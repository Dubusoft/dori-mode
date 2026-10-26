import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillHook } from "../src/config.ts";
import { buildTrace, traceText } from "../src/event-trace.ts";
import { JsonLaneReports } from "../src/lane-reports.ts";
import { redactMeta, redactSecrets } from "../src/redact.ts";

// Fake values, assembled at run time so no secret scanner sees a literal.
const body = (n: number): string => "Ab1".repeat(n);
const FAKE = body(12);

describe("redactSecrets patterns", () => {
  test("quoted JSON key", () => {
    expect(redactSecrets(`{"token":"${FAKE}"}`)).not.toContain(FAKE);
    expect(redactSecrets(`{"password": "${FAKE}"}`)).not.toContain(FAKE);
  });
  test("prefixed env vars", () => {
    for (const name of ["EXPO_TOKEN", "APP_SECRET", "STRIPE_API_KEY", "DORI_SLACK_COOKIE", "DB_PASSWORD"]) {
      const out = redactSecrets(`${name}=${FAKE}`);
      expect(out).toBe(`${name}=[REDACTED]`);
    }
  });
  test("xoxd Slack cookie, URL-encoded", () => {
    const cookie = "xoxd-" + body(6) + "%2B" + body(4) + "%3D";
    expect(redactSecrets(`cookie ${cookie} end`)).toBe("cookie [REDACTED] end");
  });
  test("telegram bot URL", () => {
    const token = "123456789:" + body(12);
    const out = redactSecrets(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(out).toBe("https://api.telegram.org/bot[REDACTED]/sendMessage");
  });
  test("ordinary text is untouched", () => {
    for (const text of ["token=5", "MAX_TOKENS=100", "sort_key list", "see src/token.ts", "state: key=value"]) expect(redactSecrets(text)).toBe(text);
  });
  test("redaction is idempotent", () => {
    const once = redactSecrets(`EXPO_TOKEN=${FAKE} {"token":"${FAKE}"}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("known secret values from the dori env file", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "redact-"));
    mkdirSync(join(home, ".dori"));
    saved = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
  test("an exact value is masked wherever it appears; a non-secret entry is not", () => {
    const value = "plain-" + body(3);
    writeFileSync(join(home, ".dori", "env"), `DORI_THING_TOKEN=${value}\nDORI_NOTE=harmless-note-text\n`);
    expect(redactSecrets(`oops ${value} leaked`)).toBe("oops [REDACTED] leaked");
    expect(redactSecrets("harmless-note-text")).toBe("harmless-note-text");
  });
});

describe("sanitize boundaries", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test("stored lane report text and evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-reports-"));
    dirs.push(dir);
    const row = new JsonLaneReports(dir).append({ lane: "k", generation: 0, kind: "progress", text: `EXPO_TOKEN=${FAKE}`, evidence: `{"token":"${FAKE}"}`, at: 1 });
    expect(JSON.stringify(row)).not.toContain(FAKE);
    expect(JSON.stringify(new JsonLaneReports(dir).list())).not.toContain(FAKE);
  });
  test("hook argv text and title", () => {
    const argv = fillHook(["hook", "{text}", "{title}", "{thread}"], { text: `EXPO_TOKEN=${FAKE}`, title: `EXPO_TOKEN=${FAKE}`, thread: "t" });
    expect(argv.join(" ")).not.toContain(FAKE);
  });
  test("event meta and trace output", () => {
    expect(JSON.stringify(redactMeta({ lane: "k", cwd: `/x/EXPO_TOKEN=${FAKE}` }))).not.toContain(FAKE);
    const trace = buildTrace("e1", {
      event: { id: "e1", line: "x", at: 1, meta: { lane: "k", thread: `EXPO_TOKEN=${FAKE}` } },
      outcome: { lane: "k", reportedAt: 2, note: `EXPO_TOKEN=${FAKE}` },
    } as never);
    expect(trace && traceText(trace).join("\n")).not.toContain(FAKE);
  });
});
