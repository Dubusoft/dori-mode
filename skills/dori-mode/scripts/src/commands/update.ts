import { homedir } from "node:os";
import { join } from "node:path";

import { realClock, run } from "../run.ts";
import { updateInstall } from "../update.ts";
import { writeUpdateResult } from "../auto-update.ts";
import { refreshBootPrep } from "../boot-prep-install.ts";
import { refreshLaneSandbox } from "../lane-sandbox-install.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori update [--dev] [--force] [--result PATH]`: fast-forward this install and restart the supervisor when HEAD moved. */
export const updateCommand: CliCommand = {
  options: {
    dev: { type: "boolean" },
    force: { type: "boolean" },
    result: { type: "string" },
  },
  run: async ({ flags, opt }) => {
    const result = opt("result");
    if (flags.positionals.length || ("result" in flags.values && !result) ||
        Object.entries(flags.values).some(([name, v]) => name !== "result" && ((name !== "dev" && name !== "force") || v !== true))) {
      die("usage: dori update [--dev] [--force] [--result PATH]");
    }
    const logged: string[] = [];
    const code = await updateInstall({
      run, sleep: realClock.sleep, log: (line) => { console.log(line); logged.push(line); },
      // A fresh process: this one still holds the modules it loaded before the pull, which may refer to files the pull
      // removed or exports the pulled code no longer has.
      // stdin is inherited so runner setup and `dori setup --migrate` can ask new keys on a terminal.
      upgradeRunners: async () => Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "runner", "upgrade"], { stdio: ["inherit", "inherit", "inherit"] }).exited,
      // stdout is passed through as it arrives (prompts included) and kept for the update summary.
      migrateConfig: async () => {
        const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "setup", "--migrate"], { stdio: ["inherit", "pipe", "inherit"] });
        const decoder = new TextDecoder();
        let output = "";
        for await (const chunk of p.stdout) { process.stdout.write(chunk); output += decoder.decode(chunk, { stream: true }); }
        return { code: await p.exited, output };
      },
      refreshLaneSandbox: () => refreshLaneSandbox(homedir()),
      refreshBootPrep: () => refreshBootPrep(homedir()),
    },
      { packageDir: join(import.meta.dir, "..", ".."), branch: flags.values.dev ? "dev" : "main", force: flags.values.force === true });
    // The supervisor's automatic update (update.ts AutoUpdate) reads its outcome from here.
    if (result) writeUpdateResult(result, { at: Date.now(), code, lines: logged });
    process.exit(code);
  },
};
