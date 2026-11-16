import type { CandidatesReport } from "./autopilot.ts";

/**
 * The supervisor's autopilot tick: every `tickMs` (config `autopilot.tickSec`) it judges the autopilot candidates (as
 * `dori autopilot candidates` does). Autopilot is always on; only a pause (`dori autopilot pause`) keeps it from waking
 * the lead. Otherwise it wakes the lead with an urgent `AUTOPILOT_READY` only when the LAUNCH set holds a task id the
 * last wake did not name, and once more every
 * AUTOPILOT_RENOTIFY_MS (naming the current set) while launchable tasks stay unlaunched. A set that only shrinks or
 * changes slots wakes no one; the remembered set silently follows it. A tick that finds nothing to launch forgets the
 * set, so the same ids coming back are news again. A toodo event (kick) brings the next tick forward once the burst
 * has settled: AUTOPILOT_KICK_QUIET_MS after the last kick, or AUTOPILOT_KICK_MAX_MS after the first. Reservations and
 * lane changes raise no toodo event, so an optional `localState` key is compared every pass and a change kicks. The
 * remembered set lives in memory: a supervisor restart announces a waiting set once more.
 *
 * With the optional `execute` dep and `executorOn()` true (config `autopilot.executor`), every judged tick hands its LAUNCH ids
 * to the executor first (an empty list on a pause or an empty set, so open sequences still resume) and wakes the lead only
 * for ids the executor did not take over: a result of kind review, disabled or refused, or none at all. launched, held,
 * paused, failed and ambiguous ids are the executor's (it journals its own AUTOPILOT_EXECUTOR_* notices). With the switch off
 * nothing is executed and the wake is exactly the one above.
 */

export const AUTOPILOT_RENOTIFY_MS = 30 * 60_000;
export const AUTOPILOT_KICK_QUIET_MS = 10_000;
export const AUTOPILOT_KICK_MAX_MS = 60_000;
/** The toodo-server stream events that bring the next tick forward (tasks-changed covers a mark set or cleared). */
export const AUTOPILOT_KICK_EVENTS: ReadonlySet<string> = new Set(["task-ready", "task-status-changed", "resync", "tasks-changed"]);

export type AutopilotTickDeps = {
  /** Read every pass, so a config reload applies live. */
  readonly tickMs: () => number;
  /** judgeCandidates over the live reads; throws when toodo cannot be read. */
  readonly judge: () => Promise<CandidatesReport>;
  /** An opaque key of supervisor-local state (reservations, lanes) that raises no toodo event; a change kicks. */
  readonly localState?: () => Promise<string>;
  /** Read every pass: whether `execute` is used (config `autopilot.executor`). */
  readonly executorOn?: () => boolean;
  /** Hands LAUNCH ids to the executor (reconciling open sequences first); a throw is logged and the tick goes on. */
  readonly execute?: (ids: readonly number[]) => Promise<readonly { taskId: number; kind: string }[]>;
  readonly enqueue: (id: string, line: string) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
};

/** The urgent line for a LAUNCH set: `AUTOPILOT_READY #12,#15 slots=1`, `again` on a reminder. */
export const readyLine = (ids: readonly number[], slots: number | null, again: boolean): string =>
  `AUTOPILOT_READY ${ids.map((id) => `#${id}`).join(",")} slots=${slots ?? "unlimited"}${again ? " again" : ""}`;

/** Executor outcomes that leave the task to the lead (the executor started nothing and sent no notice for them). */
const LEAD_KINDS: ReadonlySet<string> = new Set(["review", "disabled", "refused"]);

export class AutopilotTick {
  private nextAt = Number.NEGATIVE_INFINITY;
  private firstKickAt: number | undefined;
  private lastKickAt = Number.NEGATIVE_INFINITY;
  private remembered: { ids: readonly number[]; slots: number | null; at: number } | undefined;
  private lastError: string | undefined;
  private localKey: string | undefined;
  private lastLocalError: string | undefined;
  private lastExecuteError: string | undefined;

  constructor(private readonly deps: AutopilotTickDeps) {}

  /** A toodo change: the next pass judges once kicks pause for AUTOPILOT_KICK_QUIET_MS, or AUTOPILOT_KICK_MAX_MS after the first. */
  kick(): void {
    const now = this.deps.now();
    this.firstKickAt ??= now;
    this.lastKickAt = now;
  }

  due(now: number): boolean {
    if (now >= this.nextAt) return true;
    return this.firstKickAt !== undefined &&
      (now - this.lastKickAt >= AUTOPILOT_KICK_QUIET_MS || now - this.firstKickAt >= AUTOPILOT_KICK_MAX_MS);
  }

  private async checkLocalState(): Promise<void> {
    if (!this.deps.localState) return;
    try {
      const key = await this.deps.localState();
      if (this.localKey !== undefined && key !== this.localKey) this.kick();
      this.localKey = key;
      this.lastLocalError = undefined;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== this.lastLocalError) this.deps.log(`AUTOPILOT_LOCAL_STATE_ERROR ${why}`);
      this.lastLocalError = why;
    }
  }

  /** Runs the executor over `ids`; returns the ids of `all` the lead must still hear about. An executor that throws leaves them to the lead. */
  private async execute(ids: readonly number[], all: readonly number[]): Promise<number[]> {
    try {
      const results = await this.deps.execute!(ids);
      this.lastExecuteError = undefined;
      return all.filter((id) => !ids.includes(id) || results.every((r) => r.taskId !== id || LEAD_KINDS.has(r.kind)) );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== this.lastExecuteError) this.deps.log(`AUTOPILOT_EXECUTOR_ERROR ${why}`);
      this.lastExecuteError = why;
      return [...all];
    }
  }

  /** One pass: judges when due. Never throws; an unreadable toodo is logged once per distinct error and retried next tick. */
  async tick(): Promise<void> {
    await this.checkLocalState();
    const now = this.deps.now();
    if (!this.due(now)) return;
    this.nextAt = now + this.deps.tickMs();
    this.firstKickAt = undefined;
    let report: CandidatesReport;
    try {
      report = await this.deps.judge();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== this.lastError) this.deps.log(`AUTOPILOT_TICK_ERROR ${why}`);
      this.lastError = why;
      return;
    }
    if (this.lastError !== undefined) this.deps.log("AUTOPILOT_TICK_OK");
    this.lastError = undefined;
    let ids = report.verdicts.filter((v) => v.verdict === "LAUNCH").map((v) => v.taskId).sort((a, b) => a - b);
    if (this.deps.execute && this.deps.executorOn?.()) ids = await this.execute(report.paused ? [] : ids, ids);
    // A pause wakes no one; forgetting the set makes it news once the pause is lifted.
    if (!ids.length || report.paused) { this.remembered = undefined; return; }
    const prev = this.remembered;
    if (!prev || ids.some((id) => !prev.ids.includes(id))) {
      this.remembered = { ids, slots: report.slots, at: now };
      this.deps.enqueue(`autopilot-ready:${now}`, readyLine(ids, report.slots, false));
      return;
    }
    // Only a shrink or a slots change: follow it silently, keeping the time of the last wake.
    this.remembered = { ids, slots: report.slots, at: prev.at };
    if (now - prev.at < AUTOPILOT_RENOTIFY_MS) return;
    this.remembered.at = now;
    this.deps.enqueue(`autopilot-ready:${now}`, readyLine(ids, report.slots, true));
  }
}
