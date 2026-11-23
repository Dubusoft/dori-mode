import { placementReports } from "../launch-service.ts";
import { candidatesLine, placementLine, placementTable, resolvePlacement } from "../placement.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori placement [--repo owner/repo] [--cwd D] [--done "..."] [--json]`: where launches go. */
export const placementCommand: CliCommand = {
  options: {
    repo: { type: "string" },
    cwd: { type: "string" },
    done: { type: "string" },
    json: { type: "boolean" },
  },
  run: async ({ config, flags, opt }) => {
    if (flags.positionals.length) die("usage: dori placement [--repo owner/repo] [--cwd D] [--done \"...\"] [--json]", 2);
    const reports = await placementReports(config.stateDir);
    const repo = opt("repo");
    if (repo === undefined && opt("cwd") === undefined && opt("done") === undefined) {
      if (flags.values.json) console.log(JSON.stringify({ runners: reports, defaultMachine: config.placement.defaultMachine, fallback: config.placement.fallback }, null, 2));
      else for (const line of placementTable(reports, config.placement)) console.log(line);
      process.exit(0);
    }
    // --repo reads as a Done line naming that repo, so it matches exactly what a launch with that repo would.
    const done = [opt("done"), repo ? `merged ${repo}#0` : undefined].filter(Boolean).join("; ");
    const p = resolvePlacement({ cwd: opt("cwd"), done }, config.placement, reports);
    if (flags.values.json) console.log(JSON.stringify(p));
    else {
      console.log(placementLine(p));
      // Without checking room, the preferred candidate (online, defaultMachine first) stands for the pick.
      if (p.candidates) console.log(candidatesLine(p, p.online === false ? "none" : p.machine));
      if (p.online === false) console.log(`HOLD machine=${p.machine} runner ${p.machine} that owns ${p.rule} is offline; the launch waits for it`);
    }
    process.exit(0);
  },
};
