import { realClock } from "../run.ts";
import { queueEmit } from "../event-sources.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori emit <KIND> --text T [--id ID]`: journal one event. */
export const emitCommand: CliCommand = {
  options: {
    text: { type: "string" },
    id: { type: "string" },
  },
  run: async ({ config, flags, key, opt, need }) => {
    const kind = key;
    if (!kind || flags.positionals.length > 1 || Object.keys(flags.values).some((name) => name !== "text" && name !== "id")) die("usage: dori emit <KIND> --text T [--id ID]");
    const id = queueEmit(config.stateDir, kind ?? "", need("text"), realClock.now(), opt("id"));
    console.log(`EMIT_QUEUED ${id}`);
  },
};
