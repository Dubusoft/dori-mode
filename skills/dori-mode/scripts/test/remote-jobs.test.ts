import { afterEach, expect, test } from "bun:test";

import { EventSources, readSourceStatus, SourceSpecs, sourceViews, validateSpec } from "../src/event-sources.ts";
import { openOperations, type OperationStore } from "../src/operations.ts";
import { remoteRunner, remoteWaitCheck } from "../src/remote-jobs.ts";
import type { Ran, Runner } from "../src/run.ts";
import { type CallResult, type RunnerCall, RunnerUnavailable } from "../src/runner/call.ts";
import { scheduleRow, SCHEDULE_ACTION, type ScheduleSpec } from "../src/schedule.ts";
import { Waits } from "../src/waits.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const T0 = 1_800_000_000_000;
const CWD = "/srv/work";

type Sent = { readonly label: string; readonly type: string; readonly body: Record<string, unknown>; readonly timeoutMs?: number };

/** A RunnerCall whose runners in `online` answer with `answer`; any other label is RUNNER_UNAVAILABLE at once. */
const fakeCall = (answer: (type: string, body: Record<string, unknown>) => CallResult<unknown>, online: string[] = ["w1"]) => {
  const up = new Set(online);
  const sent: Sent[] = [];
  const call: RunnerCall = {
    call: async (label, type, body, opts) => {
      sent.push({ label, type, body: body as Record<string, unknown>, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      if (!up.has(label)) throw new RunnerUnavailable(label, "disconnected", `no admitted connection for ${type}`);
      return answer(type, body as Record<string, unknown>) as never;
    },
    query: async () => { throw new Error("no queries here"); },
    connected: (label) => up.has(label),
  };
  return { call, sent, up };
};

const verified = (result: unknown): CallResult<unknown> => ({ cmdId: "c1", state: "verified", detail: "ok", result });
const jobOut = (output: string, exitCode = 0) => verified({ exitCode, timedOut: false, output, err: "" });

/** A source registry on a fresh state dir; enqueue dedupes by id like the store. */
const sourcesWorld = (opts: { run?: Runner; remote?: RunnerCall; schedules?: boolean } = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const events: { id: string; line: string }[] = [];
  const seen = new Set<string>();
  let ops: OperationStore | undefined;
  if (opts.schedules) {
    ops = openOperations(depsFor(newWorld(), clock, state.dir).config);
    const store = ops;
    cleanups.push(() => { store.close(); });
  }
  const sources = new EventSources({
    stateDir: state.dir, now: clock.now, run: opts.run ?? (async () => { throw new Error("no local run expected"); }),
    enqueue: (id, line) => { if (seen.has(id)) return false; seen.add(id); events.push({ id, line }); return true; },
    ...(opts.remote ? { remote: opts.remote } : {}),
    ...(ops ? { schedules: { operations: ops, journaled: (id: string) => seen.has(id) } } : {}),
  });
  cleanups.push(() => { sources.close(); });
  return { state, clock, events, sources, specs: new SourceSpecs(state.dir), ops };
};

const poll = (extra: Record<string, unknown> = {}) => ({ name: "ci", type: "poll", kind: "BUILD_SEEN", command: ["check-ci"], everySec: 30, match: "^BUILD (\\d+)", cwd: CWD, ...extra });

test("a poll on a machine runs there and journals the ids and lines a local poll does", async () => {
  const output = "BUILD 41 ok\nnoise\nBUILD 42 failed\n";
  const local = sourcesWorld({ run: async (): Promise<Ran> => ({ code: 0, out: output, err: "" }) });
  local.specs.add(poll());
  await local.sources.tick();

  const remote = fakeCall(() => jobOut(output));
  const away = sourcesWorld({ remote: remote.call });
  away.specs.add(poll({ machine: "w1" }));
  await away.sources.tick();

  expect(local.events.length).toBe(2);
  expect(away.events).toEqual(local.events);
  expect(remote.sent).toEqual([{
    label: "w1", type: "job.run", timeoutMs: 60_000,
    body: { opKey: `poll:ci:${T0}`, name: "ci", command: ["check-ci"], cwd: CWD, timeoutSec: 30, heavy: false },
  }]);
  expect(sourceViews(away.state.dir).sources.find((s) => s.name === "ci")?.machine).toBe("w1");
});

test("an offline machine poll journals one SOURCE_FAILED naming the runner and retries every period", async () => {
  const remote = fakeCall(() => jobOut(""), []);
  const w = sourcesWorld({ remote: remote.call });
  w.specs.add(poll({ machine: "w1" }));
  await w.sources.tick();
  w.clock.at += 30_000;
  await w.sources.tick();
  expect(remote.sent.length).toBe(2);
  expect(w.events.length).toBe(1);
  expect(w.events[0]?.id).toBe(`source-failed:ci:${T0}`);
  expect(w.events[0]?.line).toContain("SOURCE_FAILED ci poll: RUNNER_UNAVAILABLE runner=w1");
  expect(readSourceStatus(w.state.dir)?.sources.ci?.failing).toBe(true);
});

const waitsWorld = (remote?: RunnerCall, maxFailures?: number) => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const waits = new Waits(state.dir, maxFailures, remote);
  const events: { id: string; line: string }[] = [];
  const emit = (id: string, line: string) => { events.push({ id, line }); };
  const noRun: Runner = async () => { throw new Error("no local run expected"); };
  return { state, clock, waits, events, emit, noRun };
};

const waitInput = { key: "release", until: "file ready", note: "tell owner", cwd: CWD };

test("a wait on a machine is checked by its runner and a met check ends it as WAIT_DONE", async () => {
  const remote = fakeCall(() => verified({ met: true }));
  const w = waitsWorld(remote.call);
  const wait = w.waits.register({ ...waitInput, machine: "w1" }, w.clock.now());
  expect(wait.machine).toBe("w1");
  expect(w.waits.register({ ...waitInput, key: "here", machine: "local" }, w.clock.now()).machine).toBeUndefined();
  expect(() => w.waits.register({ ...waitInput, key: "bad", machine: "no such" }, w.clock.now())).toThrow("--machine");
  w.waits.cancel("here");
  await w.waits.tick(w.clock.now, w.noRun, w.emit);
  expect(w.events).toEqual([{ id: `wait:${wait.id}`, line: "WAIT_DONE release tell owner" }]);
  expect(remote.sent).toEqual([{ label: "w1", type: "wait.check", timeoutMs: 30_000, body: { waitId: wait.id, signal: "file ready", cwd: CWD } }]);
  expect(w.waits.list()).toEqual([]);
});

test("an unavailable runner counts as a failed check, up to WAIT_FAILED", async () => {
  const remote = fakeCall(() => verified({ met: true }), []);
  const w = waitsWorld(remote.call, 2);
  const wait = w.waits.register({ ...waitInput, machine: "w1" }, w.clock.now());
  await w.waits.tick(w.clock.now, w.noRun, w.emit);
  expect(w.waits.list()[0]?.failures).toBe(1);
  expect(w.events).toEqual([]);
  w.clock.at += wait.everyMs;
  await w.waits.tick(w.clock.now, w.noRun, w.emit);
  expect(w.events).toEqual([{ id: `wait:${wait.id}`, line: "WAIT_FAILED release tell owner (2 checks in a row failed; no --timeout set)" }]);
});

test("settleRemote ends only an open wait of that runner", () => {
  const w = waitsWorld();
  const there = w.waits.register({ ...waitInput, machine: "w1" }, w.clock.now());
  const here = w.waits.register({ ...waitInput, key: "here" }, w.clock.now());
  w.waits.settleRemote("w2", there.id, w.emit);
  w.waits.settleRemote("w1", here.id, w.emit);
  w.waits.settleRemote("w1", "missing", w.emit);
  expect(w.events).toEqual([]);
  w.waits.settleRemote("w1", there.id, w.emit);
  w.waits.settleRemote("w1", there.id, w.emit);
  expect(w.events).toEqual([{ id: `wait:${there.id}`, line: "WAIT_DONE release tell owner" }]);
  expect(w.waits.list().map((x) => x.key)).toEqual(["here"]);
});

test("a refused cmd.result is a refusal, not a result", async () => {
  const refused = fakeCall(() => ({ cmdId: "c1", state: "failed", detail: "RUNNER_POLICY jobs deny" }));
  await expect(remoteRunner(refused.call, "w1", { opKey: "k", name: "n" })(["x"], { cwd: CWD, timeoutMs: 1 }))
    .rejects.toThrow("RUNNER_JOB_REFUSED runner=w1: failed: RUNNER_POLICY jobs deny");
  await expect(remoteRunner(refused.call, "w1", { opKey: "k", name: "n" })(["x"])).rejects.toThrow("needs cwd");
  const check = await remoteWaitCheck(refused.call, "w1")({ id: "w", until: "file ready", cwd: CWD });
  expect(check.ok).toBe(false);
  expect(check.error).toBe("RUNNER_WAIT_REFUSED runner=w1: failed: RUNNER_POLICY jobs deny");
});

test("a machine schedule waits while its runner is offline and runs once it is back", async () => {
  const remote = fakeCall(() => jobOut("all green"), []);
  const w = sourcesWorld({ remote: remote.call, schedules: true });
  w.specs.add({ name: "nightly", type: "schedule", kind: "NIGHTLY", everySec: 60, command: ["nightly"], cwd: CWD, machine: "w1", since: T0 });
  w.clock.at = T0 + 60_000;
  await w.sources.tick();
  await w.sources.settled();
  expect(remote.sent).toEqual([]);
  expect(readSourceStatus(w.state.dir)?.sources.nightly?.waiting).toBe("runner w1 offline");
  const rows = w.ops?.list({ lane: "schedule:nightly" }).filter((op) => op.action === SCHEDULE_ACTION) ?? [];
  expect(rows.map((op) => op.state)).toEqual(["planned"]);

  remote.up.add("w1");
  await w.sources.tick();
  await w.sources.settled();
  const target = rows[0]?.target ?? "";
  expect(remote.sent).toEqual([{
    label: "w1", type: "job.run", timeoutMs: 630_000,
    body: { opKey: `schedule:nightly:${target}`, name: "nightly", command: ["nightly"], cwd: CWD, timeoutSec: 600, heavy: false },
  }]);
  expect(w.events).toEqual([{ id: `schedule:nightly:${target}`, line: "NIGHTLY nightly: all green" }]);
  const status = readSourceStatus(w.state.dir)?.sources.nightly;
  expect(status?.waiting).toBeUndefined();
  expect(status?.lastResult).toBe("ok");
  const spec = new SourceSpecs(w.state.dir).list()[0] as ScheduleSpec;
  expect(scheduleRow(spec, status, w.clock.now()).machine).toBe("w1");
});

test("validation: a machine needs cwd, a command job and no heavy; local is the supervisor host", () => {
  expect(() => validateSpec(poll({ machine: "w1", cwd: undefined }))).toThrow("source ci: a poll on a machine needs cwd (a directory on that machine)");
  expect(() => validateSpec(poll({ machine: "not a label" }))).toThrow("is not a runner label");
  expect(validateSpec(poll({ machine: "local" }))).not.toHaveProperty("machine");
  const job = { name: "nightly", type: "schedule", kind: "NIGHTLY", everySec: 60, since: T0 };
  expect(() => validateSpec({ ...job, command: ["x"], cwd: CWD, heavy: true, machine: "w1" })).toThrow("heavy jobs run on the supervisor host only");
  expect(() => validateSpec({ ...job, text: "hello", machine: "w1" })).toThrow("machine is for command jobs");
  expect(() => validateSpec({ ...job, command: ["x"], machine: "w1" })).toThrow("needs cwd");
  expect(validateSpec({ ...job, command: ["x"], cwd: CWD, machine: "w1" })).toMatchObject({ machine: "w1" });
  expect(validateSpec({ ...job, text: "hello", machine: "local" })).not.toHaveProperty("machine");
});
