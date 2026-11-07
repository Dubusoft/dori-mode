import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { askingLine } from "../ask-user.ts";
import { ackLaneMessage, LaneMessageError, type LaneMessageStore } from "../lane-messages.ts";
import { laneGeneration, type LaneReportStore } from "../lane-reports.ts";
import type { RecoveryLane } from "../recover.ts";
import { type Observation, settleAttempted, type SupervisorReadback } from "./durability.ts";
import { type AttemptRow, HUB_FILE } from "./hub.ts";
import { LOCAL_RUNNER } from "./serve.ts";
import type { Lane, Registry } from "../registry.ts";
import { journalId, type AnyRunnerEvent, type CommandStatusState, type InventoryLane } from "./protocol.ts";

/**
 * The supervisor side of runner-owned lanes (design 4.4, 4.5, 5.7).
 *
 * Ownership: `Lane.runner` names the runner that owns a lane. An event about a lane is taken only from the runner whose
 * authenticated connection carried it and that `Lane.runner` names; anything else - another runner's lane, a lane
 * the registry does not have - is dropped as `RUNNER_FORGED_EVENT runner=<label> key=<key>` (urgent). The hub still
 * acks it, so the runner does not resend it forever. The line's id is the forged identity (runner, key, event type, the
 * lane's owner and generation), not the frame: the same forgery repeated is journaled once, a new one is a new alert. One exception: an observation (`lane.state`, `lane.progress`)
 * from a runner about an open lane on its own machine that no runner owns yet (a legacy lane before adopt-legacy.ts has
 * adopted it) is dropped here without a line: a runner observes every lane on its host. That runner's `lane.started`, `lane.report` or `lane.asking` about such a lane
 * is still forged: it controls no lane it does not own.
 *
 * Reports: a `lane.report` becomes a row of the lane report store, its `source` the event's journal id, so the same
 * event imported again (`dori runner evacuate`) is the same row. The store's routing then does the rest exactly as for
 * a local `dori report`: a done report goes through `claimDone` (registry first, then the journal; the same evidence
 * again is `LANE_DONE_ALREADY_CLAIMED`), the rest is journaled or posted to the thread.
 *
 * Acks: the owner's `lane.ack` (the lane ran `dori report ack <id>`) applies `ackLaneMessage` to the message store; a
 * `LaneMessageError` is the digest line `LANE_ACK_FAILED <key> <id> <reason>`.
 *
 * Signals: the owner's `lane.state` dead is urgent `RUNNER_LANE_DEAD` (with the runner's `reason=` when it gave one;
 * dropped for a closed lane, one with a launch reservation or a pending recovery, and one about another pane), its `lane.asking` is urgent `LANE_ASKING` (the line
 * ask-user.ts raises for a local lane's on-screen question), and a failed `lane.start` or `lane.recover` result is urgent
 * `RUNNER_LAUNCH_FAILED` or `RUNNER_RECOVER_FAILED`; each under a stable id from the runner label and the event's seq.
 *
 * Inventory (the hello): a lane the runner owns that its inventory lacks is marked `recoveryPending` and sent
 * `lane.recover` (a lane with no pane yet is skipped: it still waits for its queued `lane.start`); the owner's next
 * `lane.started` for it clears `recoveryPending` with its new pane (a `lane.started` is applied only for a lane with no pane yet, a `recoveryPending` lane, or the lane's current pane; any other is a stale replay and is ignored). The hello also
 * records the journal head as `recoveryAfter`: a start journaled at or before it predates the recovery and is ignored too;
 * a lane without `recoveryAfter` (an older registry entry) takes any start of its owner. A `lane.started` for a closed lane
 * is never applied: one closed with no pane (a launch cancelled before its start landed) gets `lane.close` and one
 * `LANE_STARTED_AFTER_CLOSE` line; one closed with its pane is a replay. A start for a reservation its launch stopped
 * waiting for (`launchUnconfirmed`) releases it: `LAUNCH_CONFIRMED_LATE`. A key in the inventory with no open lane in the registry is `LANE_ORPHAN <key>` and gets no registry
 * entry, unless the archive holds that key closed, owned by the same runner, in the same pane (an open lane that no runner owns is left to adopt-legacy.ts);
 * a lane in both whose pane, tab or session differs takes the runner's values for those three only.
 *
 * Lane events are read back from the hub's own journal (`runner_events`), not taken from the connection: the hub
 * acks an event once it is in that journal, so a supervisor that stops before storing a report finds the event there
 * on its next pass and stores it then. Everything done with an event is idempotent (a report's `source`, stable ids).
 */

export type LaneHubDeps = {
  readonly registry: Pick<Registry, "read" | "open" | "update">;
  readonly reports: () => LaneReportStore | undefined;
  /** Journals a line under a stable id. */
  readonly emit: (id: string, line: string) => void;
  readonly now: () => number;
  /** Sends a command to the runner; undefined when it is not connected. */
  readonly recover: (label: string, key: string) => number | undefined;
  /** Sends `lane.close` for `key` to the runner under `cmdId`; undefined when it is not connected. */
  readonly close?: (label: string, key: string, cmdId: string) => number | undefined;
  /** The runner journal's newest position (0 when empty); a recovery records it so older journaled starts stay stale. */
  readonly journalHead?: () => number;
  /** The lane message store a `lane.ack` is applied to; without it an ack is a failed event (retried from the journal). */
  readonly messages?: () => LaneMessageStore | undefined;
  /** Pushes the lane's current notice (status, objection, claim) to its runner; called for every lane the runner owns at its hello. */
  readonly notify?: (label: string, lane: Lane) => Promise<void> | void;
};

const patch = async (deps: LaneHubDeps, key: string, fields: Partial<RecoveryLane>): Promise<void> => {
  await deps.registry.update(key, (current) => (current ? { ...current, ...fields } : undefined));
};

const LANE_EVENTS = new Set(["lane.started", "lane.state", "lane.report", "lane.asking", "lane.progress", "lane.ack"]);

/** Lane events that only describe what a runner sees. */
const OBSERVATION_EVENTS = new Set(["lane.state", "lane.progress"]);

/** A runner's observation of an open lane on its own machine that no runner owns yet: it observes every lane on its host (observe.ts). */
const ownMachineObservation = (label: string, frame: AnyRunnerEvent, lane: Lane): boolean =>
  OBSERVATION_EVENTS.has(frame.type) && !lane.runner && !lane.closedAt
  && (label === LOCAL_RUNNER ? !lane.machine : lane.machine === label);

export type JournaledLaneEvent = { readonly rowid: number; readonly label: string; readonly frame: AnyRunnerEvent };

const EVENT_LINE = /^RUNNER_EVENT runner=(\S+) seq=(\d+) type=(lane\.\S+|cmd\.result) (.*)$/s;

/** The cmdId prefix the supervisor gives a `lane.start`: `lane-start:<key>:<ms>`. */
const LANE_START_CMD = /^lane-start:([^:]+):\d+$/;
/** The cmdId prefix supervise-loop.ts gives a `lane.recover`: `recover:<key>:<ms>`. */
const RECOVER_CMD = /^recover:([^:]+):\d+$/;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").slice(0, 200);

/** The journal column laneEventsAfter orders by: `position`, or `rowid` in a journal from before that column. */
const positionColumn = (db: Database): string =>
  (db.query("PRAGMA table_info(runner_events)").all() as { name: string }[]).some((column) => column.name === "position") ? "position" : "rowid";

/** The newest position in the hub's journal, in laneEventsAfter's numbering; 0 when there is no journal or it is empty. */
export const runnerJournalHead = (stateDir: string): number => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runner_events'").get()) return 0;
    const row = db.query(`SELECT MAX(${positionColumn(db)}) AS head FROM runner_events`).get() as { head: number | null };
    return row.head ?? 0;
  } finally {
    db.close();
  }
};

/** The lane events in the hub's journal after `afterRowid`, oldest first; a line that does not parse is skipped. */
export const laneEventsAfter = (stateDir: string, afterRowid: number): JournaledLaneEvent[] => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runner_events'").get()) return [];
    const position = positionColumn(db);
    const rows = db.query(`SELECT ${position} AS rowid, line FROM runner_events WHERE ${position} > ? ORDER BY ${position}`).all(afterRowid) as { rowid: number; line: string }[];
    return rows.flatMap(({ rowid, line }) => {
      const m = EVENT_LINE.exec(line);
      if (!m) return [];
      try {
        const frame = { v: 1, runner: m[1], gen: 0, epoch: 0, seq: Number(m[2]), type: m[3], body: JSON.parse(m[4] as string) } as unknown as AnyRunnerEvent;
        return [{ rowid, label: m[1] as string, frame }];
      } catch {
        return [];
      }
    });
  } finally {
    db.close();
  }
};

/** `position`: the event's journal position, when it was read from the journal (laneEventsAfter). */
export const acceptLaneEvent = async (deps: LaneHubDeps, label: string, frame: AnyRunnerEvent, position?: number): Promise<void> => {
  if (frame.type === "cmd.result") {
    // A refused or failed lane.start leaves a registered lane with no agent: the lead has to hear of it.
    const b = frame.body;
    if (b.state !== "failed") return;
    const recoverKey = RECOVER_CMD.exec(b.cmdId)?.[1];
    if (recoverKey) {
      // A failed lane.recover leaves the lane recoveryPending with no agent the runner knows of.
      const lane = await deps.registry.read(recoverKey);
      if (!lane || lane.closedAt || lane.runner !== label) return;
      deps.emit(`runner-recover-failed:${label}:${frame.seq}`, `RUNNER_RECOVER_FAILED ${recoverKey} runner=${label} ${oneLine(b.detail)}; the lane was not recovered: fix the runner and let it reconnect, or dori close ${recoverKey} --cancelled and launch again`);
      return;
    }
    const key = LANE_START_CMD.exec(b.cmdId)?.[1];
    if (!key) return;
    const lane = await deps.registry.read(key);
    if (!lane || lane.closedAt || lane.runner !== label || lane.pane) return;
    deps.emit(`runner-launch-failed:${label}:${frame.seq}`, `RUNNER_LAUNCH_FAILED ${key} runner=${label} ${oneLine(b.detail)}; the lane has no agent: fix the runner, dori close ${key} --cancelled and launch again`);
    return;
  }
  if (!LANE_EVENTS.has(frame.type)) return;
  const key = (frame.body as { readonly key: string }).key;
  const lane = await deps.registry.read(key);
  if (lane && ownMachineObservation(label, frame, lane)) return;
  if (!lane || lane.runner !== label) {
    deps.emit(`runner-forged:${JSON.stringify([label, key, frame.type, lane?.runner ?? null, lane ? laneGeneration(lane) : null])}`, `RUNNER_FORGED_EVENT runner=${label} key=${key} type=${frame.type}${lane?.runner ? ` owner=${lane.runner}` : " (no such runner lane)"}`);
    return;
  }
  if (frame.type === "lane.started") {
    const b = frame.body;
    if (lane.closedAt) {
      // A lane closed with a pane was started and its close took that pane: this is a replay. A lane closed with no pane
      // was cancelled while its start was still out: that start landed late, and its agent is stopped, not recorded.
      if (lane.pane) return;
      const sent = deps.close?.(label, key, `late-start-close:${key}:${frame.seq}`);
      deps.emit(`lane-started-after-close:${label}:${frame.seq}`, `LANE_STARTED_AFTER_CLOSE ${key} runner=${label} pane=${b.pane} started after the lane was closed; ${sent === undefined ? "the runner is not connected, so lane.close was not sent: the agent may still run in that pane" : "lane.close sent to stop it"}`);
      return;
    }
    // A replayed journal can hold an old start: only a first launch, an outstanding recovery or the current pane applies.
    const lr = lane as RecoveryLane;
    if (lr.pane && !lr.recoveryPending && lr.pane !== b.pane) return;
    // A start journaled before the hello that asked for the recovery is not the recovery's.
    if (lr.recoveryPending && position !== undefined && lr.recoveryAfter !== undefined && position <= lr.recoveryAfter) return;
    // A start or a recovery: either way the lane runs again, so a pending recovery (reconcileInventory) is over.
    // A launch that gave up waiting (launchUnconfirmed) left its reservation paused: this start confirms it.
    const late = Boolean(lane.launchReservation && lane.launchUnconfirmed);
    await patch(deps, key, {
      pane: b.pane, tab: b.tab, ...(b.session ? { session: b.session } : {}),
      recoveryPending: undefined, recoveryAfter: undefined, recoveryPreviousPane: undefined, recoveryExhausted: undefined,
      ...(late ? { status: undefined, launchReservation: undefined, launchUnconfirmed: undefined } : {}),
    });
    if (late) deps.emit(`launch-confirmed-late:${label}:${frame.seq}`, `LAUNCH_CONFIRMED_LATE ${key} runner=${label} pane=${b.pane} the runner started the lane after its launch stopped waiting; the reservation is released and the lane is working`);
    return;
  }
  if (frame.type === "lane.state") {
    if (frame.body.status !== "dead") return;
    // A dead replayed from the journal can predate what the lane is now: a closed lane, a launch still being
    // reserved, a recovery already under way, or another pane than the lane's own say nothing about its agent.
    const lr = lane as RecoveryLane;
    if (lr.closedAt || lr.launchReservation || lr.recoveryPending) return;
    if (frame.body.pane && lr.pane && frame.body.pane !== lr.pane) return;
    deps.emit(`runner-lane-dead:${label}:${frame.seq}`, `RUNNER_LANE_DEAD ${key} runner=${label}${frame.body.pane ? ` pane=${frame.body.pane}` : ""}${frame.body.reason ? ` reason=${frame.body.reason}` : ""} the lane's agent stopped on its runner: read its last report, then dori close ${key} or launch it again`);
    return;
  }
  if (frame.type === "lane.asking") {
    // The runner sends its own askingLine (lanes.ts); the line is rebuilt here around the owner-checked key.
    const question = frame.body.text.replace(/^LANE_ASKING \S+ waits on an on-screen question, not dori report: /, "");
    deps.emit(`runner-lane-asking:${label}:${frame.seq}`, askingLine(key, { question, options: [], pending: 1 }));
    return;
  }
  if (frame.type === "lane.ack") {
    const messages = deps.messages?.();
    if (!messages) throw new Error(`RUNNER_ACK_UNSTORED no lane message store for ${key}`);
    try {
      ackLaneMessage(messages, key, frame.body.id, deps.now());
    } catch (e) {
      if (!(e instanceof LaneMessageError)) throw e;
      deps.emit(`lane-ack-failed:${label}:${frame.seq}`, `LANE_ACK_FAILED ${key} ${frame.body.id} ${oneLine(e.message)}`);
    }
    return;
  }
  if (frame.type !== "lane.report") return;
  const store = deps.reports();
  if (!store) throw new Error(`RUNNER_REPORT_UNSTORED no lane report store for ${key}`);
  const b = frame.body;
  store.append({
    lane: key, generation: laneGeneration(lane), kind: b.kind, text: b.text, ...(b.evidence ? { evidence: b.evidence } : {}),
    at: deps.now(), source: journalId(label, frame.seq),
  });
  await patch(deps, key, { lastRunnerReportAt: deps.now() });
};

export const reconcileInventory = async (deps: LaneHubDeps, label: string, inventory: readonly InventoryLane[]): Promise<void> => {
  const open = (await deps.registry.open()).filter((l) => !l.closedAt);
  const openKeys = new Set(open.map((l) => l.key));
  const owned = open.filter((l) => l.runner === label);
  const seen = new Map(inventory.map((l) => [l.key, l]));
  for (const lane of owned) {
    await deps.notify?.(label, lane);
    const there = seen.get(lane.key);
    if (!there) {
      // No pane yet: never started, its lane.start is still queued for this runner; there is nothing to recover.
      if (!lane.pane) continue;
      const head = deps.journalHead?.();
      await patch(deps, lane.key, { recoveryPending: true, ...(head !== undefined ? { recoveryAfter: head } : {}) });
      deps.recover(label, lane.key);
      continue;
    }
    if (there.pane !== lane.pane || there.tab !== lane.tab || (there.session !== undefined && there.session !== lane.session)) {
      await patch(deps, lane.key, { pane: there.pane, tab: there.tab, ...(there.session !== undefined ? { session: there.session } : {}) });
    }
  }
  for (const [key, there] of seen) {
    if (openKeys.has(key)) continue;
    // A closed lane of this runner still listed in its pane is the archived lane, not an unknown agent.
    const known = await deps.registry.read(key);
    if (known?.closedAt && (known.runner ?? known.machine ?? LOCAL_RUNNER) === label && known.pane === there.pane) continue;
    deps.emit(`lane-orphan:${label}:${key}`, `LANE_ORPHAN ${key} runner=${label} runs on that runner but the registry has no open lane ${key}; adopt it or stop it`);
  }
};

export type LaneStartReadbackDeps = {
  readonly registry: Pick<Registry, "read">;
  /** The `lane.start` commands an earlier supervisor run sent to `label` and never saw answered (hub.ts `staleAttempts`). */
  readonly attempts: (label: string) => readonly AttemptRow[];
  /** Forgets an attempt the read-back settled. */
  readonly settle: (label: string, cmdId: string) => void;
  /** `cmd.status` on the runner's connection. */
  readonly status: (label: string, cmdId: string) => Promise<CommandStatusState>;
  /** `lane.observe` on the runner: its state and detail. */
  readonly observe: (label: string, key: string) => Promise<{ readonly state: "verified" | "failed" | "ambiguous"; readonly detail: string }>;
  /** Sends the recorded command again under its own cmdId; its answer comes back as any lane.start's does. */
  readonly resend: (label: string, attempt: AttemptRow) => void;
  readonly emit: (id: string, line: string) => void;
};

/**
 * What a `lane.observe` answer says of a lane whose start nobody knows the fate of: a lane the runner reports in any
 * state is `present`; `RUNNER_LANE_UNKNOWN` (the runner holds no lane of that key) is `absent`, so the start never
 * happened there; anything else, a known lane whose pane is gone among them, is `unknown`.
 */
export const observationOf = (answer: { readonly state: string; readonly detail: string }): Observation =>
  answer.state === "verified" ? "present" : answer.state === "failed" && /\bRUNNER_LANE_UNKNOWN\b/.test(answer.detail) ? "absent" : "unknown";

/**
 * After a supervisor restart, at a runner's hello: reads back each `lane.start` an earlier run sent to it and never saw
 * answered (design 5.6, durability.ts `settleAttempted`). Only a lane still open, owned by that runner and without a
 * pane is read back; any other attempt is settled without asking. The runner's own answer (`cmd.status`) decides first;
 * a runner with no record of it is asked `lane.observe`, and a lane in its hello inventory counts as present. A proven
 * absence sends the same `lane.start` again under its cmdId, `ambiguous` is `OPERATION_AMBIGUOUS` once, and a command
 * the runner still runs stays recorded for the next hello. Returns each attempt's outcome by cmdId.
 */
export const readBackLaneStarts = async (
  deps: LaneStartReadbackDeps, label: string, inventory: readonly InventoryLane[],
): Promise<Map<string, SupervisorReadback | "settled">> => {
  const outcomes = new Map<string, SupervisorReadback | "settled">();
  const there = new Set(inventory.map((l) => l.key));
  for (const attempt of deps.attempts(label)) {
    const key = attempt.key;
    const lane = attempt.type === "lane.start" && key ? await deps.registry.read(key) : undefined;
    if (!key || !lane || lane.closedAt || lane.runner !== label || lane.pane) {
      deps.settle(label, attempt.cmdId);
      outcomes.set(attempt.cmdId, "settled");
      continue;
    }
    const outcome = await settleAttempted({
      status: (cmdId) => deps.status(label, cmdId),
      observe: async (k) => (there.has(k) ? "present" : observationOf(await deps.observe(label, k))),
      resend: () => { deps.resend(label, attempt); },
      emit: (line) => { deps.emit(`operation-ambiguous:${label}:${attempt.cmdId}`, `${line}; the lane has no pane: check the runner's host, then dori close ${key} --cancelled and launch again`); },
    }, { cmdId: attempt.cmdId, key, type: attempt.type });
    // A resend records the attempt again under this run's epoch; a pending command is read back at the next hello.
    if (outcome === "verified" || outcome === "ambiguous") deps.settle(label, attempt.cmdId);
    outcomes.set(attempt.cmdId, outcome);
  }
  return outcomes;
};
