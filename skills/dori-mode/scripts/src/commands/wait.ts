import { realClock } from "../run.ts";
import { Waits } from "../waits.ts";
import { type CliCommand, die, offlineWarn } from "./context.ts";

/** `dori wait <key> --until SIGNAL ... | --list | --cancel <key>`: durable supervisor-owned follow-ups. */
export const waitCommand: CliCommand = {
  options: {
    list: { type: "boolean" },
    cancel: { type: "string" },
    until: { type: "string" },
    note: { type: "string" },
    thread: { type: "string" },
    every: { type: "string" },
    timeout: { type: "string" },
    "on-success": { type: "string" },
    machine: { type: "string" },
    cwd: { type: "string" },
  },
  run: async ({ config, flags, key, opt, need, machineOpt }) => {
    const waits = new Waits(config.stateDir);
    if (flags.values.list) {
      if (key || opt("cancel") || opt("until")) die("usage: dori wait --list");
      console.log(JSON.stringify(waits.list(), null, 2));
    } else if (opt("cancel")) {
      if (key || opt("until")) die("usage: dori wait --cancel <key>");
      const cancelled = need("cancel");
      if (!waits.cancel(cancelled)) die(`no wait "${cancelled}"`);
      console.log(`WAIT_CANCELLED ${cancelled}`);
    } else {
      const target = await machineOpt();
      if (target && !opt("cwd")) die("dori wait --machine needs --cwd (a directory on that machine)");
      const wait = waits.register({
        key: key ?? die("wait needs a key"), until: need("until"), note: need("note"),
        thread: opt("thread"), every: opt("every"), timeout: opt("timeout"), onSuccess: opt("on-success"), cwd: target ? need("cwd") : process.cwd(),
        ...(target ? { machine: target.machine } : {}),
      }, realClock.now());
      console.log(`WAIT_REGISTERED ${wait.key}${target ? ` machine=${target.machine}` : ""}`);
      if (target?.offline) console.log(offlineWarn(target.machine, "wait"));
    }
  },
};
