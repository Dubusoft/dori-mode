import type { DoriConfig, GuardThresholds } from "./config.ts";
import { readFile } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import { win32 } from "node:path";
import type { Runner } from "./run.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";

export type HostSample = {
  readonly load1: number;
  readonly memFreePct: number;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  /** Total swap in GB; 0 when the host has none, -1 when unreadable. */
  readonly swapTotalGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

export const loadNow = (): number => loadavg()[0] ?? 0;

/** One row of the Windows sampler's process table: `rss` in KB, `created` in ms since the epoch (0 when unknown). */
export type WinProc = { readonly pid: number; readonly ppid: number; readonly rss: number; readonly name: string; readonly cmd: string; readonly created: number };

/** What `templates/runner-sample.ps1` prints: host metrics (-1 when unreadable) and the process table. */
export type WinSample = {
  readonly load1: number;
  readonly memFreePct: number;
  readonly swapFreeKb: number;
  readonly swapTotalKb: number;
  readonly diskFreeKb: number;
  readonly procs: readonly WinProc[];
};

export type WinSampleLoader = () => Promise<WinSample | undefined>;

/** The installed sampler, `<runnerDir>\bin\runner-sample.ps1`, run with the disk guard's path. */
export const runnerSampleArgv = (runnerDir: string, dataPath: string): string[] => [
  "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", win32.join(runnerDir, "bin", "runner-sample.ps1"), dataPath,
];

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const parseWinProc = (v: unknown): WinProc | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const p = v as Record<string, unknown>;
  if (!Number.isSafeInteger(p.pid) || !Number.isSafeInteger(p.ppid) || !finite(p.rss) || typeof p.name !== "string") return undefined;
  return {
    pid: p.pid as number, ppid: p.ppid as number, rss: Math.max(0, Math.round(p.rss)), name: p.name,
    cmd: typeof p.cmd === "string" ? p.cmd : "", created: finite(p.created) && p.created > 0 ? p.created : 0,
  };
};

/** The sampler's JSON, or undefined when it is not one sample object. A malformed process row is dropped. */
export const parseWinSample = (text: string): WinSample | undefined => {
  let v: unknown;
  try { v = JSON.parse(text.replace(/^\uFEFF/, "").trim()); } catch { return undefined; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  const metric = (key: string): number => (finite(s[key]) && (s[key] as number) >= 0 ? s[key] as number : -1);
  const procs = Array.isArray(s.procs) ? s.procs.map(parseWinProc).filter((p): p is WinProc => p !== undefined) : [];
  return { load1: metric("load1"), memFreePct: metric("memFreePct"), swapFreeKb: metric("swapFreeKb"), swapTotalKb: metric("swapTotalKb"), diskFreeKb: metric("diskFreeKb"), procs };
};

/** One sampler run: undefined when it fails or prints no sample. */
export const readWinSample = async (run: Runner, argv: readonly string[]): Promise<WinSample | undefined> => {
  const r = await run(argv);
  return r.code === 0 ? parseWinSample(r.out) : undefined;
};

/** A sample taken for the host is reused for the process table while it is at most this old. */
export const WIN_SAMPLE_REUSE_MS = 10_000;

export type WinSampleSource = { readonly host: WinSampleLoader; readonly procs: WinSampleLoader };

/**
 * One sampler spawn per guard tick: `host` always runs `load` and keeps the result, `procs` reuses it while it is at
 * most `reuseMs` old and runs `load` itself otherwise.
 */
export const winSampleSource = (load: WinSampleLoader, now: () => number, reuseMs = WIN_SAMPLE_REUSE_MS): WinSampleSource => {
  let cached: { readonly at: number; readonly sample: Promise<WinSample | undefined> } | undefined;
  return {
    host: () => {
      const sample = load();
      cached = { at: now(), sample };
      return sample;
    },
    procs: () => (cached && now() - cached.at <= reuseMs ? cached.sample : load()),
  };
};

/** The 1-minute load on demand (heavy admission): the sampler's `load1` on win32 (-1 when unreadable), else `loadavg`. */
export const sampleLoad1 = async (os: string, run: Runner, runnerDir: string = defaultRunnerDir(), dataPath: string = homedir()): Promise<number> =>
  os === "win32" ? (await readWinSample(run, runnerSampleArgv(runnerDir, dataPath)))?.load1 ?? -1 : loadNow();

const winHostSample = (s: WinSample | undefined, panes: number): HostSample => ({
  load1: s?.load1 ?? -1,
  memFreePct: s && s.memFreePct >= 0 ? s.memFreePct : 100,
  diskFreeGb: s && s.diskFreeKb >= 0 ? s.diskFreeKb / 1_048_576 : 0,
  swapFreeGb: s && s.swapFreeKb >= 0 ? s.swapFreeKb / 1_048_576 : 0,
  swapTotalGb: s && s.swapTotalKb >= 0 ? s.swapTotalKb / 1_048_576 : -1,
  panes,
});

type MemInfoReader = (path: string) => Promise<string>;

const parseMemInfo = (text: string): Pick<HostSample, "memFreePct" | "swapFreeGb" | "swapTotalGb"> => {
  const values = new Map([...text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [m[1]!, Number(m[2])]));
  const total = values.get("MemTotal") ?? 0;
  return {
    memFreePct: total > 0 ? Math.round((values.get("MemAvailable") ?? 0) / total * 100) : 100,
    swapFreeGb: (values.get("SwapFree") ?? 0) / 1_048_576,
    swapTotalGb: (values.get("SwapTotal") ?? 0) / 1_048_576,
  };
};

/** The filesystem the disk guard checks: `diskGuardPath`, else the one holding the state directory. */
export const diskGuardPath = (config: Pick<DoriConfig, "diskGuardPath" | "stateDir">): string => config.diskGuardPath?.trim() || config.stateDir;

/**
 * One host sample. `paneCount` (-1 when unreadable) is the caller's: a runner counts its own herdr panes, the
 * supervisor (which reaches no pane) passes `async () => -1` when it needs only the load. On win32 every metric comes
 * from one `winSample` run (default: the sampler in the default runner directory); an unreadable metric falls back as
 * the POSIX path does (memory 100%, disk and swap free 0, swap total -1), load to -1.
 */
export const sampleHost = async (
  run: Runner,
  dataPath: string,
  paneCount: () => Promise<number>,
  readMemInfo: MemInfoReader = (path) => readFile(path, "utf8"),
  os: string = process.platform,
  winSample: WinSampleLoader = () => readWinSample(run, runnerSampleArgv(defaultRunnerDir(), dataPath)),
): Promise<HostSample> => {
  if (os === "win32") {
    const [sample, panes] = await Promise.all([winSample(), paneCount()]);
    return winHostSample(sample, panes);
  }
  const linux = os === "linux";
  const [df, panes, mp, swap, memInfo] = await Promise.all([
    run(["df", "-k", dataPath]),
    paneCount(),
    linux ? Promise.resolve(null) : run(["memory_pressure", "-Q"]),
    linux ? Promise.resolve(null) : run(["sysctl", "-n", "vm.swapusage"]),
    linux ? readMemInfo("/proc/meminfo") : Promise.resolve(null),
  ]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const memory = memInfo === null ? null : parseMemInfo(memInfo);
  const memFreePct = memory?.memFreePct ?? (mp?.code === 0 ? num(/free percentage: (\d+)%/.exec(mp.out)?.[1], 100) : 100);
  const swapFreeGb = memory?.swapFreeGb ?? num(/free = ([\d.]+)M/.exec(swap?.out ?? "")?.[1], 0) / 1024;
  const macTotal = /total = ([\d.]+)M/.exec(swap?.out ?? "")?.[1];
  const swapTotalGb = memory?.swapTotalGb ?? (macTotal === undefined ? -1 : num(macTotal, 0) / 1024);
  return { load1: loadNow(), memFreePct, diskFreeGb, swapFreeGb, swapTotalGb, panes };
};

export const alertReasons = (s: Pick<HostSample, "load1" | "memFreePct" | "diskFreeGb" | "panes">, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct < t.memFreeMinPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

/**
 * Why memory is critical: free memory under `memFreeCritPct`, or swap (when the host has any) under `swapFreeCritPct`
 * free. A negative metric (-1: unreadable) never counts.
 */
export const criticalReasons = (s: Pick<HostSample, "memFreePct" | "swapFreeGb" | "swapTotalGb">, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.memFreePct >= 0 && s.memFreePct < t.memFreeCritPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeCritPct}%`);
  if (s.swapTotalGb > 0 && s.swapFreeGb >= 0) {
    const pct = s.swapFreeGb / s.swapTotalGb * 100;
    if (pct < t.swapFreeCritPct) r.push(`swap free ${s.swapFreeGb.toFixed(2)} GB of ${s.swapTotalGb.toFixed(1)} GB (${Math.round(pct)}%) < ${t.swapFreeCritPct}%`);
  }
  return r;
};

/** Free memory must recover this many points above the threshold before the low-memory flag clears. */
export const MEM_LOW_CLEAR_MARGIN_PCT = 2;

/** Low memory latches below the threshold and clears only at threshold + MEM_LOW_CLEAR_MARGIN_PCT. */
export const memIsLow = (s: HostSample, t: GuardThresholds, wasLow = false): boolean =>
  s.memFreePct < t.memFreeMinPct || (wasLow && s.memFreePct < t.memFreeMinPct + MEM_LOW_CLEAR_MARGIN_PCT);

export type GuardState = { alerting: boolean; computeReady?: boolean; memLow?: boolean };

/** `alertDetail` (the lanes by memory, who was warned) is appended to an ALERT line after `; `. */
export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState, alertDetail?: string): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  const memLow = memIsLow(s, t, state.memLow);
  const alertLine = `HOST_GUARD ALERT ${reasons.join(" | ")}${alertDetail ? `; ${alertDetail}` : ""}`;
  if (alerting === state.alerting) {
    // Already alerting for another reason: memory running low is still reported once.
    if (alerting && memLow && !state.memLow) out.push(alertLine);
  } else {
    out.push(alerting
      ? alertLine
      : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    state.alerting = alerting;
  }
  state.memLow = memLow;
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};
