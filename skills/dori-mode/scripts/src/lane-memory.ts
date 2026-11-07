import { readFile } from "node:fs/promises";
import type { WinProc, WinSampleLoader } from "./host-guard.ts";
import type { Runner } from "./run.ts";
import { LANE_KEY } from "./registry.ts";

/**
 * One process: its parent, resident memory, command name and the DORI_LANE_KEY in its own environment, if any.
 * `args` is the full command line, used only for matching and never printed.
 */
export type Proc = { readonly pid: number; readonly ppid: number; readonly rssKb: number; readonly comm: string; readonly lane?: string; readonly args?: string };

/** One lane's resident memory, its processes and their children summed, with the heaviest commands first. */
export type LaneMemory = {
  readonly lane: string;
  readonly rssKb: number;
  readonly top: readonly { readonly comm: string; readonly rssKb: number; readonly count: number }[];
};

/**
 * The lane of every process: the lane its own environment names, else its nearest ancestor's (so an emulator, expo or
 * tsserver started under a lane counts for it); undefined for a process outside every lane.
 */
export const procLanes = (procs: readonly Proc[]): Map<number, string | undefined> => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const owner = new Map<number, string | undefined>();
  const laneOf = (p: Proc): string | undefined => {
    const path: Proc[] = [];
    let cur: Proc | undefined = p;
    let found: string | undefined;
    // The walk stops at a known answer, a lane, a missing parent, or a cycle.
    while (cur && !path.includes(cur)) {
      if (owner.has(cur.pid)) { found = owner.get(cur.pid); break; }
      path.push(cur);
      if (cur.lane) { found = cur.lane; break; }
      cur = cur.ppid !== cur.pid ? byPid.get(cur.ppid) : undefined;
    }
    for (const q of path) owner.set(q.pid, found);
    return found;
  };
  for (const p of procs) laneOf(p);
  return owner;
};

/** Groups processes by lane (see `procLanes`); processes outside every lane are left out. Lanes come heaviest first. */
export const laneMemory = (procs: readonly Proc[]): LaneMemory[] => {
  const owner = procLanes(procs);
  const lanes = new Map<string, Map<string, { rssKb: number; count: number }>>();
  for (const p of procs) {
    const lane = owner.get(p.pid);
    if (!lane) continue;
    const comms = lanes.get(lane) ?? new Map<string, { rssKb: number; count: number }>();
    const c = comms.get(p.comm) ?? { rssKb: 0, count: 0 };
    comms.set(p.comm, { rssKb: c.rssKb + p.rssKb, count: c.count + 1 });
    lanes.set(lane, comms);
  }
  return [...lanes].map(([lane, comms]) => ({
    lane,
    rssKb: [...comms.values()].reduce((sum, c) => sum + c.rssKb, 0),
    top: [...comms].map(([comm, c]) => ({ comm, ...c })).sort((a, b) => b.rssKb - a.rssKb),
  })).sort((a, b) => b.rssKb - a.rssKb);
};

export const formatKb = (kb: number): string => kb >= 1_048_576 ? `${(kb / 1_048_576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;

/** `dori-436 4.1 GB (qemu-system-x86 3.9 GB, node x12 210 MB)`: the lane, its total and its heaviest `commands` commands. */
export const describeLane = (l: LaneMemory, commands = 3): string =>
  `${l.lane} ${formatKb(l.rssKb)} (${l.top.slice(0, commands).map((c) => `${c.comm}${c.count > 1 ? ` x${c.count}` : ""} ${formatKb(c.rssKb)}`).join(", ")})`;

/** The ALERT detail naming the heaviest `lanes` lanes, or undefined when no lane process was found. */
export const laneMemoryDetail = (lanes: readonly LaneMemory[], count = 3): string | undefined =>
  lanes.length ? `lanes by memory: ${lanes.slice(0, count).map((l) => describeLane(l)).join(", ")}` : undefined;

/*
 * `sampleProcs` is a runner-side primitive (runner/guard.ts, runner/observe.ts): the supervisor reads per-lane memory
 * from the runners' `guard.sample.lanes` and never walks a lane host's process table itself.
 */
const LANE_ENV = /(?:^|\0)DORI_LANE_KEY=([^\0]*)/;

const safeComm = (comm: string): string => comm.replace(/[^\w.:+-]/g, "_");

/**
 * The Windows sampler's rows as processes. No environment is readable from outside a Windows process, so a lane is
 * seeded on its shell pid (`seeds`: pid to lane key) and reaches the shell's descendants through `procLanes`. Windows
 * does not re-parent orphans, so a parent link is kept only when the parent was created before the child; any other
 * ppid becomes 0.
 */
export const winProcs = (rows: readonly WinProc[], seeds: ReadonlyMap<number, string>): Proc[] => {
  const created = new Map(rows.map((r) => [r.pid, r.created]));
  return rows.map((r) => {
    const parentCreated = created.get(r.ppid);
    const linked = r.ppid !== r.pid && parentCreated !== undefined && parentCreated > 0 && r.created > 0 && parentCreated < r.created;
    const lane = seeds.get(r.pid);
    return {
      pid: r.pid, ppid: linked ? r.ppid : 0, rssKb: r.rss, comm: safeComm(r.name),
      ...(lane && LANE_KEY.test(lane) ? { lane } : {}), ...(r.cmd ? { args: r.cmd } : {}),
    };
  });
};

/** Where `sampleProcs` reads a Windows process table: the sampler run and the lane shell pids. */
export type WinProcSource = { readonly sample: WinSampleLoader; readonly seeds: () => ReadonlyMap<number, string> };

/**
 * Reads every process on this host with its lane. Linux only for now (the lane comes from /proc/<pid>/environ); on
 * another platform, or when `ps` fails, it returns no processes. An environment that cannot be read (another user's
 * process, or one that just exited) counts as no lane of its own. With `win` (a Windows host) the processes come from
 * the sampler instead (see `winProcs`); a failed sampler run returns no processes.
 */
export const sampleProcs = async (
  run: Runner,
  readEnviron: (pid: number) => Promise<string> = (pid) => readFile(`/proc/${pid}/environ`, "utf8"),
  linux = process.platform === "linux",
  win?: WinProcSource,
): Promise<Proc[]> => {
  if (!linux && win) {
    const sample = await win.sample();
    return sample ? winProcs(sample.procs, win.seeds()) : [];
  }
  if (!linux) return [];
  const ps = await run(["ps", "-eo", "pid=,ppid=,rss=,comm="]);
  if (ps.code !== 0) return [];
  // The full command lines come from a second call: `comm` may hold spaces, `args` always does.
  const argsPs = await run(["ps", "-eo", "pid=,args="]);
  const argsByPid = new Map<number, string>();
  if (argsPs.code === 0) {
    for (const line of argsPs.out.split("\n")) {
      const a = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
      if (a) argsByPid.set(Number(a[1]), a[2]!);
    }
  }
  const rows = ps.out.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)).filter((m) => m !== null);
  return Promise.all(rows.map(async (m) => {
    const pid = Number(m[1]);
    const lane = await readEnviron(pid).then((env) => {
      const key = LANE_ENV.exec(env)?.[1]?.trim();
      return key && LANE_KEY.test(key) ? key : undefined;
    }, () => undefined);
    // A command name lands in event lines and pane text, which must not carry shell syntax.
    return { pid, ppid: Number(m[2]), rssKb: Number(m[3]), comm: safeComm(m[4]!), ...(lane ? { lane } : {}), ...(argsByPid.has(pid) ? { args: argsByPid.get(pid)! } : {}) };
  }));
};
