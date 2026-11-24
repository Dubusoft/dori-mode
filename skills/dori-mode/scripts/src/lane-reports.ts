import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { fillHook } from "./config.ts";
import { replaceFileAtomic } from "./durable-write.ts";
import { claimDone, type Emit, type FlowDeps, laneMeta } from "./done-flow.ts";
import { relayedText, scrubForThread } from "./freshness.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { EventMeta } from "./supervise-journal.ts";
import { REPORT_KINDS, type ReportKind } from "./runner/report-kinds.ts";
import { LaneFileError } from "./lane-file-contract.ts";
import { ownerClosedRecorded } from "./thread-followup.ts";
import { type OpenResult, openedLine } from "./owner-decisions.ts";
import { parseRequestText } from "./runner/decision-text.ts";
import { type LaneReport, type LaneReportStore, laneGeneration, type ReportRoute, UNFENCED_GENERATION } from "./lane-report-store.ts";
import { discordStatusTransport, type LaneStatusTransport, statusChannel, upsertStatus } from "./lane-status.ts";
import { errLine, oneLine } from "./line-text.ts";
export { REPORT_KINDS, isReportKind, type ReportKind } from "./runner/report-kinds.ts";

/**
 * Structured lane reports (design 3.3): `dori report <key> <kind> --text T [--evidence E]` writes one
 * row, and the supervisor routes each row once and marks it consumed. Nothing is typed into the lead's pane.
 */
/** Longest text or evidence an event carries inline; a longer one, or one of more than INLINE_REPORT_LINES lines, is saved to a file the event points at. */
export const INLINE_REPORT_MAX = 200;
export const INLINE_REPORT_LINES = 3;
/** Where full report bodies are saved, under the state directory. */
export const REPORT_BODIES_DIR = "reports";

const inline = (text: string): boolean => text.trim().split("\n").length <= INLINE_REPORT_LINES && oneLine(text).length <= INLINE_REPORT_MAX;

/**
 * Saves a row whose text or evidence is long or has many lines to `<stateDir>/reports/<row id>.txt`, as written (already
 * redacted), and returns that path; a short one-line row saves nothing and returns undefined. Rewriting is harmless.
 */
export const saveReportBody = (stateDir: string, report: LaneReport): string | undefined => {
  if (inline(report.text) && (!report.evidence || inline(report.evidence))) return undefined;
  const dir = join(stateDir, REPORT_BODIES_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.id.replace(/[^\w.-]/g, "_")}.txt`);
  replaceFileAtomic(path, `lane: ${report.lane}\nkind: ${report.kind}\nreport: ${report.id}\nat: ${new Date(report.at).toISOString()}\n\n${report.text}\n${report.evidence ? `\nevidence:\n${report.evidence}\n` : ""}`, 0o600);
  return path;
};

const summary = (text: string): string => { const flat = oneLine(text); return flat.length <= INLINE_REPORT_MAX ? flat : `${flat.slice(0, INLINE_REPORT_MAX)}...`; };

/**
 * The event a routed row becomes: `LANE_REPORT <key> <kind> <text>`, with ` (evidence: E)` when given. With `body` (the
 * file saveReportBody wrote) the text and evidence are cut to INLINE_REPORT_MAX and the event ends ` (full report: <path>)`.
 */
export const reportLine = (report: LaneReport, body?: string, kind = "LANE_REPORT"): string =>
  `${kind} ${report.lane} ${report.kind} ${summary(report.text)}${report.evidence ? ` (evidence: ${summary(report.evidence)})` : ""}${body ? ` (full report: ${body})` : ""}`;

/** Failed routing passes in a row after which a pending row raises one urgent event (it stays pending and is retried). */
export const POISON_ALERT_AFTER = 3;
const failures = new WeakMap<LaneReportStore, Map<string, number>>();

/**
 * Opens the owner decision a lane question carries (owner-decisions.ts openLaneDecision); undefined for a free-text
 * question, which is routed to the journal as before.
 */
export type DecisionOpener = (lane: Lane, report: LaneReport) => Promise<OpenResult | undefined>;

/** Journals one line under a stable id; the supervisor dedupes a repeat of the same id. */
export type ReportEnqueue = (id: string, line: string, meta?: EventMeta) => unknown;

/** The review lines a lane status message carries. */
export type ReviewSection = (lane: Lane) => Promise<readonly string[]>;

/**
 * Routes every pending row once, oldest first, and marks it consumed after its effect. question, blocked and milestone
 * become a `LANE_REPORT` event under the id `lane-report:<row id>` (its class comes from eventPolicy: question and
 * blocked wake the lead, milestone is digest by default). progress and milestone also update the lane's one `[System]`
 * status message in its thread (laneStatusText), posted the first time and edited afterwards through `transport`
 * (default: discordStatusTransport); its id lives on the lane (statusMessageId). Without a transport progress is posted
 * through hooks.threadReply as before, and without either, or a thread, or when the post fails, it is a digest
 * LANE_REPORT instead; a failed status update of a milestone is only logged (the lead has the row). done is the
 * lane's done claim, as `dori claim-done`. A row whose lane is closed or unregistered is not lost: it becomes a
 * `LANE_REPORT_LATE <key> <kind> <text>` event under `lane-report-late:<row id>` (route `late`). A crash between the
 * effect and the mark repeats the effect: the journal dedupes the event by id, and a thread post may show twice.
 * A row stamped with an older non-zero generation than its lane's (laneGeneration: a session recovery replaced) is
 * routed late too, with ` (from a replaced session)`, so it never acts as the lane. A long or multi-line row's body is
 * saved to a file and its event carries the path (reportLine). Progress posted to the thread is marked `[System]`
 * relayed (freshness.ts relayedText), so the owner never reads it as the lane speaking. The consumed row records the
 * event it became (eventId), the done claim's `done-claim:<key>:<at>` included.
 * With `openDecision`, a question of an open lane is first offered to it: a question with choices opens (or finds, the
 * row id being its sourceRef) one owner decision thread and becomes a digest `OWNER_DECISION_OPENED` event under
 * `owner-decision-opened:<decision id>` (route `decision`); a free-text question (undefined) is journaled as above, and
 * a throw is a failed routing pass like any other.
 * A row whose routing throws is logged and left pending (retried next pass); the rest are still routed. After
 * POISON_ALERT_AFTER failed passes in a row it raises one urgent `LANE_REPORT <key> blocked REPORT_STUCK ...` event
 * under `lane-report-stuck:<row id>`. Returns one log line per routed row.
 */
export const routeReports = async (
  deps: FlowDeps, store: LaneReportStore, enqueue: ReportEnqueue, home = process.env.HOME ?? "",
  transport: LaneStatusTransport | null = discordStatusTransport(deps.clock) ?? null, openDecision?: DecisionOpener, reviewSection?: ReviewSection,
): Promise<string[]> => {
  // A review status that cannot be read never stops a report: the status message goes out without it.
  const review = async (lane: Lane): Promise<readonly string[]> => {
    try { return (await reviewSection?.(lane)) ?? []; } catch (e) {
      console.error(`LANE_STATUS_REVIEW_ERROR ${lane.key} ${errLine(e, 160)}`);
      return [];
    }
  };
  const out: string[] = [];
  const failed = failures.get(store) ?? new Map<string, number>();
  failures.set(store, failed);
  for (const report of store.pending()) {
    try {
      const lane = await deps.registry.read(report.lane);
      let route: ReportRoute;
      let eventId: string | undefined;
      const stale = lane && report.generation !== UNFENCED_GENERATION && report.generation < laneGeneration(lane);
      const late = !lane || statusOf(lane) === "closed" || stale;
      // A nonblocking input request (the lane goes ahead without it) is news for the lead, never an owner thread.
      const request = !late && report.kind === "question" ? parseRequestText(report.text) : undefined;
      const deferred = request && !request.blocking ? request : undefined;
      const opened = !late && !deferred && report.kind === "question" && openDecision ? await openDecision(lane, report) : undefined;
      if (late || !lane) {
        eventId = `lane-report-late:${report.id}`;
        const line = reportLine(report, saveReportBody(deps.config.stateDir, report), "LANE_REPORT_LATE");
        await enqueue(eventId, stale ? `${line} (from a replaced session)` : line, lane ? laneMeta(lane) : { lane: report.lane });
        route = "late";
      } else if (deferred) {
        eventId = `lane-request:${report.id}`;
        await enqueue(eventId, `LANE_REQUEST_NONBLOCKING ${lane.key} ${summary(deferred.need)} (why: ${summary(deferred.reason)}; going ahead: ${summary(deferred.waiting)}${deferred.file ? `; file ${deferred.file}` : ""}): not posted to the owner; ask the owner yourself with dori decision open --request only when it is really needed`, laneMeta(lane));
        route = "journal";
      } else if (opened) {
        eventId = `owner-decision-opened:${opened.decision.id}`;
        await enqueue(eventId, openedLine(opened.decision, opened.duplicateOf), laneMeta(lane));
        route = "decision";
      } else if (report.kind === "done") {
        if (lane.fileRun && !report.fileReceipt) throw new LaneFileError("LANE_REPORT_FILES_MISSING", lane.key, "this managed lane's done report has no file snapshot; claim done again through its runner");
        await claimDone(deps, lane, oneLine(report.evidence ?? report.text), report.fileReceipt, report.text);
        const claim = (await deps.registry.read(report.lane))?.claim;
        // done-flow.ts claimEventId's format, spelled here: test/cli-sync-watch.test.ts mocks done-flow with a fixed export list.
        if (claim) eventId = `done-claim:${report.lane}:${claim.at}`;
        route = "claim";
      } else if (report.kind === "progress" && transport && statusChannel(lane)) {
        try {
          await upsertStatus(deps, transport, statusChannel(lane) ?? "", lane, store, report, home, await review(lane));
          route = "thread";
        } catch (e) {
          eventId = `lane-report:${report.id}`;
          await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report))} (status message failed: ${errLine(e, 160)})`, laneMeta(lane));
          route = "journal";
        }
      } else if (report.kind === "progress" && deps.config.hooks.threadReply && lane.thread !== "none" && !ownerClosedRecorded(deps.config.stateDir, lane.thread)) {
        const posted = await deps.run(fillHook(deps.config.hooks.threadReply, { thread: lane.thread, text: relayedText(lane.key, scrubForThread(oneLine(report.text), home)), key: lane.key }));
        if (posted.code === 0) route = "thread";
        else {
          const error = (posted.err || posted.out || `exit ${posted.code}`).replace(/\s+/g, " ").slice(0, 160);
          eventId = `lane-report:${report.id}`;
          await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report))} (thread post failed: ${error})`, laneMeta(lane));
          route = "journal";
        }
      } else {
        eventId = `lane-report:${report.id}`;
        await enqueue(eventId, reportLine(report, saveReportBody(deps.config.stateDir, report)), laneMeta(lane));
        route = "journal";
        const channel = statusChannel(lane);
        if (report.kind === "milestone" && transport && channel) {
          try { await upsertStatus(deps, transport, channel, lane, store, report, home, await review(lane)); }
          catch (e) { console.error(`LANE_STATUS_ERROR ${lane.key} ${report.id} ${errLine(e, 160)}`); }
        }
      }
      // A routed report is the lane being heard, like a thread reply: freshness neither nudges it nor raises NO-PROGRESS.
      if (route !== "late") await deps.registry.patch(report.lane, { lastReplyAt: deps.clock.now() });
      store.consume(report.id, deps.clock.now(), route, eventId);
      failed.delete(report.id);
      out.push(`LANE_REPORT_ROUTED ${report.id} ${report.kind} ${route}`);
    } catch (e) {
      if (e instanceof LaneFileError && !e.transient) {
        // A permanent file refusal never retries: a stale report is routed late, any other refusal journals its exact leaf line.
        try {
          const lane = await deps.registry.read(report.lane);
          const meta = lane ? laneMeta(lane) : { lane: report.lane };
          let route: ReportRoute = "journal";
          let eventId = `lane-report-refused:${report.id}`;
          if (e.code === "LANE_REPORT_STALE") {
            eventId = `lane-report-late:${report.id}`;
            route = "late";
            await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report), "LANE_REPORT_LATE")} (from a replaced session)`, meta);
          } else await enqueue(eventId, e.message, meta);
          store.consume(report.id, deps.clock.now(), route, eventId);
          failed.delete(report.id);
          out.push(`LANE_REPORT_ROUTED ${report.id} ${report.kind} ${route}`);
          continue;
        } catch (refuse) {
          console.error(`LANE_REPORT_REFUSE_ERROR ${report.id} ${refuse instanceof Error ? refuse.message : String(refuse)}`);
        }
      }
      // Poison isolation: the row stays pending and is retried on the next supervisor pass, never in a hot loop.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`LANE_REPORT_ERROR ${report.id} ${message}`);
      const n = (failed.get(report.id) ?? 0) + 1;
      failed.set(report.id, n);
      if (n !== POISON_ALERT_AFTER) continue;
      try {
        // LANE_REPORT ... blocked is urgent in the default event policy; the journal dedupes the id across restarts.
        await enqueue(`lane-report-stuck:${report.id}`, `LANE_REPORT ${report.lane} blocked REPORT_STUCK ${report.id} (${report.kind}) failed to route ${n} times: ${oneLine(message, 160)}; it stays pending and is retried every pass`, { lane: report.lane });
      } catch (alert) {
        console.error(`LANE_REPORT_STUCK_ERROR ${report.id} ${alert instanceof Error ? alert.message : String(alert)}`);
      }
    }
  }
  return out;
};
