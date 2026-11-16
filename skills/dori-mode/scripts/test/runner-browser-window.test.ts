import { expect, test } from "bun:test";
import { browserWatch, browserWatchSettings, browserWindowCheck, CHROME_BUNDLE, ensureBrowserWindow, type BrowserWindowDeps } from "../src/runner/browser-window.ts";
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

/** A watch over `host(answers)` whose clock moves one minute per tick, with a 5 min grace and a 30 min cooldown. */
const watching = (answers: readonly Ran[]) => {
  const h = host(answers);
  let now = 0;
  const tick = browserWatch(
    { run: h.deps.run, now: () => now, log: h.deps.log, check: browserWindowCheck("darwin", h.deps)! },
    browserWatchSettings({}),
  );
  const minutes = async (n: number) => { for (let i = 0; i < n; i++) { await tick(); now += 60_000; } };
  const opens = () => h.calls.filter((c) => c.startsWith("open ")).length;
  return { h, minutes, opens };
};

test("the watch opens a window once no browser has connected for the grace period", async () => {
  const w = watching([ONE, NONE]);
  await w.minutes(6);
  expect(w.opens()).toBe(0);
  await w.minutes(1);
  expect(w.opens()).toBe(1);
  expect(w.h.logs.some((l) => l.startsWith("RUNNER_BSK_WATCH_OPEN"))).toBe(true);
});

test("a browser that reconnects within the grace period opens nothing", async () => {
  const w = watching([ONE, NONE, NONE, NONE, ONE]);
  await w.minutes(20);
  expect(w.opens()).toBe(0);
  expect(w.h.logs.some((l) => l.startsWith("RUNNER_BSK_WATCH_RECONNECTED"))).toBe(true);
});

test("the watch waits out its cooldown before opening again", async () => {
  const w = watching([NONE]);
  await w.minutes(35);
  expect(w.opens()).toBe(1);
  await w.minutes(2);
  expect(w.opens()).toBe(2);
});

test("watch settings read whole minutes and keep the defaults otherwise", () => {
  expect(browserWatchSettings({ DORI_BSK_WATCH_MINUTES: "0", DORI_BSK_WATCH_COOLDOWN_MINUTES: "10" })).toEqual({ graceMs: 0, cooldownMs: 600_000, ignored: [] });
  const bad = browserWatchSettings({ DORI_BSK_WATCH_MINUTES: "soon" });
  expect(bad.graceMs).toBe(300_000);
  expect(bad.ignored).toHaveLength(1);
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
