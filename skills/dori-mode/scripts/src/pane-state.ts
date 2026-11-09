import type { Pane } from "./panes.ts";

/** States herdr reports for a pane whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

/** Why `pane` cannot take typed text as an agent prompt: missing from the list, or no agent runs in it (only a shell). */
export const agentRefusal = (panes: readonly Pane[], pane: string): string | undefined => {
  const found = panes.find((p) => p.pane_id === pane);
  if (!found) return `pane ${pane} missing`;
  if (!found.agent) return `pane ${pane} runs no agent`;
  return undefined;
};
