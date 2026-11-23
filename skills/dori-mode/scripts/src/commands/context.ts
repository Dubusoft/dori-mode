import type { ParseArgsOptionsConfig } from "node:util";

import { envFilePath, resolveCredential } from "../credentials.ts";
import type { FlowDeps } from "../done-flow.ts";
import { laneOps, type LaneOps } from "../lane-ops.ts";
import { Discord } from "../messenger/discord.ts";
import { discordThread } from "../messenger/discord-inbound.ts";
import { fetchHttp } from "../messenger/http.ts";
import { withThreadParent } from "../messenger/target.ts";
import { type Registry, statusOf } from "../registry.ts";
import { realClock, run } from "../run.ts";
import { RunnerUnavailable } from "../runner/call.ts";
import { type CliRunnerCall, cliRunnerCall, cliSocketPath } from "../runner/cli-relay.ts";
import { defaultRunnerDir } from "../runner/fs-safety.ts";
import { LOCAL_RUNNER } from "../runner/serve.ts";
import { BUILT_IN } from "../tunables.ts";

export const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

export type Flags = {
  readonly values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly positionals: string[];
};

type Lane = NonNullable<Awaited<ReturnType<Registry["read"]>>>;

export type CliContext = {
  readonly command: string;
  /** The raw arguments after the command, for commands that read their own flags. */
  readonly rest: string[];
  readonly config: FlowDeps["config"];
  readonly deps: FlowDeps;
  readonly flags: Flags;
  readonly key: string | undefined;
  /** `--loop MIN` as a number (0 when absent: run once). */
  readonly loopMin: number;
  readonly opt: (name: string) => string | undefined;
  readonly need: (name: string) => string;
  /** RUNNER_UNAVAILABLE (exit 2) at once when the supervisor's CLI relay does not answer: every lane operation needs it (D7). */
  readonly needSupervisor: () => Promise<void>;
  readonly lane: (key: string) => Promise<Lane>;
  /** `--machine`: undefined when absent or `local`; else a runner label known to the hub, otherwise the command dies. */
  readonly machineOpt: () => Promise<{ machine: string; offline: boolean } | undefined>;
};

export type CliCommand = {
  /**
   * The flags this command takes. A flag no command declares is refused before the command runs (exit 2), unless
   * `ownFlags` is set: then the command reads its own flags from `rest` and checks them itself.
   */
  readonly options: ParseArgsOptionsConfig;
  readonly ownFlags?: true;
  readonly run: (ctx: CliContext) => Promise<void>;
};

/** Runner label -> true when its runner is not connected, from the hub table (`runners.sqlite`) the way `dori status` reads it; undefined: no such runner. */
export const runnerOffline = async (stateDir: string, label: string): Promise<boolean | undefined> => {
  const { readRunnerRows } = await import("../runner/hub.ts");
  const { runnerView } = await import("../status.ts");
  const row = readRunnerRows(stateDir).find((r) => r.label === label);
  if (!row) return undefined;
  const state = runnerView(row, Date.now()).state;
  return state === "offline" || state === "lost" || state === "revoked";
};

export const offlineWarn = (machine: string, what: "wait" | "source" | "schedule"): string =>
  `WARN runner ${machine} is not connected; the ${what} is kept and runs when it reconnects`;

/** `--command`: a JSON argv array, else a shell line run with `sh -c`. */
export const commandArgv = (command: string | undefined): unknown => {
  if (!command) return die("--command is required");
  if (!command.startsWith("[")) return ["sh", "-c", command];
  try { return JSON.parse(command) as unknown; } catch { return die("--command starting with [ must be a JSON argv array"); }
};

export const messengerToken = (name: string): string => resolveCredential(name) ?? die(`${name} is not set in the environment or in ${envFilePath()}`);

/**
 * A launch's `--thread` as the lane stores it: `discord:<channel>/<thread>`, the parent read from Discord when the value names
 * only the thread. Without a token or an answer it is kept in ref form (`discord:<id>`), with THREAD_PARENT_UNKNOWN on stderr.
 */
export const laneThreadRef = async (value: string | undefined, channels: readonly string[]): Promise<string | undefined> => {
  if (value === undefined || value === "none") return value;
  const token = resolveCredential("DORI_DISCORD_TOKEN");
  return withThreadParent(value, channels, async (id) => {
    if (!token) { console.error(`THREAD_PARENT_UNKNOWN ${id}: DORI_DISCORD_TOKEN is not set; the lane keeps discord:${id}`); return undefined; }
    try { return discordThread(await new Discord(fetchHttp, realClock, token).call("GET", `/channels/${id}`))?.parent; }
    catch (e) { console.error(`THREAD_PARENT_UNKNOWN ${id}: ${e instanceof Error ? e.message : String(e)}; the lane keeps discord:${id}`); return undefined; }
  });
};

export const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

// Lead mode: lane mode (DORI_LANE_KEY, or a pane its runner knows) was handled before loadConfig, so every command run with
// this context runs for the lead and may name any lane.
export const leadContext = (config: FlowDeps["config"], registry: Registry, command: string, rest: string[], flags: Flags): CliContext => {
  // Lane operations go through the supervisor's CLI relay; built on first use, so commands that touch no lane never connect.
  let cliCall: CliRunnerCall | undefined;
  const relay = (): CliRunnerCall => (cliCall ??= cliRunnerCall(cliSocketPath(defaultRunnerDir())));
  let cliOps: LaneOps | undefined;
  const deps: FlowDeps = {
    run, clock: realClock, registry, config, tunables: BUILT_IN,
    get ops(): LaneOps { return cliOps ??= laneOps(relay(), { now: realClock.now, log: (line) => { console.error(line); } }); },
  };
  const opt = (name: string): string | undefined => {
    const v = flags.values[name];
    return typeof v === "string" ? v.trim() : undefined;
  };
  const need = (name: string): string => opt(name) || die(`--${name} is required`);
  return {
    command, rest, config, deps, flags, opt, need,
    key: flags.positionals[0],
    loopMin: Number(opt("loop") ?? 0),
    needSupervisor: async () => {
      try { await relay().refresh(LOCAL_RUNNER); }
      catch (e) { if (e instanceof RunnerUnavailable) die(e.message, 2); throw e; }
    },
    lane: async (k) => {
      const found = await deps.registry.read(k);
      if (!found) return die(`no registered lane "${k}"`);
      if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
      return found;
    },
    machineOpt: async () => {
      const machine = opt("machine");
      if (machine === undefined || machine === "local") return undefined;
      const offline = await runnerOffline(config.stateDir, machine);
      if (offline === undefined) die(`RUNNER_UNKNOWN_MACHINE ${machine}: no runner with that label has enrolled; see them with \`dori status\` or \`dori runner probe\``);
      return { machine, offline: offline === true };
    },
  };
};
