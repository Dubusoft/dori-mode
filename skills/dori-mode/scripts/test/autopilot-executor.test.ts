import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_AUTOPILOT, ledgerRows, type ToodoTask } from "../src/autopilot.ts";
import { type ExecutorDeps, reconcileExecutions, runExecutor } from "../src/autopilot-executor.ts";
import { type LaunchInput, SandboxRefusal } from "../src/launch.ts";
import type { PlacedLaunch } from "../src/launch-service.ts";
import type { ThreadMember } from "../src/messenger/discord.ts";
import { JsonOperations, type Observed, type Operation, type OperationStore, plan } from "../src/operations.ts";
import type { Lane } from "../src/registry.ts";
import { dequeueLaunch, enqueueLaunch, launchQueue } from "../src/routing.ts";
import type { ToodoGuideline, ToodoTaskRecord } from "../src/toodo-client.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const KEY = "ap-12-1";
const task = (over: Partial<ToodoTask> = {}): ToodoTask => ({
  id: 12, workspaceId: 7, title: "Build the feature", description: "Ship the complete feature.", status: "planned", resolution: null,
  dependsOn: [], refs: ["owner:discord:c/m", "repo:owner/repo"], criteria: [{ text: "tests pass", kind: "manual" }],
  wait: null, autopilot: true, dueDate: null, ...over,
});

let dir: string;
let store: JsonOperations;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dori-autopilot-executor-")); store = new JsonOperations(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Only the store and world survive restart. Every dependency can stop at a completed step without timers or a server. */
const harness = (initial = task()) => {
  let current = initial;
  let held = false;
  let remote = false;
  let observed: Observed = "unknown";
  let member: ThreadMember = "added";
  let startup = "STARTUP_OK";
  let admissionError: Error | undefined;
  let validationError: Error | undefined;
  let crashAfter: string | undefined;
  let crashed = false;
  let mutateOnStart = false;
  let worktreeRoot: string | undefined = "/wt/";
  const dirs: string[] = [];
  const calls = { start: 0, thread: 0, brief: 0, admit: 0, launch: 0, blocker: 0, notify: 0, reserve: 0 };
  const notes: { kind: string; body: string }[] = [];
  const lanes = new Map<string, Lane>();
  const threads = new Map<string, string>();
  const files = new Map<string, string>();
  const notices = new Map<string, string>();
  const logs: string[] = [];
  const inputs: LaunchInput[] = [];
  const placements: PlacedLaunch[] = [];
  let guidelines: ToodoGuideline[] = [];
  let dependencies: ToodoTask[] = [];
  const checkpoint = () => {
    if (!crashed && crashAfter && store.list().some((op) => op.action === `autopilot-${crashAfter}` && op.state === "verified")) {
      crashed = true;
      throw new Error(`crash after ${crashAfter}`);
    }
  };
  const record = (): ToodoTaskRecord => ({ id: current.id, status: current.status, resolution: current.resolution, refs: current.refs, notes, criteria: [] });
  const fresh = (ops: OperationStore = store): ExecutorDeps => ({
    config: { ...DEFAULT_AUTOPILOT, executor: true }, stateDir: dir, ciMergeBase: "dev", store: ops, pauseFile: join(dir, "pause.json"),
    now: () => T0, lock: async () => () => {}, out: (line) => logs.push(line), err: (line) => logs.push(line),
    toodo: () => ({
      task: async () => { checkpoint(); return current; },
      tasksByIds: async (ids) => { checkpoint(); return [current, ...dependencies].filter((t) => ids.includes(t.id)); },
      flaggedTasks: async () => { checkpoint(); calls.reserve++; return current.status === "planned" ? [current] : []; },
      guidelines: async () => { checkpoint(); return guidelines; },
    }),
    openLanes: async () => new Set(lanes.keys()),
    quota: async () => ({ readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] }),
    hosts: async () => ({ defaultMachine: "local", machines: new Map([["local", { ok: true, slots: 10 }]]), targets: new Map() }),
    writer: {
      startTask: async (_id, opts) => {
        checkpoint(); calls.start++;
        expect(ops.get(`toodo:12/autopilot-start-task/1`)?.state).toBe("attempted");
        current = { ...current, status: "in_progress", refs: [...current.refs, ...(opts?.refs ?? [])], ...(mutateOnStart ? { description: "Changed scope" } : {}) };
        return { wrote: true, task: record() };
      },
      read: async () => { checkpoint(); return record(); },
      reportBlocker: async (_id, note) => { checkpoint(); calls.blocker++; notes.push({ kind: "blocker", body: note }); return { wrote: true, task: record() }; },
    },
    parentChannel: "c",
    createThread: async (thread) => {
      checkpoint(); calls.thread++;
      expect(ops.get("toodo:12/autopilot-thread/1")?.state).toBe("attempted");
      threads.set(thread.title, "thread-12");
      return { id: "thread-12", member };
    },
    findThread: async (thread) => { checkpoint(); return threads.get(thread.title); },
    readLane: async (key) => { checkpoint(); return lanes.get(key); },
    observeLaunch: async () => { checkpoint(); return observed; },
    place: async () => {
      checkpoint();
      const target = remote ? "remote" : "local";
      return {
        target, ...(remote ? { machine: target, cwd: "/runner/declared/checkout" } : {}), lines: [],
        plan: {
          placement: { machine: target, movable: false, source: "runner", cwd: "/runner/declared/checkout" },
          check: { machine: target, verdict: { ok: !held, reasons: held ? ["no room"] : [] }, summary: "" }, lines: [],
        },
      };
    },
    validate: async () => { checkpoint(); if (validationError) throw validationError; },
    admit: async (input, placed) => {
      checkpoint(); calls.admit++; inputs.push(input); placements.push(placed);
      const row = ops.get(`toodo:12/autopilot-${placed.plan.check.verdict.ok ? "admit" : "hold"}/1`)!;
      expect(row.state).toBe("attempted");
      expect(JSON.parse(row.data!).input.key).toBe(KEY);
      expect(JSON.parse(row.data!).base).toBe("dev");
      if (!placed.plan.check.verdict.ok) {
        const queue = enqueueLaunch(dir, { ...input, mode: undefined, queuedAt: new Date(T0).toISOString(), reasons: ["no room"] });
        return { kind: "held", target: placed.target, verdict: placed.plan.check.verdict, queued: queue.length };
      }
      if (admissionError) throw admissionError;
      calls.launch++;
      const lane: Lane = { ...input, thread: input.thread!, openedAt: new Date(T0).toISOString(), pane: "pane-12" };
      lanes.set(input.key, lane);
      observed = startup === "STARTUP_OK" ? "done" : "unknown";
      dequeueLaunch(dir, input.key);
      return { kind: "launched", lane, startup: `${startup} ${input.key}`, notes: [], notices: [] };
    },
    queue: () => launchQueue(dir), dropQueued: (key) => { dequeueLaunch(dir, key); },
    writeBrief: async (path, brief) => { checkpoint(); calls.brief++; files.set(path, brief); },
    worktreeRoot: (label) => { expect(label).toBe("local"); return worktreeRoot; },
    makeLaneDir: async (path) => { checkpoint(); dirs.push(path); },
    readBrief: async (path) => { checkpoint(); return files.get(path); },
    notify: (id, line) => { checkpoint(); calls.notify++; notices.set(id, line); },
  });
  return {
    fresh, calls, lanes, threads, files, notices, notes, logs, inputs, placements, dirs,
    worktreeRoot: (value: string | undefined) => { worktreeRoot = value; },
    task: (patch: Partial<ToodoTask>) => { current = { ...current, ...patch }; },
    held: (value: boolean) => { held = value; }, remote: () => { remote = true; }, member: (value: ThreadMember) => { member = value; },
    observe: (value: Observed) => { observed = value; }, startup: (value: string) => { startup = value; },
    failAdmission: (error: Error) => { admissionError = error; }, failValidation: () => { validationError = new Error("checkout is shared"); },
    crashAfter: (step: string) => { crashAfter = step; }, crashed: () => crashed,
    changeOnStart: () => { mutateOnStart = true; }, guidelines: (value: ToodoGuideline[]) => { guidelines = value; },
    dependencies: (value: ToodoTask[]) => { dependencies = value; },
  };
};

const row = (action: string): Operation => store.get(`toodo:12/autopilot-${action}/1`)!;
const freshStore = () => new JsonOperations(dir);

test("ready contract reserves, starts, threads, writes, launches and settles exactly once", async () => {
  const h = harness(task({ refs: [...task().refs, "mode:mass-ulw", "model:test-model"] }));
  expect(await runExecutor(h.fresh(), [12])).toEqual([{ taskId: 12, laneKey: KEY, kind: "launched" }]);
  expect(h.calls).toEqual({ start: 1, thread: 1, brief: 1, admit: 1, launch: 1, blocker: 0, notify: 1, reserve: 1 });
  expect(h.inputs[0]).toMatchObject({ key: KEY, done: "pr owner/repo autopilot/12", mode: "mass-ulw", model: "test-model", task: 12, thread: "discord:c/thread-12" });
  expect(h.inputs[0]!.cwd).toBe(`/wt/repo-${KEY}`);
  expect(h.inputs[0]!.cwd!.startsWith(dir)).toBe(false);
  expect(h.dirs).toEqual([`/wt/repo-${KEY}`]);
  expect([...h.files.keys()][0]).toBe(join(dir, "autopilot", KEY, "brief.md"));
  expect([...h.files.values()][0]).toContain("origin/dev");
  expect(ledgerRows(store)[0]?.state).toBe("verified");
  for (const action of ["prepare", "reserve", "start-task", "thread", "brief", "admit", "settle", "notice", "execute"]) expect(row(action).state).toBe("verified");
  expect(JSON.parse(row("execute").data!).thread).toMatchObject({ parent: "c", title: `${KEY}: Build the feature`, id: "thread-12" });
  await runExecutor(h.fresh(freshStore()), [12]);
  await reconcileExecutions(h.fresh(freshStore()));
  expect(h.calls.admit).toBe(1);
  expect(h.calls.notify).toBe(1);
});

test("review contract has no reservations, writes, threads, or admission", async () => {
  const h = harness(task({ refs: ["owner:discord:c/m"] }));
  expect(await runExecutor(h.fresh(), [12])).toEqual([{ taskId: 12, kind: "review", reasons: ["repo-missing"] }]);
  expect(store.list()).toEqual([]);
  expect(Object.values(h.calls).every((n) => n === 0)).toBe(true);
  expect(h.logs[0]).toContain("repo-missing");
});

test("base mismatch refuses before reserving or starting", async () => {
  const h = harness();
  expect(await runExecutor({ ...h.fresh(), ciMergeBase: "main" }, [12])).toEqual([{ taskId: 12, kind: "review", reasons: ["merge-base-mismatch"] }]);
  expect(store.list()).toEqual([]);
  expect(h.calls.start).toBe(0);
});

test("remote placement drops its declared checkout and lets the runner create its per-key cwd", async () => {
  const h = harness(); h.remote();
  await runExecutor(h.fresh(), [12]);
  expect(h.inputs[0]!.machine).toBe("remote");
  expect(h.inputs[0]!.cwd).toBeUndefined();
  expect(h.placements[0]!.cwd).toBeUndefined();
  expect(JSON.parse(row("admit").data!).input.cwd).toBeUndefined();
});

test("local placement without a known worktree root goes to review before any lane directory or admission", async () => {
  const h = harness(); h.worktreeRoot(undefined);
  expect((await runExecutor(h.fresh(), [12]))[0]).toMatchObject({ kind: "review", reasons: ["worktree-root-missing"] });
  expect([h.calls.admit, h.dirs.length]).toEqual([0, 0]);
  expect(ledgerRows(store)[0]?.state).toBe("failed");
});

test("HOLD keeps its queue and reservation, then resumes under the same lane key", async () => {
  const h = harness(); h.held(true);
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("held");
  expect(launchQueue(dir).map((q) => q.key)).toEqual([KEY]);
  expect(ledgerRows(store)[0]?.state).toBe("planned");
  expect(row("admit")).toBeUndefined();
  await reconcileExecutions(h.fresh(freshStore()));
  expect(h.calls.admit).toBe(1);
  h.held(false);
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("launched");
  expect(h.inputs.map((input) => input.key)).toEqual([KEY, KEY]);
  expect(h.calls.launch).toBe(1);
  expect([h.calls.start, h.calls.thread, h.calls.brief, h.calls.reserve]).toEqual([1, 1, 1, 1]);
  expect(launchQueue(dir)).toEqual([]);
  expect(ledgerRows(store)).toHaveLength(1);
});

test("binding admission HOLD after a successful placement stays held and resumes instead of failing", async () => {
  const h = harness(), deps = h.fresh();
  const result = await runExecutor({
    ...deps, admit: async (input, placed) => {
      expect(placed.plan.check.verdict.ok).toBe(true);
      const verdict = { ok: false, reasons: ["review reserve 1 on machine local: author slots 0"] };
      const queue = enqueueLaunch(dir, { ...input, mode: undefined, queuedAt: new Date(T0).toISOString(), reasons: verdict.reasons });
      return { kind: "held", target: placed.target, verdict, queued: queue.length };
    },
  }, [12]);
  expect(result).toEqual([{ taskId: 12, laneKey: KEY, kind: "held" }]);
  expect(ledgerRows(store)[0]?.state).toBe("planned");
  expect(row("execute").state).toBe("planned");
  expect(h.calls.blocker).toBe(0);
  expect(h.notices.size).toBe(0);
  // A restart after the queue write but before the operation result also retains the HOLD outcome.
  store.put({ ...row("admit"), state: "attempted" });
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("launched");
  expect(launchQueue(dir)).toEqual([]);
  expect(h.calls.launch).toBe(1);
  expect(h.calls.blocker).toBe(0);
});

test("a held key launched by hand is never admitted again", async () => {
  const h = harness(); h.held(true);
  await runExecutor(h.fresh(), [12]);
  h.lanes.set(KEY, { key: KEY, title: "t", brief: "b", thread: "discord:c/x", openedAt: new Date(T0).toISOString() } as Lane);
  dequeueLaunch(dir, KEY); h.held(false);
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("ambiguous");
  expect([h.calls.admit, h.calls.launch, h.calls.notify]).toEqual([1, 0, 1]);
});

test("a held key dropped by hand goes to review and is not admitted", async () => {
  const dropped = harness(); dropped.held(true);
  await runExecutor(dropped.fresh(), [12]);
  dequeueLaunch(dir, KEY); dropped.held(false);
  expect((await reconcileExecutions(dropped.fresh(freshStore())))[0]).toMatchObject({ kind: "review", reasons: ["hold-dropped"] });
  expect(dropped.calls.admit).toBe(1);
  expect(ledgerRows(store)[0]?.state).toBe("failed");
});

test("pause stops new executions and prevents a held launch from draining", async () => {
  const h = harness();
  writeFileSync(join(dir, "pause.json"), "{}");
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("paused");
  expect(store.list()).toEqual([]);
  rmSync(join(dir, "pause.json"));
  h.held(true); await runExecutor(h.fresh(), [12]);
  h.held(false); writeFileSync(join(dir, "pause.json"), "{}");
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("paused");
  expect(h.calls.launch).toBe(0);
  expect(launchQueue(dir)[0]?.key).toBe(KEY);
});

test("scope or guideline changes while held require review and remove the queued launch", async () => {
  const h = harness(); h.held(true);
  await runExecutor(h.fresh(), [12]);
  h.task({ description: "A different feature" }); h.held(false);
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]).toMatchObject({ kind: "review", reasons: ["contract-changed"] });
  expect(h.calls.launch).toBe(0);
  expect(ledgerRows(store)[0]?.state).toBe("failed");
  expect(launchQueue(dir)).toEqual([]);
});

test("guideline changes and a changed merge gate are checked again before HOLD drains", async () => {
  const h = harness(); h.held(true);
  await runExecutor(h.fresh(), [12]);
  h.guidelines([{ id: 1, workspaceId: 7, kind: "rule", body: "New rule", updatedAt: 1 }]);
  h.held(false);
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]).toMatchObject({ kind: "review", reasons: ["contract-changed"] });
  expect(h.calls.launch).toBe(0);
});

test("scope changing during start-task stops before thread creation", async () => {
  const h = harness(); h.changeOnStart();
  expect((await runExecutor(h.fresh(), [12]))[0]).toMatchObject({ kind: "review", reasons: ["contract-changed"] });
  expect([h.calls.start, h.calls.thread, h.calls.admit]).toEqual([1, 0, 0]);
});

test("a dependency re-read refuses an open prerequisite", async () => {
  const h = harness(task({ dependsOn: [3] }));
  h.dependencies([task({ id: 3, status: "in_progress" })]);
  expect((await runExecutor(h.fresh(), [12]))[0]).toMatchObject({ kind: "review", reasons: ["prerequisite-open:3"] });
  expect(h.calls.start).toBe(0);
});

test("failed member addition is partial success and never creates another thread", async () => {
  const h = harness(); h.member({ failed: "403" });
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("launched");
  await reconcileExecutions(h.fresh(freshStore()));
  expect(h.calls.thread).toBe(1);
  expect(JSON.parse(row("execute").data!).thread.member).toEqual({ failed: "403" });
});

for (const boundary of ["prepare", "reserve", "start-task", "thread", "brief", "admit", "settle"]) {
  test(`crash after ${boundary}: fresh executor resumes each effect once`, async () => {
    const h = harness(); h.crashAfter(boundary);
    await runExecutor(h.fresh(), [12]).catch((e: Error) => { expect(e.message).toBe(`crash after ${boundary}`); });
    expect(h.crashed()).toBe(true);
    expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("launched");
    expect([h.calls.start, h.calls.thread, h.calls.brief, h.calls.admit, h.calls.launch, h.calls.notify]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(ledgerRows(store)).toHaveLength(1);
    expect(row("execute").state).toBe("verified");
  });
}

test("attempted launch with unknown read-back becomes ambiguous and never admits again", async () => {
  const h = harness(); h.held(true);
  await runExecutor(h.fresh(), [12]);
  const data = JSON.parse(row("execute").data!);
  const attempted = plan(store, T0, { lane: "toodo:12", action: "autopilot-admit", target: "1", data: JSON.stringify({ input: data.input, base: "dev" }) });
  store.put({ ...attempted, state: "attempted", attempts: 1 });
  h.held(false);
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("ambiguous");
  await reconcileExecutions(h.fresh(freshStore()));
  await runExecutor(h.fresh(), [12]);
  expect(h.calls.admit).toBe(1); // Only the earlier HOLD admission.
  expect(h.calls.launch).toBe(0);
  expect(h.calls.notify).toBe(1);
  expect(ledgerRows(store)[0]?.state).toBe("ambiguous");
});

test("attempted launch with confirmed startup reconciles without another admission", async () => {
  const h = harness(); h.held(true);
  await runExecutor(h.fresh(), [12]);
  const attempted = plan(store, T0, { lane: "toodo:12", action: "autopilot-admit", target: "1", data: row("hold").data });
  store.put({ ...attempted, state: "attempted", attempts: 1 });
  h.observe("done");
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("launched");
  expect(h.calls.admit).toBe(1);
  expect(ledgerRows(store)[0]?.state).toBe("verified");
});

test("positive proof an attempted launch never started fails with one blocker, without retry", async () => {
  const h = harness(); h.held(true);
  await runExecutor(h.fresh(), [12]);
  const attempted = plan(store, T0, { lane: "toodo:12", action: "autopilot-admit", target: "1", data: row("hold").data });
  store.put({ ...attempted, state: "attempted", attempts: 1 });
  h.observe("not-done");
  expect((await reconcileExecutions(h.fresh(freshStore())))[0]?.kind).toBe("failed");
  await reconcileExecutions(h.fresh(freshStore()));
  expect([h.calls.admit, h.calls.blocker, h.calls.notify]).toEqual([1, 1, 1]);
  expect(h.notes[0]?.kind).toBe("blocker");
  expect(launchQueue(dir)).toEqual([]);
});

test("a sandbox refusal proves no startup and records a blocker; uncertain startup stays ambiguous", async () => {
  const h = harness(); h.failAdmission(new SandboxRefusal("SANDBOX_MISSING", KEY, "not installed"));
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("failed");
  expect(h.calls.blocker).toBe(1);
  expect(ledgerRows(store)[0]?.state).toBe("failed");
});

test("a registered pane without STARTUP_OK is not a verified launch", async () => {
  const h = harness(); h.startup("STARTUP_UNCONFIRMED");
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("ambiguous");
  expect(h.lanes.has(KEY)).toBe(true);
  await reconcileExecutions(h.fresh(freshStore()));
  expect(h.calls.admit).toBe(1);
});

test("validation refusal fails before admission and records a blocker", async () => {
  const h = harness(); h.failValidation();
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("failed");
  expect([h.calls.admit, h.calls.blocker]).toEqual([0, 1]);
});

test("default-off switch stops new and resumed executions", async () => {
  const h = harness();
  expect(await runExecutor({ ...h.fresh(), config: DEFAULT_AUTOPILOT }, [12])).toEqual([{ taskId: 12, kind: "disabled" }]);
  expect(store.list()).toEqual([]);
  h.held(true); await runExecutor(h.fresh(), [12]);
  expect((await reconcileExecutions({ ...h.fresh(freshStore()), config: DEFAULT_AUTOPILOT }))[0]?.kind).toBe("disabled");
  expect(h.calls.launch).toBe(0);
});

test("a CLI reservation is never adopted by the executor", async () => {
  const h = harness();
  plan(store, T0, { lane: "toodo:12", action: "autopilot-launch", target: "1", data: JSON.stringify({ laneKey: KEY }) });
  expect((await runExecutor(h.fresh(), [12]))[0]?.kind).toBe("refused");
  expect(h.calls.start).toBe(0);
});
