import { realClock } from "../run.ts";
import { requestLeadRestart } from "../lead-restart.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori lead-restart [--model ID] [--thinking LEVEL]`: request a cold start of the lead at its next idle moment. */
export const leadRestartCommand: CliCommand = {
  options: {
    model: { type: "string" },
    thinking: { type: "string" },
  },
  run: async ({ config, flags, opt }) => {
    if (flags.positionals.length || Object.keys(flags.values).some((name) => name !== "model" && name !== "thinking") ||
        ("model" in flags.values && !opt("model")) || ("thinking" in flags.values && !opt("thinking"))) {
      die("usage: dori lead-restart [--model ID] [--thinking LEVEL]");
    }
    const request = requestLeadRestart(config, realClock.now(), opt("model"), opt("thinking"));
    console.log(`LEAD_RESTART_REQUESTED ${request.id} ${request.models[0]?.model}`);
  },
};
