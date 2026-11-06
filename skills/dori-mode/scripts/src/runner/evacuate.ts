import type { Lane } from "../registry.ts";
import { acceptLaneEvent, type LaneHubDeps } from "./lanes-hub.ts";
import type { AnyRunnerEvent } from "./protocol.ts";

/**
 * `dori runner evacuate <label>`: stopping a runner that cannot be used any more (D9). In order: (1) the runner's
 * events not yet acked are fetched over ssh and taken exactly as if they had arrived, so a report already received is
 * not stored twice (same `source`) and none is lost; (2) every open lane the runner owns is told, through that runner
 * (`lane.send`) while it still runs, that its reports will fail until the runner is back; (3) the runner's service is
 * stopped. `Lane.runner` is kept: the runner is the only path to its lanes, so there is nothing to fall back to. The
 * lanes keep running: their panes belong to herdr, not to the runner. A step that fails is reported and the later
 * steps still run.
 */

export type EvacuateDeps = {
  readonly hub: LaneHubDeps;
  readonly exportOutbox: (label: string) => Promise<readonly AnyRunnerEvent[]>;
  readonly tellLane: (lane: Lane, text: string) => Promise<boolean>;
  readonly stopRunner: (label: string) => Promise<{ readonly ok: boolean; readonly detail: string }>;
};

export const evacuateNoticeText = (lane: Lane, label: string): string =>
  `[LEAD] the runner on ${label} is being stopped. Until it is back, dori report, claim-done and lane status for ${lane.key} fail; keep working, and send your report again once dori report succeeds.`;

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
    const told = await deps.tellLane(lane, evacuateNoticeText(lane, label)).catch(() => false);
    lines.push(`RUNNER_EVACUATE_LANE ${lane.key} ${told ? "told" : "not told: the notice could not be sent through the runner, tell the lane by hand"}`);
  }
  const stopped = await deps.stopRunner(label).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
  lines.push(stopped.ok ? `RUNNER_EVACUATE_STOPPED runner=${label}` : `RUNNER_EVACUATE_STOP_FAILED runner=${label} ${stopped.detail}`);
  return lines;
};
