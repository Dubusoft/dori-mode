import type { DoriConfig } from "./config.ts";
import type { LaneReads } from "./done-flow.ts";
import type { LaneOps } from "./lane-ops.ts";
import { appendDeadPaneReport } from "./lane-reports.ts";
import { ALIVE_STATUSES } from "./pane-state.ts";
import type { Lane } from "./registry.ts";
import { laneAgentRunning } from "./runner/observe.ts";
import type { ProcessInfo } from "./runner/protocol.ts";
import { BUILT_IN } from "./tunables.ts";

/** Unrecognised ticks in a row before one alert names the pane. */
export const UNRECOGNISED_ALERT_AFTER = 3;

/** Terminal title of the DAG viewer a mass-ulw lane opens next to its agent pane. It runs no agent, so herdr reports no status. */
export const DAG_VIEWER_TITLE = "OmO DAG";

/** Per-pane memory across ticks: the CLI keeps one of these for the life of the loop. */
export type DeadPaneState = {
  readonly unknown: Map<string, number>;
  readonly lastTail: Map<string, string>;
  /** The owning lane's activity stamp (laneActivity) when the pane's unrecognised count was last checked. */
  readonly activity: Map<string, number>;
  /** Panes no registered lane owns that already raised their one digest line. */
  readonly digested: Set<string>;
};
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map(), activity: new Map(), digested: new Set() });

/** The latest sign of life the registry holds for a lane: a report or progress ping (lastReplyAt), its done claim, a status change. */
const laneActivity = (lane: Lane): number => Math.max(
  lane.lastReplyAt ?? 0,
  lane.claim ? Date.parse(lane.claim.at) || 0 : 0,
  ...(lane.history ?? []).map((entry) => Date.parse(entry.at) || 0),
);

/**
 * A pane is alive when herdr reports a running agent status for it; that wins over any screen text. Otherwise it is
 * dead only when this tick's tail carries a configured dead marker AND equals the previous tick's tail, so the two
 * reads are a full loop interval apart and a screen mid-redraw never counts. A marker seen once is pending. Anything
 * else is unrecognised, counted per pane, with one alert after UNRECOGNISED_ALERT_AFTER ticks in a row.
 * A pane belongs to a lane when it is the lane's pane or shares its tab. A DAG viewer pane of a lane is never counted; any
 * other lane pane's alert names the lane (`lane=<key>`), and its count starts over whenever the lane shows activity in the
 * registry (a report, a done claim, a status change), so a lane that keeps reporting is never flagged. A pane no lane
 * owns raises one `unregistered` line (lead-digest) for the life of the state, however often its count fills again.
 * A dead pane that is a registered lane's pane also leaves a synthetic `blocked` report row under that lane's key (lane-reports.ts appendDeadPaneReport), so the lane's result is not lost.
 * A lane's pane whose lane agent process still runs there (runner/observe.ts `laneAgentRunning`, from the pane's
 * process-info) is alive like one with an alive status: herdr's agent detection can miss a live agent. A lane pane the
 * lead already heard of as dead (`Lane.deadAlertPane`, from RUNNER_LANE_DEAD) raises no line of its own.
 * Pane lists and tails come from each machine's runner: `view` (the supervisor round's cached reads), else `ops`.
 * A machine that is not `admitted` (its runner has no admitted connection) is skipped without a line.
 */
export const deadPaneTick = async (ops: LaneOps, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState = newDeadPaneState(), lanes: readonly Lane[] = [], view: LaneReads = ops, now: () => number = Date.now, admitted: (machine?: string) => boolean = () => true): Promise<string[]> => {
  const out: string[] = [];
  const byPane = new Map(lanes.flatMap((lane) => lane.pane ? [[lane.machine ? `${lane.machine}/${lane.pane}` : lane.pane, lane] as const] : []));
  const agentRuns = async (machine: string | undefined, pane: string, key: string): Promise<boolean> => {
    try {
      const r = await ops.processInfo({ ...(machine ? { machine } : {}), pane });
      if (r.code !== 0) return false;
      return laneAgentRunning((JSON.parse(r.out) as { result?: { process_info?: ProcessInfo } }).result?.process_info, key);
    } catch {
      return false;
    }
  };
  const ctx: Ctx = { byPane, now, agentRuns };
  const machines = new Set(lanes.flatMap((lane) => lane.machine ? [lane.machine] : []));
  for (const machine of machines) {
    if (!admitted(machine)) continue;
    // Remote inventories contain other people's panes too: inspect only registered lane panes.
    const owned = new Set(lanes.flatMap((lane) => lane.machine === machine && lane.pane ? [lane.pane] : []));
    try {
      out.push(...await inspect(view, { ...config, laneWorkspace: "", leadPane: "", ignorePanes: [] }, seen, hourKey, state, ctx, machine, owned));
    } catch (e) {
      out.push(`DEAD_PANES_WARN machine=${machine} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (admitted(undefined)) out.push(...await inspect(view, config, seen, hourKey, state, ctx));
  return out;
};

type Ctx = {
  readonly byPane: ReadonlyMap<string, Lane>;
  readonly now: () => number;
  /** Whether lane `key`'s agent process runs in `pane` on `machine`; false when the process-info cannot be read. */
  readonly agentRuns: (machine: string | undefined, pane: string, key: string) => Promise<boolean>;
};

const inspect = async (view: LaneReads, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState, ctx: Ctx, machine?: string, owned?: ReadonlySet<string>): Promise<string[]> => {
  const out: string[] = [];
  const watch = new Set([config.laneWorkspace].filter(Boolean));
  const skip = new Set([config.leadPane, ...config.ignorePanes].filter(Boolean));
  const marked = (tail: string) => BUILT_IN.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()));
  const panes = await view.panes(machine);
  const laneTabs = new Map(panes.flatMap((p) => {
    const lane = p.tab_id ? ctx.byPane.get(machine ? `${machine}/${p.pane_id}` : p.pane_id) : undefined;
    return lane && p.tab_id ? [[p.tab_id, lane] as const] : [];
  }));
  for (const pane of panes) {
    if (owned && !owned.has(pane.pane_id)) continue;
    if (skip.has(pane.pane_id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    const id = machine ? `${machine}/${pane.pane_id}` : pane.pane_id;
    if (pane.agent_status && ALIVE_STATUSES.has(pane.agent_status)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      state.activity.delete(id);
      continue;
    }
    if (pane.tab_id && laneTabs.has(pane.tab_id) && pane.terminal_title?.trim().startsWith(DAG_VIEWER_TITLE)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      continue;
    }
    const owner = ctx.byPane.get(id) ?? (pane.tab_id ? laneTabs.get(pane.tab_id) : undefined);
    if (owner && await ctx.agentRuns(machine, pane.pane_id, owner.key)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      state.activity.delete(id);
      continue;
    }
    // The lead already heard of this lane's pane as dead from its runner.
    const alerted = owner?.deadAlertPane === pane.pane_id;
    const tail = (await view.screen({ ...(machine ? { machine } : {}), pane: pane.pane_id }, 6)).toLowerCase();
    const previous = state.lastTail.get(id);
    state.lastTail.set(id, tail);
    if (marked(tail)) {
      state.unknown.delete(id);
      if (previous !== tail) continue;
      const mark = `${id} ${hourKey}`;
      if (seen.has(mark)) continue;
      seen.add(mark);
      const lane = ctx.byPane.get(id);
      if (!alerted) out.push(`DEAD_PANE ${pane.pane_id}${machine ? ` machine=${machine}` : ""}`);
      if (lane) {
        try { appendDeadPaneReport(config, lane, pane.pane_id, ctx.now()); }
        catch (e) { out.push(`DEAD_PANES_WARN lane=${lane.key} no blocked report row written: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160)}`); }
      }
      continue;
    }
    if (owner) {
      const active = laneActivity(owner);
      if (state.activity.get(id) !== active) {
        state.unknown.delete(id);
        state.activity.set(id, active);
      }
    }
    const n = (state.unknown.get(id) ?? 0) + 1;
    state.unknown.set(id, n);
    if (n !== UNRECOGNISED_ALERT_AFTER || alerted) continue;
    const where = machine ? ` machine=${machine}` : "";
    const detail = `dead-panes: no alive status and no dead marker for ${n} ticks`;
    if (owner) out.push(`UNRECOGNISED_PANE ${pane.pane_id} lane=${owner.key}${where} ${detail}`);
    else if (!state.digested.has(id)) {
      state.digested.add(id);
      out.push(`UNRECOGNISED_PANE ${pane.pane_id} unregistered${where} ${detail}`);
    }
  }
  return out;
};
