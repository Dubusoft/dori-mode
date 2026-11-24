import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { releaseSlot } from "./heavy-slot.ts";
import type { Runner } from "./run.ts";
import { errText } from "./line-text.ts";

/**
 * iOS simulators a heavy command boots outlive it: CoreSimulator, not the command, owns a booted device, so
 * `expo run:ios` or `xcodebuild test` leaves it Booted (and holding gigabytes) after it exits. On macOS a heavy run lists
 * the booted simulators before its command and again after it; the ones booted in between are its own. They are added to
 * `<heavy dir>/simulators`, the slot is freed, and when no other heavy holds a slot the run shuts down every simulator
 * that file lists that is still booted. A simulator another heavy may still be using therefore waits for the last heavy on
 * the machine to end, and one booted before the run started (by the owner, or by a heavy still running) is never in its
 * list.
 */

export const SIMULATORS_FILE = "simulators";
const SIMCTL_TIMEOUT_MS = 60_000;
/** A slot directory without an owner file is being claimed, unless it is older than this (heavy-slot.ts's orphan age). */
const CLAIMING_MS = 60_000;

export type SimulatorDeps = {
  readonly run: Runner;
  readonly dir: string;
  readonly platform: string;
  readonly alive: (pid: number) => boolean;
  readonly now: () => number;
  readonly pid: number;
  readonly err: (line: string) => void;
};


/** The UDIDs `xcrun simctl` lists as Booted; throws when simctl fails or prints something else. */
export const bootedSimulators = async (run: Runner): Promise<Set<string>> => {
  const listed = await run(["xcrun", "simctl", "list", "--json", "devices", "booted"], { timeoutMs: SIMCTL_TIMEOUT_MS });
  if (listed.code !== 0) throw new Error(`xcrun simctl list exited ${listed.code}: ${(listed.err || listed.out).slice(0, 200)}`);
  const devices = (JSON.parse(listed.out) as { devices?: Record<string, { udid?: unknown; state?: unknown }[]> }).devices ?? {};
  return new Set(Object.values(devices).flat().flatMap((d) => (d.state === "Booted" && typeof d.udid === "string" ? [d.udid] : [])));
};

const heavyRunning = (deps: SimulatorDeps): boolean =>
  readdirSync(deps.dir).filter((name) => /^slot\.\d+$/.test(name)).some((name) => {
    const slot = join(deps.dir, name);
    try {
      return deps.alive(Number(readFileSync(join(slot, "owner"), "utf8").split(" ")[0]));
    } catch {
      try { return deps.now() - statSync(slot).mtimeMs <= CLAIMING_MS; } catch { return false; }
    }
  });

const record = (deps: SimulatorDeps, udids: readonly string[]): void => {
  if (udids.length) appendFileSync(join(deps.dir, SIMULATORS_FILE), udids.map((u) => `${u}\n`).join(""));
};

/** Shuts down the listed simulators that are still booted, unless a heavy holds a slot; then the list stays for it. */
export const shutDownHeavySimulators = async (deps: SimulatorDeps): Promise<void> => {
  if (heavyRunning(deps)) return;
  const file = join(deps.dir, SIMULATORS_FILE);
  const taken = `${file}.${deps.pid}`;
  try {
    renameSync(file, taken);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
  const listed = [...new Set(readFileSync(taken, "utf8").split("\n").filter(Boolean))];
  rmSync(taken, { force: true });
  let booted: Set<string>;
  try {
    booted = await bootedSimulators(deps.run);
  } catch (error) {
    record(deps, listed);
    deps.err(`dori heavy: simulators left booted: ${errText(error)}`);
    return;
  }
  // A heavy that started meanwhile may be using one of them: it takes the list over.
  if (heavyRunning(deps)) { record(deps, listed.filter((u) => booted.has(u))); return; }
  for (const udid of listed.filter((u) => booted.has(u))) {
    const shut = await deps.run(["xcrun", "simctl", "shutdown", udid], { timeoutMs: SIMCTL_TIMEOUT_MS });
    deps.err(shut.code === 0
      ? `dori heavy: shut down simulator ${udid}, booted by a heavy command`
      : `dori heavy: simulator ${udid} not shut down: xcrun simctl shutdown exited ${shut.code}: ${(shut.err || shut.out).slice(0, 200)}`);
  }
};

/**
 * Lists the booted simulators before a heavy command runs in `slot`. The returned function, called once the command has
 * exited, records the simulators it booted, frees the slot and shuts them down when no other heavy runs. Off macOS it
 * only frees the slot.
 */
export const watchSimulators = async (deps: SimulatorDeps, slot: string): Promise<() => Promise<void>> => {
  if (deps.platform !== "darwin") return async () => releaseSlot(slot);
  let before: Set<string> | undefined;
  try {
    before = await bootedSimulators(deps.run);
  } catch (error) {
    deps.err(`dori heavy: simulators this command boots are not tracked: ${errText(error)}`);
  }
  return async () => {
    try {
      if (before) record(deps, [...await bootedSimulators(deps.run)].filter((u) => !before.has(u)));
    } catch (error) {
      deps.err(`dori heavy: simulators this command booted are not tracked: ${errText(error)}`);
    } finally {
      releaseSlot(slot);
    }
    try {
      await shutDownHeavySimulators(deps);
    } catch (error) {
      deps.err(`dori heavy: simulators not shut down: ${errText(error)}`);
    }
  };
};
