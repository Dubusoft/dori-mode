import { createHash } from "node:crypto";
import { join } from "node:path";

import type { GuardThresholds } from "./config.ts";
import { alertReasons } from "./host-guard.ts";
import { RUN_TIMEOUT_CODE, type Runner } from "./run.ts";

/** The agent script the server installs on each worker machine as `$HOME/.dori/guard-agent.sh`. */
export const GUARD_AGENT_TEMPLATE = join(import.meta.dir, "..", "templates", "guard-agent.sh");

const REMOTE_SCRIPT = '"$HOME/.dori/guard-agent.sh"';
const REMOTE_VERSION = '"$HOME/.dori/guard-agent.version"';
const HEREDOC = "DORI_GUARD_EOF";
const INSTALL_TIMEOUT_MS = 30_000;
const SAMPLE_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 30_000;

/** First 12 hex chars of the script's sha256: what `guard-agent.version` holds once installed. */
export const guardAgentVersion = (script: string): string => createHash("sha256").update(script).digest("hex").slice(0, 12);

export type GuardMachine = { readonly label: string; readonly target: string };

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
    const label = str(o.label) ?? str(o.id);
    if (!label) continue;
    out.push({ label, target: str(o.ssh_target) ?? str(o.target) ?? str(o.ssh) ?? str(o.host) ?? label });
  }
  return out;
};

/** herdr's saved machines (none when herdr fails), with `overrides` (label -> ssh target) replacing or adding by label. */
export const listGuardMachines = async (run: Runner, overrides: Readonly<Record<string, string>>): Promise<GuardMachine[]> => {
  const r = await run(["herdr", "machine", "list", "--json"]);
  let listed: GuardMachine[] = [];
  if (r.code === 0) {
    try { listed = parseMachineList(r.out); } catch { listed = []; }
  }
  const byLabel = new Map(listed.map((m) => [m.label, m]));
  for (const [label, target] of Object.entries(overrides)) byLabel.set(label, { label, target });
  return [...byLabel.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
};

export const sshArgv = (target: string, command: string): string[] => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, command];

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

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export type SampleResult = { ok: true; sample: MachineSample } | { ok: false; detail: string };

const sampleWith = async (run: Runner, m: GuardMachine, timeoutMs: number): Promise<SampleResult> => {
  const r = await run(sshArgv(m.target, `sh ${REMOTE_SCRIPT} sample`), { timeoutMs });
  if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) return { ok: false, detail: `unreachable: ${firstLine(r.err) || `ssh exit ${r.code}`}` };
  if (r.code === 127 || (r.code !== 0 && /No such file|Can't open|cannot open/i.test(r.err))) {
    return { ok: false, detail: `guard agent not installed; run dori guard install --machine ${m.label}` };
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

/** Writes the script and its version file in one ssh call, then samples to confirm the installed version. */
export const installGuardAgent = async (run: Runner, m: GuardMachine, script: string): Promise<InstallResult> => {
  if (script.split("\n").some((l) => l.replace(/\r$/, "") === HEREDOC)) throw new Error(`guard agent script contains the heredoc delimiter ${HEREDOC}`);
  const version = guardAgentVersion(script);
  const body = script.endsWith("\n") ? script : `${script}\n`;
  const command = [
    "umask 077",
    'mkdir -p "$HOME/.dori" || exit 1',
    `cat > ${REMOTE_SCRIPT} <<'${HEREDOC}' || exit 1`,
    `${body}${HEREDOC}`,
    `printf '%s\\n' '${version}' > ${REMOTE_VERSION} || exit 1`,
  ].join("\n");
  const w = await run(sshArgv(m.target, command), { timeoutMs: INSTALL_TIMEOUT_MS });
  if (w.code !== 0) {
    const why = w.timedOut || w.code === RUN_TIMEOUT_CODE || w.code === 255 ? "unreachable" : `install failed (exit ${w.code})`;
    return { ok: false, detail: `${why}: ${firstLine(w.err) || firstLine(w.out)}` };
  }
  const s = await sampleWith(run, m, INSTALL_TIMEOUT_MS);
  if (!s.ok) return { ok: false, detail: `installed but sample failed: ${s.detail}` };
  if (s.sample.version !== version) return { ok: false, detail: `version check failed: have=${s.sample.version} want=${version}` };
  return { ok: true, version };
};

export type MachineGuardState = Map<string, { alerting: boolean; offline: boolean; outdated: boolean }>;

const tag = (label: string): string => `machine=${label.replace(/\s/g, "_")}`;

/** Alert reasons for a remote sample; a -1 (unreadable) metric never alerts. */
const machineReasons = (s: MachineSample, t: GuardThresholds): string[] => alertReasons({
  load1: s.load1,
  memFreePct: s.memFreePct === -1 ? Infinity : s.memFreePct,
  diskFreeGb: s.diskFreeGb === -1 ? Infinity : s.diskFreeGb,
  panes: -1,
}, t);

/**
 * HOST_GUARD lines for state changes since the last tick. First sight reports only OFFLINE, ALERT and OUTDATED; while
 * a machine is offline its alert and outdated state stand. Machines absent from `results` keep their state.
 * `alertDetail` (for example the lanes running there) is appended to an ALERT line after `; `, as on the host's own.
 */
export const machineGuardTick = (
  results: readonly { machine: GuardMachine; result: SampleResult }[],
  t: GuardThresholds,
  want: string,
  state: MachineGuardState,
  alertDetail: (machine: GuardMachine) => string | undefined = () => undefined,
): string[] => {
  const out: string[] = [];
  for (const { machine, result } of results) {
    const id = tag(machine.label);
    const prev = state.get(machine.label);
    if (!result.ok) {
      if (!prev?.offline) out.push(`HOST_GUARD OFFLINE ${id} ${result.detail.replace(/\s*\n\s*/g, " ").trim()}`);
      state.set(machine.label, { alerting: prev?.alerting ?? false, offline: true, outdated: prev?.outdated ?? false });
      continue;
    }
    const s = result.sample;
    if (prev?.offline) out.push(`HOST_GUARD ONLINE ${id}`);
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
    state.set(machine.label, { alerting, offline: false, outdated });
  }
  return out;
};

/** Reinstalls the agent on every machine whose installed version differs from `script`'s; returns how many failed. */
export const refreshGuardAgents = async (
  run: Runner,
  machines: readonly GuardMachine[],
  script: string,
  log: (line: string) => void,
): Promise<number> => {
  const want = guardAgentVersion(script);
  const failed = await Promise.all(machines.map(async (m) => {
    const r = await run(sshArgv(m.target, `cat ${REMOTE_VERSION}`), { timeoutMs: SAMPLE_TIMEOUT_MS });
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
