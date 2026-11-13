import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { autopilotLaneKey, LAUNCH_ACTION, ledgerRows } from "./autopilot.ts";
import { type AutopilotDeps, EXECUTE_ACTION as EXECUTE, liveJudgeDeps, readPause, reserveAutopilot } from "./autopilot-cli.ts";
import { type AutopilotContract, planTask } from "./autopilot-plan.ts";
import { resolveCredential } from "./credentials.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaunchInput, SandboxRefusal, validateLaunch } from "./launch.ts";
import { admitLaunch, type LaunchOutcome, placeLaunch, type PlacedLaunch } from "./launch-service.ts";
import { Discord, type ThreadMember } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { type Observed, type Operation, type OperationSpec, type OperationStore, perform, plan, reconcile, settleOperation } from "./operations.ts";
import type { Lane } from "./registry.ts";
import { dequeueLaunch, launchQueue, type QueuedLaunch } from "./routing.ts";
import { ensureRunnerSubdir } from "./runner/fs-safety.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";
import { laneEventsAfter } from "./runner/lanes-hub.ts";
import { machineRunner } from "./lane-ops.ts";
import { writeFileAtomic } from "./setup.ts";
import { acquireStateLock } from "./state-lock.ts";
import { ToodoClient, ToodoWriter } from "./toodo-client.ts";

/**
 * Durable autopilot executions, one sequence and stable step ids per reserved lane key. Receipts live on the sequence
 * row before a step is verified; an interrupted effect is read back, never guessed. An attempted launch is never sent
 * again, even when a later read proves absence: absence fails this attempt, uncertainty asks the lead once.
 *
 * HOLD admission has its own row and leaves the launch planned. A queued key is drained only by that same execution,
 * after checking pause and the contract again. Queue presence never proves an attempted launch did not happen.
 *
 * Remote placement deliberately drops the runner's declared checkout: launchLane without cwd lets the runner create
 * its own lanes/<key> directory, and the standard footer creates the worktree under that runner's reported root.
 * Local lanes cannot omit cwd (launchLane falls back to leadCwd) and cannot start under stateDir (the lane sandbox
 * hides it), so they start in an empty <local worktree root>/<repo name>-<key>, the exact path the footer tells the lane
 * to create its worktree at (git accepts an existing empty directory). The runner refuses a missing explicit cwd, so
 * the directory is created first (parents recursively, then the leaf by ensureRunnerSubdir: idempotent, refuses a
 * symlink). No known root is review, never a launch.
 * The brief stays under stateDir: only the lead reads it; the runner writes the lane's own copy from briefText.
 */

type Terminal = "launched" | "review" | "failed" | "ambiguous";

/** An execution's current result. Held and paused executions retain their original reservation. */
export type ExecutorResult = {
  readonly taskId: number;
  readonly laneKey?: string;
  readonly kind: Terminal | "held" | "paused" | "disabled" | "refused";
  readonly reasons?: readonly string[];
};

/** Thread identity recorded before creating it; a returned id is durable even when adding the owner failed. */
export type ExecutorThread = { readonly parent: string; readonly title: string; readonly id?: string; readonly member?: ThreadMember };

/** All world reads and effects are injected. notify must durably deduplicate its stable id (the supervisor journal). */
export type ExecutorDeps = Omit<AutopilotDeps, "toodo"> & {
  readonly stateDir: string;
  readonly ciMergeBase: string;
  readonly toodo: () => Pick<ToodoClient, "task" | "tasksByIds" | "flaggedTasks" | "guidelines">;
  readonly writer: Pick<ToodoWriter, "startTask" | "read" | "reportBlocker">;
  readonly parentChannel: string;
  readonly createThread: (thread: ExecutorThread) => Promise<{ readonly id: string; readonly member: ThreadMember }>;
  /** Find a thread after a lost create reply. Undefined means unknown, never permission to create it again. */
  readonly findThread: (thread: ExecutorThread) => Promise<string | undefined>;
  readonly readLane: (key: string) => Promise<Lane | null | undefined>;
  /** done requires STARTUP_OK evidence; not-done requires positive evidence nothing started, not registry absence. */
  readonly observeLaunch: (input: LaunchInput) => Promise<Observed>;
  readonly place: (input: LaunchInput) => Promise<PlacedLaunch>;
  readonly validate: (input: LaunchInput) => Promise<void>;
  readonly admit: (input: LaunchInput, placed: PlacedLaunch) => Promise<LaunchOutcome>;
  readonly queue: () => readonly QueuedLaunch[];
  readonly dropQueued: (key: string) => void;
  readonly writeBrief: (path: string, brief: string) => Promise<void>;
  /** Runner `label`'s reported worktree root (runner/hub.ts runnerWorktreeRoot); undefined for the local runner refuses local placement. */
  readonly worktreeRoot: (label: string) => string | undefined;
  /** Creates the empty local lane directory and its parents; an existing directory is fine. */
  readonly makeLaneDir: (path: string) => Promise<void>;
  readonly readBrief: (path: string) => Promise<string | undefined>;
  readonly notify: (id: string, line: string) => void;
};

type Execution = {
  readonly taskId: number;
  readonly laneKey: string;
  readonly title: string;
  readonly contract: AutopilotContract;
  readonly brief: string;
  readonly thread: ExecutorThread;
  readonly input?: LaunchInput;
  readonly placed?: PlacedLaunch;
  readonly startup?: string;
  readonly notStarted?: boolean;
  readonly notified?: boolean;
  readonly outcome?: Terminal;
  readonly reasons?: readonly string[];
};

const dataOf = (row: Operation): Execution => JSON.parse(row.data!) as Execution;
const step = (row: Operation, name: string, data: unknown): OperationSpec =>
  ({ lane: row.lane, action: `autopilot-${name}`, target: row.target, data: JSON.stringify(data) });
const stepId = (row: Operation, name: string): string => `${row.lane}/autopilot-${name}/${row.target}`;
const resultOf = (data: Execution, kind: ExecutorResult["kind"]): ExecutorResult =>
  ({ taskId: data.taskId, laneKey: data.laneKey, kind, ...(data.reasons ? { reasons: data.reasons } : {}) });
const save = (deps: ExecutorDeps, row: Operation, patch: Partial<Execution>): Execution => {
  const current = deps.store.get(row.id)!;
  const data = { ...dataOf(current), ...patch };
  deps.store.put({ ...current, data: JSON.stringify(data), updatedAt: deps.now() });
  return data;
};

const prepare = async (deps: ExecutorDeps, taskId: number) => {
  const reader = deps.toodo();
  const task = await reader.task(taskId);
  if (!task) return { kind: "review" as const, reasons: ["task-missing"] };
  const [tasks, guidelines] = await Promise.all([reader.tasksByIds(task.dependsOn), reader.guidelines(task.workspaceId)]);
  const planned = planTask({ task, tasks: new Map(tasks.map((t) => [t.id, t])), guidelines, config: deps.config });
  if (planned.kind === "review") return planned;
  const reasons: string[] = [];
  if (!deps.parentChannel) reasons.push("thread-channel-missing");
  if (planned.contract.base !== deps.ciMergeBase) reasons.push("merge-base-mismatch");
  if (!task.autopilot) reasons.push("not-flagged");
  if (!task.refs.some((ref) => /^owner:\S+$/.test(ref))) reasons.push("owner-ref-missing");
  if (!task.criteria.length) reasons.push("criteria-missing");
  if (task.wait) reasons.push("waiting");
  for (const id of task.dependsOn) {
    const dep = tasks.find((t) => t.id === id);
    if (!dep || dep.workspaceId !== task.workspaceId || dep.status !== "done" || !["merged", "completed"].includes(dep.resolution ?? "")) reasons.push(`prerequisite-open:${id}`);
  }
  return reasons.length ? { kind: "review" as const, reasons } : { ...planned, task };
};

/** Finish the ledger and its follow-up before closing the sequence; a crash resumes any unfinished follow-up. */
const finish = async (deps: ExecutorDeps, row: Operation): Promise<ExecutorResult> => {
  const data = dataOf(deps.store.get(row.id)!);
  const outcome = data.outcome!;
  const state = outcome === "launched" ? "verified" : outcome === "ambiguous" ? "ambiguous" : "failed";
  const reservationId = `${row.lane}/${LAUNCH_ACTION}/${row.target}`;
  const detail = data.reasons?.join(", ") ?? outcome;
  const settled = await perform(deps.store, deps.now, step(row, "settle", { laneKey: data.laneKey, reservationId, state, base: data.contract.base }),
    async () => {
      settleOperation(deps.store, deps.now(), reservationId, state, detail);
      return { ok: true, detail };
    },
    async () => !deps.store.get(reservationId) || deps.store.get(reservationId)?.state === state ? "done" : "not-done");
  if (settled.op.state !== "verified") return resultOf(data, "ambiguous");
  if (outcome === "review" || outcome === "failed") {
    const dropped = await perform(deps.store, deps.now, step(row, "drop-held", { laneKey: data.laneKey }),
      async () => { deps.dropQueued(data.laneKey); return { ok: true, detail: "removed held launch" }; },
      async () => deps.queue().some((q) => q.key === data.laneKey) ? "not-done" : "done");
    if (dropped.op.state !== "verified") return resultOf(data, outcome);
  }
  if (outcome === "failed") {
    const note = `Autopilot ${data.laneKey} did not start: ${detail}`;
    const blocked = await perform(deps.store, deps.now, step(row, "blocker", { taskId: data.taskId, note }),
      async () => { await deps.writer.reportBlocker(data.taskId, note); return { ok: true, detail: note }; },
      async () => (await deps.writer.read(data.taskId)).notes.some((n) => n.kind === "blocker" && n.body === note) ? "done" : "not-done");
    if (blocked.op.state !== "verified") return resultOf(data, outcome);
  }
  const notice = step(row, "notice", { laneKey: data.laneKey, outcome, detail });
  // The journal enqueue is idempotent by id. A lost receipt may enqueue the same id, never a second notification.
  const id = stepId(row, "notice");
  const notified = await perform(deps.store, deps.now, notice, async () => {
    deps.notify(id, `AUTOPILOT_EXECUTOR_${outcome.toUpperCase()} #${data.taskId} lane=${data.laneKey} ${detail}`);
    save(deps, row, { notified: true });
    return { ok: true, detail: "journaled" };
  }, async () => dataOf(deps.store.get(row.id)!).notified ? "done" : "not-done");
  if (notified.op.state !== "verified") return resultOf(data, outcome);
  settleOperation(deps.store, deps.now(), row.id, state, detail);
  return resultOf(data, outcome);
};

const stop = (deps: ExecutorDeps, row: Operation, outcome: Terminal, reasons?: readonly string[]): Promise<ExecutorResult> => {
  save(deps, row, { outcome, reasons });
  return finish(deps, row);
};

const currentContract = async (deps: ExecutorDeps, row: Operation): Promise<readonly string[]> => {
  const data = dataOf(deps.store.get(row.id)!);
  const fresh = await prepare(deps, data.taskId);
  if (fresh.kind === "review") return fresh.reasons;
  if (fresh.contract.version !== data.contract.version || fresh.contract.base !== data.contract.base
    || fresh.contract.guidelines.hash !== data.contract.guidelines.hash) return ["contract-changed"];
  if (fresh.task.status !== "planned" && !(fresh.task.status === "in_progress" && fresh.task.refs.includes(`lane:${data.laneKey}`))) return ["task-state-changed"];
  return [];
};

const launchReadback = async (deps: ExecutorDeps, row: Operation): Promise<Observed> => {
  const data = dataOf(deps.store.get(row.id)!);
  if (data.notStarted) return "not-done";
  if (data.startup?.startsWith("STARTUP_OK") && await deps.readLane(data.laneKey)) return "done";
  return deps.observeLaunch(data.input!);
};

const resume = async (deps: ExecutorDeps, row: Operation): Promise<ExecutorResult> => {
  let data = dataOf(deps.store.get(row.id)!);
  if (data.outcome) return finish(deps, row);
  // Read back an attempted launch before pause or scope checks: its effect may already exist.
  const priorLaunch = deps.store.get(stepId(row, "admit"));
  if (priorLaunch && priorLaunch.state !== "planned") {
    const reconciled = await reconcile(deps.store, deps.now, priorLaunch, () => launchReadback(deps, row));
    return stop(deps, row, reconciled.state === "verified" ? "launched" : reconciled.state === "planned" || reconciled.state === "failed" ? "failed" : "ambiguous",
      reconciled.state === "verified" ? undefined : [reconciled.detail]);
  }
  if (readPause(deps.pauseFile)) return resultOf(data, "paused");
  const changed = await currentContract(deps, row);
  if (changed.length) return stop(deps, row, "review", changed);
  await perform(deps.store, deps.now, step(row, "prepare", { taskId: data.taskId, laneKey: data.laneKey, version: data.contract.version, base: data.contract.base }),
    async () => ({ ok: true, detail: "contract prepared" }), async () => "done");

  const reserved = await perform(deps.store, deps.now, step(row, "reserve", { taskId: data.taskId, laneKey: data.laneKey, version: data.contract.version, base: data.contract.base }),
    async () => ({ ok: (await reserveAutopilot(deps, data.taskId)) === 0, detail: "reserve judged" }),
    async () => deps.store.get(`${row.lane}/${LAUNCH_ACTION}/${row.target}`) ? "done" : "not-done");
  if (reserved.op.state !== "verified") {
    if (reserved.op.state === "ambiguous") return stop(deps, row, "ambiguous", [reserved.op.detail]);
    return resultOf(data, "refused");
  }
  const afterReservation = await currentContract(deps, row);
  if (afterReservation.length) return stop(deps, row, "review", afterReservation);
  const started = await perform(deps.store, deps.now, step(row, "start-task", { taskId: data.taskId, refs: [`lane:${data.laneKey}`] }),
    async () => { await deps.writer.startTask(data.taskId, { reason: `Autopilot ${data.laneKey}`, refs: [`lane:${data.laneKey}`] }); return { ok: true, detail: "started task" }; },
    async () => {
      const task = await deps.toodo().task(data.taskId);
      return task?.refs.includes(`lane:${data.laneKey}`) && task.status !== "planned" ? "done" : "not-done";
    });
  if (started.op.state !== "verified") {
    if (started.op.state === "ambiguous") return stop(deps, row, "ambiguous", [started.op.detail]);
    return resultOf(data, "held");
  }
  const beforeThread = await currentContract(deps, row);
  if (beforeThread.length) return stop(deps, row, "review", beforeThread);
  if (readPause(deps.pauseFile)) return resultOf(data, "paused");
  const threaded = await perform(deps.store, deps.now, step(row, "thread", data.thread),
    async () => {
      const created = await deps.createThread(data.thread);
      save(deps, row, { thread: { ...data.thread, ...created } });
      return { ok: true, detail: typeof created.member === "object" ? `thread exists; owner add failed: ${created.member.failed}` : "created thread" };
    },
    async () => {
      const thread = dataOf(deps.store.get(row.id)!).thread;
      if (thread.id) return "done";
      const id = await deps.findThread(thread);
      if (!id) return "unknown";
      save(deps, row, { thread: { ...thread, id } });
      return "done";
    });
  if (threaded.op.state !== "verified") return stop(deps, row, "ambiguous", [threaded.op.detail]);
  data = dataOf(deps.store.get(row.id)!);
  const beforeBrief = await currentContract(deps, row);
  if (beforeBrief.length) return stop(deps, row, "review", beforeBrief);
  const input: LaunchInput = data.input ?? {
    key: data.laneKey, title: data.title, brief: join(deps.stateDir, "autopilot", data.laneKey, "brief.md"),
    done: data.contract.done, mode: data.contract.mode, ...(data.contract.model ? { model: data.contract.model } : {}),
    task: data.taskId, thread: `discord:${data.thread.parent}/${data.thread.id}`,
  };
  const written = await perform(deps.store, deps.now, step(row, "brief", { path: input.brief, base: data.contract.base, version: data.contract.version }),
    async () => { await deps.writeBrief(input.brief, data.brief); return { ok: true, detail: "brief written" }; },
    async () => (await deps.readBrief(input.brief))?.startsWith(data.brief.trimEnd()) ? "done" : "not-done");
  if (written.op.state !== "verified") return resultOf(data, "held");

  const beforeLaunch = await currentContract(deps, row);
  if (beforeLaunch.length) return stop(deps, row, "review", beforeLaunch);
  if (readPause(deps.pauseFile)) return resultOf(data, "paused");
  if (deps.store.get(stepId(row, "hold"))?.state === "verified") {
    // A held key left the queue without this execution: a manual launch is never repeated, a manual drop is the lead's call.
    if (await deps.readLane(data.laneKey)) return stop(deps, row, "ambiguous", ["held launch started outside the executor"]);
    if (!deps.queue().some((q) => q.key === data.laneKey)) return stop(deps, row, "review", ["hold-dropped"]);
  }
  const placement = await deps.place({ ...input, cwd: undefined });
  let localCwd: string | undefined;
  if (!placement.machine) {
    const root = deps.worktreeRoot(machineRunner(undefined))?.replace(/\/+$/, "");
    if (!root) return stop(deps, row, "review", ["worktree-root-missing"]);
    localCwd = join(root, `${data.contract.repo.split("/").pop()}-${data.laneKey}`);
  }
  const placed = { ...placement, cwd: localCwd };
  const launch = { ...input, machine: placed.machine, cwd: placed.cwd };
  data = save(deps, row, { input: launch, placed });
  if (localCwd) {
    try { await deps.makeLaneDir(localCwd); } catch (e) {
      return stop(deps, row, "review", [`local-cwd-unusable: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  try { await deps.validate(launch); } catch (e) {
    return stop(deps, row, "failed", [e instanceof Error ? e.message : String(e)]);
  }
  if (!placed.plan.check.verdict.ok) {
    const held = await perform(deps.store, deps.now, step(row, "hold", { input: launch, placed, base: data.contract.base }),
      async () => ({ ok: (await deps.admit(launch, placed)).kind === "held", detail: "queued" }),
      async () => deps.queue().some((q) => q.key === data.laneKey) ? "done" : "not-done");
    return held.op.state === "ambiguous" ? stop(deps, row, "ambiguous", [held.op.detail]) : resultOf(data, "held");
  }
  const admitted = await perform(deps.store, deps.now, step(row, "admit", { input: launch, placed, base: data.contract.base }),
    async () => {
      try {
        const result = await deps.admit(launch, placed);
        if (result.kind === "launched") save(deps, row, { startup: result.startup });
        return { ok: result.kind === "launched" && result.startup.startsWith("STARTUP_OK"), detail: result.kind === "held" ? "unexpected HOLD" : result.startup };
      } catch (e) {
        if (e instanceof SandboxRefusal) save(deps, row, { notStarted: true });
        throw e;
      }
    }, () => launchReadback(deps, row));
  return stop(deps, row, admitted.op.state === "verified" ? "launched" : admitted.op.state === "failed" ? "failed" : "ambiguous",
    admitted.op.state === "verified" ? undefined : [admitted.op.detail]);
};

/** Execute LAUNCH candidates serially under the same lock as the CLI. Existing executions resume their original key. */
export const runExecutor = async (deps: ExecutorDeps, taskIds: readonly number[]): Promise<ExecutorResult[]> => {
  const results: ExecutorResult[] = [];
  for (const taskId of new Set(taskIds)) {
    if (!deps.config.executor) { results.push({ taskId, kind: "disabled" }); continue; }
    const release = await deps.lock();
    try {
      const existing = deps.store.list({ lane: `toodo:${taskId}` }).find((op) => op.action === EXECUTE);
      if (existing) {
        results.push(["planned", "attempted"].includes(existing.state) ? await resume(deps, existing) : resultOf(dataOf(existing), dataOf(existing).outcome!));
        continue;
      }
      if (readPause(deps.pauseFile)) { results.push({ taskId, kind: "paused" }); continue; }
      if (ledgerRows(deps.store).some((op) => op.lane === `toodo:${taskId}`)) { results.push({ taskId, kind: "refused" }); continue; }
      const ready = await prepare(deps, taskId);
      if (ready.kind === "review") {
        deps.out(`AUTOPILOT_EXECUTOR_REVIEW #${taskId} ${ready.reasons.join(", ")}`);
        results.push({ taskId, kind: "review", reasons: ready.reasons });
        continue;
      }
      const attempt = 1;
      const laneKey = autopilotLaneKey(taskId, attempt);
      const data: Execution = {
        taskId, laneKey, title: ready.task.title, contract: ready.contract, brief: ready.brief,
        thread: { parent: deps.parentChannel, title: `${laneKey}: ${ready.task.title}`.slice(0, 100) },
      };
      const row = plan(deps.store, deps.now(), { lane: `toodo:${taskId}`, action: EXECUTE, target: String(attempt), data: JSON.stringify(data) });
      results.push(await resume(deps, row));
    } finally { release(); }
  }
  return results;
};

/** At startup and each tick, resume open sequences (including HOLD); settled or ambiguous launches never relaunch. */
export const reconcileExecutions = (deps: ExecutorDeps): Promise<ExecutorResult[]> =>
  runExecutor(deps, deps.store.list({ states: ["planned", "attempted"] }).filter((op) => op.action === EXECUTE).map((op) => dataOf(op).taskId));

/**
 * Live dependencies over FlowDeps and a caller-owned operation store. notify enqueues a stable supervisor event id;
 * log receives admission and reservation lines. No credentials or remote calls are needed until an execution runs.
 */
export const liveExecutorDeps = (
  flow: FlowDeps, store: OperationStore, notify: ExecutorDeps["notify"], log: (line: string) => void = console.log,
): ExecutorDeps => {
  let discord: Discord | undefined;
  const transport = (): Discord => {
    const token = resolveCredential("DORI_DISCORD_TOKEN");
    if (!token) throw new Error("DORI_DISCORD_TOKEN is not configured");
    return discord ??= new Discord(fetchHttp, flow.clock, token);
  };
  return {
    ...liveJudgeDeps(flow, store), stateDir: flow.config.stateDir, ciMergeBase: flow.config.ciMergeBase,
    toodo: () => new ToodoClient(flow.tunables.toodoEvents), writer: new ToodoWriter(flow.tunables.toodoWriter),
    parentChannel: flow.config.discordChannels[0] ?? "", now: flow.clock.now, out: log, err: log, notify,
    lock: () => acquireStateLock(join(flow.config.stateDir, "autopilot-launch.lock.sqlite")),
    createThread: (thread) => transport().startThread(thread.parent, undefined, thread.title, flow.config.discord?.ownerId),
    // A lost Discord create reply has no durable remote id. Stop ambiguous rather than creating a duplicate.
    findThread: async (thread) => thread.id,
    readLane: (key) => flow.registry.read(key),
    observeLaunch: async (input) => {
      const lane = await flow.registry.read(input.key);
      const events = laneEventsAfter(flow.config.stateDir, 0).filter(({ label, frame }) =>
        label === machineRunner(input.machine) && frame.type === "cmd.result" && frame.body.cmdId.startsWith(`lane-start:${input.key}:`));
      for (const { frame } of events.reverse()) {
        if (frame.type !== "cmd.result") continue;
        if (frame.body.state === "failed" && !lane?.pane) return "not-done";
        const result = frame.body.result as { startup?: { verdict?: string }; pane?: string } | undefined;
        if (frame.body.state === "verified" && result?.startup?.verdict === "ok" && lane?.pane === result.pane) return "done";
      }
      return "unknown";
    },
    place: (input) => placeLaunch(flow, input), validate: (input) => validateLaunch(flow, input),
    admit: (input, placed) => admitLaunch(flow, input, placed, log),
    queue: () => launchQueue(flow.config.stateDir), dropQueued: (key) => { dequeueLaunch(flow.config.stateDir, key); },
    writeBrief: async (path, brief) => { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, brief, 0o600); },
    // The local runner's own report first; config.worktreeRoot is the lead's fallback for that host (ci-follow.ts does the same).
    worktreeRoot: (label) => (flow.runnerWorktreeRoot ?? ((l) => runnerWorktreeRoot(flow.config.stateDir, l)))(label) || flow.config.worktreeRoot || undefined,
    makeLaneDir: async (path) => { mkdirSync(dirname(path), { recursive: true }); ensureRunnerSubdir(dirname(path), basename(path)); },
    readBrief: async (path) => {
      try { return readFileSync(path, "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
  };
};
