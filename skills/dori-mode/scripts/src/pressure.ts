import { formatKb, type Proc, procLanes } from "./lane-memory.ts";
import type { Clock } from "./run.ts";

/** A process the critical-pressure stage sent a signal to. */
export type KilledProc = { readonly pid: number; readonly lane?: string; readonly comm: string; readonly rssKb: number };

/** How long a process gets between SIGTERM and SIGKILL. */
const GRACE_MS = 5000;

/** `self` and every ancestor of it found in `procs`; killing any of them would take the supervisor down with it. */
const selfAndAncestors = (procs: readonly Proc[], self: number): Set<number> => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set<number>([self]);
  for (let cur = byPid.get(self); cur && !keep.has(cur.ppid); cur = byPid.get(cur.ppid)) keep.add(cur.ppid);
  return keep;
};

/**
 * The processes to kill under critical memory pressure: those whose full command line contains a non-blank pattern
 * and that belong to one of `lanes` (by `DORI_LANE_KEY`, own or inherited). `self` and its ancestors are never targets.
 */
export const heavyTargets = (procs: readonly Proc[], patterns: readonly string[], lanes: ReadonlySet<string>, self?: number): Proc[] => {
  const needles = patterns.map((p) => p.trim()).filter(Boolean);
  if (!needles.length) return [];
  const keep = self === undefined ? new Set<number>() : selfAndAncestors(procs, self);
  const owner = procLanes(procs);
  return procs.filter((p) => {
    const lane = owner.get(p.pid);
    return lane !== undefined && lanes.has(lane) && !keep.has(p.pid) && needles.some((n) => p.args?.includes(n));
  });
};

export type KillDeps = {
  readonly clock: Clock;
  readonly alive: (pid: number) => boolean;
  readonly signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
};

/** Sends `sig`; false when the process was already gone (ESRCH), any other failure is thrown. */
const send = (deps: KillDeps, pid: number, sig: "SIGTERM" | "SIGKILL"): boolean => {
  try {
    deps.signal(pid, sig);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
};

/**
 * SIGTERM every target, wait five seconds, then SIGKILL those still alive. Returns the processes that were sent a
 * signal; one that was already gone is left out. `lanes` is the pid -> lane map from `procLanes`.
 */
export const killProcs = async (targets: readonly Proc[], deps: KillDeps, lanes: Map<number, string | undefined>): Promise<KilledProc[]> => {
  const termed = targets.filter((p) => send(deps, p.pid, "SIGTERM"));
  if (termed.length) await deps.clock.sleep(GRACE_MS);
  for (const p of termed) if (deps.alive(p.pid)) send(deps, p.pid, "SIGKILL");
  return termed.map((p) => {
    const lane = lanes.get(p.pid) ?? p.lane;
    return { pid: p.pid, ...(lane ? { lane } : {}), comm: p.comm, rssKb: p.rssKb };
  });
};

/** `dori-12 qemu-system-x86 3.9 GB (pid 4242), ...`: what was killed, for the CRITICAL line. */
export const describeKilled = (k: readonly KilledProc[]): string =>
  k.map((p) => `${p.lane ? `${p.lane} ` : ""}${p.comm} ${formatKb(p.rssKb)} (pid ${p.pid})`).join(", ");
