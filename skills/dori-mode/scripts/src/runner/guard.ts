import type { GuardThresholds } from "../config.ts";
import { alertReasons, criticalReasons, type HostSample } from "../host-guard.ts";
import { procLanes, type Proc } from "../lane-memory.ts";
import { heavyTargets, killProcs, type KillDeps, type KilledProc } from "../pressure.ts";
import type { KillResult, MachineSample, SampleResult } from "../remote-guard.ts";
import type { AnyRunnerEvent, GuardLevel, RunnerEventBodies, RunnerEventType } from "./protocol.ts";

/**
 * The machine guard moved onto the runner (design 3.5). The runner samples its host every 30 s with the same
 * `sampleHost` the supervisor uses for its own host, judges the sample with `alertReasons`/`criticalReasons` against
 * its thresholds, and sends `guard.sample` once a minute and on every level change, `guard.alert` on entering alert or
 * critical. Under critical memory it kills by itself: only processes matching its `heavyKill` patterns that belong to a
 * lane on this host (by `DORI_LANE_KEY`, own or inherited), never itself or its ancestors (`heavyTargets`), and
 * reports them in `guard.critical`. `guard.kill {keys}` from the supervisor runs the same kill limited to those lanes;
 * the supervisor never sends patterns.
 *
 * On the supervisor, `RunnerGuardBoard` keeps each runner's latest sample and the kills it has not reported yet, so
 * the machine-guard sweep can feed them to the same `machineGuardTick`/`machineCriticalTick` an ssh sample goes
 * through: the HOST_GUARD lines are the same either way.
 */

export const GUARD_SAMPLE_MS = 30_000;
export const GUARD_SEND_MS = 60_000;
/** A runner's sample stands in for an ssh sample while it is at most this old. */
export const GUARD_SAMPLE_FRESH_MS = 3 * GUARD_SAMPLE_MS;

type Publish = <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;

export type RunnerGuardDeps = {
  readonly sample: () => Promise<HostSample>;
  readonly thresholds: GuardThresholds;
  readonly heavyKill: readonly string[];
  readonly procs: () => Promise<Proc[]>;
  /** The runner's pid; it and its ancestors are never killed. */
  readonly self: number;
  readonly kill: KillDeps;
  readonly publish: Publish;
  readonly now: () => number;
  readonly os: string;
};

export const guardLevel = (s: HostSample, t: GuardThresholds): { readonly level: GuardLevel; readonly reasons: string[] } => {
  const critical = criticalReasons(s, t);
  if (critical.length) return { level: "critical", reasons: critical };
  const alert = alertReasons(s, t);
  return alert.length ? { level: "alert", reasons: alert } : { level: "ok", reasons: [] };
};

const round = (n: number, digits = 2): number => (n < 0 ? -1 : Math.round(n * 10 ** digits) / 10 ** digits);

export class RunnerGuard {
  private level: GuardLevel | undefined;
  private sentAt = -Infinity;

  constructor(private readonly deps: RunnerGuardDeps) {}

  async tick(): Promise<void> {
    const s = await this.deps.sample();
    const { level, reasons } = guardLevel(s, this.deps.thresholds);
    const now = this.deps.now();
    const changed = level !== this.level;
    if (changed || now - this.sentAt >= GUARD_SEND_MS) {
      this.deps.publish("guard.sample", {
        level, reasons, sampledAt: Math.round(now), load1: round(s.load1), memFreePct: s.memFreePct, diskFreeGb: round(s.diskFreeGb),
        swapFreeGb: round(s.swapFreeGb), swapTotalGb: round(s.swapTotalGb), os: this.deps.os,
      });
      this.sentAt = now;
    }
    if (changed && level !== "ok" && (this.level === undefined || this.level === "ok")) this.deps.publish("guard.alert", { reasons });
    this.level = level;
    if (level === "critical") await this.killAndReport(undefined, reasons);
  }

  async killLanes(keys: readonly string[]): Promise<KilledProc[]> {
    return this.killAndReport(new Set(keys), ["requested by the supervisor"]);
  }

  private async killAndReport(only: ReadonlySet<string> | undefined, reasons: readonly string[]): Promise<KilledProc[]> {
    const procs = await this.deps.procs();
    const owner = procLanes(procs);
    const lanes = new Set([...owner.values()].filter((k): k is string => k !== undefined && (!only || only.has(k))));
    const targets = heavyTargets(procs, this.deps.heavyKill, lanes, this.deps.self);
    if (!targets.length) return [];
    const killed = await killProcs(targets, this.deps.kill, owner);
    if (killed.length) {
      this.deps.publish("guard.critical", {
        killed: killed.map((k) => k.pid), paused: [], reasons: [...reasons], rssKb: killed.map((k) => k.rssKb), cmds: killed.map((k) => k.comm),
      });
    }
    return killed;
  }
}

export class RunnerGuardBoard {
  private readonly samples = new Map<string, { readonly sample: MachineSample; readonly at: number }>();
  private readonly kills = new Map<string, { pid: number; rssKb: number; cmd: string }[]>();

  constructor(private readonly now: () => number) {}

  event(label: string, frame: AnyRunnerEvent): void {
    if (frame.type === "guard.sample") {
      const b = frame.body;
      if (b.load1 === undefined || b.memFreePct === undefined || b.diskFreeGb === undefined) return;
      this.samples.set(label, {
        at: this.now(),
        sample: { version: "", os: b.os ?? "linux", load1: b.load1, memFreePct: b.memFreePct, diskFreeGb: b.diskFreeGb, swapFreeGb: b.swapFreeGb ?? -1, swapTotalGb: b.swapTotalGb ?? -1 },
      });
    }
    if (frame.type === "guard.critical") {
      const b = frame.body;
      const list = this.kills.get(label) ?? [];
      b.killed.forEach((pid, i) => list.push({ pid, rssKb: b.rssKb?.[i] ?? 0, cmd: b.cmds?.[i] ?? "?" }));
      this.kills.set(label, list);
    }
  }

  /**
   * The runner's sample as a successful sample result while it is fresh. A runner has no guard agent, so its version
   * is `versionFor(os)`, the one the sweep wants, and a runner machine never reads as OUTDATED.
   */
  sampleFor(label: string, versionFor: (os: string) => string): SampleResult | undefined {
    const entry = this.samples.get(label);
    if (!entry || this.now() - entry.at > GUARD_SAMPLE_FRESH_MS) return undefined;
    return { ok: true, sample: { ...entry.sample, version: versionFor(entry.sample.os) } };
  }

  /** The kills reported since the last call, as the ssh kill path returns them; taking them clears them. */
  takeKills(label: string): KillResult {
    const killed = this.kills.get(label) ?? [];
    this.kills.delete(label);
    return { ok: true, killed };
  }
}
