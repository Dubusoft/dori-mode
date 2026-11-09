import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { NEEDS_PROTO, RunnerCalls, RunnerUnavailable } from "../src/runner/call.ts";
import { HERDR_PAUSED_FILE, herdrPaused, hostHerdr } from "../src/runner/herdr-control.ts";
import { HerdrWatch, startManagedHerdr } from "../src/runner/herdr-watch.ts";
import { runnerEffects } from "../src/runner/main.ts";
import { decodeFrame, encodeFrame, ProtocolError, supervisorCommand } from "../src/runner/protocol.ts";
import type { RunnerLanes } from "../src/runner/lanes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const UNIT = "/h/.config/systemd/user/herdr-server.service";

/** One host: herdr answering or not, its server pids, and whether its unit file is installed. */
const host = (init: { up: boolean; pids: number[]; unit?: boolean; unitOwns?: boolean; termEnds?: boolean; startAnswers?: boolean }) => {
  const runnerDir = mkdtempSync(join(tmpdir(), "herdr-control-"));
  dirs.push(runnerDir);
  const w = { ...init, unit: init.unit ?? true, unitOwns: init.unitOwns ?? true, termEnds: init.termEnds ?? true, startAnswers: init.startAnswers ?? true };
  let at = 0;
  const calls: string[] = [];
  const signals: string[] = [];
  const run = async (argv: readonly string[]): Promise<Ran> => {
    const line = argv.join(" ");
    calls.push(line);
    if (line === "herdr pane list") return w.up ? { code: 0, out: JSON.stringify({ result: { panes: [] } }), err: "" } : { code: 1, out: "", err: "connection refused" };
    if (argv[0] === "pgrep") return w.pids.length ? { code: 0, out: w.pids.join("\n"), err: "" } : { code: 1, out: "", err: "" };
    if (argv[0] === "ps") return { code: 0, out: w.pids.map((p) => `${p} Thu Nov  6 10:00:00 2026`).join("\n"), err: "" };
    if (line === "systemctl --user stop herdr-server.service") { if (w.unitOwns) { w.pids = []; w.up = false; } return { code: 0, out: "", err: "" }; }
    if (line === "systemctl --user start herdr-server.service") { w.pids = [900]; w.up = w.startAnswers; return { code: 0, out: "", err: "" }; }
    return { code: 127, out: "", err: `unexpected ${line}` };
  };
  const control = hostHerdr({
    run, runnerDir, os: "linux", home: "/h", exists: (p) => (p === UNIT ? w.unit : existsSync(p)),
    now: () => at, sleep: async (ms) => { at += ms; },
    signal: (pid, sig) => {
      signals.push(`${sig} ${pid}`);
      if (sig === "SIGKILL" || w.termEnds) { w.pids = w.pids.filter((p) => p !== pid); w.up = false; }
    },
  });
  return { w, calls, signals, control, runnerDir, paused: () => herdrPaused(runnerDir) };
};

test("status only reads: state, server instance, unit and pause marker", async () => {
  const h = host({ up: true, pids: [77] });
  const out = await h.control("status");
  expect(out.result).toEqual({ action: "status", state: "up", instance: "77 Thu Nov 6 10:00:00 2026", managed: true, paused: false });
  expect(h.calls.filter((c) => c.startsWith("systemctl"))).toEqual([]);
  expect(h.signals).toEqual([]);
});

test("stop sets the pause marker, stops the unit, signals what is left and starts nothing", async () => {
  const h = host({ up: true, pids: [77], unit: false });
  const out = await h.control("stop");
  expect(h.paused()).toBe(true);
  expect(h.signals).toEqual(["SIGTERM 77"]);
  expect(h.calls.some((c) => c.includes("start"))).toBe(false);
  expect(out.result).toMatchObject({ action: "stop", state: "down", paused: true, managed: false });
});

test("start clears the pause marker and starts the unit of a down herdr; refuses a hung one and a host without a unit", async () => {
  const h = host({ up: false, pids: [] });
  await h.control("stop");
  expect(h.paused()).toBe(true);
  const out = await h.control("start");
  expect(h.paused()).toBe(false);
  expect(h.calls).toContain("systemctl --user start herdr-server.service");
  expect(out.result).toMatchObject({ action: "start", state: "up", paused: false });

  const hung = host({ up: false, pids: [55] });
  await expect(hung.control("start")).rejects.toThrow("HERDR_HUNG");
  expect(hung.signals).toEqual([]);

  const bare = host({ up: false, pids: [], unit: false });
  await expect(bare.control("start")).rejects.toThrow("HERDR_UNMANAGED");
});

test("start waits for the started unit to answer and fails when it never does", async () => {
  const h = host({ up: false, pids: [], startAnswers: false });
  await expect(h.control("start")).rejects.toThrow("HERDR_START_UNCONFIRMED");
});

test("restart of a hung server the unit owns: the unit is stopped, nothing is signalled, the unit is started again", async () => {
  const h = host({ up: false, pids: [55] });
  const out = await h.control("restart");
  expect(h.signals).toEqual([]);
  expect(h.calls.indexOf("systemctl --user stop herdr-server.service")).toBeLessThan(h.calls.indexOf("systemctl --user start herdr-server.service"));
  expect(out.result).toMatchObject({ action: "restart", state: "up", instance: "900 Thu Nov 6 10:00:00 2026", managed: true, paused: false });
});

test("restart of a server started by hand that ignores SIGTERM: TERM, then KILL after the wait, then the unit starts", async () => {
  const h = host({ up: false, pids: [55], unitOwns: false, termEnds: false });
  const out = await h.control("restart");
  expect(h.signals).toEqual(["SIGTERM 55", "SIGKILL 55"]);
  expect(out.result).toMatchObject({ action: "restart", state: "up" });
});

test("restart on a host without a herdr unit is refused before anything is ended", async () => {
  const h = host({ up: true, pids: [77], unit: false });
  await expect(h.control("restart")).rejects.toThrow("HERDR_UNMANAGED");
  expect(h.signals).toEqual([]);
  expect(h.calls.filter((c) => c.startsWith("systemctl"))).toEqual([]);
  expect(h.w.up).toBe(true);
});

test("a herdr stopped on purpose is reported down but not started by the watch until the marker is gone", async () => {
  let at = 0;
  let paused = true;
  const starts: string[] = [];
  const events: string[] = [];
  const watch = new HerdrWatch({
    run: async () => ({ code: 1, out: "", err: "down" }), now: () => at, monotonic: () => at,
    publish: (type, body) => { events.push(`${type} ${JSON.stringify(body)}`); },
    process: async () => ({ running: false }),
    start: async () => { starts.push("start"); return { ok: true, detail: "started" }; },
    paused: () => paused,
  });
  for (let i = 0; i < 3; i++) { await watch.sample(); at += 60_000; }
  expect(watch.snapshot()?.state).toBe("down");
  expect(starts).toEqual([]);
  expect(events[0]).toContain("stopped by dori runner herdr stop");
  paused = false;
  await watch.sample();
  expect(starts).toEqual(["start"]);
});

test("macOS: a herdr unit booted out by stop is bootstrapped again before the kickstart is retried", async () => {
  const calls: string[] = [];
  let loaded = false;
  const result = await startManagedHerdr({
    os: "darwin", home: "/h", exists: () => true, read: () => "gui/501\n",
    run: async (argv) => {
      calls.push(argv.join(" "));
      if (argv[1] === "bootstrap") { loaded = true; return { code: 0, out: "", err: "" }; }
      return loaded ? { code: 0, out: "", err: "" } : { code: 113, out: "", err: "Could not find service" };
    },
  });
  expect(result).toEqual({ ok: true, detail: "exit=0" });
  expect(calls).toEqual([
    "launchctl kickstart gui/501/com.dori.herdr",
    "launchctl bootstrap gui/501 /h/Library/LaunchAgents/com.dori.herdr.plist",
    "launchctl kickstart gui/501/com.dori.herdr",
  ]);
});

test("host.herdr is a proto-4 command: its frame validates, an unknown action does not, and a proto-3 runner is refused before sending", async () => {
  const head = { runner: "worker-a", gen: 1, epoch: 1 };
  const frame = supervisorCommand(head, 7, "host.herdr", { cmdId: "c1", action: "restart" });
  expect(decodeFrame(encodeFrame(frame), "supervisor")).toEqual(frame);
  expect(() => decodeFrame(encodeFrame({ ...frame, body: { cmdId: "c1", action: "kill" } } as never), "supervisor")).toThrow(ProtocolError);
  expect(NEEDS_PROTO["host.herdr"]).toBe(4);
  const sent: string[] = [];
  const calls = new RunnerCalls({
    accept: { connected: () => true, command: (label, type) => { sent.push(`${label} ${type}`); return 1; }, control: () => true },
    proto: () => 3, now: () => 0, timers: { set: () => 0, clear: () => {} }, log: () => {},
  });
  const refused = await calls.call("worker-a", "host.herdr", { action: "status" }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(RunnerUnavailable);
  expect((refused as RunnerUnavailable).why).toBe("outdated");
  expect(sent).toEqual([]);
});

test("the runner routes host.herdr to its herdr control and answers with the structured result", async () => {
  const actions: string[] = [];
  const effects = runnerEffects({
    lanes: {} as RunnerLanes, guard: { killLanes: async () => [] }, run: async () => ({ code: 0, out: "", err: "" }),
    herdr: async (action) => { actions.push(action); return { detail: "read; herdr up", result: { action, state: "up", managed: true, paused: false } }; },
  });
  const effect = effects?.["host.herdr"];
  expect(effect).toBeDefined();
  const out = await effect?.(supervisorCommand({ runner: "local", gen: 1, epoch: 1 }, 1, "host.herdr", { cmdId: "c", action: "status" }));
  expect(actions).toEqual(["status"]);
  expect(out).toEqual({ detail: "read; herdr up", result: { action: "status", state: "up", managed: true, paused: false } });
  expect(HERDR_PAUSED_FILE).toBe("herdr-paused");
});
