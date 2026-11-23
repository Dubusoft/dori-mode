import { pauseLane, resumeLane } from "../pause.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori pause|resume <key> [--note TEXT]`: pause a lane on the owner's word, or undo it. */
export const pauseCommand: CliCommand = {
  options: {
    note: { type: "string" },
  },
  run: async ({ deps, key, command, opt, needSupervisor, lane }) => {
    const act = command === "pause" ? pauseLane : resumeLane;
    const target = await lane(key ?? die(`${command} needs a lane key`));
    await needSupervisor();
    const r = await act(deps, target, opt("note") ?? `${command}d by the lead`);
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  },
};
