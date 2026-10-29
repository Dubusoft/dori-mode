import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GuardThresholds } from "./config.ts";
import { alertReasons } from "./host-guard.ts";
import { type Ran, RUN_TIMEOUT_CODE, type Runner } from "./run.ts";

/** The agent script the server installs on each worker machine as `$HOME/.dori/guard-agent.sh`. */
export const GUARD_AGENT_TEMPLATE = join(import.meta.dir, "..", "templates", "guard-agent.sh");
/** The agent script installed on each Windows worker as `%USERPROFILE%\.dori\guard-agent.ps1`. */
export const GUARD_AGENT_PS_TEMPLATE = join(import.meta.dir, "..", "templates", "guard-agent.ps1");

/** Both agent scripts: `sh` for POSIX workers, `ps` for Windows workers. */
export type GuardAgentScripts = { readonly sh: string; readonly ps: string };
/** The installed version each kind of worker should report. */
export type GuardAgentWants = { readonly sh: string; readonly ps: string };

/** Reads both agent templates. */
export const readGuardAgentScripts = async (): Promise<GuardAgentScripts> => {
  const [sh, ps] = await Promise.all([readFile(GUARD_AGENT_TEMPLATE, "utf8"), readFile(GUARD_AGENT_PS_TEMPLATE, "utf8")]);
  return { sh, ps };
};

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

export const guardAgentWants = (scripts: GuardAgentScripts): GuardAgentWants => ({ sh: guardAgentVersion(scripts.sh), ps: guardAgentVersion(scripts.ps) });

/** The version a sample from `os` should report: the PowerShell agent's on Windows, the sh agent's elsewhere. */
export const wantFor = (want: string | GuardAgentWants, os: string): string => (typeof want === "string" ? want : os === "windows" ? want.ps : want.sh);

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

const SSH_NOTICES = ["** ", "Warning: Permanently added", "Pseudo-terminal will not be allocated"];

/** The first stderr line that is not an ssh client notice (post-quantum warning, known-hosts note, no-tty note). */
const stderrLine = (err: string): string =>
  err.split("\n").map((l) => l.trim()).find((l) => l && !SSH_NOTICES.some((p) => l.startsWith(p))) ?? "";

/** An ssh result's error for a detail: the real stderr line, else stdout's first line, else `ssh exit <code>`. */
const sshError = (r: { code: number; out: string; err: string }): string => stderrLine(r.err) || firstLine(r.out) || `ssh exit ${r.code}`;

/** Prefix of every detail for a worker whose ssh login shell is not POSIX sh (Windows cmd or PowerShell). */
export const UNSUPPORTED_SHELL = "unsupported remote shell";
const UNSUPPORTED_WHY = `${UNSUPPORTED_SHELL} (not POSIX sh, likely Windows cmd or PowerShell)`;
const NOT_RECOGNIZED = /is not recognized as (an internal or external command|the name of a cmdlet)/i;

/** The unsupported-shell detail when a failed command's real error is cmd's or PowerShell's unknown-command message. */
const unsupportedShell = (r: { code: number; err: string }): string | undefined => {
  const line = stderrLine(r.err);
  return r.code !== 0 && NOT_RECOGNIZED.test(line) ? `${UNSUPPORTED_WHY}: ${line}` : undefined;
};

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

const POSIX_PROBE = 'x=6; echo "DORI_POSIX_$((x*7))"';
const POSIX_TOKEN = "DORI_POSIX_42";
const PS_PROBE = "Write-Output ('DORI_PS_' + (6*7))";
const PS_TOKEN = "DORI_PS_42";
const NO_SHELL = `${UNSUPPORTED_SHELL} (no POSIX sh or PowerShell)`;

/** The ssh command that runs PowerShell `snippet` on Windows, whether the OpenSSH login shell is cmd.exe or PowerShell. */
export const encodedPowerShell = (snippet: string): string =>
  `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(snippet, "utf16le").toString("base64")}`;

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const psAgent = (args: string): string => encodedPowerShell(`& (Join-Path $env:USERPROFILE '.dori\\guard-agent.ps1') ${args}; exit $LASTEXITCODE`);
const PS_VERSION = encodedPowerShell(
  "$f = Join-Path $env:USERPROFILE '.dori\\guard-agent.version'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f -TotalCount 1; exit 0 } else { exit 1 }",
);
/** PowerShell's error when the agent script itself is missing on a Windows worker. */
const psAgentMissing = (r: Ran): boolean => /guard-agent\.ps1/i.test(r.err) && /not recognized|cannot find|does not exist|not found/i.test(r.err);

/** How a machine runs commands over ssh: POSIX sh, or Windows PowerShell through an encoded command. */
export type MachineKind = "posix" | "windows";
const machineKinds = new Map<string, MachineKind>();

/** Forgets every machine's resolved kind. */
export const clearShellModes = (): void => machineKinds.clear();

/** The ssh command (and its stdin) for one kind of machine. */
type KindCommand = (kind: MachineKind) => { readonly command: string; readonly stdin?: string };

const runIn = (run: Runner, target: string, cmd: { readonly command: string; readonly stdin?: string }, timeoutMs: number): Promise<Ran> =>
  run(sshArgv(target, cmd.command), cmd.stdin === undefined ? { timeoutMs } : { timeoutMs, stdin: cmd.stdin });

type ShellFailure = { ok: false; unsupported: boolean; detail: string };

/** Finds `target`'s kind: POSIX when the sh probe answers, else Windows when the encoded PowerShell probe does; caches it. */
const resolveKind = async (run: Runner, target: string, timeoutMs: number): Promise<{ ok: true; kind: MachineKind } | ShellFailure> => {
  let why = "";
  for (const [kind, command, token] of [["posix", POSIX_PROBE, POSIX_TOKEN], ["windows", encodedPowerShell(PS_PROBE), PS_TOKEN]] as const) {
    const r = await runIn(run, target, { command }, timeoutMs);
    if (unreachable(r)) return { ok: false, unsupported: false, detail: `unreachable: ${sshError(r)}` };
    if (r.out.split("\n").some((l) => l.trim() === token)) {
      machineKinds.set(target, kind);
      return { ok: true, kind };
    }
    why ||= stderrLine(r.err);
  }
  return { ok: false, unsupported: true, detail: `${NO_SHELL}: ${why || "no probe output"}` };
};

/** A result showing the cached kind is wrong: cmd's/PowerShell's unknown-command error under posix; exit 127 or an unknown command other than the agent under windows. */
const wrongKind = (kind: MachineKind, r: Ran): boolean => kind === "posix"
  ? r.code !== 0 && NOT_RECOGNIZED.test(stderrLine(r.err))
  : !psAgentMissing(r) && (r.code === 127 || (r.code !== 0 && NOT_RECOGNIZED.test(r.err)));

/**
 * Runs `cmd` on `m` for its cached kind, resolving the kind when none is cached. When a cached kind gets a
 * wrong-kind result, the kind is resolved again and, if it changed, the command runs once more.
 */
const runOn = async (run: Runner, m: GuardMachine, cmd: KindCommand, timeoutMs: number): Promise<{ ok: true; r: Ran; kind: MachineKind } | ShellFailure> => {
  const cached = machineKinds.get(m.target);
  const first = cached ? { ok: true as const, kind: cached } : await resolveKind(run, m.target, timeoutMs);
  if (!first.ok) return first;
  const r = await runIn(run, m.target, cmd(first.kind), timeoutMs);
  if (!cached || !wrongKind(first.kind, r)) return { ok: true, r, kind: first.kind };
  machineKinds.delete(m.target);
  const again = await resolveKind(run, m.target, timeoutMs);
  if (!again.ok) return again;
  if (again.kind === first.kind) return { ok: true, r, kind: first.kind };
  return { ok: true, r: await runIn(run, m.target, cmd(again.kind), timeoutMs), kind: again.kind };
};

const sampleWith = async (run: Runner, m: GuardMachine, timeoutMs: number): Promise<SampleResult> => {
  const p = await runOn(run, m, (kind) => ({ command: kind === "windows" ? psAgent("sample") : `sh ${REMOTE_SCRIPT} sample` }), timeoutMs);
  if (!p.ok) return { ok: false, detail: p.detail };
  const r = p.r;
  if (unreachable(r)) return { ok: false, detail: `unreachable: ${sshError(r)}` };
  if (p.kind === "windows" && psAgentMissing(r)) return { ok: false, detail: `${NOT_INSTALLED}; run dori guard install --machine ${m.label}` };
  const unsupported = unsupportedShell(r);
  if (unsupported) return { ok: false, detail: unsupported };
  if (r.code === 127 || (r.code !== 0 && /No such file|Can't open|cannot open/i.test(r.err))) {
    return { ok: false, detail: `${NOT_INSTALLED}; run dori guard install --machine ${m.label}` };
  }
  if (r.code !== 0) return { ok: false, detail: `sample failed (exit ${r.code}): ${sshError(r)}` };
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
  const p = await runOn(run, m, (kind) => ({
    command: kind === "windows" ? psAgent(`kill ${pats.map(psQuote).join(" ")}`) : `sh ${REMOTE_SCRIPT} kill ${pats.map(shellQuote).join(" ")}`,
  }), KILL_TIMEOUT_MS);
  if (!p.ok) return { ok: false, detail: p.detail };
  const r = p.r;
  if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) return { ok: false, detail: `unreachable: ${sshError(r)}` };
  if (p.kind === "windows" && psAgentMissing(r)) return { ok: false, detail: `guard agent not installed; run dori guard install --machine ${m.label}` };
  const unsupported = unsupportedShell(r);
  if (unsupported) return { ok: false, detail: unsupported };
  if (r.code === 127 || (r.code !== 0 && /No such file|Can't open|cannot open/i.test(r.err))) {
    return { ok: false, detail: `guard agent not installed; run dori guard install --machine ${m.label}` };
  }
  if (r.code !== 0) return { ok: false, detail: `kill failed (exit ${r.code}): ${sshError(r)}` };
  const killed = parseKillOutput(r.out);
  return killed ? { ok: true, killed } : { ok: false, detail: `bad kill output: ${firstLine(r.out).slice(0, 200) || "(empty)"}` };
};

/** `unsupported` marks a worker with neither POSIX sh nor PowerShell: the agent is skipped there, not failed. */
export type InstallResult =
  | { ok: true; version: string }
  | { ok: false; unsupported?: false; detail: string }
  | { ok: false; unsupported: true; detail: string };

/** Writes the ps1 text read from stdin and its version to temp files in %USERPROFILE%\.dori and moves them over the live files. */
const psInstall = (version: string): string => encodedPowerShell([
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $text = [Console]::In.ReadToEnd()",
  "  $d = Join-Path $env:USERPROFILE '.dori'",
  "  New-Item -ItemType Directory -Force -Path $d | Out-Null",
  "  $enc = New-Object System.Text.UTF8Encoding $false",
  "  $s = Join-Path $d ('guard-agent.ps1.tmp.' + $PID)",
  "  $v = Join-Path $d ('guard-agent.version.tmp.' + $PID)",
  "  [IO.File]::WriteAllText($s, $text, $enc)",
  `  [IO.File]::WriteAllText($v, '${version}' + [char]10, $enc)`,
  "  Move-Item -Force -LiteralPath $s -Destination (Join-Path $d 'guard-agent.ps1')",
  "  Move-Item -Force -LiteralPath $v -Destination (Join-Path $d 'guard-agent.version')",
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  "exit 0",
].join("\n"));

/**
 * Finds the machine's kind, then writes that kind's script (`sh` for POSIX, `ps` for Windows) and its version file to
 * temp files and moves them into place in one call, then samples to confirm the installed version.
 */
export const installGuardAgent = async (run: Runner, m: GuardMachine, scripts: GuardAgentScripts): Promise<InstallResult> => {
  const script = scripts.sh;
  if (script.split("\n").some((l) => l.replace(/\r$/, "") === HEREDOC)) throw new Error(`guard agent script contains the heredoc delimiter ${HEREDOC}`);
  const want = guardAgentWants(scripts);
  const body = script.endsWith("\n") ? script : `${script}\n`;
  const shCommand = [
    "umask 077",
    'mkdir -p "$HOME/.dori" || exit 1',
    `cat > ${REMOTE_SCRIPT_TMP} <<'${HEREDOC}' || exit 1`,
    `${body}${HEREDOC}`,
    `printf '%s\\n' '${want.sh}' > ${REMOTE_VERSION_TMP} || exit 1`,
    `mv -f ${REMOTE_SCRIPT_TMP} ${REMOTE_SCRIPT} || exit 1`,
    `mv -f ${REMOTE_VERSION_TMP} ${REMOTE_VERSION} || exit 1`,
  ].join("\n");
  const p = await runOn(run, m, (kind) => (kind === "windows" ? { command: psInstall(want.ps), stdin: scripts.ps } : { command: shCommand }), INSTALL_TIMEOUT_MS);
  if (!p.ok) return p.unsupported ? { ok: false, unsupported: true, detail: p.detail } : { ok: false, detail: p.detail };
  const version = p.kind === "windows" ? want.ps : want.sh;
  const w = p.r;
  if (w.code !== 0) {
    const why = unreachable(w) ? "unreachable" : `install failed (exit ${w.code})`;
    return { ok: false, detail: `${why}: ${sshError(w)}` };
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
  /** The worker has neither POSIX sh nor PowerShell, so the agent cannot run there. */
  unsupported: boolean;
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
      unsupported: bool(o.unsupported), failures: num(o.failures), nextAttemptAt: num(o.nextAttemptAt),
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
  want: string | GuardAgentWants,
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
      let unsupported = prev?.unsupported ?? false;
      let nextAttemptAt = now + machineBackoffMs(failures);
      if (result.detail.startsWith(UNSUPPORTED_SHELL)) {
        if (!unsupported) out.push(`HOST_GUARD UNSUPPORTED ${id} ${detail}`);
        unsupported = true;
        offline = false;
        notInstalled = false;
        nextAttemptAt = now + BACKOFF_MAX_MS;
      } else if (result.detail.startsWith(NOT_INSTALLED)) {
        if (!notInstalled) out.push(`HOST_GUARD NOT_INSTALLED ${id} ${detail}`);
        notInstalled = true;
        offline = false;
        unsupported = false;
      } else if (failures >= OFFLINE_AFTER_FAILURES) {
        if (!offline) out.push(`HOST_GUARD OFFLINE ${id} ${detail}`);
        offline = true;
        notInstalled = false;
        unsupported = false;
      }
      state.set(machine.label, {
        alerting: prev?.alerting ?? false, offline, outdated: prev?.outdated ?? false, notInstalled, unsupported,
        failures, nextAttemptAt,
      });
      continue;
    }
    const s = result.sample;
    if (prev?.offline || prev?.notInstalled || prev?.unsupported) out.push(`HOST_GUARD ONLINE ${id}`);
    const reasons = machineReasons(s, t);
    const alerting = reasons.length > 0;
    if (alerting !== (prev?.alerting ?? false)) {
      const detail = alerting ? alertDetail(machine) : undefined;
      out.push(alerting
        ? `HOST_GUARD ALERT ${id} ${reasons.join(" | ")}${detail ? `; ${detail}` : ""}`
        : `HOST_GUARD CLEAR ${id} load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    }
    const wanted = wantFor(want, s.os);
    const outdated = s.version !== wanted;
    if (outdated && !(prev?.outdated ?? false)) {
      out.push(`HOST_GUARD OUTDATED ${id} have=${s.version} want=${wanted}; run dori update or dori guard install --machine ${machine.label}`);
    }
    if (!outdated && prev?.outdated) out.push(`HOST_GUARD CURRENT ${id} ${s.version}`);
    state.set(machine.label, { alerting, offline: false, outdated, notInstalled: false, unsupported: false, failures: 0, nextAttemptAt: 0 });
  }
  return out;
};

/**
 * Reinstalls the agent on every machine whose installed version differs from its kind's script in `scripts` (or that has none: the
 * version probe exits 1 or prints nothing); returns how many failed. An unreachable machine, or a probe failing
 * otherwise, is logged and skipped, counted as failed; a machine with neither POSIX sh nor PowerShell is skipped, not failed.
 */
export const refreshGuardAgents = async (
  run: Runner,
  machines: readonly GuardMachine[],
  scripts: GuardAgentScripts,
  log: (line: string) => void,
): Promise<number> => {
  const wants = guardAgentWants(scripts);
  const failed = await Promise.all(machines.map(async (m) => {
    const p = await runOn(run, m, (kind) => ({ command: kind === "windows" ? PS_VERSION : `cat ${REMOTE_VERSION}` }), SAMPLE_TIMEOUT_MS);
    if (!p.ok && p.unsupported) {
      log(`GUARD_AGENT_SKIPPED ${m.label} ${p.detail.replace(/\s*\n\s*/g, " ")}`);
      return false;
    }
    if (!p.ok) {
      log(`GUARD_AGENT_UNREACHABLE ${m.label} ${p.detail.replace(/^unreachable: /, "")}`);
      return true;
    }
    const r = p.r;
    if (unreachable(r)) {
      log(`GUARD_AGENT_UNREACHABLE ${m.label} ${sshError(r)}`);
      return true;
    }
    if (r.code !== 0 && r.code !== 1) {
      log(`GUARD_AGENT_FAILED ${m.label} version probe failed (exit ${r.code}): ${sshError(r)}`);
      return true;
    }
    const want = p.kind === "windows" ? wants.ps : wants.sh;
    const have = (r.code === 0 && firstLine(r.out)) || "none";
    if (have === want) {
      log(`GUARD_AGENT_CURRENT ${m.label} ${want}`);
      return false;
    }
    const res = await installGuardAgent(run, m, scripts);
    if (res.ok) log(`GUARD_AGENT_UPDATED ${m.label} ${have}..${res.version}`);
    else if (res.unsupported) {
      log(`GUARD_AGENT_SKIPPED ${m.label} ${res.detail.replace(/\s*\n\s*/g, " ")}`);
      return false;
    } else log(`GUARD_AGENT_FAILED ${m.label} ${res.detail.replace(/\s*\n\s*/g, " ")}`);
    return !res.ok;
  }));
  return failed.filter(Boolean).length;
};
