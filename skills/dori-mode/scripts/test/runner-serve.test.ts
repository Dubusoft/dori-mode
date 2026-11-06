import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

import { RunnerAuth } from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { runStartupCheck } from "../src/runner/fs-safety.ts";
import { HUB_FILE, readRunnerRows } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { loadIdentity, type ObservedLane, serveRunner, trackedConnector } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { connectUnix, controlSocketPath } from "../src/runner/unix-transport.ts";
import { collectStatus, renderStatus } from "../src/status.ts";
import { openRunnerHub } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

/** A promise that resolves the first time `match` sees a value. */
const waiter = <T>() => {
  const waiting: { match: (value: T) => boolean; resolve: () => void }[] = [];
  return {
    see(value: T) { for (const w of waiting.splice(0)) if (w.match(value)) w.resolve(); else waiting.push(w); },
    when: (match: (value: T) => boolean) => new Promise<void>((resolve) => { waiting.push({ match, resolve }); }),
  };
};

test("a local runner over the real unix socket says hello, replays its outbox, heartbeats and shows as RUNNER local connected", async () => {
  const state = withState();
  cleanups.push(state.done);
  const stateDir = join(state.dir, "state");
  const runnerDir = join(state.dir, "runner");
  const clock = fakeClock(Date.parse("2026-11-05T00:00:00Z"));
  const deps = depsFor(newWorld(), clock, stateDir, { runners: {} });

  // Supervisor side: the hub on <runnerDir>/sock/control, as supervise() opens it; it enrolls the local runner in-process.
  const logs: string[] = [];
  const logged = waiter<string>();
  const heartbeats = waiter<string>();
  const hub = openRunnerHub(stateDir, runnerDir, clock.now, clock.now, (line) => { logs.push(line); logged.see(line); }, {
    onHeartbeat: (label) => { heartbeats.see(label); }, hostId: "host-a",
    // RunnerCalls timeouts never fire here: the test settles every pending query itself.
    timers: { set: () => 0, clear: () => {} },
  });
  cleanups.push(() => hub.close());
  expect(statSync(join(runnerDir, "sock")).mode & 0o777).toBe(0o700);
  expect(statSync(controlSocketPath(runnerDir)).isSocket()).toBe(true);

  // Runner side, wired as `dori runner serve` wires it, with a fake clock and a manual timer.
  const exits: number[] = [];
  expect(runStartupCheck(runnerDir, { stderr: () => {}, exit: (code) => { exits.push(code); } })).toBe(true);
  expect(exits).toEqual([]);
  const identity = loadIdentity(runnerDir, "local", "host-a");
  const runnerState = new RunnerState(runnerDir, { now: clock.now });
  expect(runnerState.boot()).toBe(1);
  const outbox = new Outbox(runnerDir, { now: clock.now });
  cleanups.push(() => { outbox.close(); runnerState.close(); });
  const observed: ObservedLane[] = [{ key: "demo", pane: "w1:p2", tab: "w1:t1", status: "working" }];
  const tracked = trackedConnector(connectUnix(controlSocketPath(runnerDir)));
  const client = new RunnerClient({ label: identity.label, hostId: identity.hostId }, {
    connect: tracked.connect, outbox, state: runnerState, clock, auth: new RunnerAuth(runnerDir), inventory: () => observed.map(({ status: _s, ...lane }) => lane),
  });
  const timers: { ms: number; tick: () => void }[] = [];
  const controller = new AbortController();
  const heartbeat = heartbeats.when((label) => label === "local");
  const serving = serveRunner({
    client, latest: tracked.latest, clock, heartbeatMs: 15_000, observe: async () => observed, log: () => {},
    every: (ms, tick) => { const timer = { ms, tick }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; },
  }, controller.signal);

  await heartbeat;
  // The heartbeat timer is separate from the observation timer.
  expect(timers.map((t) => t.ms).sort((a, b) => a - b)).toEqual([15_000, 30_000]);
  expect(logs).toContain("RUNNER_CONNECTED runner=local gen=1 eventAck=0");

  // The lane.state observed before the connection was appended to the outbox, replayed and committed to the hub's own journal.
  expect(hub.hub.runner("local")?.eventAck).toBe(1);
  const db = new Database(join(stateDir, HUB_FILE), { readonly: true });
  expect((db.query("SELECT id FROM runner_events").all() as { id: string }[]).map((r) => r.id)).toEqual(["runner:local:1"]);
  db.close();

  // dori status reads the persisted row.
  const status = await collectStatus(deps);
  expect(status.runners?.[0]).toMatchObject({ label: "local", state: "connected", proto: 4, gen: 1, heartbeatAgeSec: 0 });
  // The lane count is the registry's open lanes on the machine, not the hello inventory ("demo" is not in the registry).
  expect(renderStatus(status)).toMatch(/^- local: 연결됨 · 레인 0개 · herdr 미확인 · 미전달 이벤트 1개 \(가장 오래된 것 \d+초 전\)$/m);

  // The handle's RunnerCalls: a label with no connection fails closed at once; a query pending on the live connection
  // (this client has no query dispatcher, so it stays unanswered) is rejected when the connection closes.
  expect(hub.calls.connected("local")).toBe(true);
  await expect(hub.calls.query("box", "q.panes", {})).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE", why: "disconnected" });
  const pendingQuery = hub.calls.query("local", "q.panes", {}).then(() => undefined, (e: unknown) => e);
  expect(hub.calls.pending()).toBe(1);

  // Past the stale threshold with no heartbeat the line reads stale; the runner stopping reads offline.
  clock.at += 61_000;
  expect(renderStatus(await collectStatus(deps))).toMatch(/^- local: 응답 늦음 · 마지막 응답 1분 전 · /m);
  const gone = logged.when((line) => line === "RUNNER_DISCONNECTED runner=local");
  controller.abort();
  await serving;
  await gone;
  expect(await pendingQuery).toMatchObject({ code: "RUNNER_UNAVAILABLE", why: "disconnected" });
  expect(hub.calls.pending()).toBe(0);
  expect(readRunnerRows(stateDir)[0]?.disconnectedAt).toBe(clock.at);
  expect(renderStatus(await collectStatus(deps))).toMatch(/^- local: 오프라인 · /m);
});

test("without a runners section dori status still shows the local runner, offline until it says hello", async () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(Date.parse("2026-11-05T00:00:00Z"));
  const status = await collectStatus(depsFor(newWorld(), clock, state.dir));
  expect(status.runners?.map((r) => [r.label, r.state])).toEqual([["local", "offline"]]);
  expect(renderStatus(status)).toContain("\n■ 머신 (1)\n- local: 오프라인 · 레인 0개 · herdr 미확인\n  머신 샘플 없음\n");
});
