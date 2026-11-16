import { languageInstruction } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import type { FlowDeps, LaneReads } from "./done-flow.ts";
import type { LaneReportStore } from "./lane-reports.ts";
import { checkPausedLane } from "./pause.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { SweepView } from "./sweep-view.ts";

export const scrubForThread = (line: string, home: string): string =>
  redactSecrets(line)
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

/**
 * A thread post the supervisor makes for a lane (a `dori report progress` row):
 * marked `[System]` and relayed, so the owner never reads it as the lane, or the lead, speaking.
 */
export const relayedText = (key: string, text: string): string => `[System] 레인 ${key} 전달: ${text}`;

export type SweepAct = { readonly kind: "nudged" | "no-progress" | "idle-escalate" | "working-while-paused"; readonly lane: string; readonly detail: string };

/**
 * The nudge an idle silent lane gets: three ways out, each through `dori report` (the lane's runner carries it): claim
 * done, report a blocker outside the lane, or post a progress line and keep working. One line, since it is typed into
 * the pane. A remote lane runs the runner's own `dori` (`~/.dori/runner/bin/dori`).
 */
export const nudgeText = (lane: Lane, silentMin: number, ownerLanguage?: string): string => {
  const dori = lane.machine ? "~/.dori/runner/bin/dori" : "dori";
  const done = `claim it: ${dori} report ${lane.key} done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version>"`;
  const blocked = `report it: ${dori} report ${lane.key} blocked --text "<what blocks you>"`;
  const language = languageInstruction(ownerLanguage);
  return `[LEAD] your work thread has had no update for ${silentMin} min. If the deliverable is done and every Done signal is live, ${done}. If you are blocked on something outside this lane, ${blocked}. Otherwise post a 1-2 sentence progress line (done since last, next), keep its status true, and continue the work now.${language ? ` ${language}` : ""}`;
};

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

/** The time of each lane's newest report row (any kind), read once per tick. */
const lastRowAt = (reports: LaneReportStore): Map<string, number> => {
  const at = new Map<string, number>();
  for (const row of reports.list()) at.set(row.lane, Math.max(at.get(row.lane) ?? row.at, row.at));
  return at;
};

/**
 * With `reports`, a lane's report rows are its progress: the router already posts them, so a working
 * lane with a row newer than nudgeAfterMin costs no pane read at all. Its pane status is read (for the nudge) only once
 * no row arrived within nudgeAfterMin, counted from its newest row or reply. A pane's text is never read for a report.
 * Every read and the nudge go through the lane's runner: `view` (the supervisor round's cached reads), else `deps.ops`.
 * A lane whose machine is not `admitted` (its runner has no admitted connection) is skipped.
 */
export const freshnessTick = async (deps: FlowDeps, view?: SweepView, reports?: LaneReportStore, admitted: (machine?: string) => boolean = () => true): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  const reads: LaneReads = view ?? deps.ops;
  let rows: Map<string, number> | undefined;
  for (const lane of await deps.registry.open()) {
    if (!admitted(lane.machine)) continue;
    if (statusOf(lane) === "paused") {
      const checked = view ? await checkPausedLane(deps, lane, view) : await checkPausedLane(deps, lane);
      if (checked && checked.lane.lastFreshnessNote !== "working-while-paused") {
        // Reported once per working stretch (the note clears when the lane goes idle), so the lead can ask; it stays paused.
        await deps.registry.patch(lane.key, (fresh) => (statusOf(fresh) === "paused" ? { lastFreshnessNote: "working-while-paused" } : undefined));
        const interrupt = checked.stopped ? "re-interrupted, its turn stopped" : "PAUSE_UNVERIFIED: Escape did not stop its turn";
        acts.push({ kind: "working-while-paused", lane: lane.key, detail: `paused lane was woken and is working; ${interrupt}; left paused (resume is dori resume only)` });
      }
      continue;
    }
    if (statusOf(lane) !== "working" || !lane.pane || lane.recoveryPending) continue;
    if (reports) rows ??= lastRowAt(reports);
    const rowAt = rows?.get(lane.key);
    if (rowAt !== undefined && now - rowAt < deps.tunables.nudgeAfterMin * 60_000) continue;
    const heard = Math.max(lastHeard(lane), rowAt ?? -Infinity);
    const silentMin = Math.round((now - heard) / 60_000);
    let current = lane;
    // Only this sweep's own fields are written, onto the fresh lane: a pause, objection or claim made meanwhile stands.
    const save = async (fields: Partial<Lane>): Promise<void> => {
      current = { ...current, ...fields };
      await deps.registry.patch(lane.key, fields);
    };
    if (silentMin >= deps.tunables.nudgeAfterMin) {
      // The pane's agent status (read by the lane's runner) decides. A working lane is never interrupted and nothing is posted for it: the lead hears
      // once per silence and decides. No nudge was sent, so this silence never escalates.
      if ((await reads.status(lane)).status === "working") {
        if (lane.thread !== "none" && (current.lastNudgeAt ?? 0) < heard) {
          await save({ lastNudgeAt: now, idleEscalations: undefined, lastIdleEscalateAt: undefined });
          acts.push({ kind: "no-progress", lane: lane.key, detail: `${silentMin} min without a thread update while working` });
        }
      } else if ((current.lastNudgeAt ?? 0) < heard) {
        // A question prompt on the lane's screen is the owner's to answer: the runner refuses to type over it.
        const delivery = await deps.ops.send(lane, nudgeText(lane, silentMin, deps.config.ownerLanguage), { refuseWhileAsking: true });
        if (delivery !== "failed") {
          await save({ lastNudgeAt: now, idleEscalations: 0, lastIdleEscalateAt: undefined });
          acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery ${delivery}` });
        } else if ((current.lastNudgeFailedAt ?? 0) < heard) {
          // Not typed (its input line holds other text, or the pane is not live) or not submitted: not counted as
          // nudged, so the next tick tries again; the lead hears it once per silence.
          await save({ lastNudgeFailedAt: now });
          acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery failed; retried each tick` });
        }
      } else if (current.idleEscalations !== undefined && current.lastNudgeAt !== undefined) {
        // Nudged this silence and still idle with no update: the lane is not nudged again, the lead hears instead,
        // idleEscalateMin after the nudge and then after twice the previous wait each time, until the lane speaks.
        const count = current.idleEscalations;
        const since = current.lastIdleEscalateAt ?? current.lastNudgeAt;
        if (now - since >= deps.tunables.idleEscalateMin * 2 ** count * 60_000) {
          const nudgedMin = Math.round((now - current.lastNudgeAt) / 60_000);
          await save({ idleEscalations: count + 1, lastIdleEscalateAt: now });
          acts.push({ kind: "idle-escalate", lane: lane.key, detail: `${silentMin} min silent and idle, no update ${nudgedMin} min after its nudge (escalation ${count + 1}); it is not nudged again: read its pane, steer it, or dori close ${lane.key}` });
        }
      }
    }
  }
  return acts;
};
