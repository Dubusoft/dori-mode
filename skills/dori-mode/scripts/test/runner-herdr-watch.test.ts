import { expect, test } from "bun:test";
import { HerdrWatch, herdrProcess, startManagedHerdr } from "../src/runner/herdr-watch.ts";
import { HerdrDownInference, type HerdrRecord } from "../src/runner/herdr-down.ts";
import { decodeFrame, encodeFrame, runnerEvent, type RunnerEventType } from "../src/runner/protocol.ts";
import { eventClass } from "../src/event-policy.ts";
import type { Ran, Runner } from "../src/run.ts";
import { RunnerGuard } from "../src/runner/guard.ts";
import { fakeClock } from "./fakes.ts";

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const bad = (): Ran => ({ code: 1, out: "", err: "unreadable" });
const setup = () => {
  const world = { at: 0, wall: 1_000_000, readable: true, running: true, instance: "server-1", starts: 0, installed: true };
  const events: [RunnerEventType, unknown][] = [];
  let lists = 0;
  const watch = new HerdrWatch({
    run: async () => { lists++; return world.readable ? ok('{"result":{"panes":[]}}') : bad(); },
    now: () => world.wall, monotonic: () => world.at,
    process: async () => ({ running: world.running, instance: world.instance }),
    start: async () => { if (!world.installed) return undefined; world.starts++; return { ok: true, detail: "started" }; },
    publish: (type, body) => { events.push([type, body]); },
  });
  const tick = async (at: number) => { world.at = at; world.wall = 1_000_000 + at; return watch.sample(); };
  return { world, watch, events, tick, lists: () => lists };
};

test("watch reuses one pane list per sample and publishes only state or instance transitions", async () => {
  const t = setup();
  expect(await t.tick(0)).toBe(0);
  await t.tick(30_000);
  expect(t.events).toEqual([["herdr.state", { state: "up", instance: "server-1", detail: "pane list readable" }]]);
  t.world.instance = "server-2";
  await t.tick(60_000);
  expect(t.events).toHaveLength(2);
  expect(t.watch.snapshot()).toEqual({ state: "up", instance: "server-2", since: 1_060_000 });
  expect(t.lists()).toBe(3);
});

test("down requires consecutive failures spanning 30 seconds; one failure is reset by success", async () => {
  const t = setup();
  await t.tick(0);
  t.world.readable = false; t.world.running = false;
  await t.tick(10_000); await t.tick(20_000);
  expect(t.watch.snapshot()?.state).toBe("up");
  t.world.readable = true; await t.tick(30_000);
  t.world.readable = false; await t.tick(40_000);
  expect(t.world.starts).toBe(0);
  await t.tick(70_000);
  expect(t.watch.snapshot()).toEqual({ state: "down", since: 1_070_000 });
  expect(t.world.starts).toBe(1);
  expect(t.events.filter(([type]) => type === "herdr.start")).toEqual([["herdr.start", { ok: true, detail: "started" }]]);
});

test("hung is reported without a start; a later down may start, and recovery resets cooldown", async () => {
  const t = setup();
  t.world.readable = false;
  await t.tick(0); await t.tick(30_000);
  expect(t.watch.snapshot()?.state).toBe("hung");
  expect(t.world.starts).toBe(0);
  t.world.running = false; await t.tick(60_000);
  expect(t.world.starts).toBe(1);
  t.world.readable = true; await t.tick(90_000);
  t.world.readable = false; await t.tick(120_000); await t.tick(150_000);
  expect(t.world.starts).toBe(2);
});

test("start cooldown doubles from one minute through a thirty minute cap using monotonic time", async () => {
  const t = setup();
  t.world.readable = false; t.world.running = false;
  await t.tick(0);
  for (let at = 30_000; at <= 6_000_000; at += 30_000) {
    t.world.wall = 0;
    await t.tick(at);
  }
  const starts = t.events.filter(([type]) => type === "herdr.start");
  // Attempts at 30,90,210,450,930,1890,3690,5490 seconds.
  expect(starts).toHaveLength(8);
});

test("sleep resume discards the first failure and resets the consecutive failure window", async () => {
  const t = setup();
  await t.tick(0);
  t.world.readable = false; t.world.running = false;
  await t.tick(30_000);
  await t.tick(300_000);
  await t.tick(330_000);
  expect(t.world.starts).toBe(0);
  await t.tick(360_000);
  expect(t.world.starts).toBe(1);
});

test("an unmanaged down server is reported without start events", async () => {
  const t = setup();
  t.world.readable = false; t.world.running = false; t.world.installed = false;
  await t.tick(0); await t.tick(30_000); await t.tick(60_000);
  expect(t.watch.snapshot()?.state).toBe("down");
  expect(t.events.map(([type]) => type)).toEqual(["herdr.state"]);
});

test("guard samples carry the latest watch snapshot on every emitted sample", async () => {
  const clock = fakeClock(0);
  const published: [RunnerEventType, unknown][] = [];
  let state: "up" | "hung" = "up";
  const guard = new RunnerGuard({
    sample: async () => ({ load1: 1, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 10, swapTotalGb: 10, panes: 0 }),
    herdr: () => ({ state, since: 0, instance: "server-1" }),
    thresholds: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 20 },
    heavyKill: [], procs: async () => [], self: 1,
    kill: { clock, alive: () => false, signal: () => {} }, now: clock.now, os: "linux",
    publish: (type, body) => { published.push([type, body]); },
  });
  await guard.tick();
  expect(published[0]?.[1]).toMatchObject({ herdr: { state: "up", since: 0, instance: "server-1" } });
  state = "hung"; clock.at = 60_000;
  await guard.tick();
  expect(published[1]?.[1]).toMatchObject({ herdr: { state: "hung", since: 0, instance: "server-1" } });
});

test("Linux only starts an installed service; macOS uses the saved launchd domain without -k", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => { calls.push([...argv]); return ok(); };
  expect(await startManagedHerdr({ run, os: "linux", home: "/h", exists: () => false })).toBeUndefined();
  expect(calls).toHaveLength(0);
  expect(await startManagedHerdr({ run, os: "linux", home: "/h", exists: (p) => p === "/h/.config/systemd/user/herdr-server.service" })).toMatchObject({ ok: true });
  expect(calls[0]).toEqual(["systemctl", "--user", "start", "herdr-server.service"]);
  await startManagedHerdr({ run, os: "darwin", home: "/h", exists: () => true, read: () => "gui/501\n" });
  expect(calls[1]).toEqual(["launchctl", "kickstart", "gui/501/com.dori.herdr"]);
  expect(await startManagedHerdr({ run, os: "darwin", home: "/h", exists: () => true, read: () => "bad" })).toMatchObject({ ok: false });
  expect(calls).toHaveLength(2);
  expect(await startManagedHerdr({ run: async () => bad(), os: "linux", exists: () => true })).toEqual({ ok: false, detail: "unreadable" });
});

test("server identity combines sorted pids and start times; unreadable process tables never authorize start", async () => {
  const run: Runner = async (argv) => argv[0] === "pgrep" ? ok("42\n7") : ok("42 Fri Nov 6 10:00:00 2026\n7 Fri Nov 6 09:00:00 2026");
  expect(await herdrProcess(run)).toEqual({ running: true, instance: "42 Fri Nov 6 10:00:00 2026;7 Fri Nov 6 09:00:00 2026" });
  expect(await herdrProcess(async () => bad())).toEqual({ running: false });
  expect(await herdrProcess(async () => ({ code: 2, out: "", err: "denied" }))).toEqual({ running: true });
  expect(await herdrProcess(async (argv) => argv[0] === "pgrep" ? ok("42") : bad())).toEqual({ running: true });
});

test("health schemas are strict throughout the supported protocol window", () => {
  const head = { runner: "lab", gen: 1, epoch: 1 };
  const event = runnerEvent(head, 1, "guard.sample", { level: "ok", reasons: [], sampledAt: 0, herdr: { state: "hung", since: 0 } });
  expect(decodeFrame(encodeFrame(event), "runner")).toEqual(event);
  expect(() => decodeFrame(encodeFrame(runnerEvent(head, 2, "guard.sample", { ...event.body, herdr: { state: "unknown", since: 0 } } as never)), "runner")).toThrow();
  expect(() => decodeFrame(encodeFrame(runnerEvent(head, 2, "herdr.state", { state: "down", detail: "", extra: true } as never)), "runner")).toThrow();
  expect(() => decodeFrame(encodeFrame(runnerEvent(head, 2, "guard.sample", { ...event.body, herdr: { state: "down", since: -1 } } as never)), "runner")).toThrow();
});

test("supervisor uses explicit proto 4 health, keeps proto 3 inference, and routes start outcomes", () => {
  const store = new Map<string, HerdrRecord>();
  const infer = new HerdrDownInference({ read: (k) => store.get(k), save: (k, v) => { store.set(k, v); } }, () => 100);
  const head = { runner: "lab", gen: 1, epoch: 1 };
  const unreadable = runnerEvent(head, 1, "guard.sample", { level: "ok", reasons: [], sampledAt: 0, panes: -1 });
  expect(infer.event("lab", unreadable, 4)).toBeUndefined();
  expect(infer.event("lab", unreadable, 4)).toBeUndefined();
  expect(store.has("lab")).toBe(false);
  expect(infer.event("old", unreadable, 3)).toBeUndefined();
  expect(infer.event("old", unreadable, 3)?.line).toStartWith("HERDR_DOWN");
  const hung = runnerEvent(head, 2, "herdr.state", { state: "hung", detail: "running" });
  expect(infer.event("lab", hung, 4)?.line).toStartWith("HERDR_HUNG machine=lab");
  expect(infer.event("lab", hung, 4)).toBeUndefined();
  expect(store.get("lab")?.state).toBe("hung");
  const up = runnerEvent(head, 3, "guard.sample", { level: "ok", reasons: [], sampledAt: 1, panes: -1, herdr: { state: "up", since: 0, instance: "server-2" } });
  expect(infer.event("lab", up, 4)?.line).toContain("HERDR_UP machine=lab server=server-2");
  expect(infer.event("lab", runnerEvent(head, 4, "herdr.state", { state: "up", instance: "server-3", detail: "replaced" }), 4)?.line).toContain("HERDR_UP machine=lab server=server-3");
  expect(infer.event("lab", runnerEvent(head, 5, "herdr.state", { state: "up", instance: "server-3", detail: "same" }), 4)).toBeUndefined();
  expect(infer.event("lab", runnerEvent(head, 4, "herdr.start", { ok: false, detail: "unit failed" }), 4)?.line).toBe("HERDR_START machine=lab failed unit failed");
  expect(eventClass("HERDR_HUNG machine=lab")).toBe("lead-urgent");
  const elevated = runnerEvent(head, 6, "herdr.state", { state: "elevated", detail: "refused" });
  expect(decodeFrame(encodeFrame(elevated), "runner")).toEqual(elevated);
  expect(infer.event("lab", elevated, 4)?.line).toStartWith("HERDR_ELEVATED machine=lab lane recovery on this machine is held");
  expect(store.get("lab")?.state).toBe("elevated");
  expect(eventClass("HERDR_ELEVATED machine=lab")).toBe("lead-urgent");
});
