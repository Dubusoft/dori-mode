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
  readonly quotaMaxUsedPct: number;
  readonly quotaUnreadable: "hold";
  readonly mergeBase: string;
  readonly crossWorkspacePrereqs: "block";
  /** Seconds between the supervisor's autopilot ticks. */
  readonly tickSec: number;
};

export const TICK_SEC_MIN = 30;
export const TICK_SEC_MAX = 3600;

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  quotaMaxUsedPct: 80, quotaUnreadable: "hold", mergeBase: "dev", crossWorkspacePrereqs: "block", tickSec: 300,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Keys read as nothing so an older config still loads: the bundle design's, and `mode` (autopilot is always on; `dori
 * setup` removes it, see config-schema.ts).
 */
const REMOVED_KEYS: ReadonlySet<string> = new Set(["workspaces", "bundleExpiryDays", "wip", "wipCap", "attemptCap", "onRevoke", "mode"]);

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
    quotaMaxUsedPct: pick<number>("quotaMaxUsedPct", (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100, "a number in (0, 100]"),
    quotaUnreadable: pick<"hold">("quotaUnreadable", only("hold"), "\"hold\""),
    mergeBase: pick<string>("mergeBase", (v) => typeof v === "string" && v.trim() !== "" && v === v.trim(), "a branch name"),
    crossWorkspacePrereqs: pick<"block">("crossWorkspacePrereqs", only("block"), "\"block\""),
    tickSec: pick<number>("tickSec", (v) => Number.isInteger(v) && (v as number) >= TICK_SEC_MIN && (v as number) <= TICK_SEC_MAX,
      `an integer from ${TICK_SEC_MIN} to ${TICK_SEC_MAX}`),
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

/** A row still running: open (planned/attempted), or verified with its laneKey an open registry lane. */
const rowLive = (op: Operation, openLanes: ReadonlySet<string>): boolean => {
  if (OPEN_STATES.includes(op.state)) return true;
  if (op.state !== "verified") return false;
  const key = laneKeyOf(op);
  return key !== undefined && openLanes.has(key);
};

/**
 * Reservations of other tasks not running as a lane yet (open rows whose laneKey is no open lane): each takes one host
 * slot that the pane count does not show.
 */
export const pendingReservations = (rows: readonly Operation[], openLanes: ReadonlySet<string>, exceptTaskId?: number): number =>
  rows.filter((op) => op.action === LAUNCH_ACTION && (exceptTaskId === undefined || op.lane !== `toodo:${exceptTaskId}`) && OPEN_STATES.includes(op.state))
    .filter((op) => { const key = laneKeyOf(op); return key === undefined || !openLanes.has(key); }).length;

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
};

export type QuotaSummary = { readonly readable: boolean; readonly maxUsedPct?: number };
/**
 * The `dori can-launch` verdict for the default machine; `slots` is how many more lanes its pane limit allows
 * (absent when the pane limit is off, so nothing caps the count).
 */
export type HostSummary = { readonly ok: boolean; readonly reason?: string; readonly slots?: number };

export type JudgeContext = {
  /** Tasks returned by toodo, keyed by id, including every dependency. */
  readonly tasks: ReadonlyMap<number, ToodoTask>;
  /** Launch-attempt rows (ledgerRows). */
  readonly ledger: readonly Operation[];
  /** Keys of open registry lanes. */
  readonly openLanes: ReadonlySet<string>;
  /** Highest 5h/7d used percentage over the Claude accounts. */
  readonly quota: QuotaSummary;
  readonly host: HostSummary;
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
  else if (input.quota.maxUsedPct !== undefined && input.quota.maxUsedPct >= config.quotaMaxUsedPct) found.add("quota-over-threshold");
  if (!input.host.ok) found.add("host-hold");

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
 * Judges `taskIds` (ascending by id), then assigns the host's free slots: only the first `host.slots` LAUNCH tasks in
 * launch order stay LAUNCH, the rest HOLD `no-slot`. Without `host.slots` every LAUNCH task keeps its verdict.
 */
export const judgeAll = (ctx: JudgeContext, taskIds: readonly number[]): Verdict[] => {
  const verdicts = [...new Set(taskIds)].sort((a, b) => a - b).map((taskId) => judge({ ...ctx, taskId }));
  const slots = ctx.host.slots ?? Number.POSITIVE_INFINITY;
  const launching = verdicts.filter((v) => v.verdict === "LAUNCH").map((v) => v.taskId).sort(launchOrder(ctx.tasks));
  const noSlot = new Set(launching.slice(Math.max(0, slots)));
  return verdicts.map((v) => noSlot.has(v.taskId) ? verdictOf(v.taskId, new Set<Reason>(["no-slot"])) : v);
};

// ---------------------------------------------------------------------------------------------------------------------
// Output

export type CandidatesReport = {
  /** `dori autopilot pause` is in force: nothing launches. */
  readonly paused: boolean;
  /** Free host slots; null when the pane limit is off. */
  readonly slots: number | null;
  readonly verdicts: readonly Verdict[];
};

/** Text output of `dori autopilot candidates`: a header line and one line per verdict, or AUTOPILOT_NO_CANDIDATES. */
export const formatCandidates = (report: CandidatesReport): string[] => {
  if (report.verdicts.length === 0) return ["AUTOPILOT_NO_CANDIDATES"];
  return [
    `AUTOPILOT${report.paused ? " paused: nothing launches" : ""} slots=${report.slots ?? "unlimited"} candidates=${report.verdicts.length}`,
    ...report.verdicts.map((v) => `AUTOPILOT_CANDIDATE #${v.taskId} ${v.verdict} ${v.verdict === "LAUNCH" ? "would-launch" : v.reasons.join(", ")}`),
  ];
};

/** The `--json` shape of `dori autopilot candidates`. */
export const candidatesJson = (report: CandidatesReport) => ({
  paused: report.paused,
  slots: report.slots,
  candidates: report.verdicts.map((v) => ({ taskId: v.taskId, verdict: v.verdict, reasons: v.reasons })),
});
