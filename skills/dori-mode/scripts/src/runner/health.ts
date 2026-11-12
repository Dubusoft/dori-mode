import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../run.ts";
import { RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import { herdrElevatedError, winHerdrServers } from "./herdr-watch.ts";

/**
 * The runner's health file and the probe that reads it. The runner rewrites `<runnerDir>/health` every 15 s with
 * `{pid, gen, monotonicMs, wallAt}`, on a timer of its own so a busy work loop shows as a stale file. `dori runner
 * probe --json` runs on the runner's host (over ssh from the supervisor) and decides from the file's age and whether
 * its pid is alive: healthy (alive, younger than 60 s), stalled (alive, 60 to 120 s) or dead (no file, no such
 * process, or older than 120 s). The age is taken from the file's mtime, so it uses the host's own clock both ways.
 * The probe also reads the host's herdr once (`probeHerdr`), so an ssh diagnosis shows it; the verdict and exit code
 * stay the runner's alone.
 */

export const HEALTH_WRITE_MS = 15_000;
export const HEALTH_FRESH_MS = 60_000;
export const HEALTH_DEAD_MS = 120_000;

export type Health = { readonly pid: number; readonly gen: number; readonly monotonicMs: number; readonly wallAt: number };
export type Verdict = "healthy" | "stalled" | "dead";
export type ProbeResult = {
  readonly process: "alive" | "dead";
  readonly verdict: Verdict;
  readonly pid?: number;
  readonly gen?: number;
  readonly healthAgeMs?: number;
};

export const healthPath = (runnerDir: string): string => join(runnerDir, RUNNER_PATHS.health);

export const writeHealth = (runnerDir: string, health: Health): void => {
  writeRunnerFile(healthPath(runnerDir), `${JSON.stringify(health)}\n`);
};

export type HealthDeps = {
  readonly runnerDir: string;
  readonly pid: number;
  readonly gen: number;
  readonly now: () => number;
  readonly monotonic: () => number;
  readonly every: (ms: number, tick: () => void) => () => void;
  readonly log?: (line: string) => void;
};

/** Writes the health file now and then every `ms`; returns the stop function. A failed write is logged, not thrown. */
export const startHealth = (deps: HealthDeps, ms: number = HEALTH_WRITE_MS): (() => void) => {
  const tick = (): void => {
    try { writeHealth(deps.runnerDir, { pid: deps.pid, gen: deps.gen, monotonicMs: deps.monotonic(), wallAt: deps.now() }); }
    catch (error) { deps.log?.(`RUNNER_HEALTH_WRITE_FAILED ${error instanceof Error ? error.message : String(error)}`); }
  };
  tick();
  return deps.every(ms, tick);
};

const isHealth = (value: unknown): value is Health => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.pid) && Number.isSafeInteger(v.gen) && typeof v.monotonicMs === "number" && typeof v.wallAt === "number";
};

export const readHealth = (runnerDir: string): { readonly health: Health; readonly mtimeMs: number } | undefined => {
  try {
    const path = healthPath(runnerDir);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isHealth(parsed)) return undefined;
    return { health: parsed, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
};

/** `process.kill(pid, 0)`: a process we may not signal (EPERM) still exists. */
export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

export type ProbeDeps = {
  readonly runnerDir: string;
  readonly now: () => number;
  readonly isAlive?: (pid: number) => boolean;
  readonly read?: typeof readHealth;
};

export const probe = (deps: ProbeDeps): ProbeResult => {
  const found = (deps.read ?? readHealth)(deps.runnerDir);
  if (!found) return { process: "dead", verdict: "dead" };
  const { health, mtimeMs } = found;
  const alive = (deps.isAlive ?? pidAlive)(health.pid);
  const healthAgeMs = Math.max(0, Math.round(deps.now() - mtimeMs));
  const base = { pid: health.pid, gen: health.gen, healthAgeMs };
  if (!alive) return { process: "dead", verdict: "dead", ...base };
  const verdict: Verdict = healthAgeMs > HEALTH_DEAD_MS ? "dead" : healthAgeMs > HEALTH_FRESH_MS ? "stalled" : "healthy";
  return { process: "alive", verdict, ...base };
};

/**
 * herdr on this host: answering, no `herdr server` process, a server process that does not answer, a server that runs
 * elevated and refuses this unelevated client (Windows), or unknown (pgrep failed).
 */
export type HerdrProbe = "up" | "down" | "hung" | "elevated" | "unknown";
export const HERDR_PROBE_TIMEOUT_MS = 5_000;

/**
 * One reading of the host's herdr, as `dori doctor` reads it: `herdr workspace list` answering is up; otherwise a
 * `herdr server` process (pgrep) means hung and none means down. A single reading, with no retry or debounce.
 */
export const probeHerdr = async (run: Runner, opts: { platform?: string; user?: string } = {}): Promise<HerdrProbe> => {
  const list = await run(["herdr", "workspace", "list"], { timeoutMs: HERDR_PROBE_TIMEOUT_MS });
  if (list.code === 0) return "up";
  if ((opts.platform ?? process.platform) === "win32") {
    if (herdrElevatedError(`${list.err}\n${list.out}`, "win32")) return "elevated";
    const ids = await winHerdrServers(run, opts.user);
    return ids ? (ids.length ? "hung" : "down") : "unknown";
  }
  const procs = await run(["pgrep", "-f", "herdr server"], { timeoutMs: HERDR_PROBE_TIMEOUT_MS });
  return procs.code === 0 ? "hung" : procs.code === 1 ? "down" : "unknown";
};
