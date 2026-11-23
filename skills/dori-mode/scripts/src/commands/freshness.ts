import { freshnessTick, sweepActLine } from "../freshness.ts";
import { openLaneReports } from "../lane-report-store.ts";
import { type CliCommand, every } from "./context.ts";

/** `dori freshness [--loop MIN]`: nudge silent lanes. */
export const freshnessCommand: CliCommand = {
  options: {
    loop: { type: "string" },
  },
  run: async ({ deps, loopMin, needSupervisor }) => {
    // A one-shot run fails closed with the supervisor down; a loop warns per pass and retries (D7).
    if (loopMin <= 0) await needSupervisor();
    await every(loopMin, async () => {
      const reports = openLaneReports(deps.config);
      try {
        for (const a of await freshnessTick(deps, undefined, reports)) console.log(sweepActLine(a));
      } finally { reports.close(); }
    });
  },
};
