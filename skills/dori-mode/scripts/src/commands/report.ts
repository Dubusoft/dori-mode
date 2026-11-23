import { type CliCommand, die } from "./context.ts";

/** `dori report`: lane-only; the lead gets the refusal. */
export const reportCommand: CliCommand = {
  options: {},
  run: async ({ flags }) => {
    // A report is the lane's own voice, sent by its runner over the lane socket (lane mode); the lead has no lane to
    // report as.
    die(`DORI_CLI_LANE_COMMAND dori report${flags.positionals[0] === "ack" ? " ack" : ""} runs only inside a lane (DORI_LANE_KEY, or a pane its runner knows)`, 2);
  },
};
