import { resolve } from "node:path";

import { attachLaneFiles } from "../launch.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori attach <key> <path> ...`: add lead files to a running lane. */
export const attachCommand: CliCommand = {
  options: {},
  run: async ({ deps, flags, key, needSupervisor, lane }) => {
    const paths = flags.positionals.slice(1);
    if (!key || !paths.length || Object.keys(flags.values).length) die("usage: dori attach <key> <path> [<path> ...]");
    const target = await lane(key ?? "");
    await needSupervisor();
    try { for (const line of await attachLaneFiles(deps, target, paths.map((p) => resolve(p)))) console.log(line); }
    catch (e) { die(e instanceof Error ? e.message : String(e)); }
  },
};
