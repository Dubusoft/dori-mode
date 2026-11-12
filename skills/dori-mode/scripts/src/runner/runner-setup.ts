// The engine of `dori runner setup`: prunes runner-config.json of keys parsePolicy no longer reads, applies
// `--set`/`--unset`, asks the rest (config-keys.ts), validates with parsePolicy and writes the file back. The file IO is
// injected, local (`~/.dori/runner`) or over ssh (a POSIX sh script on stdin, or an encoded PowerShell command).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configureKeys, pruneRunnerConfig, readSeenKeys, RUNNER_CONFIG_KEYS, RUNNER_UNASKED_KEYS, runnerConfigDefault, writeSeenKeys, type Json, type KeyPrompter } from "../config-keys.ts";
import { encodedPowerShell, sshArgv, type GuardMachine } from "../remote-guard.ts";
import type { Ran, Runner } from "../run.ts";
import { writeFileAtomic } from "../setup.ts";
import { RUNNER_FILE_MODE } from "./fs-safety.ts";
import { parsePolicy, POLICY_FILE } from "./policy.ts";

/**
 * `read`: undefined when the file is absent. `write`: atomic, 0600. `backup`: `runner-config.json.bak`, 0600.
 * `platform`: the runner host's, whose path rules judge the file's paths; absent: this process's (the local runner).
 */
export type RunnerConfigIO = {
  readonly where: string;
  readonly platform?: NodeJS.Platform;
  readonly read: () => Promise<string | undefined>;
  readonly write: (text: string) => Promise<void>;
  readonly backup: (text: string) => Promise<void>;
};

export const localRunnerConfigIO = (runnerDir: string): RunnerConfigIO => {
  const path = join(runnerDir, POLICY_FILE);
  return {
    where: path,
    read: async () => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    write: async (text) => writeFileAtomic(path, text, RUNNER_FILE_MODE),
    backup: async (text) => writeFileAtomic(`${path}.bak`, text, RUNNER_FILE_MODE),
  };
};

/** The line a remote read prints instead of the file when runner-config.json is missing. */
export const REMOTE_ABSENT = "DORI_RUNNER_CONFIG_ABSENT";
const REMOTE_TIMEOUT_MS = 30_000;

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** POSIX sh: print the file, or the absent sentinel. */
export const posixReadScript = (): string => [
  `f="$HOME/.dori/runner/${POLICY_FILE}"`,
  `if [ -f "$f" ]; then cat "$f"; else echo ${REMOTE_ABSENT}; fi`,
  "",
].join("\n");

/** POSIX sh: write `text` (base64 in the script, never raw) to `~/.dori/runner/<name>` through a 0600 tmp file and mv. */
export const posixWriteScript = (name: string, text: string): string => [
  "set -e",
  "umask 077",
  'd="$HOME/.dori/runner"',
  'mkdir -p "$d"',
  'chmod 700 "$d"',
  `f="$d/${name}"`,
  't="$f.tmp.$$"',
  `b='${b64(text)}'`,
  // GNU/busybox decode with -d; an older macOS base64 only takes -D.
  `printf '%s\\n' "$b" | base64 -d > "$t" 2>/dev/null || printf '%s\\n' "$b" | base64 -D > "$t"`,
  'chmod 600 "$t"',
  'mv -f "$t" "$f"',
  "",
].join("\n");

const WIN_DIR = "$d = Join-Path $env:USERPROFILE '.dori\\runner'";

/** PowerShell: `DORI_RUNNER_CONFIG <base64>` (no console encoding in the way), or the absent sentinel. */
export const windowsReadScript = (): string => [
  "$ErrorActionPreference = 'Stop'",
  WIN_DIR,
  `$f = Join-Path $d '${POLICY_FILE}'`,
  `if (Test-Path -LiteralPath $f) { Write-Output ('DORI_RUNNER_CONFIG ' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($f))) } else { Write-Output '${REMOTE_ABSENT}' }`,
].join("\n");

/** PowerShell: write `text` (base64 in the command) to `%USERPROFILE%\.dori\runner\<name>` through a tmp file and Move-Item. */
export const windowsWriteScript = (name: string, text: string): string => [
  "$ErrorActionPreference = 'Stop'",
  WIN_DIR,
  "New-Item -ItemType Directory -Force -Path $d | Out-Null",
  `$f = Join-Path $d '${name}'`,
  `[IO.File]::WriteAllBytes($f + '.tmp', [Convert]::FromBase64String('${b64(text)}'))`,
  "Move-Item -LiteralPath ($f + '.tmp') -Destination $f -Force",
].join("\n");

const remoteDetail = (r: Ran): string =>
  r.err.trim().split("\n").filter((line) => line.trim() && !/^(#< CLIXML|<Objs )/.test(line.trim())).at(-1)?.trim() || `exit ${r.code}`;

export const remoteRunnerConfigIO = (run: Runner, machine: GuardMachine, kind: "posix" | "windows"): RunnerConfigIO => {
  const exec = async (script: string): Promise<string> => {
    const r = kind === "windows"
      ? await run(sshArgv(machine.target, encodedPowerShell(script)), { timeoutMs: REMOTE_TIMEOUT_MS })
      : await run(sshArgv(machine.target, "sh -s"), { stdin: script, timeoutMs: REMOTE_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`RUNNER_SETUP_REMOTE_FAILED ${machine.label}: ${remoteDetail(r)}`);
    return r.out;
  };
  const windows = kind === "windows";
  return {
    where: `${machine.label}:${windows ? "%USERPROFILE%\\.dori\\runner\\" : "~/.dori/runner/"}${POLICY_FILE}`,
    // Any POSIX runner (Linux or macOS) shares one set of path rules.
    platform: windows ? "win32" : "linux",
    read: async () => {
      const out = await exec(windows ? windowsReadScript() : posixReadScript());
      if (out.trim() === REMOTE_ABSENT) return undefined;
      if (!windows) return out;
      const encoded = /^DORI_RUNNER_CONFIG (\S*)$/m.exec(out)?.[1];
      if (encoded === undefined) throw new Error(`RUNNER_SETUP_REMOTE_FAILED ${machine.label}: unexpected read output`);
      return Buffer.from(encoded, "base64").toString("utf8");
    },
    write: async (text) => { await exec(windows ? windowsWriteScript(POLICY_FILE, text) : posixWriteScript(POLICY_FILE, text)); },
    backup: async (text) => { await exec(windows ? windowsWriteScript(`${POLICY_FILE}.bak`, text) : posixWriteScript(`${POLICY_FILE}.bak`, text)); },
  };
};

export type RunnerSetupDeps = {
  readonly io: RunnerConfigIO;
  readonly prompt: KeyPrompter;
  readonly interactive: boolean;
  readonly log: (line: string) => void;
  readonly seenPath: string;
  readonly mode: "full" | "new";
  readonly home?: string;
  /**
   * A worker runner without the file runs the empty default policy (no agents, no roots), so an absent file there is a
   * missing config (exit 2), not a skip. The local runner derives its policy from the supervisor config instead.
   */
  readonly requireFile?: boolean;
};

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Exit 0 done (or skipped: no file, nothing to set, not interactive), 1 failed (bad JSON, or a result parsePolicy
 * refuses; nothing written), 2 written or unchanged but required keys are still missing, or no file while `requireFile`.
 * IO errors propagate.
 */
export const runRunnerSetup = async (d: RunnerSetupDeps, input: { readonly patch: Json; readonly unset: readonly string[] }): Promise<number> => {
  const old = await d.io.read();
  let raw: Json = {};
  if (old !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(old);
    } catch (e) {
      d.log(`RUNNER_SETUP_FAILED ${d.io.where} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it by hand`);
      return 1;
    }
    if (!isRecord(parsed)) {
      d.log(`RUNNER_SETUP_FAILED ${d.io.where} is not valid JSON (not an object); fix it by hand`);
      return 1;
    }
    raw = parsed;
  } else if (Object.keys(input.patch).length === 0 && !d.interactive) {
    if (d.requireFile) {
      d.log(`RUNNER_SETUP_FILE_MISSING no ${POLICY_FILE} at ${d.io.where} (the runner has no agents and no allowedRoots)`);
      return 2;
    }
    d.log(`RUNNER_SETUP_SKIPPED no ${POLICY_FILE} at ${d.io.where}`);
    return 0;
  }
  const pruned = pruneRunnerConfig(raw);
  const seen = readSeenKeys(d.seenPath);
  const configured = await configureKeys({
    specs: RUNNER_CONFIG_KEYS, current: pruned.next, patch: input.patch, unset: input.unset,
    prompt: d.prompt, interactive: d.interactive, seen, mode: d.mode, skip: RUNNER_UNASKED_KEYS, defaults: runnerConfigDefault(d.home, d.io.platform), log: d.log,
  });
  const { next } = configured;
  try {
    parsePolicy(next, d.home, undefined, d.io.platform ? { platform: d.io.platform } : {});
  } catch (e) {
    d.log(`RUNNER_SETUP_FAILED invalid runner-config: ${e instanceof Error ? e.message : String(e)}; nothing was written`);
    return 1;
  }
  if (old !== undefined && pruned.removed.length) {
    await d.io.backup(old);
    for (const key of pruned.removed) d.log(`RUNNER_SETUP_KEY_REMOVED ${key} (${POLICY_FILE} no longer reads it)`);
  }
  // An absent file stays absent while nothing was set: the local runner keeps its derived policy.
  if (JSON.stringify(next) !== JSON.stringify(raw)) {
    await d.io.write(`${JSON.stringify(next, null, 2)}\n`);
    d.log(`RUNNER_SETUP_WRITTEN ${d.io.where}`);
  } else {
    d.log(`RUNNER_SETUP_UNCHANGED ${d.io.where}`);
  }
  if (d.interactive) writeSeenKeys(d.seenPath, [...seen, ...configured.shown]);
  for (const key of configured.missingRequired) d.log(`RUNNER_SETUP_KEY_MISSING ${key} [required]`);
  return configured.missingRequired.length ? 2 : 0;
};
