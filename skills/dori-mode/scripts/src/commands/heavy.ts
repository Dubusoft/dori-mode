import { loadavg } from "node:os";

import { acquireSlot, pidAlive } from "../heavy-slot.ts";
import { watchSimulators } from "../heavy-simulators.ts";
import { realClock, run } from "../run.ts";
import { heavyDirOf } from "../runner/lane-cli.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori heavy <label> -- <command ...>`: run a heavy command in a free slot; everything after -- is the command. */
export const heavyCommand: CliCommand = {
  options: {},
  ownFlags: true,
  run: async ({ config, rest }) => {
    const sep = rest.indexOf("--");
    const label = rest[0];
    const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
    if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
    // One slot directory per host (D17), shared with the lanes' `dori heavy` and the supervisor's scheduled heavy jobs.
    const load = async () => loadavg()[0] ?? 0;
    const dir = heavyDirOf();
    const slot = await acquireSlot({ dir, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
    const finish = await watchSimulators({ run, dir, platform: process.platform, alive: (pid) => pidAlive(pid), now: realClock.now, pid: process.pid, err: (line) => console.error(line) }, slot);
    try {
      const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
      process.exitCode = await child.exited;
    } finally {
      await finish();
    }
  },
};
