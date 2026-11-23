import { claimDone } from "../done-flow.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori claim-done <key> --evidence TEXT`: the lead claims done for a lane. */
export const claimDoneCommand: CliCommand = {
  options: {
    evidence: { type: "string" },
  },
  run: async ({ deps, key, need, needSupervisor, lane }) => {
    // Inside a lane claim-done is lane mode's (a done report over the lane socket); the lead names the lane.
    const target = await lane(key ?? die("claim-done needs a lane key"));
    const evidence = need("evidence");
    await needSupervisor();
    console.log(await claimDone(deps, target, evidence));
  },
};
