import { recoverLanes } from "../recover.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori recover [key]`: recover missing or wrong-model working lane panes. */
export const recoverCommand: CliCommand = {
  options: {},
  run: async ({ deps, flags, key, needSupervisor }) => {
    if (flags.positionals.length > 1 || Object.keys(flags.values).length) die("usage: dori recover [key]");
    if (key && !(await deps.registry.read(key))) die(`no registered lane "${key}"`);
    await needSupervisor();
    for (const line of await recoverLanes(deps, key)) console.log(line);
  },
};
