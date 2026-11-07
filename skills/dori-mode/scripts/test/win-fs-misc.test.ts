import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../src/config.ts";
import { RENAME_RETRIES, RENAME_RETRY_MS, renameWithRetry, writeFileAtomic } from "../src/setup.ts";

const roots: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "dori-win-fs-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename`), { code });

/** A rename that fails with `codes` in order, then really renames. */
const flaky = (codes: string[]) => {
  const calls: string[] = [];
  return {
    calls,
    rename: (from: string, to: string): void => {
      calls.push(from);
      const code = codes.shift();
      if (code) throw errno(code);
      renameSync(from, to);
    },
  };
};

describe("expandHome", () => {
  test("accepts ~/ and ~\\ and leaves other paths alone", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
    expect(expandHome("~\\.dori", "/h")).toBe("/h/.dori");
    expect(expandHome("~x/a", "/h")).toBe("~x/a");
    expect(expandHome("/abs", "/h")).toBe("/abs");
  });
});

describe("rename retry", () => {
  test("win32 retries EPERM, EACCES and EBUSY with the short sleep, then succeeds", () => {
    const d = temp();
    const sleeps: number[] = [];
    const r = flaky(["EPERM", "EACCES", "EBUSY"]);
    writeFileAtomic(join(d, "f"), "x", 0o600, { platform: "win32", rename: r.rename, sleep: (ms) => sleeps.push(ms) });
    expect(readFileSync(join(d, "f"), "utf8")).toBe("x");
    expect(r.calls).toHaveLength(4);
    expect(sleeps).toEqual([RENAME_RETRY_MS, RENAME_RETRY_MS, RENAME_RETRY_MS]);
    expect(readdirSync(d)).toEqual(["f"]);
  });

  test("win32 gives up after the last retry with the original error", () => {
    const sleeps: number[] = [];
    const r = flaky(Array(RENAME_RETRIES + 1).fill("EBUSY"));
    expect(() => renameWithRetry("a", "b", { platform: "win32", rename: r.rename, sleep: (ms) => sleeps.push(ms) })).toThrow(/EBUSY/);
    expect(r.calls).toHaveLength(RENAME_RETRIES + 1);
    expect(sleeps).toHaveLength(RENAME_RETRIES);
  });

  test("other errors and other platforms are not retried", () => {
    const sleeps: number[] = [];
    const missing = flaky(["ENOENT"]);
    expect(() => renameWithRetry("a", "b", { platform: "win32", rename: missing.rename, sleep: (ms) => sleeps.push(ms) })).toThrow(/ENOENT/);
    expect(missing.calls).toHaveLength(1);
    const linux = flaky(["EBUSY"]);
    expect(() => renameWithRetry("a", "b", { platform: "linux", rename: linux.rename, sleep: (ms) => sleeps.push(ms) })).toThrow(/EBUSY/);
    expect(linux.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
