import { resolveLaneContext } from "./runner/lane-identity.ts";

/** The lane this process runs inside (`DORI_LANE_KEY`, lane-identity.ts), or undefined for the lead. */
export const callerLane = (env: Readonly<Record<string, string | undefined>> = process.env): string | undefined => resolveLaneContext(env);

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
