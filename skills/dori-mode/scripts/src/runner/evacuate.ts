import type { Lane } from "../registry.ts";
import { acceptLaneEvent, type LaneHubDeps } from "./lanes-hub.ts";
import type { AnyRunnerEvent } from "./protocol.ts";

/**
 * `dori runner evacuate <label>`: the forced rollback of design 7.5, for a runner that cannot be used any more. In
 * order: (1) the runner's events not yet acked are fetched over ssh and taken exactly as if they had arrived, so a
 * report already received is not stored twice (same `source`) and none is lost; (2) every open lane the runner owns
 * is told, in its own pane over herdr, to go back to printing `[REPORT]` lines; (3) `Lane.runner` is cleared, which puts
 * the lane back on the screen-scraping path; (4) the runner's service is stopped. The lanes keep running: their panes
 * belong to herdr, not to the runner. A step that fails is reported and the later steps still run.
 */

export type EvacuateDeps = {
  readonly hub: LaneHubDeps;
  readonly exportOutbox: (label: string) => Promise<readonly AnyRunnerEvent[]>;
  readonly tellLane: (lane: Lane, text: string) => Promise<boolean>;
  readonly stopRunner: (label: string) => Promise<{ readonly ok: boolean; readonly detail: string }>;
};

export const footerBackText = (lane: Lane, label: string): string =>
  `[LEAD] footer update: the runner on ${label} is being stopped. From now on report by printing this line in your own output: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>; when done print [REPORT] ${lane.key} | done | <merge SHA, closed issue, version>. Run heavy jobs with sh ~/.dori/guard-agent.sh heavy <label> -- <command>.`;

export const evacuate = async (deps: EvacuateDeps, label: string): Promise<string[]> => {
  const lines: string[] = [];
  try {
    const events = await deps.exportOutbox(label);
    let taken = 0;
    for (const event of events) {
      if (!event.type.startsWith("lane.")) continue;
      await acceptLaneEvent(deps.hub, label, event);
      taken += 1;
    }
    lines.push(`RUNNER_EVACUATE_IMPORTED runner=${label} events=${taken}`);
  } catch (e) {
    lines.push(`RUNNER_EVACUATE_EXPORT_FAILED runner=${label} ${e instanceof Error ? e.message : String(e)}; reports not yet sent by the runner stay on it`);
  }
  const owned = (await deps.hub.registry.open()).filter((l) => l.runner === label && !l.closedAt);
  for (const lane of owned) {
    const told = lane.pane ? await deps.tellLane(lane, footerBackText(lane, label)).catch(() => false) : false;
    await deps.hub.registry.update(lane.key, (current) => {
      if (!current) return undefined;
      const { runner: _r, runnerAdoptedAt: _a, lastRunnerReportAt: _l, ...rest } = current;
      return rest as Lane;
    });
    lines.push(`RUNNER_EVACUATE_LANE ${lane.key} runner cleared${told ? "" : "; the footer update could not be typed, tell the lane by hand"}`);
  }
  const stopped = await deps.stopRunner(label).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
  lines.push(stopped.ok ? `RUNNER_EVACUATE_STOPPED runner=${label}` : `RUNNER_EVACUATE_STOP_FAILED runner=${label} ${stopped.detail}`);
  return lines;
};
