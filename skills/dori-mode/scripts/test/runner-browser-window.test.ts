import { expect, test } from "bun:test";
import { browserWindowCheck, CHROME_BUNDLE, ensureBrowserWindow, type BrowserWindowDeps } from "../src/runner/browser-window.ts";
import type { Ran } from "../src/run.ts";

const NONE: Ran = { code: 0, out: "(no browsers connected)", err: "" };
const ONE: Ran = { code: 0, out: "ID  NAME\nb1  Chrome", err: "" };

/** A host whose `bsk browsers` answers come from `answers` in order (the last one repeats). */
const host = (answers: readonly Ran[], extra: Record<string, Ran> = {}) => {
  const calls: string[] = [];
  const logs: string[] = [];
  let next = 0;
  const deps: BrowserWindowDeps = {
    run: async (argv) => {
      const line = argv.join(" ");
      calls.push(line);
      if (line === "bsk browsers") return answers[Math.min(next++, answers.length - 1)]!;
      return extra[line] ?? { code: 0, out: "", err: "" };
    },
    clock: { sleep: async () => {} },
    log: (line) => { logs.push(line); },
  };
  return { deps, calls, logs };
};

test("a connected browser opens nothing", async () => {
  const h = host([ONE]);
  await ensureBrowserWindow(h.deps, "k1");
  expect(h.calls).toEqual(["bsk browsers"]);
  expect(h.logs[0]).toStartWith("RUNNER_BSK_OK lane=k1");
});

test("no browser opens a plain Chrome window and rechecks until bsk sees it", async () => {
  const h = host([NONE, NONE, ONE]);
  await ensureBrowserWindow(h.deps, "k1");
  expect(h.calls).toEqual(["bsk browsers", `open -b ${CHROME_BUNDLE}`, "bsk browsers", "bsk browsers"]);
  expect(h.logs[0]).toStartWith("RUNNER_BSK_WINDOW_OPENED lane=k1");
});

test("still none with no extension process is reported as a profile problem", async () => {
  const h = host([NONE], { "pgrep -f -- --extension-process": { code: 1, out: "", err: "" } });
  await ensureBrowserWindow(h.deps, "k1");
  expect(h.calls.filter((c) => c.startsWith("open "))).toHaveLength(1);
  expect(h.calls.at(-1)).toBe("pgrep -f -- --extension-process");
  expect(h.logs[0]).toStartWith("RUNNER_BSK_PROFILE_PROBLEM lane=k1");
});

test("still none with extension processes running is not a profile problem", async () => {
  const h = host([NONE], { "pgrep -f -- --extension-process": { code: 0, out: "101\n102\n", err: "" } });
  await ensureBrowserWindow(h.deps, "k1");
  expect(h.logs[0]).toStartWith("RUNNER_BSK_STILL_NONE lane=k1");
  expect(h.logs[0]).toContain("(2 extension processes)");
});

test("a bsk that cannot answer opens nothing", async () => {
  const h = host([{ code: 1, out: "", err: "error: ensure daemon is running" }]);
  await ensureBrowserWindow(h.deps, "k1");
  expect(h.calls).toEqual(["bsk browsers"]);
  expect(h.logs[0]).toBe("RUNNER_BSK_UNAVAILABLE lane=k1 error: ensure daemon is running");
});

test("the check runs only on macOS, and overlapping starts share one check", async () => {
  expect(browserWindowCheck("linux", host([NONE]).deps)).toBeUndefined();
  expect(browserWindowCheck("win32", host([NONE]).deps)).toBeUndefined();
  const h = host([NONE, ONE]);
  const check = browserWindowCheck("darwin", h.deps)!;
  await Promise.all([check("k1"), check("k2")]);
  expect(h.calls.filter((c) => c.startsWith("open "))).toHaveLength(1);
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0]).toStartWith("RUNNER_BSK_WINDOW_OPENED lane=k1");
});
