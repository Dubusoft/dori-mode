import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { herdrInUse } from "./runner/herdr-watch.ts";
import { POLICY_FILE } from "./runner/policy.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { HC_CORE_UNIT } from "./runtime/hc.ts";
import { setListedRuntimes } from "./runtime/index.ts";
import { RUNTIME_KINDS, runtimeOfPane, type RuntimeKind } from "./runtime/types.ts";

/**
 * Which terminal runtimes the lead host itself uses: the lead's pane (config `leadRuntime`) and the local runner's lanes
 * (its runner-config `laneRuntime`, which the supervisor's own local runner reads). A host on hc for both runs with herdr
 * absent: dori setup installs no herdr unit for it, dori doctor and dori status neither check nor list herdr, and the
 * supervisor neither looks up nor creates the herdr lanes workspace.
 *
 * - `herdr`: leadRuntime is herdr, the local laneRuntime is herdr or unset, or a recorded lead pane or local lane pane is
 *   still a herdr pane (it keeps herdr in use until it is gone, as the runner's herdrInUse does for its lanes).
 * - `hc`: leadRuntime or the local laneRuntime is hc, or a recorded lead pane or local lane pane is an hc terminal.
 */
export type HostRuntimes = {
  readonly leadRuntime: RuntimeKind;
  /** The local runner's runner-config `laneRuntime`; undefined: unset (herdr) or unreadable. */
  readonly laneRuntime?: RuntimeKind;
  readonly herdr: boolean;
  readonly hc: boolean;
};

/**
 * The local runner's runner-config `laneRuntime` (`<runnerDir>/runner-config.json`), read raw: the runner applies the key
 * the same way whether the file is layered onto the derived policy or is the whole policy. Undefined when the file is
 * absent, unreadable or names no runtime; the runner itself refuses an invalid file, and herdr stays the default.
 */
export const localLaneRuntime = (runnerDir: string): RuntimeKind | undefined => {
  const path = join(runnerDir, POLICY_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) as { laneRuntime?: unknown } | null)?.laneRuntime;
    return typeof value === "string" && (RUNTIME_KINDS as readonly string[]).includes(value) ? value as RuntimeKind : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether new local lanes open on herdr (the local laneRuntime is not hc), and so need the herdr lanes workspace the
 * supervisor and a launch find or create (managed-panes.ts ensureLaneWorkspace). An hc lane has no herdr tab. `home`
 * defaults to $HOME, as the supervisor's own home does (supervise-loop.ts).
 */
export const localLanesOnHerdr = (home: string = process.env.HOME || homedir()): boolean => localLaneRuntime(defaultRunnerDir(home)) !== "hc";

/** The panes of the lanes this host's own runner holds: the same owner rule as dori status (runner, else machine, else local). */
export const localLanePanes = (lanes: readonly Pick<Lane, "pane" | "machine" | "runner">[]): string[] =>
  lanes.filter((l) => (l.runner ?? (l.machine || LOCAL_RUNNER)) === LOCAL_RUNNER).flatMap((l) => (l.pane ? [l.pane] : []));

/** The predicate itself, from what the caller read: config leadRuntime and leadPane, the local laneRuntime and local lane panes. */
export const hostRuntimes = (
  config: Pick<DoriConfig, "leadRuntime" | "leadPane">, laneRuntime: RuntimeKind | undefined, lanePanes: Iterable<string> = [],
): HostRuntimes => ({
  leadRuntime: config.leadRuntime,
  ...(laneRuntime ? { laneRuntime } : {}),
  herdr: config.leadRuntime === "herdr" || herdrInUse(laneRuntime, [...(config.leadPane ? [config.leadPane] : []), ...lanePanes]),
  hc: config.leadRuntime === "hc" || laneRuntime === "hc" || [...(config.leadPane ? [config.leadPane] : []), ...lanePanes].some((p) => runtimeOfPane(p) === "hc"),
});

/** hostRuntimes with the local runner's runner-config under `home` (default runner dir) and `lanes` (open lane records). */
export const readHostRuntimes = (
  config: Pick<DoriConfig, "leadRuntime" | "leadPane">, home: string, lanes: readonly Pick<Lane, "pane" | "machine" | "runner">[] = [],
): HostRuntimes => hostRuntimes(config, localLaneRuntime(defaultRunnerDir(home)), localLanePanes(lanes));

/**
 * readHostRuntimes, also made the runtimes `listPanes` gathers in this process (herdr listed iff `herdr`, hc iff `hc`), so a
 * lead host with herdr absent never runs the herdr binary for a pane list. The supervisor calls it at start and each sweep
 * round; dori status and dori doctor at their entry.
 */
export const listHostRuntimes = (
  config: Pick<DoriConfig, "leadRuntime" | "leadPane">, home: string, lanes: readonly Pick<Lane, "pane" | "machine" | "runner">[] = [],
): HostRuntimes => {
  const rt = readHostRuntimes(config, home, lanes);
  setListedRuntimes({ herdr: rt.herdr, hc: rt.hc });
  return rt;
};

export const HERDR_UNIT = "herdr-server.service";
export const SUPERVISOR_UNIT = "dori-supervisor.service";

/**
 * The systemd user units this lead host runs, in start order: herdr-server only while herdr is used here, hc-core (the hc
 * core's autostart, a oneshot `hc server start` that counts as up once enabled) while hc is, and always the supervisor.
 * dori setup installs these, dori doctor checks them and dori status lists them.
 */
export const hostServices = (rt: Pick<HostRuntimes, "herdr" | "hc">): string[] =>
  [...(rt.herdr ? [HERDR_UNIT] : []), ...(rt.hc ? [HC_CORE_UNIT] : []), SUPERVISOR_UNIT];

/** `leadRuntime=hc, laneRuntime=hc`: what decided, for a log or check line (an unset laneRuntime reads as herdr). */
export const runtimesNote = (rt: HostRuntimes): string => `leadRuntime=${rt.leadRuntime}, laneRuntime=${rt.laneRuntime ?? "herdr"}`;
