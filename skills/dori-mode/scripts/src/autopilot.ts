import { createHash } from "node:crypto";

import { OPEN_STATES, type Operation, type OperationStore, operationId, plan, settleOperation } from "./operations.ts";

/**
 * Autopilot core (shadow mode): the pure selection predicate over toodo tasks, owner-approved bundles and the launch
 * ledger, plus the operation rows that hold bundles and shadow judgments. Nothing here performs I/O beyond the given
 * OperationStore, launches a lane or mutates toodo; callers read toodo, the registry, quota and the host guard and pass
 * plain data in.
 *
 * Rows:
 * - bundle: lane `autopilot`, action `autopilot-bundle`, target `<bundleId>`, data = Bundle JSON. `planned` while in
 *   force (prune keeps it); settled `verified` with detail `revoked ...` when revoked as a whole.
 * - launch attempt (read only here): lane `toodo:<taskId>`, action `autopilot-launch`, target `<attempt number>`,
 *   data `{ bundleId, bundleVersion, laneKey }`.
 * - shadow judgment: lane `autopilot`, action `autopilot-shadow`, target `<taskId>@<hour slot ISO>`, state `verified`,
 *   detail `<VERDICT> <reasons>`.
 */

export const AUTOPILOT_LANE = "autopilot";
export const BUNDLE_ACTION = "autopilot-bundle";
export const LAUNCH_ACTION = "autopilot-launch";
export const SHADOW_ACTION = "autopilot-shadow";
const BUNDLE_ID = /^[a-z0-9-]+$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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
};

export type BundleMember = {
  readonly hash: string;
  readonly dependsOn: readonly number[];
  readonly workspaceId: number;
  readonly revokedAt?: number;
};

/** The owner's approval of a closed list of task ids, as stored in the bundle row's data. */
export type Bundle = {
  readonly v: 1;
  readonly bundleId: string;
  readonly ownerRef: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
  readonly attemptBudget: number;
  readonly members: Readonly<Record<string, BundleMember>>;
  readonly revokedAt?: number;
};

// ---------------------------------------------------------------------------------------------------------------------
// Config

export type AutopilotConfig = {
  /** Toodo workspace ids autopilot may act in; empty refuses every task. */
  readonly workspaces: readonly number[];
  readonly bundleExpiryDays: number;
  /** Concurrent autopilot lanes, already clamped to wipCap. */
  readonly wip: number;
  readonly wipCap: number;
  readonly attemptCap: number;
  readonly quotaMaxUsedPct: number;
  readonly quotaUnreadable: "hold";
  readonly mergeBase: string;
  readonly onRevoke: "stop-new";
  readonly crossWorkspacePrereqs: "block";
  readonly mode: "shadow";
};

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  workspaces: [], bundleExpiryDays: 7, wip: 1, wipCap: 2, attemptCap: 2, quotaMaxUsedPct: 80, quotaUnreadable: "hold",
  mergeBase: "dev", onRevoke: "stop-new", crossWorkspacePrereqs: "block", mode: "shadow",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

/**
 * The config's `autopilot` (absent: DEFAULT_AUTOPILOT; each key optional). Throws TypeError naming the key on an
 * unknown key or an invalid value. A `wip` above `wipCap` is clamped to it and reported through `warn`.
 */
export const parseAutopilotConfig = (raw: unknown, warn: (line: string) => void = () => {}): AutopilotConfig => {
  if (raw === undefined) return DEFAULT_AUTOPILOT;
  if (!isRecord(raw)) throw new TypeError("autopilot must be an object");
  const known = new Set(Object.keys(DEFAULT_AUTOPILOT));
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new TypeError(`autopilot.${key} is not a known key`);
  const pick = <T>(key: keyof AutopilotConfig, ok: (v: unknown) => boolean, what: string): T => {
    const v = raw[key];
    if (v === undefined) return DEFAULT_AUTOPILOT[key] as T;
    if (!ok(v)) throw new TypeError(`autopilot.${key} must be ${what}, not ${JSON.stringify(v)}`);
    return v as T;
  };
  const only = (value: string) => (v: unknown) => v === value;
  const workspaces = pick<number[]>("workspaces", (v) => Array.isArray(v) && v.every((w) => Number.isSafeInteger(w) && w >= 0), "an array of toodo workspace ids");
  const wipCap = pick<number>("wipCap", isPositiveInt, "a positive integer");
  let wip = pick<number>("wip", isPositiveInt, "a positive integer");
  if (wip > wipCap) {
    warn(`autopilot.wip ${wip} is above autopilot.wipCap ${wipCap}; using ${wipCap}`);
    wip = wipCap;
  }
  return {
    workspaces: [...new Set(workspaces)],
    bundleExpiryDays: pick<number>("bundleExpiryDays", isPositiveInt, "a positive integer"),
    wip,
    wipCap,
    attemptCap: pick<number>("attemptCap", isPositiveInt, "a positive integer"),
    quotaMaxUsedPct: pick<number>("quotaMaxUsedPct", (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100, "a number in (0, 100]"),
    quotaUnreadable: pick<"hold">("quotaUnreadable", only("hold"), "\"hold\""),
    mergeBase: pick<string>("mergeBase", (v) => typeof v === "string" && v.trim() !== "" && v === v.trim(), "a branch name"),
    onRevoke: pick<"stop-new">("onRevoke", only("stop-new"), "\"stop-new\""),
    crossWorkspacePrereqs: pick<"block">("crossWorkspacePrereqs", only("block"), "\"block\""),
    mode: pick<"shadow">("mode", only("shadow"), "\"shadow\""),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Member hash

/** JSON with object keys sorted at every level, so equal values always serialize to the same string. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * sha256 hex of the approved content: workspace, title, description, criteria (text, kind, target) and the dependency
 * set. Criterion check state, notes, labels, refs, timeline and status are not hashed, so progress never invalidates it.
 */
export const memberHash = (task: Pick<ToodoTask, "workspaceId" | "title" | "description" | "criteria" | "dependsOn">): string =>
  createHash("sha256").update(canonicalJson({
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    criteria: task.criteria.map((c) => ({ text: c.text, kind: c.kind, target: c.target ?? null })),
    dependsOn: [...task.dependsOn].sort((a, b) => a - b),
  })).digest("hex");

// ---------------------------------------------------------------------------------------------------------------------
// Bundles

export const bundleOpId = (bundleId: string): string => operationId({ lane: AUTOPILOT_LANE, action: BUNDLE_ACTION, target: bundleId });

/** A bundle approving `tasks` as read from toodo now. Throws TypeError on a bad id, owner ref, expiry, budget or empty list. */
export const buildBundle = (input: {
  readonly bundleId: string; readonly ownerRef: string; readonly now: number; readonly tasks: readonly ToodoTask[];
  readonly expiresDays: number; readonly attemptBudget: number;
}): Bundle => {
  if (!BUNDLE_ID.test(input.bundleId)) throw new TypeError(`bundle id must match [a-z0-9-]+, not ${JSON.stringify(input.bundleId)}`);
  if (!input.ownerRef.trim()) throw new TypeError("owner ref must be non-empty");
  if (!isPositiveInt(input.expiresDays)) throw new TypeError("expires days must be a positive integer");
  if (!isPositiveInt(input.attemptBudget)) throw new TypeError("attempts must be a positive integer");
  if (input.tasks.length === 0) throw new TypeError("a bundle needs at least one task");
  const members: Record<string, BundleMember> = {};
  for (const task of input.tasks) {
    members[String(task.id)] = { hash: memberHash(task), dependsOn: [...task.dependsOn].sort((a, b) => a - b), workspaceId: task.workspaceId };
  }
  return {
    v: 1, bundleId: input.bundleId, ownerRef: input.ownerRef, approvedAt: input.now,
    expiresAt: input.now + input.expiresDays * DAY_MS, attemptBudget: input.attemptBudget, members,
  };
};

/** Stores `bundle` as its row (state planned). Approving an existing id again replaces its data and puts it back in force. */
export const saveBundle = (store: OperationStore, now: number, bundle: Bundle): Operation => {
  const spec = { lane: AUTOPILOT_LANE, action: BUNDLE_ACTION, target: bundle.bundleId, data: JSON.stringify(bundle) };
  const detail = `approved ${Object.keys(bundle.members).length} task(s) by ${bundle.ownerRef}`;
  const base = store.get(bundleOpId(bundle.bundleId)) ?? plan(store, now, spec);
  const next: Operation = { ...base, data: spec.data, state: "planned", detail, updatedAt: now };
  store.put(next);
  return next;
};

const parseBundle = (op: Operation): Bundle => {
  let data: unknown;
  try { data = JSON.parse(op.data ?? ""); } catch { data = undefined; }
  if (!isRecord(data) || data.v !== 1 || typeof data.bundleId !== "string" || !isRecord(data.members)) {
    throw new TypeError(`autopilot bundle row ${op.id} has unreadable data`);
  }
  return data as Bundle;
};

/** Every stored bundle, in force, expired or revoked (oldest first). Throws TypeError on a row whose data is unreadable. */
export const listBundles = (store: OperationStore): Bundle[] =>
  store.list({ lane: AUTOPILOT_LANE }).filter((op) => op.action === BUNDLE_ACTION).map(parseBundle);

/** Neither revoked nor expired at `now`. */
export const bundleInForce = (bundle: Bundle, now: number): boolean => bundle.revokedAt === undefined && now < bundle.expiresAt;

/**
 * Revokes a whole bundle (row settled verified, detail `revoked ...`) or, with `taskId`, one member (row stays planned).
 * Undefined when the bundle, or the member, is unknown. Revoking again keeps the first revokedAt.
 */
export const revokeBundle = (store: OperationStore, now: number, id: string, taskId?: number, reason?: string): Operation | undefined => {
  const op = store.get(bundleOpId(id));
  if (!op) return undefined;
  const bundle = parseBundle(op);
  const why = reason?.trim() || "by owner";
  if (taskId === undefined) {
    const next: Bundle = { ...bundle, revokedAt: bundle.revokedAt ?? now };
    store.put({ ...op, data: JSON.stringify(next) });
    return settleOperation(store, now, op.id, "verified", `revoked ${why}`);
  }
  const member = bundle.members[String(taskId)];
  if (!member) return undefined;
  const next: Bundle = { ...bundle, members: { ...bundle.members, [String(taskId)]: { ...member, revokedAt: member.revokedAt ?? now } } };
  store.put({ ...op, data: JSON.stringify(next) });
  return settleOperation(store, now, op.id, op.state, `member ${taskId} revoked ${why}`);
};

// ---------------------------------------------------------------------------------------------------------------------
// Ledger

export type LedgerState = { readonly attempts: number; readonly ambiguous: boolean; readonly live: boolean };

/** Every launch-attempt row in the store. */
export const ledgerRows = (store: OperationStore): Operation[] =>
  store.list().filter((op) => op.action === LAUNCH_ACTION && op.lane.startsWith("toodo:"));

const rowsOf = (rows: readonly Operation[], taskId: number): Operation[] =>
  rows.filter((op) => op.action === LAUNCH_ACTION && op.lane === `toodo:${taskId}`);

const laneKeyOf = (op: Operation): string | undefined => {
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

/** Launch attempts used for `taskId`. */
export const attemptsOf = (rows: readonly Operation[], taskId: number): number => rowsOf(rows, taskId).length;

export const ledgerState = (rows: readonly Operation[], taskId: number, openLanes: ReadonlySet<string>): LedgerState => {
  const mine = rowsOf(rows, taskId);
  return { attempts: mine.length, ambiguous: mine.some((op) => op.state === "ambiguous"), live: mine.some((op) => rowLive(op, openLanes)) };
};

/** WIP in use across all tasks: rows that are open, or verified with a live laneKey. */
export const wipInUse = (rows: readonly Operation[], openLanes: ReadonlySet<string>): number =>
  rows.filter((op) => op.action === LAUNCH_ACTION && rowLive(op, openLanes)).length;

export const wipLimit = (config: AutopilotConfig): number => Math.min(config.wip, config.wipCap);

// ---------------------------------------------------------------------------------------------------------------------
// Predicate

export type VerdictKind = "LAUNCH" | "HOLD" | "REFUSE";

export const REFUSE_REASONS = [
  "not-a-bundle-member", "bundle-expired", "bundle-revoked", "member-revoked", "hash-changed", "task-missing", "not-planned",
  "workspace-not-allowed", "prerequisite-missing", "prerequisite-not-adopted", "cross-workspace-prerequisite", "attempt-cap",
  "ledger-ambiguous",
] as const;
export const HOLD_REASONS = [
  "waiting", "prerequisite-open", "lane-live", "wip-full", "quota-unreadable", "quota-over-threshold", "host-hold", "toodo-unreadable",
] as const;
export type Reason = (typeof REFUSE_REASONS)[number] | (typeof HOLD_REASONS)[number];

export type Verdict = {
  readonly taskId: number;
  /** The bundle the task was judged under; null when no bundle lists it. */
  readonly bundleId: string | null;
  readonly verdict: VerdictKind;
  readonly reasons: readonly Reason[];
};

export type QuotaSummary = { readonly readable: boolean; readonly maxUsedPct?: number };
export type HostSummary = { readonly ok: boolean; readonly reason?: string };

export type JudgeContext = {
  /** Tasks returned by toodo, keyed by id, including every dependency; null when toodo-server could not be read. */
  readonly tasks: ReadonlyMap<number, ToodoTask> | null;
  readonly bundles: readonly Bundle[];
  /** Launch-attempt rows (ledgerRows). */
  readonly ledger: readonly Operation[];
  /** Keys of open registry lanes. */
  readonly openLanes: ReadonlySet<string>;
  /** Highest 5h/7d used percentage over the Claude accounts. */
  readonly quota: QuotaSummary;
  /** The `dori can-launch` verdict for the default machine. */
  readonly host: HostSummary;
  readonly config: AutopilotConfig;
  readonly now: number;
};

export type JudgeInput = JudgeContext & { readonly taskId: number };

const REFUSE_SET: ReadonlySet<string> = new Set(REFUSE_REASONS);
const ORDER: readonly Reason[] = [...REFUSE_REASONS, ...HOLD_REASONS];

/**
 * The bundle a task is judged under: the latest-approved one in force with the member not revoked; otherwise the
 * latest-approved one listing it (its revoke or expiry is the reason). Undefined when no bundle lists the task.
 */
const bundleFor = (bundles: readonly Bundle[], taskId: number, now: number): Bundle | undefined => {
  const listing = bundles.filter((b) => b.members[String(taskId)] !== undefined).sort((a, b) => b.approvedAt - a.approvedAt);
  return listing.find((b) => bundleInForce(b, now) && b.members[String(taskId)]!.revokedAt === undefined) ?? listing[0];
};

/** A dependency counts as satisfied only when done with resolution merged or completed. */
const depSatisfied = (dep: ToodoTask): boolean => dep.status === "done" && (dep.resolution === "merged" || dep.resolution === "completed");

/**
 * Judges one task. Every failing reason is collected; the verdict is REFUSE if any reason is a refusal, else HOLD if
 * any reason holds, else LAUNCH. Reasons come in REFUSE_REASONS then HOLD_REASONS order. When toodo is unreadable
 * the task holds with `toodo-unreadable` alone.
 */
export const judge = (input: JudgeInput): Verdict => {
  const { taskId, tasks, config, now } = input;
  const bundle = bundleFor(input.bundles, taskId, now);
  const bundleId = bundle?.bundleId ?? null;
  if (tasks === null) return { taskId, bundleId, verdict: "HOLD", reasons: ["toodo-unreadable"] };
  const found = new Set<Reason>();
  const member = bundle?.members[String(taskId)];
  const task = tasks.get(taskId);

  if (!bundle || !member) found.add("not-a-bundle-member");
  else {
    if (bundle.revokedAt !== undefined) found.add("bundle-revoked");
    else if (now >= bundle.expiresAt) found.add("bundle-expired");
    if (member.revokedAt !== undefined) found.add("member-revoked");
    if (task && memberHash(task) !== member.hash) found.add("hash-changed");
  }

  if (!task) found.add("task-missing");
  else {
    if (task.wait !== null) found.add("waiting");
    else if (task.status !== "planned") found.add("not-planned");
    if (!config.workspaces.includes(task.workspaceId)) found.add("workspace-not-allowed");
    if (task.refs.some((ref) => ref.startsWith("lane:") && input.openLanes.has(ref.slice("lane:".length)))) found.add("lane-live");
  }

  // Approved and current dependencies both gate the launch: a removed one is caught by the hash, an added one here too.
  const workspaceId = task?.workspaceId ?? member?.workspaceId;
  for (const depId of new Set([...(member?.dependsOn ?? []), ...(task?.dependsOn ?? [])])) {
    const dep = tasks.get(depId);
    if (!dep) { found.add("prerequisite-missing"); continue; }
    if (workspaceId !== undefined && dep.workspaceId !== workspaceId) found.add("cross-workspace-prerequisite");
    if (dep.status === "done" && dep.resolution === "not_adopted") found.add("prerequisite-not-adopted");
    else if (!depSatisfied(dep)) found.add("prerequisite-open");
  }

  const ledger = ledgerState(input.ledger, taskId, input.openLanes);
  if (ledger.attempts >= Math.min(config.attemptCap, bundle?.attemptBudget ?? config.attemptCap)) found.add("attempt-cap");
  if (ledger.ambiguous) found.add("ledger-ambiguous");
  if (ledger.live) found.add("lane-live");
  if (wipInUse(input.ledger, input.openLanes) >= wipLimit(config)) found.add("wip-full");

  if (!input.quota.readable) found.add("quota-unreadable");
  else if (input.quota.maxUsedPct !== undefined && input.quota.maxUsedPct >= config.quotaMaxUsedPct) found.add("quota-over-threshold");
  if (!input.host.ok) found.add("host-hold");

  const reasons = ORDER.filter((r) => found.has(r));
  const verdict: VerdictKind = reasons.some((r) => REFUSE_SET.has(r)) ? "REFUSE" : reasons.length > 0 ? "HOLD" : "LAUNCH";
  return { taskId, bundleId, verdict, reasons };
};

/** Task ids listed by a bundle in force at `now` (revoked members included), ascending. */
export const candidateIds = (bundles: readonly Bundle[], now: number): number[] =>
  [...new Set(bundles.filter((b) => bundleInForce(b, now)).flatMap((b) => Object.keys(b.members).map(Number)))].sort((a, b) => a - b);

/** Judges every member of every in-force bundle, plus `extraTaskIds` (e.g. ready tasks nobody approved), ascending by id. */
export const judgeAll = (ctx: JudgeContext, extraTaskIds: readonly number[] = []): Verdict[] =>
  [...new Set([...candidateIds(ctx.bundles, ctx.now), ...extraTaskIds])].sort((a, b) => a - b).map((taskId) => judge({ ...ctx, taskId }));

// ---------------------------------------------------------------------------------------------------------------------
// Shadow rows and output

/** The current hour floored, as a UTC ISO string. */
export const shadowSlot = (now: number): string => new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();

const verdictDetail = (v: Verdict): string => `${v.verdict}${v.reasons.length ? ` ${v.reasons.join(", ")}` : ""}`;

/** Writes one verified shadow row per verdict for the current hour; a row already written this hour is kept as is. */
export const recordShadow = (store: OperationStore, now: number, verdicts: readonly Verdict[]): Operation[] =>
  verdicts.map((v) => {
    const op = plan(store, now, { lane: AUTOPILOT_LANE, action: SHADOW_ACTION, target: `${v.taskId}@${shadowSlot(now)}` });
    return op.state === "planned" ? settleOperation(store, now, op.id, "verified", verdictDetail(v))! : op;
  });

export type CandidatesReport = {
  readonly mode: AutopilotConfig["mode"];
  readonly wip: { readonly inUse: number; readonly limit: number };
  readonly bundles: number;
  readonly verdicts: readonly Verdict[];
};

/** Text output of `dori autopilot candidates`: a header line and one line per verdict, or AUTOPILOT_NO_BUNDLES. */
export const formatCandidates = (report: CandidatesReport): string[] => {
  if (report.bundles === 0 && report.verdicts.length === 0) return ["AUTOPILOT_NO_BUNDLES"];
  return [
    `AUTOPILOT mode=${report.mode} record-only: nothing launches wip=${report.wip.inUse}/${report.wip.limit} bundles=${report.bundles}`,
    ...report.verdicts.map((v) =>
      `AUTOPILOT_CANDIDATE #${v.taskId} ${v.verdict} bundle=${v.bundleId ?? "-"} ${v.verdict === "LAUNCH" ? "would-launch" : v.reasons.join(", ")}`),
  ];
};

/** The `--json` shape of `dori autopilot candidates`. */
export const candidatesJson = (report: CandidatesReport) => ({
  mode: report.mode,
  wip: report.wip,
  candidates: report.verdicts.map((v) => ({ taskId: v.taskId, bundleId: v.bundleId, verdict: v.verdict, reasons: v.reasons })),
});
