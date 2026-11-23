import { join } from "node:path";

import { realClock } from "../run.ts";
import { openOperations } from "../operations.ts";
import { type CliCommand } from "./context.ts";

/** `dori autopilot ...`: autopilot-cli.ts reads its own flags. */
export const autopilotCommand: CliCommand = {
  options: {},
  ownFlags: true,
  run: async ({ config, deps, rest }) => {
    const { autopilotMain, liveJudgeDeps } = await import("../autopilot-cli.ts");
    const { acquireStateLock } = await import("../state-lock.ts");
    const store = openOperations(config);
    const code = await autopilotMain(rest, {
      ...liveJudgeDeps(deps, store), now: realClock.now,
      lock: () => acquireStateLock(join(config.stateDir, "autopilot-launch.lock.sqlite")),
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    });
    store.close();
    process.exit(code);
  },
};
