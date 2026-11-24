import { randomBytes } from "node:crypto";

import { publicSpec, SourceSpecs, sourceViews } from "../event-sources.ts";
import { type CliCommand, die, commandArgv, offlineWarn, runnerOffline } from "./context.ts";

/** `dori source list|add|remove`: registered event sources. */
export const sourceCommand: CliCommand = {
  options: {
    type: { type: "string" },
    command: { type: "string" },
    secret: { type: "string" },
    machine: { type: "string" },
    kind: { type: "string" },
    every: { type: "string" },
    match: { type: "string" },
    cwd: { type: "string" },
    port: { type: "string" },
    path: { type: "string" },
    json: { type: "boolean" },
  },
  run: async ({ config, flags, opt, need, machineOpt }) => {
    const [action, name, ...extra] = flags.positionals;
    const specs = new SourceSpecs(config.stateDir);
    const usage = "usage: dori source list [--json] | dori source add <name> --type poll|webhook|file ... [--machine M] | dori source remove <name>";
    if (extra.length) die(usage);
    if (action === "list" && name === undefined) {
      const view = sourceViews(config.stateDir);
      const registered = new Map(specs.list().map((spec) => [spec.name, publicSpec(spec)]));
      const rows = view.sources.map((source) => ({ ...source, ...(registered.get(source.name) ?? {}) }));
      const offline = new Map<string, boolean | undefined>();
      for (const row of rows) if (row.machine && !offline.has(row.machine)) offline.set(row.machine, await runnerOffline(config.stateDir, row.machine));
      if (flags.values.json) console.log(JSON.stringify(rows, null, 2));
      else for (const row of rows) console.log(`${row.name} ${row.type}${row.kind ? ` ${row.kind}` : ""} events=${row.events ?? 0} duplicates=${row.duplicates ?? 0} last=${row.lastEventAt === undefined ? "never" : `${row.lastKind} ${new Date(row.lastEventAt).toISOString()}`}${row.failing ? ` FAILING ${row.lastError}` : ""}${"identity" in row && row.identity ? ` identity=${row.identity}` : ""}${row.machine ? ` machine=${row.machine}${offline.get(row.machine) ? " (runner offline)" : ""}` : ""}`);
      return;
    }
    if (action === "remove" && name) {
      if (!specs.remove(name)) die(`no source "${name}"`);
      console.log(`SOURCE_REMOVED ${name}`);
      return;
    }
    if (action !== "add" || !name) die(usage);
    const type = need("type");
    const command = opt("command");
    const generated = type === "webhook" && !opt("secret") ? randomBytes(24).toString("hex") : undefined;
    const target = await machineOpt();
    if (target && type !== "poll") die("--machine is for --type poll sources (a webhook or file source runs on the supervisor host)");
    const spec = specs.add({
      name, type, kind: need("kind"),
      ...(type === "poll" ? {
        command: commandArgv(command),
        everySec: Number(need("every")), match: need("match"), ...(opt("cwd") ? { cwd: opt("cwd") } : {}),
        ...(target ? { machine: target.machine } : {}),
      } : {}),
      ...(type === "webhook" ? { port: Number(need("port")), secret: generated ?? need("secret") } : {}),
      ...(type === "file" ? { path: need("path"), match: need("match") } : {}),
    });
    console.log(JSON.stringify(publicSpec(spec), null, 2));
    if (generated) console.log(`WEBHOOK_SECRET ${generated} (shown once; send it as X-Dori-Secret)`);
    console.log(`SOURCE_ADDED ${spec.name}`);
    if (target?.offline) console.log(offlineWarn(target.machine, "source"));
  },
};
