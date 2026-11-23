import { closeLane } from "../done-flow.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori close <key> [--note TEXT] [--force] | --cancelled --reason TEXT`: close a lane. */
export const closeCommand: CliCommand = {
  options: {
    cancelled: { type: "boolean" },
    reason: { type: "string", multiple: true },
    note: { type: "string" },
    force: { type: "boolean" },
  },
  run: async ({ config, deps, flags, key, opt, needSupervisor, lane }) => {
    let cancelled: { reason: string } | undefined;
    if (!flags.values.cancelled && flags.values.reason !== undefined) {
      die("--reason goes with --cancelled: dori close <key> --cancelled --reason TEXT");
    }
    if (flags.values.cancelled) {
      const reasons = (Array.isArray(flags.values.reason) ? flags.values.reason : []).filter((r): r is string => typeof r === "string" && r.trim() !== "");
      if (!reasons.length) die("usage: dori close <key> --cancelled --reason TEXT [--force]");
      cancelled = { reason: reasons.map((r) => r.trim()).join("; ") };
    }
    const note = opt("note") ?? (cancelled ? `cancelled: ${cancelled.reason}` : "closed by the lead");
    const target = await lane(key ?? die("close needs a lane key"));
    await needSupervisor();
    // A cancelled autopilot lane's task gets its blocker note here (task-finish.ts taskBlocker), as in the supervisor.
    const { taskBlocker } = await import("../task-finish.ts");
    const { ToodoWriter } = await import("../toodo-client.ts");
    const blockTask = taskBlocker(new ToodoWriter(deps.tunables.toodoWriter));
    const r = await closeLane({ ...deps, blockTask }, target, note, { force: Boolean(flags.values.force), ...(cancelled ? { cancelled } : {}) });
    for (const line of r.lines) console.log(line);
    // Owner decisions still open for this lane never block the close; they are named so the lead closes or keeps them.
    const { openOwnerDecisions } = await import("../owner-decisions.ts");
    const pending = openOwnerDecisions(config.stateDir).filter((d) => d.lane === target.key).map((d) => d.id);
    if (pending.length) console.log(`CLOSE_NOTE open decisions: ${pending.join(" ")}`);
    process.exit(r.closed ? 0 : 2);
  },
};
