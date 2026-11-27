#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { AckError } from "./ack.ts";
import { COMMANDS, KNOWN_OPTIONS } from "./commands/index.ts";
import { die, leadContext } from "./commands/context.ts";
import { statusMain } from "./commands/status.ts";
import { commandHelp, USAGE } from "./commands/usage.ts";
import { loadConfig } from "./config.ts";
import { LaneMessageError } from "./lane-messages.ts";
import { LaneOpsError } from "./lane-ops.ts";
import { LaunchError } from "./launch.ts";
import { DiscordGatewayOwnedError } from "./messenger/discord-lock.ts";
import { MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { TranscriptionError } from "./messenger/voice.ts";
import { SourceError } from "./event-sources.ts";
import { Registry } from "./registry.ts";
import { ReposError } from "./repos.ts";
import { setDefaultRunTimeout } from "./run.ts";
import { RunnerUnavailable } from "./runner/call.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { laneCliMain } from "./runner/lane-cli.ts";
import { resolveLaneContext } from "./runner/lane-identity.ts";
import { connectLaneSocket } from "./runner/lane-socket.ts";
import { connectUnix } from "./runner/unix-transport.ts";
import { StoreError } from "./store.ts";
import { convertJsonState } from "./store-convert.ts";

// The lane-mode gate runs before anything else (help, setup, runner *, loadConfig): inside a lane dori takes only
// report, claim-done, report ack, lane status, heavy and secret env, all over the runner's lane socket, and opens no registry,
// store, journal, inbox or state-dir file.
{
  if (resolveLaneContext(process.env) !== undefined) {
    process.exit(await laneCliMain(process.argv.slice(2), {
      env: process.env, connect: connectLaneSocket(defaultRunnerDir(), (path) => connectUnix(path)), stdoutIsTTY: process.stdout.isTTY === true,
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    }));
  }
}

const help = commandHelp(process.argv.slice(2));
if (help !== undefined) {
  console.log(help);
  process.exit(0);
}

if (process.argv[2] === "setup") {
  const { setupMain } = await import("./setup-cli.ts");
  process.exit(await setupMain(process.argv.slice(3)));
}

if (process.argv[2] === "doctor") process.exit(await (await import("./doctor.ts")).doctorMain());
if (process.argv[2] === "status") process.exit(await statusMain(process.argv.slice(3)));

if (process.argv[2] === "runner") {
  // serve and probe run on runner hosts and live in runner/main.ts, which the worker bundle (runner/bin.ts) also runs.
  if (process.argv[3] === "serve" || process.argv[3] === "probe") {
    const { runnerHostMain } = await import("./runner/main.ts");
    process.exit(await runnerHostMain(process.argv.slice(3)));
  }
  // evacuate reads the lane reports store, so a json state dir converts first, as for the lead commands below.
  if (process.argv[3] === "evacuate") await convertJsonState((await loadConfig()).stateDir);
  const { runnerAdminMain } = await import("./runner-admin-cli.ts");
  process.exit(await runnerAdminMain({ die }));
}

const config = await loadConfig();
await convertJsonState(config.stateDir);
setDefaultRunTimeout(config.runTimeoutMs);
const [command = "", ...rest] = process.argv.slice(2);
const found = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
if (!found) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

// Not strict: an ownFlags command reads its own flags from `rest` (its own parseArgs or argv walk) and checks them there.
// For the others a flag no command declares is refused here; one only another command declares is left to the command's
// own argument checks.
const flags = parseArgs({ args: rest, allowPositionals: true, strict: false, options: KNOWN_OPTIONS });
if (!found.ownFlags) {
  const unknown = Object.keys(flags.values).filter((name) => !Object.hasOwn(KNOWN_OPTIONS, name));
  if (unknown.length) die(`usage: dori ${command} ...: unknown option ${unknown.map((name) => `--${name}`).join(" ")} (see dori ${command} --help)`, 2);
}
const loopFlag = flags.values.loop;
if (loopFlag !== undefined && (typeof loopFlag !== "string" || !/^\d+(\.\d+)?$/.test(loopFlag.trim()))) {
  die(`usage: dori ${command} [--loop MIN]: --loop takes a number of minutes (0 runs once), got ${typeof loopFlag === "string" ? JSON.stringify(loopFlag) : "no value"}`, 2);
}

try {
  await found.run(leadContext(config, new Registry(config.stateDir), command, rest, flags));
} catch (e) {
  // The supervisor (and with it every runner) is unreachable, or a runner answered RUNNER_UNAVAILABLE: fail closed (D7).
  if (e instanceof RunnerUnavailable || (e instanceof LaneOpsError && e.code === "RUNNER_UNAVAILABLE")) die(e.message, 2);
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof ReposError || e instanceof DiscordGatewayOwnedError || e instanceof AckError || e instanceof StoreError || e instanceof LaneMessageError || e instanceof SourceError) die(e.message);
  throw e;
}
