import { join } from "node:path";
import { machineBackoffMs, sshArgv, type GuardMachine } from "../remote-guard.ts";
import { RUN_TIMEOUT_CODE, type Runner } from "../run.ts";
import { plan, settleOperation, type OperationStore } from "../operations.ts";
import { RUNNER_OFFLINE_MS, RUNNER_STALE_MS } from "./hub.ts";
import { remoteRunnerCli, remoteRunnerService } from "./service.ts";

/**
 * Runner liveness and restart decisions (design 4.3), on the supervisor's monotonic clock only.
 *
 * - No heartbeat for 60 s: `RUNNER_STALE machine=<label>` once. For 180 s: `HOST_GUARD OFFLINE machine=<label>` once,
 *   and the restart decision starts.
 * - Each decision runs `dori runner probe --json` on the runner's host over ssh. ssh failing is "unreachable": no
 *   restart, retried on the guard's backoff (2 min doubling to 30 min). The process alive with a fresh health file is a
 *   partition: no restart, `RUNNER_UNREACHABLE machine=<label>` once per outage. The process gone or its health older
 *   than 120 s is "dead": a restart is planned as operations row `runner:<label>/restart/<epoch>-<n>` and carried out
 *   (a worker's service over ssh; the local runner as the supervisor's child process). A hello with a higher gen within 2 min verifies it
 *   (`RUNNER_RESTARTED`); none fails it (`RUNNER_RESTART_FAILED`) and the next decision follows the backoff.
 * - The circuit breaker allows 3 restarts per runner per hour. A restart it refuses, or 30 min offline, makes the
 *   runner LOST: `LANE_RUNNER_LOST <key> runner=<label>` once for each open lane the runner owns. Nothing is moved to
 *   another machine.
 * - A heartbeat or hello ends the outage: `HOST_GUARD ONLINE machine=<label>` when it had gone OFFLINE.
 *
 * A restart never touches herdr or a lane pane: the runner's unit is its own, so the lanes keep running through it.
 */

export const RESTART_CONFIRM_MS = 2 * 60_000;
export const RESTART_CIRCUIT_MAX = 3;
export const RESTART_CIRCUIT_WINDOW_MS = 60 * 60_000;
export const LOST_AFTER_OFFLINE_MS = 30 * 60_000;

export type ProbeOutcome =
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "alive" }
  | { readonly kind: "dead"; readonly detail: string };

export type LivenessDeps = {
  readonly monotonic: () => number;
  /** Wall clock for operations rows. */
  readonly now: () => number;
  /** The supervisor epoch, part of each restart row's id. */
  readonly epoch: number;
  readonly probe: (label: string) => Promise<ProbeOutcome>;
  readonly restart: (label: string) => Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** The open lanes `label` owns (`Lane.runner`). */
  readonly ownedLanes: (label: string) => Promise<readonly string[]>;
  readonly operations: OperationStore;
  readonly emit: (line: string) => Promise<void> | void;
};

type Watched = {
  lastSeen: number;
  gen: number;
  stale: boolean;
  offline: boolean;
  offlineSince?: number;
  unreachableSaid: boolean;
  lost: boolean;
  failures: number;
  nextDecisionAt: number;
  restarts: number[];
  pending?: { readonly opId: string; readonly at: number; readonly gen: number };
  seq: number;
};

const tag = (label: string): string => `machine=${label.replace(/\s/g, "_")}`;

export const PROBE_TIMEOUT_MS = 20_000;
// The bundle `dori runner install` puts on a worker, run with the bun the user's login would find.
const REMOTE_PROBE = remoteRunnerCli("runner probe --json");

/**
 * The real probe and restart. `local` is the label of the runner on the supervisor's own host, probed without ssh and
 * restarted through `restartLocal` (the supervisor's `LocalChild.restart`: the local runner is its child process, never
 * a systemd unit); without it a local restart fails. Any other label is looked up in `machines` and reached over ssh.
 * ssh failing or timing out, a machine that cannot be found, or output that is not a probe answer is "unreachable"; a
 * stalled health file still counts as alive (the restart is kept for a runner the probe calls dead).
 */
export const livenessIo = (run: Runner, local: string, machines: () => Promise<readonly GuardMachine[]>, restartLocal?: () => Promise<void>): Pick<LivenessDeps, "probe" | "restart"> => {
  const on = async (label: string, command: readonly string[], remote: string, timeoutMs: number) => {
    if (label === local) return run(command, { timeoutMs });
    const machine = (await machines()).find((m) => m.label === label);
    if (!machine) return undefined;
    return run(sshArgv(machine.target, remote), { timeoutMs });
  };
  return {
    probe: async (label) => {
      const r = await on(label, [process.execPath, join(import.meta.dir, "..", "cli.ts"), "runner", "probe", "--json"], REMOTE_PROBE, PROBE_TIMEOUT_MS);
      if (!r) return { kind: "unreachable", detail: `no machine ${label}` };
      if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) return { kind: "unreachable", detail: (r.err.trim().split("\n").at(-1) ?? "") || `exit ${r.code}` };
      let verdict: unknown;
      try { verdict = (JSON.parse(r.out.trim().split("\n").at(-1) ?? "") as { verdict?: unknown }).verdict; } catch { verdict = undefined; }
      if (verdict === "healthy" || verdict === "stalled") return { kind: "alive" };
      if (verdict === "dead") return { kind: "dead", detail: r.out.trim().slice(0, 200) };
      return { kind: "unreachable", detail: `no probe answer (exit ${r.code})` };
    },
    restart: async (label) => {
      if (label === local) {
        if (!restartLocal) return { ok: false, detail: "the local runner is the supervisor's child; restart dori-supervisor.service" };
        await restartLocal();
        return { ok: true, detail: "child restart" };
      }
      const r = await on(label, [], remoteRunnerService("restart"), PROBE_TIMEOUT_MS);
      if (!r) return { ok: false, detail: `no machine ${label}` };
      return r.code === 0 ? { ok: true, detail: "service restart" } : { ok: false, detail: (r.err.trim().split("\n").at(-1) ?? "") || `exit ${r.code}` };
    },
  };
};

export class LivenessMonitor {
  private readonly runners = new Map<string, Watched>();
  private deciding = false;

  constructor(private readonly deps: LivenessDeps) {}

  /**
   * Starts watching `label` as if it had just been seen (a supervisor start counts from then). Restarts already in the
   * operations store from the last hour count toward the circuit, so a supervisor restart does not reset it.
   */
  track(label: string, gen = 0): void {
    if (!this.runners.has(label)) {
      const mono = this.deps.monotonic();
      const wall = this.deps.now();
      const restarts = this.deps.operations.list({ lane: `runner:${label}` })
        .filter((op) => op.action === "restart" && wall - op.at < RESTART_CIRCUIT_WINDOW_MS)
        .map((op) => mono - (wall - op.at));
      this.runners.set(label, { lastSeen: mono, gen, stale: false, offline: false, unreachableSaid: false, lost: false, failures: 0, nextDecisionAt: 0, restarts, seq: 0 });
    }
  }

  async heartbeat(label: string): Promise<void> {
    this.track(label);
    await this.seen(label, this.runners.get(label) as Watched);
  }

  async hello(label: string, gen: number): Promise<void> {
    this.track(label, gen);
    const r = this.runners.get(label) as Watched;
    if (r.pending && gen > r.pending.gen) {
      settleOperation(this.deps.operations, this.deps.now(), r.pending.opId, "verified", `hello with gen ${gen} after the restart`);
      await this.deps.emit(`RUNNER_RESTARTED ${tag(label)} gen=${gen}`);
      r.pending = undefined;
    }
    r.gen = Math.max(r.gen, gen);
    await this.seen(label, r);
  }

  restartsLastHour(label: string): number {
    const r = this.runners.get(label);
    const at = this.deps.monotonic();
    return r ? r.restarts.filter((t) => at - t < RESTART_CIRCUIT_WINDOW_MS).length : 0;
  }

  private async seen(label: string, r: Watched): Promise<void> {
    r.lastSeen = this.deps.monotonic();
    if (r.offline) await this.deps.emit(`HOST_GUARD ONLINE ${tag(label)}`);
    Object.assign(r, { stale: false, offline: false, offlineSince: undefined, unreachableSaid: false, lost: false, failures: 0, nextDecisionAt: 0 });
  }

  /** One pass over every tracked runner; a pass still running when the next is due is skipped. */
  async tick(): Promise<void> {
    if (this.deciding) return;
    this.deciding = true;
    try {
      for (const [label, r] of this.runners) await this.tickOne(label, r);
    } finally {
      this.deciding = false;
    }
  }

  private async tickOne(label: string, r: Watched): Promise<void> {
    const at = this.deps.monotonic();
    const silent = at - r.lastSeen;
    if (silent >= RUNNER_STALE_MS && !r.stale) {
      r.stale = true;
      await this.deps.emit(`RUNNER_STALE ${tag(label)} no heartbeat for ${Math.floor(silent / 1000)} s`);
    }
    if (silent >= RUNNER_OFFLINE_MS && !r.offline) {
      r.offline = true;
      r.offlineSince = at;
      r.nextDecisionAt = at;
      await this.deps.emit(`HOST_GUARD OFFLINE ${tag(label)} runner heartbeat missing for ${Math.floor(silent / 1000)} s`);
    }
    if (!r.offline || r.lost) return;
    if (r.pending) {
      if (at - r.pending.at < RESTART_CONFIRM_MS) return;
      settleOperation(this.deps.operations, this.deps.now(), r.pending.opId, "failed", `no hello with a higher gen within ${RESTART_CONFIRM_MS / 1000} s`);
      await this.deps.emit(`RUNNER_RESTART_FAILED ${tag(label)} no hello with a higher gen within ${RESTART_CONFIRM_MS / 60_000} min`);
      r.pending = undefined;
      r.failures += 1;
      r.nextDecisionAt = at + machineBackoffMs(r.failures);
    }
    if (r.offlineSince !== undefined && at - r.offlineSince >= LOST_AFTER_OFFLINE_MS) { await this.lose(label, r, `offline for ${LOST_AFTER_OFFLINE_MS / 60_000} min`); return; }
    if (at < r.nextDecisionAt) return;
    const outcome = await this.deps.probe(label);
    // A heartbeat or hello during the probe ended the outage; the probe's answer is older than that.
    if (!r.offline) return;
    if (outcome.kind !== "dead") {
      if (outcome.kind === "alive" && !r.unreachableSaid) {
        r.unreachableSaid = true;
        await this.deps.emit(`RUNNER_UNREACHABLE ${tag(label)} the runner is alive and healthy on its host but its connection is down; not restarting`);
      }
      r.failures += 1;
      r.nextDecisionAt = at + machineBackoffMs(r.failures);
      return;
    }
    r.restarts = r.restarts.filter((t) => at - t < RESTART_CIRCUIT_WINDOW_MS);
    if (r.restarts.length >= RESTART_CIRCUIT_MAX) { await this.lose(label, r, `restart circuit open: ${RESTART_CIRCUIT_MAX} restarts in the last hour`); return; }
    r.seq += 1;
    const op = plan(this.deps.operations, this.deps.now(), { lane: `runner:${label}`, action: "restart", target: `${this.deps.epoch}-${r.seq}`, data: outcome.detail });
    settleOperation(this.deps.operations, this.deps.now(), op.id, "attempted", "restart requested");
    r.restarts.push(at);
    // Pending before the effect: the restarted runner's hello can arrive while the restart command is still running.
    r.pending = { opId: op.id, at, gen: r.gen };
    const done = await this.deps.restart(label).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
    if (!done.ok && r.pending?.opId === op.id) {
      r.pending = undefined;
      settleOperation(this.deps.operations, this.deps.now(), op.id, "failed", done.detail);
      await this.deps.emit(`RUNNER_RESTART_FAILED ${tag(label)} ${done.detail}`);
      r.failures += 1;
      r.nextDecisionAt = at + machineBackoffMs(r.failures);
    }
  }

  private async lose(label: string, r: Watched, why: string): Promise<void> {
    r.lost = true;
    const lanes = await this.deps.ownedLanes(label);
    for (const key of lanes) await this.deps.emit(`LANE_RUNNER_LOST ${key} runner=${label} ${why}; the lane is not moved`);
  }
}
