import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { enrollRunner, RunnerAuth } from "../src/runner/auth.ts";
import type { Timers } from "../src/runner/call.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { HUB_FILE } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import type { AnyRunnerEvent, SupervisorCommandBodies } from "../src/runner/protocol.ts";
import { commandDispatcher, type DispatchDeps, trackedConnector } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { connectUnix, controlSocketPath } from "../src/runner/unix-transport.ts";
import type { Lane } from "../src/registry.ts";
import { openRunnerHub, readBackRunnerStarts } from "../src/supervise-loop.ts";
import { fakeClock, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const START: Omit<SupervisorCommandBodies["lane.start"], "cmdId"> = {
  key: "lane-a", briefText: "brief", done: "file /tmp/x", thread: "none", cwd: "/srv/a", agentProfile: "default",
  mode: "ulw", model: "m", sandbox: false, expectedLaneGen: 0,
};

/** Timers that never fire: a call nobody answers stays pending instead of timing out. */
const never: Timers = { set: () => 0, clear: () => {} };

const world = () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const clock = fakeClock(Date.parse("2026-11-07T00:00:00Z"));
  return { stateDir: join(tmp.dir, "state"), runnerDir: join(tmp.dir, "runner"), labDir: join(tmp.dir, "lab"), clock };
};
type World = ReturnType<typeof world>;

const openHub = (w: World, onEvent: (frame: AnyRunnerEvent) => void = () => {}) =>
  openRunnerHub(w.stateDir, w.runnerDir, w.clock.now, w.clock.now, () => {}, { hostId: "host-a", timers: never, onEvent: (_label, frame) => { onEvent(frame); } });

const connectLab = async (w: World, effects: DispatchDeps["effects"], enroll?: ReturnType<typeof openHub>, ignoreCommands = false) => {
  mkdirSync(w.labDir, { recursive: true, mode: 0o700 });
  const tracked = trackedConnector(connectUnix(controlSocketPath(w.runnerDir)));
  const auth = new RunnerAuth(w.labDir);
  if (enroll) {
    const issued = enroll.auth.issueCode("lab");
    const enrolled = await enrollRunner({ auth, connect: tracked.connect, code: issued.code, label: "lab", hostId: "host-b", expectedFingerprint: enroll.auth.fingerprint });
    expect(enrolled.ok).toBe(true);
  }
  const state = new RunnerState(w.labDir, { now: w.clock.now });
  state.boot();
  const outbox = new Outbox(w.labDir, { now: w.clock.now });
  const commands: { type: string; cmdId: string }[] = [];
  const dispatch = commandDispatcher({
    state, policy: { ...DEFAULT_POLICY, agents: { default: ["omo"] }, allowedRoots: ["/srv"] }, realpath: (p) => p, log: () => {}, publish: (body) => { client.publish("cmd.result", body); }, effects,
  });
  const client: RunnerClient = new RunnerClient({ label: "lab", hostId: "host-b" }, {
    connect: tracked.connect, outbox, state, clock: w.clock, auth, log: () => {},
    onCommand: (c) => { if (ignoreCommands) return; commands.push({ type: c.type, cmdId: (c.body as { cmdId: string }).cmdId }); dispatch(c); },
  });
  expect((await client.connectOnce()).ok).toBe(true);
  const stop = () => { tracked.latest()?.close("test"); outbox.close(); state.close(); };
  return { state, commands, stop };
};

const attemptRows = (w: World): { cmdId: string; epoch: number }[] => {
  const db = new Database(join(w.stateDir, HUB_FILE), { readonly: true });
  try { return db.query("SELECT cmdId, epoch FROM runner_attempts ORDER BY cmdId").all() as { cmdId: string; epoch: number }[]; } finally { db.close(); }
};

const registryOf = (lanes: Record<string, Partial<Lane>>) => ({ read: async (key: string) => (lanes[key] as Lane | undefined) ?? null });

test("a lane.start lost across a supervisor restart is read back: unknown to the runner and absent, it is sent again under its cmdId", async () => {
  const w = world();
  // Run 1: the start is sent and the runner never runs it (a runner that lost it, or a supervisor that died first).
  const hub1 = openHub(w);
  const lost = await connectLab(w, {}, hub1, true);
  void hub1.calls.call("lab", "lane.start", START, { cmdId: "lane-start:lane-a:1" }).catch(() => undefined);
  expect(attemptRows(w)).toEqual([{ cmdId: "lane-start:lane-a:1", epoch: 1 }]);
  lost.stop();
  hub1.close();

  // Run 2: the runner comes back with no record of it; lane.observe finds no lane of that key.
  let answered: (frame: AnyRunnerEvent) => void = () => {};
  const resentResult = new Promise<AnyRunnerEvent>((resolve) => { answered = resolve; });
  const hub2 = openHub(w, (frame) => { if (frame.type === "cmd.result" && frame.body.cmdId === "lane-start:lane-a:1") answered(frame); });
  cleanups.push(() => hub2.close());
  const lab = await connectLab(w, {
    "lane.observe": async () => { throw new Error("RUNNER_LANE_UNKNOWN lane-a"); },
    "lane.start": async () => ({ detail: "started", result: { pane: "p-1", tab: "t-1", startup: { verdict: "ok", detail: "" } } }),
  });
  cleanups.push(lab.stop);
  const logs: string[] = [];
  const emitted: string[] = [];
  await readBackRunnerStarts(hub2, registryOf({ "lane-a": { key: "lane-a", runner: "lab", launchUnconfirmed: true } }), "lab", [], (_id, line) => { emitted.push(line); }, (line) => { logs.push(line); });

  expect(logs).toEqual(["RUNNER_READBACK runner=lab cmdId=lane-start:lane-a:1 retry"]);
  expect((await resentResult).body).toMatchObject({ state: "verified" });
  expect(lab.commands.map((c) => c.type)).toEqual(["lane.observe", "lane.start"]);
  expect(lab.commands[1]?.cmdId).toBe("lane-start:lane-a:1");
  expect(emitted).toEqual([]);
  // Its result settled the record that the resend wrote under this run's epoch.
  expect(attemptRows(w)).toEqual([]);
});

test("the runner's own record decides first, ambiguity reaches the lead once, and only paneless open lanes of an earlier run are read back", async () => {
  const w = world();
  const hub1 = openHub(w);
  const first = await connectLab(w, {}, hub1);
  // The runner ran this start and recorded it; the supervisor never saw the answer.
  first.state.recordIntent({ cmdId: "lane-start:done:1", cmdSeq: 90, type: "lane.start", epoch: 1, key: "done" });
  first.state.recordResult("lane-start:done:1", "verified", "started");
  first.stop();
  for (const key of ["done", "gone", "has-pane", "closed"]) hub1.hub.recordAttempt("lab", "lane.start", `lane-start:${key}:1`, key, { ...START, key });
  hub1.close();

  const hub2 = openHub(w);
  cleanups.push(() => hub2.close());
  // A start of this run is a live call, never read back.
  hub2.hub.recordAttempt("lab", "lane.start", "lane-start:live:2", "live", { ...START, key: "live" });
  const lab = await connectLab(w, { "lane.observe": async () => { throw new Error("RUNNER_LANE_ABSENT gone pane p-9 is gone"); } });
  cleanups.push(lab.stop);
  const logs: string[] = [];
  const emitted: { id: string; line: string }[] = [];
  const registry = registryOf({
    done: { key: "done", runner: "lab" },
    gone: { key: "gone", runner: "lab" },
    "has-pane": { key: "has-pane", runner: "lab", pane: "p-2" },
    closed: { key: "closed", runner: "lab", closedAt: "2026-11-06T00:00:00Z" },
    live: { key: "live", runner: "lab" },
  });
  await readBackRunnerStarts(hub2, registry, "lab", [], (id, line) => { emitted.push({ id, line }); }, (line) => { logs.push(line); });

  expect(logs.sort()).toEqual([
    "RUNNER_READBACK runner=lab cmdId=lane-start:closed:1 settled",
    "RUNNER_READBACK runner=lab cmdId=lane-start:done:1 verified",
    "RUNNER_READBACK runner=lab cmdId=lane-start:gone:1 ambiguous",
    "RUNNER_READBACK runner=lab cmdId=lane-start:has-pane:1 settled",
  ]);
  // Nothing was started again; only the lane the runner had no record of was observed.
  expect(lab.commands).toEqual([{ type: "lane.observe", cmdId: expect.stringMatching(/^lane\.observe:gone:/) }]);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.id).toBe("operation-ambiguous:lab:lane-start:gone:1");
  expect(emitted[0]?.line).toStartWith("OPERATION_AMBIGUOUS lane-start:gone:1 lane.start gone:");
  expect(attemptRows(w)).toEqual([{ cmdId: "lane-start:live:2", epoch: 2 }]);
});

test("a lane in the runner's hello inventory counts as started without asking lane.observe", async () => {
  const w = world();
  const hub1 = openHub(w);
  (await connectLab(w, {}, hub1)).stop();
  hub1.hub.recordAttempt("lab", "lane.start", "lane-start:seen:1", "seen", { ...START, key: "seen" });
  hub1.close();
  const hub2 = openHub(w);
  cleanups.push(() => hub2.close());
  const lab = await connectLab(w, {});
  cleanups.push(lab.stop);
  const logs: string[] = [];
  await readBackRunnerStarts(hub2, registryOf({ seen: { key: "seen", runner: "lab" } }), "lab", [{ key: "seen", pane: "p-3", tab: "t-3" }], () => {}, (line) => { logs.push(line); });
  expect(logs).toEqual(["RUNNER_READBACK runner=lab cmdId=lane-start:seen:1 verified"]);
  expect(lab.commands).toEqual([]);
  expect(attemptRows(w)).toEqual([]);
});
