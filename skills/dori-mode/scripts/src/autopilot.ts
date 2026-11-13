import { OPEN_STATES, type Operation, type OperationStore, settleOperation } from "./operations.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Autopilot core: the pure selection predicate over toodo tasks the owner marked for autopilot (toodo's
 * `autopilot` field) and the launch ledger, plus slot assignment against the host guard. Autopilot is always on: a
 * marked task that judges LAUNCH may run unless `dori autopilot pause` is in force.
 * Nothing here performs I/O beyond the given OperationStore, launches a lane or mutates toodo; callers read toodo, the
 * registry, quota and the host guard and pass plain data in.
 *
 * Rows:
 * - launch attempt (written by `dori autopilot launch`): lane `toodo:<taskId>`, action `autopilot-launch`, target
 *   `<attempt number>`, data `{ laneKey }`; planned while reserved, then verified, failed or ambiguous. When its lane
 *   closes, settleLaneOutcome adds `outcome` to the data: `done` (state verified) or `failed` (state failed).
 */

export const LAUNCH_ACTION = "autopilot-launch";
/** A task ref naming the owner's word that marked it, e.g. `owner:discord:<channel>/<message>`. */
const OWNER_REF = /^owner:\S+$/;

/** The toodo-server task fields the predicate reads (camelCase, as `list_tasks` / `get_task` return them). */
export type ToodoTask = {
  readonly id: number;
  readonly workspaceId: number;
  readonly title: string;
  readonly description: string;
  readonly status: "planned" | "in_progress" | "in_review" | "done";
  readonly resolution: "merged" | "completed" | "not_adopted" | null;
  readonly dependsOn: readonly number[];
  readonly refs: readonly string[];
  readonly criteria: readonly { readonly text: string; readonly kind: string; readonly target?: string }[];
  /** `until` in seconds; a waiting in-progress task reads status planned with this set. */
  readonly wait: { readonly until: number; readonly status: string } | null;
  /** Marked for autopilot in toodo. */
  readonly autopilot: boolean;
  /** `YYYY-MM-DD`, or null when the task has no due date. */
  readonly dueDate: string | null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Config

export type AutopilotConfig = {
  readonly quotaUnreadable: "hold";
  readonly mergeBase: string;
  readonly crossWorkspacePrereqs: "block";
  /** Seconds between the supervisor's autopilot ticks. */
  readonly tickSec: number;
  /** Seconds a quota read is reused by every caller (judge, `dori quota`, `/quota`) before the endpoints are read again. */
  readonly quotaCacheSec: number;
};

export const TICK_SEC_MIN = 30;
export const TICK_SEC_MAX = 3600;
export const QUOTA_CACHE_SEC_MIN = 30;
export const QUOTA_CACHE_SEC_MAX = 900;

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  quotaUnreadable: "hold", mergeBase: "dev", crossWorkspacePrereqs: "block", tickSec: 300, quotaCacheSec: 90,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Keys read as nothing so an older config still loads: the bundle design's, `mode` (autopilot is always on; `dori
 * setup` removes it, see config-schema.ts) and `quotaMaxUsedPct` (an account counts as spent only at 100%).
 */
const REMOVED_KEYS: ReadonlySet<string> = new Set(["workspaces", "bundleExpiryDays", "wip", "wipCap", "attemptCap", "onRevoke", "mode", "quotaMaxUsedPct"]);

/**
 * The config's `autopilot` (absent: DEFAULT_AUTOPILOT; each key optional). Throws TypeError naming the key on an
 * unknown key or an invalid value. A removed key is ignored and named through `warn`.
 */
export const parseAutopilotConfig = (raw: unknown, warn: (line: string) => void = () => {}): AutopilotConfig => {
  if (raw === undefined) return DEFAULT_AUTOPILOT;
  if (!isRecord(raw)) throw new TypeError("autopilot must be an object");
  const known = new Set(Object.keys(DEFAULT_AUTOPILOT));
  const removed = Object.keys(raw).filter((key) => REMOVED_KEYS.has(key));
  for (const key of Object.keys(raw)) if (!known.has(key) && !REMOVED_KEYS.has(key)) throw new TypeError(`autopilot.${key} is not a known key`);
  if (removed.length) warn(`autopilot.${removed.join(", autopilot.")} no longer apply and are ignored`);
  const pick = <T>(key: keyof AutopilotConfig, ok: (v: unknown) => boolean, what: string): T => {
    const v = raw[key];
    if (v === undefined) return DEFAULT_AUTOPILOT[key] as T;
    if (!ok(v)) throw new TypeError(`autopilot.${key} must be ${what}, not ${JSON.stringify(v)}`);
    return v as T;
  };
  const only = (value: string) => (v: unknown) => v === value;
  return {
    quotaUnreadable: pick<"hold">("quotaUnreadable", only("hold"), "\"hold\""),
    mergeBase: pick<string>("mergeBase", (v) => typeof v === "string" && v.trim() !== "" && v === v.trim(), "a branch name"),
    crossWorkspacePrereqs: pick<"block">("crossWorkspacePrereqs", only("block"), "\"block\""),
    tickSec: pick<number>("tickSec", (v) => Number.isInteger(v) && (v as number) >= TICK_SEC_MIN && (v as number) <= TICK_SEC_MAX,
      `an integer from ${TICK_SEC_MIN} to ${TICK_SEC_MAX}`),
    quotaCacheSec: pick<number>("quotaCacheSec", (v) => Number.isInteger(v) && (v as number) >= QUOTA_CACHE_SEC_MIN && (v as number) <= QUOTA_CACHE_SEC_MAX,
      `an integer from ${QUOTA_CACHE_SEC_MIN} to ${QUOTA_CACHE_SEC_MAX}`),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Ledger

export type LedgerState = { readonly attempts: number; readonly ambiguous: boolean; readonly live: boolean };

/** Every launch-attempt row in the store. */
export const ledgerRows = (store: OperationStore): Operation[] =>
  store.list().filter((op) => op.action === LAUNCH_ACTION && op.lane.startsWith("toodo:"));

const rowsOf = (rows: readonly Operation[], taskId: number): Operation[] =>
  rows.filter((op) => op.action === LAUNCH_ACTION && op.lane === `toodo:${taskId}`);

/** The lane key of a task's launch attempt: deterministic, so the reservation names its lane before it exists. */
export const autopilotLaneKey = (taskId: number, attempt: number): string => `ap-${taskId}-${attempt}`;

export const laneKeyOf = (op: Operation): string | undefined => {
  try {
    const data = JSON.parse(op.data ?? "") as unknown;
    return isRecord(data) && typeof data.laneKey === "string" ? data.laneKey : undefined;
  } catch { return undefined; }
};

/** The task id of the launch attempt reserved for `laneKey` (its ledger row names the lane), else undefined. */
export const reservedTaskOf = (rows: readonly Operation[], laneKey: string): number | undefined => {
  const op = rows.find((row) => row.action === LAUNCH_ACTION && row.lane.startsWith("toodo:") && laneKeyOf(row) === laneKey);
  const id = op ? Number(op.lane.slice("toodo:".length)) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

/** A row still running: open (planned/attempted), or verified with its laneKey an open registry lane. */
const rowLive = (op: Operation, openLanes: ReadonlySet<string>): boolean => {
  if (OPEN_STATES.includes(op.state)) return true;
  if (op.state !== "verified") return false;
  const key = laneKeyOf(op);
  return key !== undefined && openLanes.has(key);
};

/** The machine a launch attempt was reserved on (`data.machine`), else undefined (a row written before it was recorded). */
export const reservedMachineOf = (op: Operation): string | undefined => {
  try {
    const data = JSON.parse(op.data ?? "") as unknown;
    return isRecord(data) && typeof data.machine === "string" ? data.machine : undefined;
  } catch { return undefined; }
};

/**
 * Reservations of other tasks not running as a lane yet (open rows whose laneKey is no open lane), by the machine each
 * was reserved on (`defaultMachine` for a row that names none): each takes one slot of that machine that its pane count
 * does not show.
 */
export const pendingReservations = (rows: readonly Operation[], openLanes: ReadonlySet<string>, defaultMachine: string, exceptTaskId?: number): Map<string, number> => {
  const pending = new Map<string, number>();
  for (const op of rows) {
    if (op.action !== LAUNCH_ACTION || (exceptTaskId !== undefined && op.lane === `toodo:${exceptTaskId}`) || !OPEN_STATES.includes(op.state)) continue;
    const key = laneKeyOf(op);
    if (key !== undefined && openLanes.has(key)) continue;
    const machine = reservedMachineOf(op) ?? defaultMachine;
    pending.set(machine, (pending.get(machine) ?? 0) + 1);
  }
  return pending;
};

/** A stable key for local autopilot state that can change without a toodo event. */
export const autopilotLocalStateKey = (store: OperationStore, openLanes: ReadonlySet<string>): string =>
  JSON.stringify([
    [...openLanes].sort(),
    store.list({ states: OPEN_STATES })
      .filter((op) => op.action === LAUNCH_ACTION && op.lane.startsWith("toodo:"))
      .map((op) => `${op.id}:${op.state}`).sort(),
  ]);

/** The lines settleLaneOutcome returns; the lead reports a failure to the owner and completes the toodo task of a done one. */
export const LANE_DONE_EVENT = "AUTOPILOT_LANE_DONE";
export const LANE_FAILED_EVENT = "AUTOPILOT_LANE_FAILED";
export const isLaneOutcomeLine = (line: string): boolean => line.startsWith(`${LANE_DONE_EVENT} `) || line.startsWith(`${LANE_FAILED_EVENT} `);
/** The journal id of a lane's outcome line: one per lane, so a close resumed after a crash announces it once. */
export const laneOutcomeEventId = (laneKey: string): string => `autopilot-outcome:${laneKey}`;

const outcomeOf = (op: Operation): unknown => {
  try { const data = JSON.parse(op.data ?? "") as unknown; return isRecord(data) ? data.outcome : undefined; } catch { return undefined; }
};

/**
 * Settles the launch attempt whose lane `laneKey` just closed, once. A close with `failed` set (cancelled: the lane did
 * not start, was given up, or its Done can never hold) settles the row `failed`; any other close (every Done signal held,
 * its PR merged) marks it done. Returns the line for the lead, or undefined when no launch attempt names the lane (not an
 * autopilot lane), the row already has an outcome, or the launch itself was settled failed or ambiguous. Nothing is
 * relaunched: the predicate refuses the task `already-attempted` from now on.
 */
export const settleLaneOutcome = (store: OperationStore, now: number, laneKey: string, failed?: string): string | undefined => {
  const op = ledgerRows(store).find((row) => laneKeyOf(row) === laneKey);
  if (!op || outcomeOf(op) !== undefined || op.state === "failed" || op.state === "ambiguous") return undefined;
  const taskId = op.lane.slice("toodo:".length);
  const data = JSON.stringify({ ...(JSON.parse(op.data ?? "{}") as Record<string, unknown>), outcome: failed === undefined ? "done" : "failed" });
  const why = redactSecrets((failed ?? "").replace(/\s+/g, " ").trim()).slice(0, 200);
  const head = `#${taskId} lane=${laneKey} attempt=${op.target}`;
  if (failed === undefined) {
    store.put({ ...op, state: "verified", detail: `lane ${laneKey} closed done`, data, updatedAt: now });
    return `${LANE_DONE_EVENT} ${head}: complete toodo task #${taskId}`;
  }
  store.put({ ...op, state: "failed", detail: `lane ${laneKey} closed without finishing${why ? `: ${why}` : ""}`, data, updatedAt: now });
  return `${LANE_FAILED_EVENT} ${head}${why ? ` ${why}` : ""}: tell the owner; autopilot does not launch it again`;
};

export const ledgerState = (rows: readonly Operation[], taskId: number, openLanes: ReadonlySet<string>): LedgerState => {
  const mine = rowsOf(rows, taskId);
  return { attempts: mine.length, ambiguous: mine.some((op) => op.state === "ambiguous"), live: mine.some((op) => rowLive(op, openLanes)) };
};

// ---------------------------------------------------------------------------------------------------------------------
// Predicate

export type VerdictKind = "LAUNCH" | "HOLD" | "REFUSE";

export const REFUSE_REASONS = [
  "not-flagged", "owner-ref-missing", "criteria-missing", "task-missing", "not-planned", "prerequisite-missing",
  "prerequisite-open", "prerequisite-not-adopted", "cross-workspace-prerequisite", "already-attempted", "ledger-ambiguous",
] as const;
export const HOLD_REASONS = ["waiting", "lane-live", "quota-unreadable", "quota-over-threshold", "host-hold", "no-slot"] as const;
export type Reason = (typeof REFUSE_REASONS)[number] | (typeof HOLD_REASONS)[number];

export type Verdict = {
  readonly taskId: number;
  readonly verdict: VerdictKind;
  readonly reasons: readonly Reason[];
  /** LAUNCH from judgeAll: the machine whose slot the task took. */
  readonly machine?: string;
};

/** One readable Claude account and the highest used percentage over its 5h and 7d windows. */
export type QuotaAccount = { readonly name: string; readonly maxUsedPct: number };

/**
 * `accounts` are the readable Claude accounts (non-empty when `readable`); `skipped` names the accounts left out of the
 * judgment as "name (reason)".
 */
export type QuotaSummary = {
  readonly readable: boolean;
  readonly accounts?: readonly QuotaAccount[];
  readonly skipped?: readonly string[];
  /** Accounts judged on a read older than the quota cache TTL, as "name (age)"; still readable up to STALE_READ_MAX_MS. */
  readonly stale?: readonly string[];
};

/**
 * The readable accounts split by use: `over` has a spent window (100% used), `room` has every window below 100%. omo
 * moves a lane off an account that hits its usage limit, so one account with room is enough to launch.
 */
export const quotaSplit = (quota: QuotaSummary): { over: QuotaAccount[]; room: QuotaAccount[] } => {
  const accounts = quota.accounts ?? [];
  return { over: accounts.filter((a) => a.maxUsedPct >= 100), room: accounts.filter((a) => a.maxUsedPct < 100) };
};

/** "default (100%)". */
export const quotaAccountText = (a: QuotaAccount): string => `${a.name} (${a.maxUsedPct}%)`;
/**
 * One machine's `dori can-launch` verdict; `slots` is how many more lanes its pane limit allows (absent when the pane
 * limit is off, so nothing caps the count).
 */
export type HostSummary = { readonly ok: boolean; readonly reason?: string; readonly slots?: number };

/**
 * The machines the judged tasks would launch on: each one's summary (its slots already less the reservations waiting
 * for it), and each task's target machines, most preferred first (where its launch is placed, then the fallbacks a
 * movable placement may take).
 */
export type Hosts = {
  readonly machines: ReadonlyMap<string, HostSummary>;
  readonly targets: (taskId: number) => readonly string[];
};

/** Hosts of one machine every task targets. */
export const singleHost = (host: HostSummary, machine = "local"): Hosts => ({ machines: new Map([[machine, host]]), targets: () => [machine] });

export type JudgeContext = {
  /** Tasks returned by toodo, keyed by id, including every dependency. */
  readonly tasks: ReadonlyMap<number, ToodoTask>;
  /** Launch-attempt rows (ledgerRows). */
  readonly ledger: readonly Operation[];
  /** Keys of open registry lanes. */
  readonly openLanes: ReadonlySet<string>;
  /** Each readable Claude account's highest 5h/7d use. */
  readonly quota: QuotaSummary;
  readonly hosts: Hosts;
  readonly config: AutopilotConfig;
};

export type JudgeInput = JudgeContext & { readonly taskId: number };

const REFUSE_SET: ReadonlySet<string> = new Set(REFUSE_REASONS);
const ORDER: readonly Reason[] = [...REFUSE_REASONS, ...HOLD_REASONS];

/** A dependency counts as satisfied only when done with resolution merged or completed. */
const depSatisfied = (dep: ToodoTask): boolean => dep.status === "done" && (dep.resolution === "merged" || dep.resolution === "completed");

const verdictOf = (taskId: number, found: ReadonlySet<Reason>): Verdict => {
  const reasons = ORDER.filter((r) => found.has(r));
  const verdict: VerdictKind = reasons.some((r) => REFUSE_SET.has(r)) ? "REFUSE" : reasons.length > 0 ? "HOLD" : "LAUNCH";
  return { taskId, verdict, reasons };
};

/**
 * Judges one task on its own (no slot assignment; judgeAll adds that). Every failing reason is collected; the verdict
 * is REFUSE if any reason is a refusal, else HOLD if any reason holds, else LAUNCH. Reasons come in REFUSE_REASONS then
 * HOLD_REASONS order. Any earlier launch attempt refuses: autopilot never retries by itself.
 */
export const judge = (input: JudgeInput): Verdict => {
  const { taskId, tasks, config } = input;
  const found = new Set<Reason>();
  const task = tasks.get(taskId);

  if (!task) found.add("task-missing");
  else {
    if (!task.autopilot) found.add("not-flagged");
    if (!task.refs.some((ref) => OWNER_REF.test(ref))) found.add("owner-ref-missing");
    if (task.criteria.length === 0) found.add("criteria-missing");
    if (task.wait !== null) found.add("waiting");
    else if (task.status !== "planned") found.add("not-planned");
    if (task.refs.some((ref) => ref.startsWith("lane:") && input.openLanes.has(ref.slice("lane:".length)))) found.add("lane-live");
    for (const depId of new Set(task.dependsOn)) {
      const dep = tasks.get(depId);
      if (!dep) { found.add("prerequisite-missing"); continue; }
      if (dep.workspaceId !== task.workspaceId) found.add("cross-workspace-prerequisite");
      if (dep.status === "done" && dep.resolution === "not_adopted") found.add("prerequisite-not-adopted");
      else if (!depSatisfied(dep)) found.add("prerequisite-open");
    }
  }

  const ledger = ledgerState(input.ledger, taskId, input.openLanes);
  if (ledger.live) found.add("lane-live");
  else if (ledger.attempts > 0) found.add("already-attempted");
  if (ledger.ambiguous) found.add("ledger-ambiguous");

  if (!input.quota.readable) found.add("quota-unreadable");
  else if (quotaSplit(input.quota).room.length === 0) found.add("quota-over-threshold");
  if (!input.hosts.targets(taskId).some((machine) => input.hosts.machines.get(machine)?.ok)) found.add("host-hold");

  return verdictOf(taskId, found);
};

/** Launch order among LAUNCH tasks: a due date first (earliest first), then ascending id. */
const launchOrder = (tasks: ReadonlyMap<number, ToodoTask>) => (a: number, b: number): number => {
  const da = tasks.get(a)?.dueDate ?? null;
  const db = tasks.get(b)?.dueDate ?? null;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  return a - b;
};

/**
 * Judges `taskIds` (ascending by id), then assigns free slots machine by machine: in launch order each LAUNCH task takes
 * a slot of its first target machine that is not held and has one left, and keeps LAUNCH naming that `machine`; a task
 * none of whose targets has a slot left HOLDs `no-slot`. A machine without `slots` never runs out.
 */
export const judgeAll = (ctx: JudgeContext, taskIds: readonly number[]): Verdict[] => {
  const verdicts = [...new Set(taskIds)].sort((a, b) => a - b).map((taskId) => judge({ ...ctx, taskId }));
  const free = new Map([...ctx.hosts.machines].map(([machine, h]) => [machine, h.slots ?? Number.POSITIVE_INFINITY]));
  const placed = new Map<number, string>();
  for (const taskId of verdicts.filter((v) => v.verdict === "LAUNCH").map((v) => v.taskId).sort(launchOrder(ctx.tasks))) {
    const machine = ctx.hosts.targets(taskId).find((m) => ctx.hosts.machines.get(m)?.ok && (free.get(m) ?? 0) > 0);
    if (machine === undefined) continue;
    free.set(machine, free.get(machine)! - 1);
    placed.set(taskId, machine);
  }
  return verdicts.map((v) => {
    if (v.verdict !== "LAUNCH") return v;
    const machine = placed.get(v.taskId);
    return machine === undefined ? verdictOf(v.taskId, new Set<Reason>(["no-slot"])) : { ...v, machine };
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// Output

export type CandidatesReport = {
  /** `dori autopilot pause` is in force: nothing launches. */
  readonly paused: boolean;
  /** Free slots of every machine not held, summed; null when one of them has the pane limit off. */
  readonly slots: number | null;
  /** Each target machine's free slots (null: no pane limit) or `hold`; present only when the tasks target two or more. */
  readonly machines?: readonly { readonly machine: string; readonly slots: number | null | "hold" }[];
  readonly verdicts: readonly Verdict[];
  /** Claude accounts the quota read left out, as "name (reason)"; absent when none was. */
  readonly quotaSkipped?: readonly string[];
  /** Accounts judged on a stale read (a 429 fallback or a backoff), as "name (age)"; absent when none was. */
  readonly quotaStale?: readonly string[];
  /** When an account is spent: the spent accounts and the ones with room, as "name (pct%)". */
  readonly quotaOver?: readonly string[];
  readonly quotaRoom?: readonly string[];
};

/** Text output of `dori autopilot candidates`: a header line and one line per verdict, or AUTOPILOT_NO_CANDIDATES. */
export const formatCandidates = (report: CandidatesReport): string[] => {
  if (report.verdicts.length === 0) return ["AUTOPILOT_NO_CANDIDATES"];
  return [
    `AUTOPILOT${report.paused ? " paused: nothing launches" : ""} slots=${report.slots ?? "unlimited"}${report.machines ? ` machines=${report.machines.map((m) => `${m.machine}:${m.slots ?? "unlimited"}`).join(",")}` : ""} candidates=${report.verdicts.length}${report.quotaSkipped?.length ? ` quota-skipped: ${report.quotaSkipped.join(", ")}` : ""}${report.quotaStale?.length ? ` quota-stale: ${report.quotaStale.join(", ")}` : ""}${report.quotaOver?.length ? ` quota-over: ${report.quotaOver.join(", ")} quota-room: ${report.quotaRoom?.length ? report.quotaRoom.join(", ") : "none"}` : ""}`,
    ...report.verdicts.map((v) => `AUTOPILOT_CANDIDATE #${v.taskId} ${v.verdict} ${v.verdict === "LAUNCH" ? `would-launch${report.machines && v.machine ? ` machine=${v.machine}` : ""}` : v.reasons.join(", ")}`),
  ];
};

/** The `--json` shape of `dori autopilot candidates`. */
export const candidatesJson = (report: CandidatesReport) => ({
  paused: report.paused,
  slots: report.slots,
  ...(report.machines ? { machines: report.machines } : {}),
  candidates: report.verdicts.map((v) => ({ taskId: v.taskId, verdict: v.verdict, reasons: v.reasons, ...(report.machines && v.machine ? { machine: v.machine } : {}) })),
  ...(report.quotaSkipped?.length ? { quotaSkipped: report.quotaSkipped } : {}),
  ...(report.quotaStale?.length ? { quotaStale: report.quotaStale } : {}),
  ...(report.quotaOver?.length ? { quotaOver: report.quotaOver, quotaRoom: report.quotaRoom ?? [] } : {}),
});
