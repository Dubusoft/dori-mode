import { guardTick } from "../host-guard.ts";
import { type CliCommand, die, every } from "./context.ts";

/** `dori guard [--loop MIN]`: host load, memory, disk and pane-count alerts. */
export const guardCommand: CliCommand = {
  options: {
    loop: { type: "string" },
  },
  run: async ({ config, deps, key, loopMin, needSupervisor }) => {
    if (key === "machines" || key === "install") {
      die(`GUARD_REMOVED dori guard ${key} is gone: each worker's runner reports its host now (dori status shows the readings); dori update removes old agents`, 2);
    }
    // The lead host's load, memory, disk and pane count as the local runner samples them (q.machine.observe); the
    // lanes-by-memory detail is the supervisor's (from guard.sample), not this loop's.
    const state = { alerting: false };
    if (loopMin <= 0) await needSupervisor();
    console.log("HOST_GUARD_READY");
    await every(loopMin, async () => {
      const observed = await deps.ops.observeMachine();
      for (const line of guardTick(observed.sample, config.guard, state)) console.log(line);
    });
  },
};
