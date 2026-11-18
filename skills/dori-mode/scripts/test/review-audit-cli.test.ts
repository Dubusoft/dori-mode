import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ReviewStatusStore } from "../src/review-status.ts";

// Each case spawns `bun src/cli.ts`; process startup under a loaded full run outgrows bun's default 5 s.
setDefaultTimeout(30_000);

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "review-audit-cli-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cli = async (args: string[]) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("review audit: exit 0 on a clean stateDir, exit 1 once a merge lacks approval, --json prints the audit", async () => {
  const clean = await cli(["review", "audit"]);
  expect(clean).toMatchObject({ code: 0 });
  expect(clean.out).toContain("Violations: none");

  new ReviewStatusStore(dir).recordMerge({
    lane: "author", repo: "Dubusoft/dori-mode", prNumber: 7, headSha: "a".repeat(40), mergeSha: "9".repeat(40), at: Date.UTC(2026, 10, 14, 12),
  });
  const dirty = await cli(["review", "audit", "--json"]);
  expect(dirty.code).toBe(1);
  const audit = JSON.parse(dirty.out);
  expect(audit.violations.map((v: { kind: string }) => v.kind)).toEqual(["merge_without_approval"]);
  expect(audit.stateDir).toBe(dir);

  expect(await cli(["review"])).toMatchObject({ code: 2 });
});
