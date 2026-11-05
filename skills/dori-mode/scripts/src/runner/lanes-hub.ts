import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { laneGeneration, type LaneReportStore } from "../lane-reports.ts";
import { HUB_FILE } from "./hub.ts";
import type { Lane, Registry } from "../registry.ts";
import { journalId, type AnyRunnerEvent, type InventoryLane } from "./protocol.ts";

/**
 * The supervisor side of runner-owned lanes (design 4.4, 4.5, 5.7).
 *
 * Ownership: `Lane.runner` names the runner that owns a lane. An event about a lane is taken only from the runner whose
 * authenticated connection carried it and that `Lane.runner` names; anything else - another runner's lane, a lane
 * the registry does not have - is dropped as `RUNNER_FORGED_EVENT runner=<label> key=<key>` (urgent). The hub still
 * acks it, so the runner does not resend it forever.
 *
 * Reports: a `lane.report` becomes a row of the lane report store, its `source` the event's journal id, so the same
 * event imported again (`dori runner evacuate`) is the same row. The store's routing then does the rest exactly as for
 * a local `dori report`: a done report goes through `claimDone` (registry first, then the journal; the same evidence
 * again is `LANE_DONE_ALREADY_CLAIMED`), the rest is journaled or posted to the thread.
 *
 * Inventory (the hello): a lane the runner owns that its inventory lacks is marked `recoveryPending` and sent
 * `lane.recover`; a key in the inventory with no open lane in the registry is `LANE_ORPHAN <key>` and gets no registry
 * entry (an open lane that no runner owns is a lane a shadow runner observes, and is left to the shadow comparison);
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
};

const patch = async (deps: LaneHubDeps, key: string, fields: Partial<Lane>): Promise<void> => {
  await deps.registry.update(key, (current) => (current ? { ...current, ...fields } : undefined));
};

const LANE_EVENTS = new Set(["lane.started", "lane.state", "lane.report", "lane.asking", "lane.progress"]);

export type JournaledLaneEvent = { readonly rowid: number; readonly label: string; readonly frame: AnyRunnerEvent };

const EVENT_LINE = /^RUNNER_EVENT runner=(\S+) seq=(\d+) type=(lane\.\S+) (.*)$/s;

/** The lane events in the hub's journal after `afterRowid`, oldest first; a line that does not parse is skipped. */
export const laneEventsAfter = (stateDir: string, afterRowid: number): JournaledLaneEvent[] => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runner_events'").get()) return [];
    const rows = db.query("SELECT rowid, line FROM runner_events WHERE rowid > ? ORDER BY rowid").all(afterRowid) as { rowid: number; line: string }[];
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

export const acceptLaneEvent = async (deps: LaneHubDeps, label: string, frame: AnyRunnerEvent): Promise<void> => {
  if (!LANE_EVENTS.has(frame.type)) return;
  const key = (frame.body as { readonly key: string }).key;
  const lane = await deps.registry.read(key);
  if (!lane || lane.runner !== label) {
    deps.emit(`runner-forged:${label}:${frame.seq}`, `RUNNER_FORGED_EVENT runner=${label} key=${key} type=${frame.type}${lane?.runner ? ` owner=${lane.runner}` : " (no such runner lane)"}`);
    return;
  }
  if (frame.type === "lane.started") {
    const b = frame.body;
    await patch(deps, key, { pane: b.pane, tab: b.tab, ...(b.session ? { session: b.session } : {}) });
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
    const there = seen.get(lane.key);
    if (!there) {
      await patch(deps, lane.key, { recoveryPending: true });
      deps.recover(label, lane.key);
      continue;
    }
    if (there.pane !== lane.pane || there.tab !== lane.tab || (there.session !== undefined && there.session !== lane.session)) {
      await patch(deps, lane.key, { pane: there.pane, tab: there.tab, ...(there.session !== undefined ? { session: there.session } : {}) });
    }
  }
  for (const key of seen.keys()) {
    if (!openKeys.has(key)) deps.emit(`lane-orphan:${label}:${key}`, `LANE_ORPHAN ${key} runner=${label} runs on that runner but the registry has no open lane ${key}; adopt it or stop it`);
  }
};
