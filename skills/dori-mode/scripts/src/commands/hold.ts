import { dequeueLaunch, launchQueue } from "../routing.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori hold list | dori hold drop <key>`: launches waiting after a HOLD. */
export const holdCommand: CliCommand = {
  options: {},
  run: async ({ config, flags }) => {
    const [action, dropKey, ...extra] = flags.positionals;
    if (Object.keys(flags.values).length || extra.length || (action === "list" ? dropKey !== undefined : action !== "drop" || !dropKey)) die("usage: dori hold list | dori hold drop <key>");
    if (action === "list") console.log(JSON.stringify(launchQueue(config.stateDir), null, 2));
    else if (dequeueLaunch(config.stateDir, dropKey ?? "")) console.log(`HOLD_DROPPED ${dropKey}`);
    else die(`no queued launch "${dropKey}"`);
  },
};
