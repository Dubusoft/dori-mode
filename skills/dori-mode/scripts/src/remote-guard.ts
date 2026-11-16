import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { GuardThresholds } from "./config.ts";
import { alertReasons } from "./host-guard.ts";
import { herdrMachineList } from "./herdr-machines.ts";
import { type Ran, RUN_TIMEOUT_CODE, type Runner } from "./run.ts";
import { readRunnerMachines } from "./runner/machines.ts";

const SAMPLE_TIMEOUT_MS = 20_000;

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

/** `stateMachines` (label -> target from `dori runner install <target>`) rank lowest: herdr's list and `overrides` replace them by label. */
const withOverrides = (listed: readonly GuardMachine[], overrides: Readonly<Record<string, string>>, stateMachines: Readonly<Record<string, string>> = {}): GuardMachine[] => {
  const byLabel = new Map<string, GuardMachine>(Object.entries(stateMachines).map(([label, target]) => [label, { label, target }]));
  for (const m of listed) byLabel.set(m.label, m);
  for (const [label, target] of Object.entries(overrides)) byLabel.set(label, { ...byLabel.get(label), label, target });
  return [...byLabel.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
};

/** herdr's saved machines with `overrides` (label -> ssh target) replacing or adding by label; a herdr failure or invalid JSON is not ok. */
export const readGuardMachines = async (run: Runner, overrides: Readonly<Record<string, string>>, stateDir?: string): Promise<MachineListResult> => {
  const state = stateDir === undefined ? {} : readRunnerMachines(stateDir);
  const r = await herdrMachineList(run);
  if (r.code !== 0) return { ok: false, detail: firstLine(r.err) || firstLine(r.out) || `exit ${r.code}`, machines: withOverrides([], overrides, state) };
  try {
    return { ok: true, machines: withOverrides(parseMachineList(r.out), overrides, state) };
  } catch (e) {
    return { ok: false, detail: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`, machines: withOverrides([], overrides, state) };
  }
};

/** readGuardMachines' machines, failure or not (only the overrides when herdr fails). */
export const listGuardMachines = async (run: Runner, overrides: Readonly<Record<string, string>>, stateDir?: string): Promise<GuardMachine[]> =>
  (await readGuardMachines(run, overrides, stateDir)).machines;

export const sshArgv = (target: string, command: string): string[] => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, command];

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

const SSH_NOTICES = ["** ", "Warning: Permanently added", "Pseudo-terminal will not be allocated"];

/** The first stderr line that is not an ssh client notice (post-quantum warning, known-hosts note, no-tty note). */
const stderrLine = (err: string): string =>
  err.split("\n").map((l) => l.trim()).find((l) => l && !SSH_NOTICES.some((p) => l.startsWith(p))) ?? "";

/** An ssh result's error for a detail: the real stderr line, else stdout's first line, else `ssh exit <code>`. */
const sshError = (r: { code: number; out: string; err: string }): string => stderrLine(r.err) || firstLine(r.out) || `ssh exit ${r.code}`;

/** Prefix of every detail for a worker with neither POSIX sh nor PowerShell over ssh. */
export const UNSUPPORTED_SHELL = "unsupported remote shell";

export type MachineSample = {
  readonly os: string;
  readonly load1: number;
  readonly memFreePct: number;
  readonly swapFreeGb: number;
  /** Total swap in GB; -1 when unknown. */
  readonly swapTotalGb: number;
  readonly diskFreeGb: number;
};

export type SampleResult = { ok: true; sample: MachineSample } | { ok: false; detail: string };

const unreachable = (r: { timedOut?: boolean; code: number }): boolean => Boolean(r.timedOut) || r.code === RUN_TIMEOUT_CODE || r.code === 255;

const POSIX_PROBE = 'x=6; echo "DORI_POSIX_$((x*7))"';
const POSIX_TOKEN = "DORI_POSIX_42";
const PS_PROBE = "Write-Output ('DORI_PS_' + (6*7))";
const PS_TOKEN = "DORI_PS_42";
const NO_SHELL = `${UNSUPPORTED_SHELL} (no POSIX sh or PowerShell)`;

/** The ssh command that runs PowerShell `snippet` on Windows, whether the OpenSSH login shell is cmd.exe or PowerShell. */
export const encodedPowerShell = (snippet: string): string =>
  `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(snippet, "utf16le").toString("base64")}`;

/** How a machine runs commands over ssh: POSIX sh, or Windows PowerShell through an encoded command. */
export type MachineKind = "posix" | "windows";
const machineKinds = new Map<string, MachineKind>();

/** Forgets every machine's resolved kind. */
export const clearShellModes = (): void => {
  machineKinds.clear();
  runnerKinds.clear();
};

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

/** A machine's kind, or why it could not be found. */
export type KindResult = { readonly ok: true; readonly kind: MachineKind } | ShellFailure;
const runnerKinds = new Map<string, MachineKind>();
const WINDOWS_UNAME = /^(MINGW|MSYS|CYGWIN)/;

/**
 * The kind of commands `m`'s runner takes: the cached or probed kind, except that a POSIX shell on Windows (Git Bash,
 * MSYS or Cygwin as the ssh shell, whose `uname -s` says so) counts as `windows`, since that runner is installed and
 * controlled through PowerShell. Cached per target; `clearShellModes` forgets it.
 */
export const machineKind = async (run: Runner, m: GuardMachine, timeoutMs: number = SAMPLE_TIMEOUT_MS): Promise<KindResult> => {
  const known = runnerKinds.get(m.target);
  if (known) return { ok: true, kind: known };
  const cached = machineKinds.get(m.target);
  const k = cached ? { ok: true as const, kind: cached } : await resolveKind(run, m.target, timeoutMs);
  if (!k.ok) return k;
  let kind = k.kind;
  if (kind === "posix") {
    const r = await runIn(run, m.target, { command: "uname -s" }, timeoutMs);
    if (unreachable(r)) return { ok: false, unsupported: false, detail: `unreachable: ${sshError(r)}` };
    if (r.code === 0 && WINDOWS_UNAME.test(r.out.trim())) kind = "windows";
  }
  runnerKinds.set(m.target, kind);
  return { ok: true, kind };
};

/** A runner's kills on its machine (`RunnerGuardBoard.takeKills`, from `guard.critical`), as the critical stage reads them. */
export type KillResult =
  | { ok: true; killed: { pid: number; rssKb: number; cmd: string }[] }
  | { ok: false; detail: string };

/** Per-machine guard state: whether the machine's last runner sample was in ALERT. */
export type MachineGuardEntry = { alerting: boolean };
export type MachineGuardState = Map<string, MachineGuardEntry>;

const BACKOFF_START_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** The wait after the `failures`-th consecutive failure: 2 min, doubling, at most 30 min. */
export const machineBackoffMs = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));

const bool = (v: unknown): boolean => v === true;

/** The state saved at `path` (fields of older versions are ignored); a missing or unreadable file, or one that is not an object, is empty state. */
export const loadMachineGuardState = (path: string): MachineGuardState => {
  const state: MachineGuardState = new Map();
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { return state; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return state;
  for (const [label, e] of Object.entries(data as Record<string, unknown>)) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    state.set(label, { alerting: bool(o.alerting) });
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
 * HOST_GUARD ALERT/CLEAR lines for alert changes since the last tick, judged from each machine's runner sample. First
 * sight reports only an ALERT. Machines absent from `results` keep their state. `alertDetail` (for example the lanes
 * running there) is appended to an ALERT line after `; `, as on the host's own. Runner OFFLINE/ONLINE is the liveness
 * monitor's (runner/liveness.ts).
 */
export const machineGuardTick = (
  results: readonly { machine: GuardMachine; sample: MachineSample }[],
  t: GuardThresholds,
  state: MachineGuardState,
  alertDetail: (machine: GuardMachine) => string | undefined = () => undefined,
  _now = 0,
): string[] => {
  const out: string[] = [];
  for (const { machine, sample: s } of results) {
    const id = tag(machine.label);
    const reasons = machineReasons(s, t);
    const alerting = reasons.length > 0;
    if (alerting !== (state.get(machine.label)?.alerting ?? false)) {
      const detail = alerting ? alertDetail(machine) : undefined;
      out.push(alerting
        ? `HOST_GUARD ALERT ${id} ${reasons.join(" | ")}${detail ? `; ${detail}` : ""}`
        : `HOST_GUARD CLEAR ${id} load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    }
    state.set(machine.label, { alerting });
  }
  return out;
};

/** The files the retired standalone guard agent left in each worker's ~/.dori. */
const OLD_AGENT_FILES = ["guard-agent.sh", "guard-agent.ps1", "guard-agent.version"] as const;
const POSIX_REMOVE = [
  "rc=0",
  `for f in ${OLD_AGENT_FILES.join(" ")}; do`,
  '  p="$HOME/.dori/$f"',
  '  if [ -e "$p" ]; then rm -f "$p" && echo "$f" || rc=1; fi',
  "done",
  "exit $rc",
].join("\n");
const PS_REMOVE = encodedPowerShell([
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $d = Join-Path $env:USERPROFILE '.dori'",
  `  foreach ($f in ${OLD_AGENT_FILES.map((f) => `'${f}'`).join(", ")}) {`,
  "    $p = Join-Path $d $f",
  "    if (Test-Path -LiteralPath $p) { Remove-Item -Force -LiteralPath $p; Write-Output $f }",
  "  }",
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  "exit 0",
].join("\n"));

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/**
 * Deletes the retired standalone guard agent's files (~/.dori/guard-agent.sh, .ps1, .version) from every machine and
 * logs GUARD_AGENT_REMOVED with what was there; a machine with nothing to delete logs nothing. A machine with neither
 * POSIX sh nor PowerShell is skipped (GUARD_AGENT_SKIPPED, not a failure). Returns how many machines were unreachable
 * (GUARD_AGENT_UNREACHABLE) or failed otherwise (GUARD_AGENT_FAILED).
 */
export const removeGuardAgents = async (run: Runner, machines: readonly GuardMachine[], log: (line: string) => void): Promise<number> => {
  const failed = await Promise.all(machines.map(async (m) => {
    const k = await machineKind(run, m);
    if (!k.ok && k.unsupported) {
      log(`GUARD_AGENT_SKIPPED ${m.label} ${oneLine(k.detail)}`);
      return false;
    }
    if (!k.ok) {
      log(`GUARD_AGENT_UNREACHABLE ${m.label} ${oneLine(k.detail.replace(/^unreachable: /, ""))}`);
      return true;
    }
    const r = await runIn(run, m.target, { command: k.kind === "windows" ? PS_REMOVE : POSIX_REMOVE }, SAMPLE_TIMEOUT_MS);
    if (unreachable(r)) {
      log(`GUARD_AGENT_UNREACHABLE ${m.label} ${sshError(r)}`);
      return true;
    }
    if (r.code !== 0) {
      log(`GUARD_AGENT_FAILED ${m.label} remove failed (exit ${r.code}): ${sshError(r)}`);
      return true;
    }
    const removed = OLD_AGENT_FILES.filter((f) => r.out.split("\n").some((l) => l.trim() === f));
    if (removed.length) log(`GUARD_AGENT_REMOVED ${m.label} ${removed.join(",")}`);
    return false;
  }));
  return failed.filter(Boolean).length;
};
