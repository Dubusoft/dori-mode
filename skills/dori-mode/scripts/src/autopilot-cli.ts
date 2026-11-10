import { parseArgs } from "node:util";

import {
  type AutopilotConfig, candidatesJson, type CandidatesReport, formatCandidates, type HostSummary, judgeAll, ledgerRows,
  type QuotaSummary, recordShadow, type ToodoTask,
} from "./autopilot.ts";
import type { ClaudeUsage } from "./claude-quota.ts";
import type { OperationStore } from "./operations.ts";
import { ToodoUnreadable } from "./toodo-client.ts";

/**
 * `dori autopilot` (shadow mode, lead-only): judges the planned toodo tasks marked for autopilot and adds the hourly
 * reconcile job. Nothing here launches a lane, writes to toodo or merges: candidates only reads (and with --record
 * writes shadow rows), schedule writes one schedule job.
 */

export const AUTOPILOT_USAGE = [
  "usage: dori autopilot candidates [--tasks 12,13] [--json] [--record]",
  "       dori autopilot schedule",
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

const FLAGS = { json: { type: "boolean" }, record: { type: "boolean" }, tasks: { type: "string" } } as const;
const ALLOWED: Readonly<Record<string, readonly string[]>> = { candidates: ["json", "record", "tasks"], schedule: [] };

const taskIds = (value: string | undefined): number[] => {
  const parts = (value ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) throw new UsageError("--tasks must be a comma-separated list of toodo task ids");
  return [...new Set(parts.map(Number))];
};

/**
 * Judges every planned task marked for autopilot plus `extraIds` and prints the report; --record writes one shadow row
 * per task this hour. Exit 1 with AUTOPILOT_TOODO_UNREADABLE when toodo cannot be read, since nothing can be judged.
 */
const candidates = async (deps: AutopilotDeps, json: boolean, record: boolean, extraIds: readonly number[]): Promise<number> => {
  const now = deps.now();
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
    return 1;
  }
  const ids = [...new Set([...[...tasks.values()].filter((t) => t.autopilot && t.status === "planned").map((t) => t.id), ...extraIds])];
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
    if (extra.length) throw new UsageError(`autopilot ${sub} takes no arguments`);
    const v = parsed.values as Record<string, unknown>;
    if (sub === "schedule") return schedule(deps);
    const extraIds = v.tasks === undefined ? [] : taskIds(v.tasks as string);
    return await candidates(deps, v.json === true, v.record === true, extraIds);
  } catch (e) {
    if (e instanceof UsageError) { deps.err(`${e.message}\n${AUTOPILOT_USAGE}`); return 2; }
    if (e instanceof TypeError || e instanceof ToodoUnreadable) { deps.err(`AUTOPILOT_FAILED ${e.message}`); return 1; }
    throw e;
  }
};
