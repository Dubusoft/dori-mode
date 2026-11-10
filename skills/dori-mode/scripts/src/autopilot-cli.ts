import { parseArgs } from "node:util";

import {
  type AutopilotConfig, type Bundle, buildBundle, bundleInForce, candidateIds, candidatesJson, type CandidatesReport, formatCandidates,
  type HostSummary, judgeAll, ledgerRows, listBundles, type QuotaSummary, recordShadow, revokeBundle, saveBundle, type ToodoTask,
  wipInUse, wipLimit,
} from "./autopilot.ts";
import type { ClaudeUsage } from "./claude-quota.ts";
import type { OperationStore } from "./operations.ts";
import { ToodoUnreadable } from "./toodo-client.ts";

/**
 * `dori autopilot` (shadow mode, lead-only): judges owner-approved bundle members, stores and revokes bundles, and adds
 * the hourly reconcile job. Nothing here launches a lane, writes to toodo or merges: candidates only reads (and with
 * --record writes shadow rows), approve and revoke write bundle rows, schedule writes one schedule job.
 */

export const AUTOPILOT_USAGE = [
  "usage: dori autopilot candidates [--json] [--record]",
  "       dori autopilot approve <bundleId> --tasks 12,13 --owner-ref <ref> [--expires-days N] [--attempts N]",
  "       dori autopilot revoke <bundleId> [--task N] [--reason TEXT]",
  "       dori autopilot bundles [--json]",
  "       dori autopilot schedule",
].join("\n");

export const RECONCILE_JOB = "autopilot-reconcile";
export const RECONCILE_KIND = "AUTOPILOT_RECONCILE";
export const RECONCILE_CRON = "0 * * * *";

/** The toodo reads autopilot needs; any failure throws (ToodoUnreadable from the real client). */
export type ToodoReader = { readonly tasksByIds: (ids: readonly number[]) => Promise<ToodoTask[]> };

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
  /** The can-launch verdict of the default machine; must not throw. */
  readonly host: () => Promise<HostSummary>;
  readonly schedules: () => ScheduleRegistry;
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
  json: { type: "boolean" }, record: { type: "boolean" }, tasks: { type: "string" }, "owner-ref": { type: "string" },
  "expires-days": { type: "string" }, attempts: { type: "string" }, task: { type: "string" }, reason: { type: "string" },
} as const;
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  candidates: ["json", "record"], approve: ["tasks", "owner-ref", "expires-days", "attempts"], revoke: ["task", "reason"],
  bundles: ["json"], schedule: [],
};

const positiveInt = (flag: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${flag} must be a positive integer, not ${JSON.stringify(value)}`);
  return Number(value);
};

const taskIds = (value: string | undefined): number[] => {
  const parts = (value ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) throw new UsageError("--tasks must be a comma-separated list of toodo task ids");
  return [...new Set(parts.map(Number))];
};

const bundleState = (b: Bundle, now: number): "in-force" | "revoked" | "expired" =>
  b.revokedAt !== undefined ? "revoked" : bundleInForce(b, now) ? "in-force" : "expired";

/** Judges every in-force bundle member and prints the report; --record writes one shadow row per task this hour. */
const candidates = async (deps: AutopilotDeps, json: boolean, record: boolean): Promise<number> => {
  const now = deps.now();
  const bundles = listBundles(deps.store);
  const ids = candidateIds(bundles, now);
  const ledger = ledgerRows(deps.store);
  const openLanes = await deps.openLanes();
  let tasks: Map<number, ToodoTask> | null = new Map();
  let quota: QuotaSummary = { readable: true };
  let host: HostSummary = { ok: true };
  if (ids.length) {
    // Members and their approved dependencies in one read; dependencies added since approval in a second.
    const inForce = bundles.filter((b) => bundleInForce(b, now));
    const approvedDeps = inForce.flatMap((b) => Object.values(b.members).flatMap((m) => m.dependsOn));
    try {
      const toodo = deps.toodo();
      const found = await toodo.tasksByIds([...ids, ...approvedDeps]);
      tasks = new Map(found.map((t) => [t.id, t]));
      const added = ids.flatMap((id) => tasks?.get(id)?.dependsOn ?? []).filter((id) => !tasks?.has(id));
      if (added.length) for (const t of await toodo.tasksByIds(added)) tasks.set(t.id, t);
    } catch (e) {
      if (!(e instanceof ToodoUnreadable)) throw e;
      deps.err(`AUTOPILOT_TOODO_UNREADABLE ${e.message}`);
      tasks = null;
    }
    [quota, host] = await Promise.all([deps.quota(), deps.host()]);
  }
  const verdicts = judgeAll({ tasks, bundles, ledger, openLanes, quota, host, config: deps.config, now });
  const report: CandidatesReport = {
    mode: deps.config.mode,
    wip: { inUse: wipInUse(ledger, openLanes), limit: wipLimit(deps.config) },
    bundles: bundles.filter((b) => bundleInForce(b, now)).length,
    verdicts,
  };
  if (record) recordShadow(deps.store, now, verdicts);
  if (json) deps.out(JSON.stringify(candidatesJson(report), null, 2));
  else for (const line of formatCandidates(report)) deps.out(line);
  return 0;
};

/** Reads the tasks from toodo now and stores their hashes as bundle `id`; refuses (exit 1) on anything it cannot approve. */
const approve = async (deps: AutopilotDeps, id: string, values: Record<string, unknown>): Promise<number> => {
  const ids = taskIds(values.tasks as string | undefined);
  const ownerRef = (values["owner-ref"] as string | undefined)?.trim();
  if (!ownerRef) throw new UsageError("--owner-ref is required");
  const expiresDays = positiveInt("expires-days", values["expires-days"] as string | undefined) ?? deps.config.bundleExpiryDays;
  const attemptBudget = positiveInt("attempts", values.attempts as string | undefined) ?? deps.config.attemptCap;
  const refuse = (why: string): number => { deps.err(`AUTOPILOT_APPROVE_REFUSED ${why}`); return 1; };
  let found: ToodoTask[];
  try { found = await deps.toodo().tasksByIds(ids); } catch (e) {
    if (!(e instanceof ToodoUnreadable)) throw e;
    return refuse(`toodo unreadable: ${e.message}`);
  }
  const byId = new Map(found.map((t) => [t.id, t]));
  const missing = ids.filter((t) => !byId.has(t));
  if (missing.length) return refuse(`task ${missing.map((t) => `#${t}`).join(", ")} is not in toodo (missing or archived)`);
  const outside = found.filter((t) => !deps.config.workspaces.includes(t.workspaceId));
  if (outside.length) return refuse(`task ${outside.map((t) => `#${t.id} (workspace ${t.workspaceId})`).join(", ")} is outside autopilot.workspaces [${deps.config.workspaces.join(", ")}]`);
  const now = deps.now();
  let bundle: Bundle;
  try { bundle = buildBundle({ bundleId: id, ownerRef, now, tasks: ids.map((t) => byId.get(t)!), expiresDays, attemptBudget }); }
  catch (e) { if (e instanceof TypeError) throw new UsageError(e.message); throw e; }
  saveBundle(deps.store, now, bundle);
  deps.out(`AUTOPILOT_BUNDLE_APPROVED ${bundle.bundleId} tasks=${ids.join(",")} expires=${new Date(bundle.expiresAt).toISOString()} attempts=${bundle.attemptBudget} owner=${bundle.ownerRef}`);
  return 0;
};

const revoke = (deps: AutopilotDeps, id: string, values: Record<string, unknown>): number => {
  const task = positiveInt("task", values.task as string | undefined);
  const reason = values.reason as string | undefined;
  const op = revokeBundle(deps.store, deps.now(), id, task, reason);
  if (!op) { deps.err(`AUTOPILOT_BUNDLE_UNKNOWN ${id}${task === undefined ? "" : ` has no member #${task}`}`); return 1; }
  deps.out(task === undefined ? `AUTOPILOT_BUNDLE_REVOKED ${id}` : `AUTOPILOT_MEMBER_REVOKED ${id} #${task}`);
  return 0;
};

const bundles = (deps: AutopilotDeps, json: boolean): number => {
  const now = deps.now();
  const all = listBundles(deps.store);
  if (json) {
    deps.out(JSON.stringify(all.map((b) => ({ ...b, state: bundleState(b, now) })), null, 2));
    return 0;
  }
  if (!all.length) { deps.out("AUTOPILOT_NO_BUNDLES"); return 0; }
  for (const b of all) {
    const members = Object.entries(b.members).map(([t, m]) => `${t}${m.revokedAt === undefined ? "" : "(revoked)"}`).join(",");
    deps.out(`AUTOPILOT_BUNDLE ${b.bundleId} ${bundleState(b, now)} tasks=${members} expires=${new Date(b.expiresAt).toISOString()} attempts=${b.attemptBudget} owner=${b.ownerRef}`);
  }
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

/** `dori autopilot <sub> ...`; returns the exit code (2 on a usage error). */
export const autopilotMain = async (args: readonly string[], deps: AutopilotDeps): Promise<number> => {
  try {
    let parsed;
    try { parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: FLAGS }); }
    catch (e) { throw new UsageError(e instanceof Error ? e.message : String(e)); }
    const [sub = "", id, ...extra] = parsed.positionals;
    const allowed = ALLOWED[sub];
    if (!allowed) throw new UsageError(sub ? `unknown subcommand ${sub}` : "a subcommand is required");
    const stray = Object.keys(parsed.values).filter((f) => !allowed.includes(f));
    if (stray.length) throw new UsageError(`${stray.map((f) => `--${f}`).join(", ")} is not an option of autopilot ${sub}`);
    const needsId = sub === "approve" || sub === "revoke";
    if (extra.length || (needsId ? !id : id !== undefined)) throw new UsageError(needsId ? `autopilot ${sub} takes one <bundleId>` : `autopilot ${sub} takes no arguments`);
    const v = parsed.values as Record<string, unknown>;
    switch (sub) {
      case "candidates": return await candidates(deps, v.json === true, v.record === true);
      case "approve": return await approve(deps, id!, v);
      case "revoke": return revoke(deps, id!, v);
      case "bundles": return bundles(deps, v.json === true);
      default: return schedule(deps);
    }
  } catch (e) {
    if (e instanceof UsageError) { deps.err(`${e.message}\n${AUTOPILOT_USAGE}`); return 2; }
    if (e instanceof TypeError || e instanceof ToodoUnreadable) { deps.err(`AUTOPILOT_FAILED ${e.message}`); return 1; }
    throw e;
  }
};
