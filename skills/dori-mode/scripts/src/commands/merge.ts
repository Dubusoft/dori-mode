import { userInfo } from "node:os";

import { realClock } from "../run.ts";
import { type CliCommand } from "./context.ts";

/** `dori merge pause|resume|status`: merge-pause.ts reads its own flags. */
export const mergeCommand: CliCommand = {
  options: {},
  ownFlags: true,
  run: async ({ config, rest }) => {
    const { mergePauseMain } = await import("../merge-pause.ts");
    process.exit(mergePauseMain(rest, {
      stateDir: config.stateDir, now: realClock.now, who: `lead (${userInfo().username})`,
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    }));
  },
};
