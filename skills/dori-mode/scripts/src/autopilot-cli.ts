import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  type AutopilotConfig, autopilotLaneKey, candidatesJson, type CandidatesReport, formatCandidates, type HostSummary, judgeAll,
  LAUNCH_ACTION, laneKeyOf, ledgerRows, ledgerState, pendingReservations, type QuotaSummary, type ToodoTask,
} from "./autopilot.ts";
import { type ClaudeUsage, lookupQuotaResults, readUsage } from "./claude-quota.ts";
import type { FlowDeps } from "./done-flow.ts";
import { OPEN_STATES, type OperationState, type OperationStore, plan, settleOperation } from "./operations.ts";
import { checkMachine } from "./placement.ts";
import { ToodoClient, ToodoUnreadable } from "./toodo-client.ts";

/**
 * `dori autopilot` (lead-only): judges the planned toodo tasks marked for autopilot and reserves a launch. Nothing here
 * launches a lane, writes to toodo or merges: candidates only reads, launch writes and settles launch-attempt rows; the lead runs `start_task` and `dori launch` between the reservation and its
 * settle. The supervisor's autopilot tick (autopilot-tick.ts) runs the candidates judgment every `autopilot.tickSec`.
 * Autopilot is always on: a reservation needs only no pause; `pause` / `resume` set and clear the pause file.
 */

export const AUTOPILOT_USAGE = [
  "usage: dori autopilot candidates [--tasks 12,13] [--json]",
  "       dori autopilot launch <taskId> [--launched <laneKey> | --failed | --ambiguous] [--note TEXT]",
  "       dori autopilot pause [--reason TEXT]",
  "       dori autopilot resume",
].join("\n");

// ---------------------------------------------------------------------------------------------------------------------
// Pause

/** The pause file: present while `dori autopilot pause` is in force. */
export const autopilotPausePath = (stateDir: string): string => join(stateDir, "autopilot-pause.json");

export type Pause = { readonly since: string; readonly reason: string | null };

/** The pause in force, or undefined. A file that cannot be parsed still pauses (since "?"): a brake fails closed. */
export const readPause = (path: string): Pause | undefined => {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { since: "?", reason: `pause file unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const raw = JSON.parse(text) as { since?: unknown; reason?: unknown };
    return { since: typeof raw.since === "string" ? raw.since : "?", reason: typeof raw.reason === "string" ? raw.reason : null };
  } catch { return { since: "?", reason: null }; }
};

const pauseText = (p: Pause): string => `since ${p.since}${p.reason ? `: ${p.reason}` : ""}`;

const writePause = (path: string, pause: Pause): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pause)}\n`);
  renameSync(tmp, path);
};

/** The hourly schedule job the supervisor's autopilot tick replaced; the supervisor removes it at startup. */
export const RECONCILE_JOB = "autopilot-reconcile";

/** The toodo reads autopilot needs; any failure throws (ToodoUnreadable from the real client). */
export type ToodoReader = {
  readonly tasksByIds: (ids: readonly number[]) => Promise<ToodoTask[]>;
  /** Planned tasks marked for autopilot, of every workspace. */
  readonly flaggedTasks: () => Promise<ToodoTask[]>;
};

/** What judging the candidates reads: toodo, the launch ledger, open lanes, quota and the host. */
export type JudgeDeps = {
  readonly config: AutopilotConfig;
  readonly store: OperationStore;
  /** autopilotPausePath of the state dir. */
  readonly pauseFile: string;
  readonly toodo: () => ToodoReader;
  /** Keys of open registry lanes. */
  readonly openLanes: () => Promise<ReadonlySet<string>>;
  /** Highest Claude 5h/7d use; must not throw (an unreadable read is `{ readable: false }`). */
  readonly quota: () => Promise<QuotaSummary>;
  /** The can-launch verdict and free slots of the default machine; must not throw. */
  readonly host: () => Promise<HostSummary>;
};

export type AutopilotDeps = JudgeDeps & {
  /** Takes the autopilot launch lock (waits for it); the result releases it. */
  readonly lock: () => Promise<() => void>;
  readonly now: () => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** Highest used percentage over every account's 5h and 7d windows; unreadable without usage or with no window at all. */
export const quotaSummary = (usage: ClaudeUsage | undefined): QuotaSummary => {
  const pcts = usage?.accounts.flatMap((a) => [a.fiveHour?.usedPct, a.weekly?.usedPct]).filter((p): p is number => typeof p === "number") ?? [];
  return pcts.length ? { readable: true, maxUsedPct: Math.max(...pcts) } : { readable: false };
};

/** `work()` or `fallback` when it throws or takes longer than `ms`. */
export const within = async <T>(ms: number, work: () => Promise<T>, fallback: (why: string) => T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback(`no answer within ${ms} ms`)), ms); }),
    ]);
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
};

const PROBE_MS = 15_000;

/**
 * JudgeDeps over the live world: toodo-server, the registry's open lanes, the Claude quota and the default machine's
 * can-launch check (without recording a launch verdict). `dori autopilot` and the supervisor's tick share it.
 */
export const liveJudgeDeps = (flow: Pick<FlowDeps, "ops" | "config" | "registry" | "tunables" | "clock">, store: OperationStore): JudgeDeps => ({
  config: flow.config.autopilot, store, pauseFile: autopilotPausePath(flow.config.stateDir),
  toodo: () => new ToodoClient(flow.tunables.toodoEvents),
  openLanes: async () => new Set((await flow.registry.open()).map((l) => l.key)),
  quota: () => within(PROBE_MS, async () => quotaSummary((await readUsage(lookupQuotaResults(), flow.clock.now(), AbortSignal.timeout(PROBE_MS))).usage), () => ({ readable: false })),
  host: () => within(PROBE_MS, async () => {
    const c = await checkMachine(flow.ops, flow.config, flow.config.placement.defaultMachine);
    const slots = c.freeSlots === undefined ? {} : { slots: c.freeSlots };
    return c.verdict.ok ? { ok: true, ...slots } : { ok: false, reason: c.verdict.reasons.join(" | "), ...slots };
  }, (why) => ({ ok: false, reason: why })),
});

class UsageError extends Error {}

const FLAGS = {
  json: { type: "boolean" }, tasks: { type: "string" },
  launched: { type: "string" }, failed: { type: "boolean" }, ambiguous: { type: "boolean" }, note: { type: "string" },
  reason: { type: "string" },
} as const;
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  candidates: ["json", "tasks"], launch: ["launched", "failed", "ambiguous", "note"], pause: ["reason"], resume: [],
};

const taskIds = (value: string | undefined): number[] => {
  const parts = (value ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) throw new UsageError("--tasks must be a comma-separated list of toodo task ids");
  return [...new Set(parts.map(Number))];
};

type ReadTasks = { tasks: Map<number, ToodoTask>; ids: number[] };

/**
 * The marked planned tasks, `extraIds` and every dependency of them, plus the ids to judge (marked planned ones and
 * `extraIds`). Throws ToodoUnreadable when toodo cannot be read.
 */
const loadTasks = async (deps: JudgeDeps, extraIds: readonly number[]): Promise<ReadTasks> => {
  const tasks = new Map<number, ToodoTask>();
  const toodo = deps.toodo();
  for (const t of await toodo.flaggedTasks()) tasks.set(t.id, t);
  const extra = extraIds.filter((id) => !tasks.has(id));
  if (extra.length) for (const t of await toodo.tasksByIds(extra)) tasks.set(t.id, t);
  const missingDeps = [...tasks.values()].flatMap((t) => t.dependsOn).filter((id) => !tasks.has(id));
  if (missingDeps.length) for (const t of await toodo.tasksByIds(missingDeps)) tasks.set(t.id, t);
  return { tasks, ids: [...new Set([...[...tasks.values()].filter((t) => t.autopilot && t.status === "planned").map((t) => t.id), ...extraIds])] };
};

/** loadTasks, or undefined after printing AUTOPILOT_TOODO_UNREADABLE when toodo cannot be read. */
const readTasks = async (deps: AutopilotDeps, extraIds: readonly number[]): Promise<ReadTasks | undefined> => {
  try { return await loadTasks(deps, extraIds); } catch (e) {
    if (!(e instanceof ToodoUnreadable)) throw e;
    deps.err(`AUTOPILOT_TOODO_UNREADABLE ${e.message}`);
    return undefined;
  }
};

/**
 * Judges every planned task marked for autopilot plus `extraIds`, subtracting pending reservations from host slots.
 * Quota and host are probed only when there is a task to judge. Throws ToodoUnreadable when toodo cannot be read.
 */
export const judgeCandidates = async (deps: JudgeDeps, extraIds: readonly number[] = []): Promise<CandidatesReport> => {
  const { tasks, ids } = await loadTasks(deps, extraIds);
  const paused = readPause(deps.pauseFile) !== undefined;
  if (!ids.length) return { paused, slots: null, verdicts: [] };
  const [openLanes, quota, host] = await Promise.all([deps.openLanes(), deps.quota(), deps.host()]);
  const ledger = ledgerRows(deps.store);
  const pending = pendingReservations(ledger, openLanes);
  const slotted: HostSummary = host.slots === undefined ? host : { ...host, slots: Math.max(0, host.slots - pending) };
  const verdicts = judgeAll({ tasks, ledger, openLanes, quota, host: slotted, config: deps.config }, ids);
  return { paused, slots: host.ok ? slotted.slots ?? null : 0, verdicts };
};

/**
 * Judges every planned task marked for autopilot plus `extraIds` and prints the report. Exit 1 with AUTOPILOT_TOODO_UNREADABLE when toodo cannot be read, since nothing can be judged.
 */
const candidates = async (deps: AutopilotDeps, json: boolean, extraIds: readonly number[]): Promise<number> => {
  let report: CandidatesReport;
  try { report = await judgeCandidates(deps, extraIds); } catch (e) {
    if (!(e instanceof ToodoUnreadable)) throw e;
    deps.err(`AUTOPILOT_TOODO_UNREADABLE ${e.message}`);
    return 1;
  }
  if (json) deps.out(JSON.stringify(candidatesJson(report), null, 2));
  else for (const line of formatCandidates(report)) deps.out(line);
  return 0;
};

/**
 * Reserves the next launch attempt of `taskId` under the launch lock: re-reads toodo, the ledger, open lanes, quota and
 * the host, judges the task among every marked one (other tasks' reservations not running yet take a host slot each),
 * and only on LAUNCH writes the planned row with its lane key. Exit 1 with the verdict when it is not LAUNCH, and before
 * reading anything when a pause is in force.
 */
const reserve = async (deps: AutopilotDeps, taskId: number): Promise<number> => {
  const pause = readPause(deps.pauseFile);
  if (pause) {
    deps.err(`AUTOPILOT_LAUNCH_REFUSED #${taskId} paused ${pauseText(pause)} (dori autopilot resume lifts it)`);
    return 1;
  }
  const read = await readTasks(deps, [taskId]);
  if (!read) return 1;
  const ledger = ledgerRows(deps.store);
  const [openLanes, quota, host] = await Promise.all([deps.openLanes(), deps.quota(), deps.host()]);
  const pending = pendingReservations(ledger, openLanes, taskId);
  const slotted: HostSummary = host.slots === undefined ? host : { ...host, slots: Math.max(0, host.slots - pending) };
  const verdict = judgeAll({ tasks: read.tasks, ledger, openLanes, quota, host: slotted, config: deps.config }, read.ids)
    .find((v) => v.taskId === taskId)!;
  if (verdict.verdict !== "LAUNCH") {
    deps.err(`AUTOPILOT_LAUNCH_REFUSED #${taskId} ${verdict.verdict} ${verdict.reasons.join(", ")}`);
    return 1;
  }
  const attempt = ledgerState(ledger, taskId, openLanes).attempts + 1;
  const laneKey = autopilotLaneKey(taskId, attempt);
  plan(deps.store, deps.now(), { lane: `toodo:${taskId}`, action: LAUNCH_ACTION, target: String(attempt), data: JSON.stringify({ laneKey }) });
  deps.out(`AUTOPILOT_RESERVED #${taskId} lane=${laneKey} attempt=${attempt}`);
  return 0;
};

type Settle = { readonly state: Extract<OperationState, "verified" | "failed" | "ambiguous">; readonly laneKey?: string };

/** Settles the open reservation of `taskId`: launched (verified, its lane key must match), failed or ambiguous. */
const settle = (deps: AutopilotDeps, taskId: number, how: Settle, note: string | undefined): number => {
  const open = ledgerRows(deps.store).filter((op) => op.lane === `toodo:${taskId}` && OPEN_STATES.includes(op.state));
  const op = open.at(-1);
  if (!op) { deps.err(`AUTOPILOT_NO_RESERVATION #${taskId}`); return 1; }
  const reserved = laneKeyOf(op);
  if (how.laneKey !== undefined && how.laneKey !== reserved) {
    deps.err(`AUTOPILOT_LANE_MISMATCH #${taskId} reserved=${reserved ?? "?"} given=${how.laneKey}`);
    return 1;
  }
  const what = how.state === "verified" ? `launched ${reserved}` : how.state === "failed" ? "launch failed" : "launch outcome unknown";
  settleOperation(deps.store, deps.now(), op.id, how.state, note ? `${what}: ${note}` : what);
  deps.out(`AUTOPILOT_SETTLED #${taskId} attempt=${op.target} ${how.state} lane=${reserved ?? "?"}`);
  return 0;
};

/** `dori autopilot launch <taskId> [settle flag]`: reserve, or settle the reservation, holding the launch lock throughout. */
const launch = async (deps: AutopilotDeps, positionals: readonly string[], v: Record<string, unknown>): Promise<number> => {
  const [id, ...more] = positionals;
  if (id === undefined || more.length || !/^\d+$/.test(id)) throw new UsageError("autopilot launch takes one toodo task id");
  const settles: Settle[] = [
    ...(v.launched !== undefined ? [{ state: "verified" as const, laneKey: v.launched as string }] : []),
    ...(v.failed === true ? [{ state: "failed" as const }] : []),
    ...(v.ambiguous === true ? [{ state: "ambiguous" as const }] : []),
  ];
  if (settles.length > 1) throw new UsageError("--launched, --failed and --ambiguous exclude each other");
  const note = v.note as string | undefined;
  if (note !== undefined && !settles.length) throw new UsageError("--note goes with --launched, --failed or --ambiguous");
  const release = await deps.lock();
  try {
    return settles[0] ? settle(deps, Number(id), settles[0], note) : await reserve(deps, Number(id));
  } finally {
    release();
  }
};

/** `dori autopilot pause`: new reservations refuse until `resume`; running lanes go on. Pausing twice keeps the first. */
const pause = (deps: AutopilotDeps, reason: string | undefined): number => {
  const current = readPause(deps.pauseFile);
  if (current) { deps.out(`AUTOPILOT_PAUSED ${pauseText(current)} (already paused)`); return 0; }
  const next: Pause = { since: new Date(deps.now()).toISOString(), reason: reason?.trim() || null };
  writePause(deps.pauseFile, next);
  deps.out(`AUTOPILOT_PAUSED ${pauseText(next)}`);
  return 0;
};

/** `dori autopilot resume`: lifts the pause. */
const resume = (deps: AutopilotDeps): number => {
  if (!readPause(deps.pauseFile)) { deps.out("AUTOPILOT_NOT_PAUSED"); return 0; }
  rmSync(deps.pauseFile, { force: true });
  deps.out("AUTOPILOT_RESUMED");
  return 0;
};

/** `dori autopilot <sub> ...`; returns the exit code (2 on a usage error). */
export const autopilotMain = async (args: readonly string[], deps: AutopilotDeps): Promise<number> => {
  try {
    let parsed;
    try { parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: FLAGS }); }
    catch (e) { throw new UsageError(e instanceof Error ? e.message : String(e)); }
    const [sub = "", ...extra] = parsed.positionals;
    const allowed = ALLOWED[sub];
    if (!allowed) throw new UsageError(sub ? `unknown subcommand ${sub}` : "a subcommand is required");
    const stray = Object.keys(parsed.values).filter((f) => !allowed.includes(f));
    if (stray.length) throw new UsageError(`${stray.map((f) => `--${f}`).join(", ")} is not an option of autopilot ${sub}`);
    const v = parsed.values as Record<string, unknown>;
    if (sub === "launch") return await launch(deps, extra, v);
    if (extra.length) throw new UsageError(`autopilot ${sub} takes no arguments`);
    if (sub === "pause") return pause(deps, v.reason as string | undefined);
    if (sub === "resume") return resume(deps);
    const extraIds = v.tasks === undefined ? [] : taskIds(v.tasks as string);
    return await candidates(deps, v.json === true, extraIds);
  } catch (e) {
    if (e instanceof UsageError) { deps.err(`${e.message}\n${AUTOPILOT_USAGE}`); return 2; }
    if (e instanceof TypeError || e instanceof ToodoUnreadable) { deps.err(`AUTOPILOT_FAILED ${e.message}`); return 1; }
    throw e;
  }
};
