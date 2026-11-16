import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { eventClass } from "../src/event-policy.ts";
import { LaunchError, validateLaunch } from "../src/launch.ts";
import { enrollRunner, RunnerAuth } from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { herdrDownSince } from "../src/runner/herdr-down.ts";
import { HUB_FILE, readRunnerRows } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
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
  const client = new RunnerClient({ label: "lab", hostId: "host-b", proto: 8 }, { connect, outbox, state, clock, auth });
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
