import { watchTick } from "../done-flow.ts";
import { type CliCommand } from "./context.ts";

/** `dori watch`: emit LANE_* lines every 30 s. */
export const watchCommand: CliCommand = {
  options: {},
  run: async ({ deps }) => {
    let lastWatchWarnings = new Set<string>();
    console.log("LANE_WATCH_READY");
    for (;;) {
      const lines = await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`]);
      const warnings = new Set(lines.filter((line) => line.startsWith("LANE_WATCH_WARN ")));
      for (const line of lines) {
        if (!warnings.has(line) || !lastWatchWarnings.has(line)) console.log(line);
      }
      lastWatchWarnings = warnings;
      await Bun.sleep(30_000);
    }
  },
};
