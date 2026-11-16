import type { FlowDeps } from "./done-flow.ts";

/**
 * The lane this process runs inside, or undefined for the lead. `dori launch` sets DORI_LANE_KEY in a local lane's
 * pane; a pane registered to an open lane (HERDR_PANE_ID) counts as that lane too, so unsetting the variable is not
 * enough. The lead pane (config.leadPane) is never a lane.
 */
export const callerLane = async (deps: Pick<FlowDeps, "registry" | "config">, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> => {
  const key = env.DORI_LANE_KEY?.trim();
  if (key) return key;
  const pane = env.HERDR_PANE_ID?.trim();
  if (!pane || pane === deps.config.leadPane) return undefined;
  return (await deps.registry.byPane(pane))?.key;
};

/** Why a lane may not run `command` on lane `target`, or undefined when it may (the lead always may). */
export const laneActRefusal = (caller: string | undefined, command: string, target: string): string | undefined =>
  caller === undefined || caller === target ? undefined : `LANE_PERMISSION_DENIED lane ${caller} may not ${command} lane ${target}; only its own key (the lead can act on any lane)`;

/**
 * Why `caller` may not run `dori send`, or undefined for the lead. Only the lead talks to the owner: a lane, even in its
 * own work thread, asks through `dori report <key> question` and the lead relays the answer.
 */
export const laneSendRefusal = (caller: string | undefined): string | undefined =>
  caller === undefined
    ? undefined
    : `LANE_PERMISSION_DENIED lane ${caller} may not run send; it is lead-only. Ask the lead instead: dori report ${caller} question --text "..."`;

/**
 * Why `caller` may not run `dori decision`, or undefined for the lead. Only the lead opens, closes and lists owner
 * decisions: a lane asks with a question report carrying choices, which the supervisor opens as a decision.
 */
export const laneDecisionRefusal = (caller: string | undefined): string | undefined =>
  caller === undefined
    ? undefined
    : `LANE_PERMISSION_DENIED lane ${caller} may not run decision; it is lead-only. Ask with dori report ${caller} question --option ... --recommend N --reason ...`;
