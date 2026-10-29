import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GuardThresholds } from "./config.ts";
import { alertReasons } from "./host-guard.ts";
import { RUN_TIMEOUT_CODE, type Runner } from "./run.ts";

/** The agent script the server installs on each worker machine as `$HOME/.dori/guard-agent.sh`. */
export const GUARD_AGENT_TEMPLATE = join(import.meta.dir, "..", "templates", "guard-agent.sh");

const REMOTE_SCRIPT = '"$HOME/.dori/guard-agent.sh"';
const REMOTE_VERSION = '"$HOME/.dori/guard-agent.version"';
// Written next to the live files and moved over them, so a running sample never reads a half-written script.
const REMOTE_SCRIPT_TMP = '"$HOME/.dori/guard-agent.sh.tmp.$$"';
const REMOTE_VERSION_TMP = '"$HOME/.dori/guard-agent.version.tmp.$$"';
const HEREDOC = "DORI_GUARD_EOF";
const INSTALL_TIMEOUT_MS = 30_000;
const SAMPLE_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 30_000;

/** First 12 hex chars of the script's sha256: what `guard-agent.version` holds once installed. */
export const guardAgentVersion = (script: string): string => createHash("sha256").update(script).digest("hex").slice(0, 12);

/** `id` is herdr's machine id when the list has one; a lane may name its machine by label or by id. */
export type GuardMachine = { readonly label: string; readonly target: string; readonly id?: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);

const machineEntries = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  const result = o.result && typeof o.result === "object" ? o.result as Record<string, unknown> : undefined;
  for (const v of [o.machines, result?.machines, o.profiles, result?.profiles, o.result]) if (Array.isArray(v)) return v;
  return [];
};

/** Parses `herdr machine list --json`, tolerating a bare array or one under machines/result.machines/profiles. Throws on invalid JSON. */
export const parseMachineList = (json: string): GuardMachine[] => {
  const out: GuardMachine[] = [];
  for (const e of machineEntries(JSON.parse(json))) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (o.enabled === false) continue;
    const id = str(o.id);
    const label = str(o.label) ?? id;
    if (!label) continue;
    out.push({ label, target: str(o.ssh_target) ?? str(o.target) ?? str(o.ssh) ?? str(o.host) ?? label, ...(id ? { id } : {}) });
  }
  return out;
};

/** A machine list read; on failure `machines` holds only the overrides and `detail` says why herdr's list is missing. */
export type MachineListResult = { ok: true; machines: GuardMachine[] } | { ok: false; detail: string; machines: GuardMachine[] };

const withOverrides = (listed: readonly GuardMachine[], overrides: Readonly<Record<string, string>>): GuardMachine[] => {
  const byLabel = new Map(listed.map((m) => [m.label, m]));
  for (const [label, target] of Object.entries(overrides)) byLabel.set(label, { ...byLabel.get(label), label, target });
  return [...byLabel.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
};

/** herdr's saved machines with `overrides` (label -> ssh target) replacing or adding by label; a herdr failure or invalid JSON is not ok. */
export const readGuardMachines = async (run: Runner, overrides: Readonly<Record<string, string>>): Promise<MachineListResult> => {
  const r = await run(["herdr", "machine", "list", "--json"]);
  if (r.code !== 0) return { ok: false, detail: firstLine(r.err) || firstLine(r.out) || `exit ${r.code}`, machines: withOverrides([], overrides) };
  try {
    return { ok: true, machines: withOverrides(parseMachineList(r.out), overrides) };
  } catch (e) {
    return { ok: false, detail: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`, machines: withOverrides([], overrides) };
  }
};

/** readGuardMachines' machines, failure or not (only the overrides when herdr fails). */
export const listGuardMachines = async (run: Runner, overrides: Readonly<Record<string, string>>): Promise<GuardMachine[]> =>
  (await readGuardMachines(run, overrides)).machines;

export const sshArgv = (target: string, command: string): string[] => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, command];

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export type MachineSample = {
  readonly version: string;
  readonly os: string;
  readonly load1: number;
  readonly memFreePct: number;
  readonly swapFreeGb: number;
  /** Total swap in GB; -1 when unknown, including agents that predate the field. */
  readonly swapTotalGb: number;
  readonly diskFreeGb: number;
};

/** The `DORI_GUARD_SAMPLE` line's fields; undefined when it is missing or a field is absent or not a number. */
export const parseAgentSample = (out: string): MachineSample | undefined => {
  const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("DORI_GUARD_SAMPLE "));
  if (!line) return undefined;
  const f = new Map(line.split(/\s+/).slice(1).map((kv) => {
    const i = kv.indexOf("=");
    return i < 0 ? [kv, ""] as const : [kv.slice(0, i), kv.slice(i + 1)] as const;
  }));
  const n = (k: string): number => {
    const v = f.get(k);
    return v === undefined || v === "" ? NaN : Number(v);
  };
  const s = { version: f.get("version") ?? "", os: f.get("os") ?? "", load1: n("load1"), memFreePct: n("mem_free_pct"), swapFreeGb: n("swap_free_gb"), swapTotalGb: Number.isFinite(n("swap_total_gb")) ? n("swap_total_gb") : -1, diskFreeGb: n("disk_free_gb") };
  if (!s.version || !s.os || ![s.load1, s.memFreePct, s.swapFreeGb, s.diskFreeGb].every(Number.isFinite)) return undefined;
  return s;
};

export type SampleResult = { ok: true; sample: MachineSample } | { ok: false; detail: string };

const NOT_INSTALLED = "guard agent not installed";
const unreachable = (r: { timedOut?: boolean; code: number }): boolean => Boolean(r.timedOut) || r.code === RUN_TIMEOUT_CODE || r.code === 255;

const sampleWith = async (run: Runner, m: GuardMachine, timeoutMs: number): Promise<SampleResult> => {
  const r = await run(sshArgv(m.target, `sh ${REMOTE_SCRIPT} sample`), { timeoutMs });
  if (unreachable(r)) return { ok: false, detail: `unreachable: ${firstLine(r.err) || `ssh exit ${r.code}`}` };
  if (r.code === 127 || (r.code !== 0 && /No such file|Can't open|cannot open/i.test(r.err))) {
    return { ok: false, detail: `${NOT_INSTALLED}; run dori guard install --machine ${m.label}` };
  }
  if (r.code !== 0) return { ok: false, detail: `sample failed (exit ${r.code}): ${firstLine(r.err) || firstLine(r.out)}` };
  const sample = parseAgentSample(r.out);
  return sample ? { ok: true, sample } : { ok: false, detail: `bad sample: ${firstLine(r.out).slice(0, 200) || "(empty)"}` };
};

/** Runs the installed agent's `sample` over ssh. */
export const sampleMachine = (run: Runner, m: GuardMachine): Promise<SampleResult> => sampleWith(run, m, SAMPLE_TIMEOUT_MS);

export type KillResult =
  | { ok: true; killed: { pid: number; rssKb: number; cmd: string }[] }
  | { ok: false; detail: string };

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Parses the agent's `DORI_GUARD_KILLED` lines; undefined without the closing `DORI_GUARD_KILL_DONE` line. */
const parseKillOutput = (out: string): { pid: number; rssKb: number; cmd: string }[] | undefined => {
  const killed: { pid: number; rssKb: number; cmd: string }[] = [];
  let done = false;
  for (const line of out.split("\n").map((l) => l.trim())) {
    if (line.startsWith("DORI_GUARD_KILL_DONE")) done = true;
    const m = /^DORI_GUARD_KILLED pid=(\d+) rss_kb=(\d+) cmd=(\S*)$/.exec(line);
    if (m) killed.push({ pid: Number(m[1]), rssKb: Number(m[2]), cmd: m[3]! });
  }
  return done ? killed : undefined;
};

/** Runs the installed agent's `kill` over ssh: ends that machine's processes whose command line contains any of `patterns`. */
export const killOnMachine = async (run: Runner, m: GuardMachine, patterns: readonly string[]): Promise<KillResult> => {
  const pats = patterns.filter((p) => p.trim());
  if (pats.length === 0) return { ok: true, killed: [] };
  const r = await run(sshArgv(m.target, `sh ${REMOTE_SCRIPT} kill ${pats.map(shellQuote).join(" ")}`), { timeoutMs: KILL_TIMEOUT_MS });
  if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) return { ok: false, detail: `unreachable: ${firstLine(r.err) || `ssh exit ${r.code}`}` };
  if (r.code === 127 || (r.code !== 0 && /No such file|Can't open|cannot open/i.test(r.err))) {
    return { ok: false, detail: `guard agent not installed; run dori guard install --machine ${m.label}` };
  }
  if (r.code !== 0) return { ok: false, detail: `kill failed (exit ${r.code}): ${firstLine(r.err) || firstLine(r.out)}` };
  const killed = parseKillOutput(r.out);
  return killed ? { ok: true, killed } : { ok: false, detail: `bad kill output: ${firstLine(r.out).slice(0, 200) || "(empty)"}` };
};

export type InstallResult = { ok: true; version: string } | { ok: false; detail: string };

/** Writes the script and its version file to temp files and moves them into place in one ssh call, then samples to confirm the installed version. */
export const installGuardAgent = async (run: Runner, m: GuardMachine, script: string): Promise<InstallResult> => {
  if (script.split("\n").some((l) => l.replace(/\r$/, "") === HEREDOC)) throw new Error(`guard agent script contains the heredoc delimiter ${HEREDOC}`);
  const version = guardAgentVersion(script);
  const body = script.endsWith("\n") ? script : `${script}\n`;
  const command = [
    "umask 077",
    'mkdir -p "$HOME/.dori" || exit 1',
    `cat > ${REMOTE_SCRIPT_TMP} <<'${HEREDOC}' || exit 1`,
    `${body}${HEREDOC}`,
    `printf '%s\\n' '${version}' > ${REMOTE_VERSION_TMP} || exit 1`,
    `mv -f ${REMOTE_SCRIPT_TMP} ${REMOTE_SCRIPT} || exit 1`,
    `mv -f ${REMOTE_VERSION_TMP} ${REMOTE_VERSION} || exit 1`,
  ].join("\n");
  const w = await run(sshArgv(m.target, command), { timeoutMs: INSTALL_TIMEOUT_MS });
  if (w.code !== 0) {
    const why = unreachable(w) ? "unreachable" : `install failed (exit ${w.code})`;
    return { ok: false, detail: `${why}: ${firstLine(w.err) || firstLine(w.out)}` };
  }
  const s = await sampleWith(run, m, INSTALL_TIMEOUT_MS);
  if (!s.ok) return { ok: false, detail: `installed but sample failed: ${s.detail}` };
  if (s.sample.version !== version) return { ok: false, detail: `version check failed: have=${s.sample.version} want=${version}` };
  return { ok: true, version };
};

/**
 * Per-machine guard state. `failures` counts consecutive failed samples; a machine with failures is not sampled again
 * before `nextAttemptAt` (epoch ms, 0 = every round).
 */
export type MachineGuardEntry = {
  alerting: boolean;
  offline: boolean;
  outdated: boolean;
  notInstalled: boolean;
  failures: number;
  nextAttemptAt: number;
};
export type MachineGuardState = Map<string, MachineGuardEntry>;

/** Failed samples before a machine is reported OFFLINE. */
export const OFFLINE_AFTER_FAILURES = 2;
const BACKOFF_START_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** The wait after the `failures`-th consecutive failure: 2 min, doubling, at most 30 min. */
export const machineBackoffMs = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));

/** Whether `label` is sampled this round: always after a success, after a failure only once its backoff has passed. */
export const machineDue = (state: MachineGuardState, label: string, now: number): boolean => (state.get(label)?.nextAttemptAt ?? 0) <= now;

const bool = (v: unknown): boolean => v === true;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** The state saved at `path`; a missing or unreadable file, or one that is not an object, is empty state. */
export const loadMachineGuardState = (path: string): MachineGuardState => {
  const state: MachineGuardState = new Map();
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { return state; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return state;
  for (const [label, e] of Object.entries(data as Record<string, unknown>)) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    state.set(label, {
      alerting: bool(o.alerting), offline: bool(o.offline), outdated: bool(o.outdated), notInstalled: bool(o.notInstalled),
      failures: num(o.failures), nextAttemptAt: num(o.nextAttemptAt),
    });
  }
  return state;
};

/** Saves `state` to `path` through a temp file and a rename, so a crash never leaves a half-written file. */
export const saveMachineGuardState = (path: string, state: MachineGuardState): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(state), null, 2)}\n`);
  renameSync(tmp, path);
};

const tag = (label: string): string => `machine=${label.replace(/\s/g, "_")}`;

/** Alert reasons for a remote sample; a -1 (unreadable) metric never alerts. */
const machineReasons = (s: MachineSample, t: GuardThresholds): string[] => alertReasons({
  load1: s.load1,
  memFreePct: s.memFreePct === -1 ? Infinity : s.memFreePct,
  diskFreeGb: s.diskFreeGb === -1 ? Infinity : s.diskFreeGb,
  panes: -1,
}, t);

/**
 * HOST_GUARD lines for state changes since the last tick. First sight reports only OFFLINE, NOT_INSTALLED, ALERT and
 * OUTDATED; while a machine is offline its alert and outdated state stand. A missing guard agent is NOT_INSTALLED at
 * once; any other failure is OFFLINE only at the OFFLINE_AFTER_FAILURES-th failure in a row. Each failure pushes the
 * next sample out by machineBackoffMs from `now`. An OUTDATED machine reporting the wanted version again is CURRENT.
 * Machines absent from `results` keep their state. `alertDetail` (for example the lanes running there) is appended
 * to an ALERT line after `; `, as on the host's own.
 */
export const machineGuardTick = (
  results: readonly { machine: GuardMachine; result: SampleResult }[],
  t: GuardThresholds,
  want: string,
  state: MachineGuardState,
  alertDetail: (machine: GuardMachine) => string | undefined = () => undefined,
  now = 0,
): string[] => {
  const out: string[] = [];
  for (const { machine, result } of results) {
    const id = tag(machine.label);
    const prev = state.get(machine.label);
    if (!result.ok) {
      const failures = (prev?.failures ?? 0) + 1;
      const detail = result.detail.replace(/\s*\n\s*/g, " ").trim();
      let offline = prev?.offline ?? false;
      let notInstalled = prev?.notInstalled ?? false;
      if (result.detail.startsWith(NOT_INSTALLED)) {
        if (!notInstalled) out.push(`HOST_GUARD NOT_INSTALLED ${id} ${detail}`);
        notInstalled = true;
        offline = false;
      } else if (failures >= OFFLINE_AFTER_FAILURES) {
        if (!offline) out.push(`HOST_GUARD OFFLINE ${id} ${detail}`);
        offline = true;
        notInstalled = false;
      }
      state.set(machine.label, {
        alerting: prev?.alerting ?? false, offline, outdated: prev?.outdated ?? false, notInstalled,
        failures, nextAttemptAt: now + machineBackoffMs(failures),
      });
      continue;
    }
    const s = result.sample;
    if (prev?.offline || prev?.notInstalled) out.push(`HOST_GUARD ONLINE ${id}`);
    const reasons = machineReasons(s, t);
    const alerting = reasons.length > 0;
    if (alerting !== (prev?.alerting ?? false)) {
      const detail = alerting ? alertDetail(machine) : undefined;
      out.push(alerting
        ? `HOST_GUARD ALERT ${id} ${reasons.join(" | ")}${detail ? `; ${detail}` : ""}`
        : `HOST_GUARD CLEAR ${id} load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    }
    const outdated = s.version !== want;
    if (outdated && !(prev?.outdated ?? false)) {
      out.push(`HOST_GUARD OUTDATED ${id} have=${s.version} want=${want}; run dori update or dori guard install --machine ${machine.label}`);
    }
    if (!outdated && prev?.outdated) out.push(`HOST_GUARD CURRENT ${id} ${s.version}`);
    state.set(machine.label, { alerting, offline: false, outdated, notInstalled: false, failures: 0, nextAttemptAt: 0 });
  }
  return out;
};

/**
 * Reinstalls the agent on every machine whose installed version differs from `script`'s (or that has none: the
 * version probe exits 1 or prints nothing); returns how many failed. An unreachable machine, or a probe failing
 * otherwise, is logged and skipped, counted as failed.
 */
export const refreshGuardAgents = async (
  run: Runner,
  machines: readonly GuardMachine[],
  script: string,
  log: (line: string) => void,
): Promise<number> => {
  const want = guardAgentVersion(script);
  const failed = await Promise.all(machines.map(async (m) => {
    const r = await run(sshArgv(m.target, `cat ${REMOTE_VERSION}`), { timeoutMs: SAMPLE_TIMEOUT_MS });
    if (unreachable(r)) {
      log(`GUARD_AGENT_UNREACHABLE ${m.label} ${firstLine(r.err) || `ssh exit ${r.code}`}`);
      return true;
    }
    if (r.code !== 0 && r.code !== 1) {
      log(`GUARD_AGENT_FAILED ${m.label} version probe failed (exit ${r.code}): ${firstLine(r.err) || firstLine(r.out)}`);
      return true;
    }
    const have = (r.code === 0 && firstLine(r.out)) || "none";
    if (have === want) {
      log(`GUARD_AGENT_CURRENT ${m.label} ${want}`);
      return false;
    }
    const res = await installGuardAgent(run, m, script);
    if (res.ok) log(`GUARD_AGENT_UPDATED ${m.label} ${have}..${res.version}`);
    else log(`GUARD_AGENT_FAILED ${m.label} ${res.detail.replace(/\s*\n\s*/g, " ")}`);
    return !res.ok;
  }));
  return failed.filter(Boolean).length;
};
