import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { eventClass } from "../src/event-policy.ts";
import { LaunchError, validateLaunch } from "../src/launch.ts";
import { enrollRunner, RunnerAuth } from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { HERDR_DOWN_SAMPLES, herdrDownSince, HerdrDownInference, type HerdrRecord } from "../src/runner/herdr-down.ts";
import { HUB_FILE, readRunnerRows } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { RunnerState } from "../src/runner/state.ts";
import { connectUnix, controlSocketPath } from "../src/runner/unix-transport.ts";
import { machineLines, runnerViews } from "../src/status.ts";
import { openRunnerHub } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { markHerdr } from "./herdr-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const sampleBody = (panes?: number) => ({
  level: "ok", reasons: [], sampledAt: 0, load1: 1, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 2, swapTotalGb: 2, os: "linux",
  ...(panes === undefined ? {} : { panes }),
});
const sample = (label: string, panes?: number): AnyRunnerEvent =>
  ({ v: 1, runner: label, gen: 1, epoch: 1, seq: 1, type: "guard.sample", body: sampleBody(panes) }) as unknown as AnyRunnerEvent;

/** The inference over an in-memory store; `lines` are the transitions it returned. */
const inference = (store = new Map<string, HerdrRecord>()) => {
  const clock = fakeClock(1_000_000);
  const infer = new HerdrDownInference({ read: (l) => store.get(l), save: (l, r) => { store.set(l, r); } }, clock.now);
  const feed = (label: string, panes?: number): string | undefined => infer.event(label, sample(label, panes))?.line;
  return { store, clock, feed, infer };
};

test("two unreadable samples in a row say HERDR_DOWN once; the next readable one says HERDR_UP once", () => {
  const w = inference();
  // First sight of a readable herdr is saved as up and says nothing.
  expect(w.feed("worker-a", 4)).toBeUndefined();
  expect(w.store.get("worker-a")).toEqual({ state: "up", since: 1_000_000 });
  expect(w.feed("worker-a", -1)).toBeUndefined();
  w.clock.at += 60_000;
  expect(w.feed("worker-a", -1)).toBe(`HERDR_DOWN machine=worker-a herdr unreadable in ${HERDR_DOWN_SAMPLES} guard samples in a row (panes=-1); lane recovery on this machine is held and dori launch --machine worker-a is refused until herdr reads again`);
  expect(w.store.get("worker-a")).toEqual({ state: "down", since: 1_060_000 });
  w.clock.at += 60_000;
  expect(w.feed("worker-a", -1)).toBeUndefined();
  w.clock.at += 60_000;
  expect(w.feed("worker-a", 0)).toBe("HERDR_UP machine=worker-a herdr reads again (panes=0) after 120 s down; held lane recovery resumes at the next recovery sweep");
  expect(w.store.get("worker-a")).toEqual({ state: "up", since: 1_180_000 });
  expect(w.feed("worker-a", 3)).toBeUndefined();
});

test("one unreadable sample between readable ones, and a sample without a pane count, change nothing", () => {
  const w = inference();
  expect([w.feed("mac", 2), w.feed("mac", -1), w.feed("mac", 2), w.feed("mac", -1), w.feed("mac", undefined), w.feed("mac", 2)]).toEqual(Array(6).fill(undefined));
  expect(w.store.get("mac")?.state).toBe("up");
  // A protocol-2 runner never sends panes: no state at all.
  expect(w.feed("old", undefined)).toBeUndefined();
  expect(w.store.has("old")).toBe(false);
  // Machines are counted apart, and the local runner's line names no launch refusal.
  w.feed("local", -1);
  w.feed("mac", -1);
  expect(w.feed("local", -1)).toBe("HERDR_DOWN machine=local herdr unreadable in 2 guard samples in a row (panes=-1); lane recovery on this machine is held until herdr reads again");
});

test("a supervisor restart keeps the saved down state: no second HERDR_DOWN, and the first readable sample says HERDR_UP", () => {
  const store = new Map<string, HerdrRecord>([["worker-a", { state: "down", since: 1_000_000 - 30_000 }]]);
  const w = inference(store);
  expect([w.feed("worker-a", -1), w.feed("worker-a", -1)]).toEqual([undefined, undefined]);
  expect(w.feed("worker-a", 5)).toBe("HERDR_UP machine=worker-a herdr reads again (panes=5) after 30 s down; held lane recovery resumes at the next recovery sweep");
});

test("HERDR_DOWN wakes the lead, HERDR_UP is digest", () => {
  expect(eventClass("HERDR_DOWN machine=mac herdr unreadable")).toBe("lead-urgent");
  expect(eventClass("HERDR_UP machine=mac herdr reads again")).toBe("lead-digest");
});

test("over the runner hub: a runner's guard samples save herdr on its row, enqueue the lines, and dori status shows herdr=", async () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const stateDir = join(tmp.dir, "state");
  const runnerDir = join(tmp.dir, "runner");
  const clock = fakeClock(Date.parse("2026-11-06T00:00:00Z"));
  const herdrLines: [string, string][] = [];
  let committed = 0;
  let seen: (() => void) | undefined;
  const handle = openRunnerHub(stateDir, runnerDir, clock.now, clock.now, () => {}, {
    hostId: "host-a",
    onHerdr: (id, line) => { herdrLines.push([id, line]); },
    onEvent: () => { committed++; seen?.(); },
  });
  cleanups.push(() => handle.close());
  const connect = connectUnix(controlSocketPath(runnerDir));
  const dir = join(tmp.dir, "lab");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const auth = new RunnerAuth(dir);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  cleanups.push(() => { outbox.close(); state.close(); });
  const { code } = handle.auth.issueCode("lab");
  expect(await enrollRunner({ auth, connect, code, label: "lab", hostId: "host-b", expectedFingerprint: handle.auth.fingerprint })).toMatchObject({ ok: true });
  const client = new RunnerClient({ label: "lab", hostId: "host-b", proto: 5 }, { connect, outbox, state, clock, auth });
  expect(await client.connectOnce()).toMatchObject({ ok: true });
  let unreadableSamples = 0;
  let health = { state: "up" as "up" | "down", since: clock.now(), instance: "server-1" };
  /** Publishes one guard sample and waits until the hub committed it. */
  const publish = async (panes: number): Promise<void> => {
    const want = committed + 1;
    const done = new Promise<void>((resolve) => { seen = () => { if (committed >= want) resolve(); }; });
    unreadableSamples = panes < 0 ? unreadableSamples + 1 : 0;
    const state = unreadableSamples >= 2 ? "down" : "up";
    if (state !== health.state) health = { ...health, state, since: clock.now() };
    client.publish("guard.sample", { ...sampleBody(panes), herdr: health } as never);
    await done;
  };
  const row = () => readRunnerRows(stateDir).find((r) => r.label === "lab");

  await publish(2);
  expect(row()).toMatchObject({ herdr: "up" });
  clock.at += 60_000;
  await publish(-1);
  clock.at += 60_000;
  await publish(-1);
  const downAt = clock.at;
  expect(row()).toMatchObject({ herdr: "down", herdrSince: downAt });
  expect(herdrDownSince(stateDir)).toEqual(new Map([["lab", downAt]]));
  expect(herdrLines.map(([id, line]) => [id, line.split(" ").slice(0, 2).join(" ")])).toEqual([["herdr:lab:down:3", "HERDR_DOWN machine=lab"]]);
  const lab = runnerViews(readRunnerRows(stateDir), clock.now()).find((r) => r.label === "lab")!;
  expect(machineLines(lab)[0]).toContain(" · herdr 다운");
  // The sample's readings are saved on the row for dori status, stamped with the supervisor's clock.
  expect(row()?.machine).toEqual({ at: downAt, level: "ok", reasons: [], os: "linux", load1: 1, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 2, swapTotalGb: 2, panes: -1 });
  expect(machineLines(lab)[1]).toBe("  CPU 부하 1.0 · 메모리 여유 50% · 디스크 여유 100GB · 스왑 여유 2.0/2.0GB (0초 전 측정)");

  clock.at += 60_000;
  await publish(3);
  expect(row()).toMatchObject({ herdr: "up", herdrSince: clock.at });
  expect(herdrDownSince(stateDir).size).toBe(0);
  expect(herdrLines.map(([, line]) => line.split(" ")[0])).toEqual(["HERDR_DOWN", "HERDR_UP"]);
  // The local runner has never sent a sample: its herdr is unknown.
  expect(machineLines(runnerViews(readRunnerRows(stateDir), clock.now())[0]!)).toEqual(["- local: 오프라인 · herdr 미확인", "  머신 샘플 없음"]);
});

test("readRunnerRows reads a table from before the herdr columns (the supervisor not restarted yet since an upgrade)", () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const db = new Database(join(tmp.dir, HUB_FILE), { create: true });
  db.run("CREATE TABLE runners (label TEXT PRIMARY KEY, hostId TEXT, eventAck INTEGER NOT NULL DEFAULT 0, cmdSeq INTEGER NOT NULL DEFAULT 0, maxGen INTEGER NOT NULL DEFAULT 0, cmdAck INTEGER NOT NULL DEFAULT 0, proto INTEGER, version TEXT, lastHelloAt INTEGER)");
  db.run("INSERT INTO runners (label, maxGen) VALUES ('old', 3)");
  db.close();
  expect(readRunnerRows(tmp.dir)).toEqual([{ label: "old", eventAck: 0, cmdSeq: 0, maxGen: 3, cmdAck: 0 }]);
  expect(herdrDownSince(tmp.dir).size).toBe(0);
});

test("dori launch --machine is refused at once while that machine's herdr is down, and allowed once it is up", async () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const deps = depsFor(newWorld(), fakeClock(0), tmp.dir);
  const input = { key: "lane-x", title: "x", brief: join(tmp.dir, "b.md"), done: "merged a/b#1", machine: "worker-a", cwd: "/w/app" };
  markHerdr(tmp.dir, "worker-a", "down", Date.parse("2026-11-06T01:02:03Z"));
  const refused = validateLaunch(deps, input);
  await expect(refused).rejects.toBeInstanceOf(LaunchError);
  await expect(refused).rejects.toThrow("HERDR_DOWN machine=worker-a herdr there has been unreadable since 2026-11-06T01:02:03.000Z");
  // Another machine, and this host, are not affected.
  await validateLaunch(deps, { ...input, machine: "worker-b" });
  await validateLaunch(deps, { ...input, machine: undefined });
  markHerdr(tmp.dir, "worker-a", "up", Date.parse("2026-11-06T01:05:00Z"));
  await validateLaunch(deps, input);
});
