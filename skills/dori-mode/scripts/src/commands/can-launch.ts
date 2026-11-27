import { listGuardMachines } from "../remote-guard.ts";
import { placementReports } from "../launch-service.ts";
import { recordLaunchVerdict } from "../routing.ts";
import { checkMachine, LOCAL_MACHINE, planLaunch, resolvePlacement, verdictLine } from "../placement.ts";
import { type CliCommand } from "./context.ts";

/** `dori can-launch [--machine M] [--cwd D] [--done "..."] [--all]`: whether a launch has room. */
export const canLaunchCommand: CliCommand = {
  options: {
    all: { type: "boolean" },
    machine: { type: "string" },
    cwd: { type: "string" },
    done: { type: "string" },
  },
  run: async ({ config, deps, flags, opt }) => {
    const listed = flags.values.all ? listGuardMachines(config.guardMachines, config.stateDir) : [];
    const reports = flags.values.all ? [] : await placementReports(config.stateDir);
    const input = { machine: opt("machine"), cwd: opt("cwd"), done: opt("done") ?? "" };
    const p = flags.values.all ? undefined : resolvePlacement(input, config.placement, reports);
    const machines = p ? [p.machine] : [LOCAL_MACHINE, ...listed.map((m) => m.label)];
    // An offline owning runner holds the launch without observing anything, and several declaring runners are picked
    // among exactly as a launch would: both through planLaunch.
    const planned = p && (p.online === false || p.candidates) ? await planLaunch(input, config.placement, (m) => checkMachine(deps.ops, config, m), reports) : undefined;
    for (const line of planned?.lines.filter((l) => l.startsWith("PLACEMENT_CANDIDATES ")) ?? []) console.error(line);
    const checks = planned ? [planned.check] : await Promise.all(machines.map((m) => checkMachine(deps.ops, config, m)));
    const at = Date.now();
    for (const c of checks) {
      recordLaunchVerdict(config.stateDir, c.verdict, at, c.machine);
      console.log(verdictLine(c.machine, c.verdict));
    }
    process.exit(checks.every((c) => c.verdict.ok) ? 0 : 4);
  },
};
