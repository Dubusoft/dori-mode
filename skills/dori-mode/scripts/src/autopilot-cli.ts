import { parseArgs } from "node:util";

import {
  type AutopilotConfig, autopilotLaneKey, candidatesJson, type CandidatesReport, formatCandidates, type HostSummary, judgeAll,
  LAUNCH_ACTION, laneKeyOf, ledgerRows, ledgerState, pendingReservations, type QuotaSummary, recordShadow, type ToodoTask,
} from "./autopilot.ts";
import type { ClaudeUsage } from "./claude-quota.ts";
import { OPEN_STATES, type OperationState, type OperationStore, plan, settleOperation } from "./operations.ts";
import { ToodoUnreadable } from "./toodo-client.ts";

/**
 * `dori autopilot` (lead-only): judges the planned toodo tasks marked for autopilot, adds the hourly reconcile job, and
 * reserves a launch. Nothing here launches a lane, writes to toodo or merges: candidates only reads (and with --record
 * writes shadow rows), schedule writes one schedule job, launch writes and settles launch-attempt rows; the lead runs
 * `start_task` and `dori launch` between the reservation and its settle.
 */

export const AUTOPILOT_USAGE = [
  "usage: dori autopilot candidates [--tasks 12,13] [--json] [--record]",
  "       dori autopilot schedule",
  "       dori autopilot launch <taskId> [--launched <laneKey> | --failed | --ambiguous] [--note TEXT]",
].join("\n");

export const RECONCILE_JOB = "autopilot-reconcile";
export const RECONCILE_KIND = "AUTOPILOT_RECONCILE";
export const RECONCILE_CRON = "0 * * * *";

/** The toodo reads autopilot needs; any failure throws (ToodoUnreadable from the real client). */
export type ToodoReader = {
  readonly tasksByIds: (ids: readonly number[]) => Promise<ToodoTask[]>;
  /** Planned tasks marked for autopilot, of every workspace. */
  readonly flaggedTasks: () => Promise<ToodoTask[]>;
};

/** The schedule registry (SourceSpecs) as far as `schedule` uses it. */
export type ScheduleRegistry = { readonly list: () => readonly { readonly name: string }[]; readonly add: (raw: unknown) => unknown };

export type AutopilotDeps = {
  readonly config: AutopilotConfig;
  readonly store: OperationStore;
  readonly toodo: () => ToodoReader;
  /** Keys of open registry lanes. */
  readonly openLanes: () => Promise<ReadonlySet<string>>;
  /** Highest Claude 5h/7d use; must not throw (an unreadable read is `{ readable: false }`). */
  readonly quota: () => Promise<QuotaSummary>;
  /** The can-launch verdict and free slots of the default machine; must not throw. */
  readonly host: () => Promise<HostSummary>;
  readonly schedules: () => ScheduleRegistry;
  /** Takes the autopilot launch lock (waits for it); the result releases it. */
  readonly lock: () => Promise<() => void>;
  /** argv that runs this CLI: [bun, <absolute cli.ts>]. */
  readonly cliArgv: readonly string[];
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

class UsageError extends Error {}

const FLAGS = {
  json: { type: "boolean" }, record: { type: "boolean" }, tasks: { type: "string" },
  launched: { type: "string" }, failed: { type: "boolean" }, ambiguous: { type: "boolean" }, note: { type: "string" },
} as const;
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  candidates: ["json", "record", "tasks"], schedule: [], launch: ["launched", "failed", "ambiguous", "note"],
};

const taskIds = (value: string | undefined): number[] => {
  const parts = (value ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) throw new UsageError("--tasks must be a comma-separated list of toodo task ids");
  return [...new Set(parts.map(Number))];
};

/**
 * Judges every planned task marked for autopilot plus `extraIds` and prints the report; --record writes one shadow row
 * per task this hour. Exit 1 with AUTOPILOT_TOODO_UNREADABLE when toodo cannot be read, since nothing can be judged.
 */
/**
 * The marked planned tasks, `extraIds` and every dependency of them, plus the ids to judge (marked planned ones and
 * `extraIds`); undefined after printing AUTOPILOT_TOODO_UNREADABLE when toodo cannot be read.
 */
const readTasks = async (deps: AutopilotDeps, extraIds: readonly number[]): Promise<{ tasks: Map<number, ToodoTask>; ids: number[] } | undefined> => {
  const tasks = new Map<number, ToodoTask>();
  try {
    const toodo = deps.toodo();
    for (const t of await toodo.flaggedTasks()) tasks.set(t.id, t);
    const extra = extraIds.filter((id) => !tasks.has(id));
    if (extra.length) for (const t of await toodo.tasksByIds(extra)) tasks.set(t.id, t);
    const missingDeps = [...tasks.values()].flatMap((t) => t.dependsOn).filter((id) => !tasks.has(id));
    if (missingDeps.length) for (const t of await toodo.tasksByIds(missingDeps)) tasks.set(t.id, t);
  } catch (e) {
    if (!(e instanceof ToodoUnreadable)) throw e;
    deps.err(`AUTOPILOT_TOODO_UNREADABLE ${e.message}`);
    return undefined;
  }
  return { tasks, ids: [...new Set([...[...tasks.values()].filter((t) => t.autopilot && t.status === "planned").map((t) => t.id), ...extraIds])] };
};

const candidates = async (deps: AutopilotDeps, json: boolean, record: boolean, extraIds: readonly number[]): Promise<number> => {
  const now = deps.now();
  const read = await readTasks(deps, extraIds);
  if (!read) return 1;
  const { tasks, ids } = read;
  let report: CandidatesReport = { mode: deps.config.mode, slots: null, verdicts: [] };
  if (ids.length) {
    const [openLanes, quota, host] = await Promise.all([deps.openLanes(), deps.quota(), deps.host()]);
    const verdicts = judgeAll({ tasks, ledger: ledgerRows(deps.store), openLanes, quota, host, config: deps.config }, ids);
    report = { mode: deps.config.mode, slots: host.ok ? host.slots ?? null : 0, verdicts };
  }
  if (record) recordShadow(deps.store, now, report.verdicts);
  if (json) deps.out(JSON.stringify(candidatesJson(report), null, 2));
  else for (const line of formatCandidates(report)) deps.out(line);
  return 0;
};

/** Adds the hourly reconcile job unless a job of that name exists already. */
const schedule = (deps: AutopilotDeps): number => {
  const specs = deps.schedules();
  if (specs.list().some((s) => s.name === RECONCILE_JOB)) { deps.out(`AUTOPILOT_SCHEDULE_EXISTS ${RECONCILE_JOB}`); return 0; }
  // No tz: the schedule's default zone (Asia/Seoul) applies.
  specs.add({
    name: RECONCILE_JOB, type: "schedule", kind: RECONCILE_KIND, cron: RECONCILE_CRON, catchUp: "once",
    command: [...deps.cliArgv, "autopilot", "candidates", "--record"], since: deps.now(),
  });
  deps.out(`AUTOPILOT_SCHEDULE_ADDED ${RECONCILE_JOB} cron=${RECONCILE_CRON} kind=${RECONCILE_KIND}`);
  return 0;
};

/**
 * Reserves the next launch attempt of `taskId` under the launch lock: re-reads toodo, the ledger, open lanes, quota and
 * the host, judges the task among every marked one (other tasks' reservations not running yet take a host slot each),
 * and only on LAUNCH writes the planned row with its lane key. Exit 1 with the verdict when it is not LAUNCH.
 */
const reserve = async (deps: AutopilotDeps, taskId: number): Promise<number> => {
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
    if (sub === "schedule") return schedule(deps);
    const extraIds = v.tasks === undefined ? [] : taskIds(v.tasks as string);
    return await candidates(deps, v.json === true, v.record === true, extraIds);
  } catch (e) {
    if (e instanceof UsageError) { deps.err(`${e.message}\n${AUTOPILOT_USAGE}`); return 2; }
    if (e instanceof TypeError || e instanceof ToodoUnreadable) { deps.err(`AUTOPILOT_FAILED ${e.message}`); return 1; }
    throw e;
  }
};
