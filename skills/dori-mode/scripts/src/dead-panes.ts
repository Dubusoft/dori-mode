import type { DoriConfig } from "./config.ts";
import type { LaneReads } from "./done-flow.ts";
import type { LaneOps } from "./lane-ops.ts";
import { appendDeadPaneReport } from "./lane-reports.ts";
import { ALIVE_STATUSES } from "./pane-state.ts";
import type { Lane } from "./registry.ts";
import { BUILT_IN } from "./tunables.ts";

/** Unrecognised ticks in a row before one alert names the pane. */
export const UNRECOGNISED_ALERT_AFTER = 3;

/** Terminal title of the DAG viewer a mass-ulw lane opens next to its agent pane. It runs no agent, so herdr reports no status. */
export const DAG_VIEWER_TITLE = "OmO DAG";

/** Per-pane memory across ticks: the CLI keeps one of these for the life of the loop. */
export type DeadPaneState = { readonly unknown: Map<string, number>; readonly lastTail: Map<string, string> };
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map() });

/**
 * A pane is alive when herdr reports a running agent status for it; that wins over any screen text. Otherwise it is
 * dead only when this tick's tail carries a configured dead marker AND equals the previous tick's tail, so the two
 * reads are a full loop interval apart and a screen mid-redraw never counts. A marker seen once is pending. Anything
 * else is unrecognised, counted per pane, with one alert after UNRECOGNISED_ALERT_AFTER ticks in a row.
 * A DAG viewer pane in the same tab as a registered lane's pane belongs to that lane and is never counted.
 * A dead pane that is a registered lane's pane also leaves a synthetic `blocked` report row under that lane's key (lane-reports.ts appendDeadPaneReport), so the lane's result is not lost.
 * Pane lists and tails come from each machine's runner: `view` (the supervisor round's cached reads), else `ops`.
 * A machine that is not `admitted` (its runner has no admitted connection) is skipped without a line.
 */
export const deadPaneTick = async (ops: LaneOps, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState = newDeadPaneState(), lanes: readonly Lane[] = [], view: LaneReads = ops, now: () => number = Date.now, admitted: (machine?: string) => boolean = () => true): Promise<string[]> => {
  const out: string[] = [];
  const byPane = new Map(lanes.flatMap((lane) => lane.pane ? [[lane.machine ? `${lane.machine}/${lane.pane}` : lane.pane, lane] as const] : []));
  const ctx: Ctx = { byPane, now };
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

type Ctx = { readonly byPane: ReadonlyMap<string, Lane>; readonly now: () => number };

const inspect = async (view: LaneReads, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState, ctx: Ctx, machine?: string, owned?: ReadonlySet<string>): Promise<string[]> => {
  const out: string[] = [];
  const watch = new Set([config.laneWorkspace].filter(Boolean));
  const skip = new Set([config.leadPane, ...config.ignorePanes].filter(Boolean));
  const marked = (tail: string) => BUILT_IN.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()));
  const panes = await view.panes(machine);
  const laneTabs = new Set(panes.flatMap((p) => p.tab_id && ctx.byPane.has(machine ? `${machine}/${p.pane_id}` : p.pane_id) ? [p.tab_id] : []));
  for (const pane of panes) {
    if (owned && !owned.has(pane.pane_id)) continue;
    if (skip.has(pane.pane_id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    const id = machine ? `${machine}/${pane.pane_id}` : pane.pane_id;
    if (pane.agent_status && ALIVE_STATUSES.has(pane.agent_status)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      continue;
    }
    if (pane.tab_id && laneTabs.has(pane.tab_id) && pane.terminal_title?.trim().startsWith(DAG_VIEWER_TITLE)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      continue;
    }
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
      out.push(`DEAD_PANE ${pane.pane_id}${machine ? ` machine=${machine}` : ""}`);
      if (lane) {
        try { appendDeadPaneReport(config, lane, pane.pane_id, ctx.now()); }
        catch (e) { out.push(`DEAD_PANES_WARN lane=${lane.key} no blocked report row written: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160)}`); }
      }
      continue;
    }
    const n = (state.unknown.get(id) ?? 0) + 1;
    state.unknown.set(id, n);
    if (n === UNRECOGNISED_ALERT_AFTER) out.push(`UNRECOGNISED_PANE ${pane.pane_id}${machine ? ` machine=${machine}` : ""} dead-panes: no alive status and no dead marker for ${n} ticks`);
  }
  return out;
};
