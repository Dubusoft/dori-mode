import { displayTime } from "../display-time.ts";
import { realClock } from "../run.ts";
import { readSourceStatus, SourceSpecs } from "../event-sources.ts";
import { nextSlot, queueRunNow, scheduleRow, type ScheduleSpec } from "../schedule.ts";
import { type CliCommand, die, commandArgv, offlineWarn, runnerOffline } from "./context.ts";

/** `dori schedule list|add|remove|run-now`: scheduled jobs. */
export const scheduleCommand: CliCommand = {
  options: {
    json: { type: "boolean" },
    every: { type: "string" },
    timeout: { type: "string" },
    machine: { type: "string" },
    kind: { type: "string" },
    cron: { type: "string" },
    text: { type: "string" },
    command: { type: "string" },
    cwd: { type: "string" },
    heavy: { type: "boolean" },
    tz: { type: "string" },
    "catch-up": { type: "string" },
  },
  run: async ({ config, flags, opt, need, machineOpt }) => {
    const [action, name, ...extra] = flags.positionals;
    const specs = new SourceSpecs(config.stateDir);
    const usage = "usage: dori schedule list [--json] | dori schedule add <name> (--cron EXPR | --every SEC) (--text T | --command CMD [--cwd DIR] [--machine M] [--heavy] [--timeout SEC]) --kind KIND [--tz ZONE] [--catch-up once|skip] | dori schedule remove <name> | dori schedule run-now <name>";
    if (extra.length) die(usage);
    const now = realClock.now();
    const find = (job: string): ScheduleSpec => {
      const spec = specs.list().find((s) => s.name === job);
      return spec?.type === "schedule" ? spec : die(`no schedule "${job}"`);
    };
    const at = (ms: number | undefined): string => (ms === undefined ? "never" : displayTime(ms, config.displayTimeZone, "short"));
    if (action === "list" && name === undefined) {
      const status = readSourceStatus(config.stateDir)?.sources ?? {};
      const rows = specs.list().filter((spec): spec is ScheduleSpec => spec.type === "schedule").map((spec) => scheduleRow(spec, status[spec.name], now));
      const offline = new Map<string, boolean | undefined>();
      for (const row of rows) if (row.machine && !offline.has(row.machine)) offline.set(row.machine, await runnerOffline(config.stateDir, row.machine));
      if (flags.values.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length) console.log("SCHEDULES none");
      else for (const row of rows) console.log(`${row.name} ${row.kind} ${row.when}${row.heavy ? " heavy" : ""} catch-up=${row.catchUp} next=${row.waiting ? `waiting for a ${row.waiting}` : at(row.nextRunAt)} last=${at(row.lastRunAt)}${row.lastResult ? ` ${row.lastResult}` : ""}${row.machine ? ` machine=${row.machine}${offline.get(row.machine) ? " (runner offline)" : ""}` : ""}`);
      return;
    }
    if (action === "remove" && name) {
      find(name);
      specs.remove(name);
      console.log(`SCHEDULE_REMOVED ${name}`);
      return;
    }
    if (action === "run-now" && name) {
      find(name);
      queueRunNow(config.stateDir, name, now);
      console.log(`SCHEDULE_RUN_QUEUED ${name}; the supervisor runs it on its next pass`);
      return;
    }
    if (action !== "add" || !name) die(usage);
    const every = opt("every");
    const timeout = opt("timeout");
    const target = await machineOpt();
    const spec = specs.add({
      name, type: "schedule", kind: need("kind"), since: now,
      ...(opt("cron") ? { cron: opt("cron") } : {}), ...(every !== undefined ? { everySec: Number(every) } : {}),
      ...(opt("text") !== undefined ? { text: opt("text") } : {}),
      ...(opt("command") !== undefined ? { command: commandArgv(opt("command")) } : {}),
      ...(opt("cwd") ? { cwd: opt("cwd") } : {}), ...(flags.values.heavy ? { heavy: true } : {}),
      ...(target ? { machine: target.machine } : {}),
      ...(timeout !== undefined ? { timeoutSec: Number(timeout) } : {}),
      ...(opt("tz") ? { tz: opt("tz") } : {}), ...(opt("catch-up") ? { catchUp: opt("catch-up") } : {}),
    });
    console.log(JSON.stringify(spec, null, 2));
    console.log(`SCHEDULE_ADDED ${spec.name} next ${at(spec.type === "schedule" ? nextSlot(spec, now) : undefined)}`);
    if (target?.offline) console.log(offlineWarn(target.machine, "schedule"));
  },
};
