import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askingLine } from "../src/ask-user.ts";
import { settleLaneOutcome } from "../src/autopilot.ts";
import { fillHook } from "../src/config.ts";
import { buildTrace, traceText } from "../src/event-trace.ts";
import { SqliteLaneReports } from "../src/lane-report-store.ts";
import { SqliteOperations } from "../src/operations.ts";
import { redactMeta, redactSecrets, replaceKnownSecrets } from "../src/redact.ts";
import { storePath } from "./fakes.ts";

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
  test("runner enrollment codes, session tokens, and private keys", () => {
    const code = "enroll-" + body(5);
    const token = "a".repeat(43);
    const pem = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
    const out = redactSecrets(`enroll-code=${code} session=${token}\n${pem}`);
    expect(out).not.toContain(code);
    expect(out).not.toContain(token);
    expect(out).not.toContain("abc123");
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
  test("a quoted multiline value is known in full, and each long line of it on its own", () => {
    const first = `first-${body(5)}`;
    const second = `second-${body(5)}`;
    writeFileSync(join(home, ".dori", "env"), `DORI_SA_KEY="${first}\n${second}"\nDORI_NOTE=x\n`);
    expect(redactSecrets(`dump ${first} ${second} end`)).toBe("dump [REDACTED] end");
    expect(redactSecrets(`log: ${second}`)).toBe("log: [REDACTED]");
  });
});

describe("multiline secret-store values", () => {
  // A service-account-style JSON key: its id line is long enough to mask alone, `{` and `}` are not.
  const idLine = `"private_key_id": "${body(8)}",`;
  const value = `{\n  "type": "service_account",\n  ${idLine}\n  "client_email": "bot@proj.iam.gserviceaccount.com"\n}`;
  beforeEach(() => replaceKnownSecrets([value]));
  afterEach(() => replaceKnownSecrets([]));

  test("the value is masked after its newlines were flattened to spaces", () => {
    expect(redactSecrets(`failed: ${value.replace(/\s+/g, " ")} end`)).toBe("failed: [REDACTED] end");
    expect(redactSecrets(`failed: ${value.replace(/\n/g, "\r\n")} end`)).toBe("failed: [REDACTED] end");
  });
  test("a line of 16+ characters printed alone is masked; a shorter line stays", () => {
    expect(redactSecrets(`log:   ${idLine}`)).toBe("log:   [REDACTED]");
    expect(redactSecrets("{")).toBe("{");
  });
  test("a whitespace-only value masks only its exact self", () => {
    replaceKnownSecrets([" ".repeat(9)]);
    expect(redactSecrets("plain text, two  spaces")).toBe("plain text, two  spaces");
  });
  test("autopilot lane-failed line and on-screen question line", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-ops-"));
    const store = new SqliteOperations(storePath(dir));
    try {
      store.put({ id: "toodo:9/autopilot-launch/1", lane: "toodo:9", action: "autopilot-launch", target: "1", state: "verified", detail: "verified", data: JSON.stringify({ laneKey: "k" }), attempts: 1, at: 1, updatedAt: 1 });
      const line = settleLaneOutcome(store, 2, "k", `gave up:\n${value}`);
      expect(line).toContain("gave up: [REDACTED]");
      expect(line).not.toContain(body(8));
      expect(JSON.stringify(store.list())).not.toContain(body(8));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
    const asked = askingLine("k", { question: `use this key?\n${value}`, options: [], pending: 1 });
    expect(asked).toContain("use this key? [REDACTED]");
    expect(asked).not.toContain(body(8));
  });
});

describe("sanitize boundaries", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test("stored lane report text and evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-reports-"));
    dirs.push(dir);
    const row = new SqliteLaneReports(storePath(dir)).append({ lane: "k", generation: 0, kind: "progress", text: `EXPO_TOKEN=${FAKE}`, evidence: `{"token":"${FAKE}"}`, at: 1 });
    expect(JSON.stringify(row)).not.toContain(FAKE);
    expect(JSON.stringify(new SqliteLaneReports(storePath(dir)).list())).not.toContain(FAKE);
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
