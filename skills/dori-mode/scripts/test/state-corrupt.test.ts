import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AUTO_UPDATE_STATE, readAutoUpdateState } from "../src/auto-update.ts";
import { pendingLeadRestart } from "../src/lead-restart.ts";
import { REVIEW_EXEMPT_FILE, ReviewExemptions } from "../src/review-exempt.ts";
import { REVIEW_JOBS_FILE, ReviewJobs } from "../src/review-jobs.ts";
import { REVIEW_STATUS_FILE, ReviewStatusStore } from "../src/review-status.ts";

let dir = "";
let errors: string[] = [];
let spy: Mock<typeof console.error>;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-state-corrupt-"));
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
});
afterEach(() => {
  spy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

/** Each per-tick state file: its reader, what it reads as when empty, and whether `{}` is a valid (empty) file. */
const stores = [
  { file: REVIEW_JOBS_FILE, tag: "REVIEW_JOBS", read: () => new ReviewJobs(dir).list(), empty: [], emptyObjectValid: false },
  { file: REVIEW_EXEMPT_FILE, tag: "REVIEW_EXEMPT", read: () => new ReviewExemptions(dir).list(), empty: [], emptyObjectValid: false },
  { file: REVIEW_STATUS_FILE, tag: "REVIEW_STATUS", read: () => new ReviewStatusStore(dir).merges(), empty: [], emptyObjectValid: false },
  { file: AUTO_UPDATE_STATE, tag: "AUTO_UPDATE_STATE", read: () => readAutoUpdateState(dir), empty: {}, emptyObjectValid: true },
  { file: "lead-restart.json", tag: "LEAD_RESTART", read: () => pendingLeadRestart(dir), empty: undefined, emptyObjectValid: false },
] as const;

const contents = [["{}", "{}"], ["an empty file", ""], ["truncated JSON", '{"jobs":{"a":{"job":']] as const;

test.each(stores.flatMap((s) => contents.map(([name, text]) => [s.file, name, s, text] as const)))(
  "%s holding %s is moved aside and read as empty, once",
  (_file, _name, s, text) => {
    const path = join(dir, s.file);
    writeFileSync(path, text);
    expect(s.read()).toEqual(s.empty);
    if (text === "{}" && s.emptyObjectValid) {
      expect(errors).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe("{}");
      return;
    }
    const aside = readdirSync(dir).filter((f) => f.startsWith(`${s.file}.corrupt-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(text);
    expect(existsSync(path)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(`${s.tag}_CORRUPT moved ${path} to ${join(dir, aside[0]!)}: `);
    // The next pass reads the missing file as empty without logging again.
    expect(s.read()).toEqual(s.empty);
    expect(errors).toHaveLength(1);
  },
);

test("a review store whose file was corrupt records again from empty", () => {
  const status = new ReviewStatusStore(dir);
  writeFileSync(status.path, "{");
  status.recordMerge({ lane: "ap-1", repo: "Dubusoft/dori-mode", prNumber: 7, headSha: "a".repeat(40), mergeSha: "b".repeat(40), at: 1 });
  expect(status.merges()).toHaveLength(1);
  expect(errors.filter((e) => e.startsWith("REVIEW_STATUS_CORRUPT"))).toHaveLength(1);
});
