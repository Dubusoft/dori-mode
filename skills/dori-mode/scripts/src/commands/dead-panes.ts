import { deadPaneTick, newDeadPaneState } from "../dead-panes.ts";
import { type CliCommand, every } from "./context.ts";

/** `dori dead-panes [--loop MIN]`: print DEAD_PANE <id> for stopped agent panes. */
export const deadPanesCommand: CliCommand = {
  options: {
    loop: { type: "string" },
  },
  run: async ({ config, deps, loopMin, needSupervisor }) => {
    const seen = new Set<string>();
    const paneState = newDeadPaneState();
    if (loopMin <= 0) await needSupervisor();
    await every(loopMin, async () => {
      for (const line of await deadPaneTick(deps.ops, config, seen, new Date().toISOString().slice(0, 13), paneState, await deps.registry.open())) console.log(line);
    });
  },
};
