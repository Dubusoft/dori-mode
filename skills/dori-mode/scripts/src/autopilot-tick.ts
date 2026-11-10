import { type AutopilotMode, type CandidatesReport, recordShadow } from "./autopilot.ts";
import type { OperationStore } from "./operations.ts";

/**
 * The supervisor's autopilot tick: every `tickMs` (config `autopilot.tickSec`) it judges the autopilot candidates (as
 * `dori autopilot candidates --record` does) and writes the hourly shadow rows. Mode off judges nothing; mode shadow
 * and a pause (`dori autopilot pause`) judge and record but never wake the lead. In mode on it wakes the lead with an
 * urgent `AUTOPILOT_READY` only when the LAUNCH set (task ids and free slots) differs from the one it last announced, and once more every
 * AUTOPILOT_RENOTIFY_MS while that same set stays unlaunched. A tick that finds nothing to launch forgets the announced
 * set, so the same set coming back is news again. A toodo event (kick) brings the next tick forward, at most once per
 * AUTOPILOT_KICK_MIN_MS. The announced set lives in memory: a supervisor restart announces a waiting set once more.
 */

export const AUTOPILOT_RENOTIFY_MS = 30 * 60_000;
export const AUTOPILOT_KICK_MIN_MS = 15_000;
/** The toodo-server stream events that bring the next tick forward (tasks-changed covers a mark set or cleared). */
export const AUTOPILOT_KICK_EVENTS: ReadonlySet<string> = new Set(["task-ready", "task-status-changed", "resync", "tasks-changed"]);

export type AutopilotTickDeps = {
  /** Read every pass, so a config reload applies live. */
  readonly mode: () => AutopilotMode;
  readonly tickMs: () => number;
  /** judgeCandidates over the live reads; throws when toodo cannot be read. */
  readonly judge: () => Promise<CandidatesReport>;
  readonly store: OperationStore;
  readonly enqueue: (id: string, line: string) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
};

/** The urgent line for a LAUNCH set: `AUTOPILOT_READY #12,#15 slots=1`, `again` on a reminder. */
export const readyLine = (ids: readonly number[], slots: number | null, again: boolean): string =>
  `AUTOPILOT_READY ${ids.map((id) => `#${id}`).join(",")} slots=${slots ?? "unlimited"}${again ? " again" : ""}`;

export class AutopilotTick {
  private nextAt = Number.NEGATIVE_INFINITY;
  private lastRun = Number.NEGATIVE_INFINITY;
  private kicked = false;
  private announced: { readonly fingerprint: string; at: number } | undefined;
  private lastError: string | undefined;

  constructor(private readonly deps: AutopilotTickDeps) {}

  /** A toodo change: the next pass judges, unless a tick ran within AUTOPILOT_KICK_MIN_MS (then the one after that). */
  kick(): void { this.kicked = true; }

  due(now: number): boolean {
    return now >= this.nextAt || (this.kicked && now - this.lastRun >= AUTOPILOT_KICK_MIN_MS);
  }

  /** One pass: judges when due. Never throws; an unreadable toodo is logged once per distinct error and retried next tick. */
  async tick(): Promise<void> {
    if (this.deps.mode() === "off") return;
    const now = this.deps.now();
    if (!this.due(now)) return;
    this.lastRun = now;
    this.nextAt = now + this.deps.tickMs();
    this.kicked = false;
    let report: CandidatesReport;
    try {
      report = await this.deps.judge();
      recordShadow(this.deps.store, now, report.verdicts);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== this.lastError) this.deps.log(`AUTOPILOT_TICK_ERROR ${why}`);
      this.lastError = why;
      return;
    }
    if (this.lastError !== undefined) this.deps.log("AUTOPILOT_TICK_OK");
    this.lastError = undefined;
    const ids = report.verdicts.filter((v) => v.verdict === "LAUNCH").map((v) => v.taskId).sort((a, b) => a - b);
    // Shadow and a pause wake no one; forgetting the set makes it news once launching is allowed again.
    if (!ids.length || report.mode !== "on" || report.paused) { this.announced = undefined; return; }
    const fingerprint = readyLine(ids, report.slots, false);
    if (this.announced?.fingerprint === fingerprint) {
      if (now - this.announced.at < AUTOPILOT_RENOTIFY_MS) return;
      this.announced.at = now;
      this.deps.enqueue(`autopilot-ready:${now}`, readyLine(ids, report.slots, true));
      return;
    }
    this.announced = { fingerprint, at: now };
    this.deps.enqueue(`autopilot-ready:${now}`, fingerprint);
  }
}
