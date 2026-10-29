import type { DoriConfig, GuardThresholds } from "./config.ts";
import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import type { Runner } from "./run.ts";

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

const listedPanes = async (run: Runner): Promise<number> => {
  const pl = await run(["herdr", "pane", "list"]);
  return pl.code === 0 ? (JSON.parse(pl.out) as { result: { panes: unknown[] } }).result.panes.length : -1;
};

/** `paneCount` (-1 when unreadable) defaults to its own `herdr pane list`; the supervisor passes its round's snapshot. */
export const sampleHost = async (
  run: Runner,
  dataPath = "/",
  paneCount: () => Promise<number> = () => listedPanes(run),
  readMemInfo: MemInfoReader = (path) => readFile(path, "utf8"),
): Promise<HostSample> => {
  const linux = process.platform === "linux";
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

export type GuardState = { alerting: boolean; computeReady?: boolean; memLow?: boolean };

/** `alertDetail` (the lanes by memory, who was warned) is appended to an ALERT line after `; `. */
export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState, alertDetail?: string): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  const memLow = s.memFreePct < t.memFreeMinPct;
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
