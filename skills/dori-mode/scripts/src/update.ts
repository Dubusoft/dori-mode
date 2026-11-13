import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";

export const SUPERVISOR_UNIT = "dori-supervisor.service";
const ACTIVE_POLLS = 10;
const ACTIVE_POLL_MS = 1_000;

export type UpdateDeps = {
  readonly run: Runner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /**
   * Migrates the workers once the restarted supervisor is active: removes the old standalone guard agent files from every
   * worker machine, then upgrades the runners one at a time (runner/upgrade.ts). It also runs when the checkout was
   * already up to date so a rollout an earlier update left unfinished is retried (runners on the current version are
   * skipped). It must run in a fresh process from the updated checkout: this one still holds the modules it loaded
   * before the pull, which may refer to files the pull removed. Returns its exit code; a nonzero one is listed as failed
   * in the summary and makes the update exit 2.
   */
  readonly upgradeRunners?: () => Promise<number>;
  /**
   * Migrates config.json (`dori setup --migrate`): removes keys it no longer reads and asks only keys never shown before.
   * Runs on UP_TO_DATE and, before the supervisor restart, on UPDATED. Like `upgradeRunners` it must run in a fresh process
   * from the updated checkout. Returns its exit code and the stdout it printed: the `SETUP_KEY_*` lines become the summary's
   * key changes and missing keys, and a nonzero code (2: required keys missing) makes the update exit 2.
   */
  readonly migrateConfig?: () => Promise<{ readonly code: number; readonly output: string }>;
  /** Installs the template over an outdated lane sandbox (lane-sandbox-install.ts); returns the line to log, if any. */
  readonly refreshLaneSandbox?: () => string | undefined;
  /** Installs the template over an outdated supervisor boot-prep script (boot-prep-install.ts); returns the line to log, if any. */
  readonly refreshBootPrep?: () => string | undefined;
};
export type UpdateOptions = {
  readonly packageDir: string;
  readonly branch: "main" | "dev";
  readonly force: boolean;
};

class UpdateStop extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const KEY_CHANGE = /^SETUP_KEY_(REMOVED|SET|UNSET) (\S+)/;
const KEY_PROBLEM = /^SETUP_KEY_(MISSING|INVALID) (\S+)/;

/**
 * Updates the install checkout that holds `packageDir` to `origin/<branch>` (fast-forward only), keeping local changes
 * through a stash, runs `bun install` when the package manifest or lockfile changed, re-resolves the unpinned pi-quota
 * dependency to its newest commit, and restarts the supervisor when HEAD or pi-quota moved (or `force`). Every outcome is
 * logged as one line; a finished run ends with `UPDATE_SUMMARY changed: ...; failed: ...`. Returns 1 when the update
 * stopped or the restarted supervisor is not active, 2 when it finished but a step failed (config migrate degraded, a
 * runner upgrade, a refresh, the restart command or pi-quota), else 0. A failed step never blocks the restart.
 */
export const updateInstall = async (d: UpdateDeps, o: UpdateOptions): Promise<number> => {
  const git = async (args: readonly string[], cwd = root): Promise<string> => {
    const r = await d.run(["git", ...args], { cwd, timeoutMs: 120_000 });
    if (r.code !== 0) throw new UpdateStop(`UPDATE_FAILED git ${args.join(" ")}: ${(r.err || r.out).split("\n")[0]}`);
    return r.out;
  };
  let root = o.packageDir;
  const changed: string[] = [];
  const failed: string[] = [];
  /** Logs the closing summary and returns the exit code for a finished run (`code` 1 when the supervisor is not active). */
  const finish = (code: number): number => {
    d.log(`UPDATE_SUMMARY changed: ${changed.join(", ") || "none"}; failed: ${failed.join(", ") || "none"}`);
    return code || (failed.length ? 2 : 0);
  };
  const refreshSandbox = (): void => {
    if (!d.refreshLaneSandbox) return;
    try { const line = d.refreshLaneSandbox(); if (line) { d.log(line); changed.push("lane sandbox"); } } catch (e) { d.log(`WARN lane sandbox: ${message(e)}`); failed.push("lane sandbox"); }
  };
  const refreshBootPrep = (): void => {
    if (!d.refreshBootPrep) return;
    try { const line = d.refreshBootPrep(); if (line) { d.log(line); changed.push("boot prep"); } } catch (e) { d.log(`WARN boot prep: ${message(e)}`); failed.push("boot prep"); }
  };
  const upgradeRunners = async (): Promise<void> => {
    if (!d.upgradeRunners) return;
    try { const code = await d.upgradeRunners(); if (code !== 0) failed.push(`runners exit ${code}`); } catch (e) { d.log(`WARN runners: ${message(e)}`); failed.push("runners"); }
  };
  const migrateConfig = async (): Promise<void> => {
    if (!d.migrateConfig) return;
    try {
      const r = await d.migrateConfig();
      const problems: string[] = [];
      for (const line of r.output.split("\n")) {
        const c = KEY_CHANGE.exec(line);
        if (c) changed.push(`config ${c[2]} ${c[1]!.toLowerCase()}`);
        const p = KEY_PROBLEM.exec(line);
        if (p) problems.push(`${p[2]} ${p[1]!.toLowerCase()}`);
      }
      if (r.code !== 0) failed.push(`config migrate exit ${r.code}${problems.length ? ` (${problems.join(", ")})` : ""}`);
    } catch (e) { d.log(`WARN config migrate: ${message(e)}`); failed.push("config migrate"); }
  };
  try {
    root = await git(["rev-parse", "--show-toplevel"], o.packageDir);
    await git(["fetch", "-q", "origin", o.branch]);
    const from = await git(["branch", "--show-current"]);
    const old = await git(["rev-parse", "HEAD"]);
    const stash = (await git(["status", "--porcelain", "--untracked-files=no"])) === "" ? undefined
      : (await git(["stash", "push", "-q", "-m", "dori-update"]), await git(["rev-parse", "stash@{0}"]));
    /** Puts the checkout back on the branch it was on with its local changes, then stops with `message`. */
    const abort = async (message: string): Promise<never> => {
      if ((await git(["rev-parse", "HEAD"])) !== old || (await git(["branch", "--show-current"])) !== from) await git(["checkout", "-q", from || old]);
      if (stash) await git(["stash", "pop", "-q"]);
      throw new UpdateStop(message);
    };
    if (from !== o.branch) {
      const r = await d.run(["git", "checkout", "-q", o.branch], { cwd: root });
      if (r.code !== 0) await abort(`UPDATE_FAILED cannot check out ${o.branch}: ${(r.err || r.out).split("\n")[0]}`);
      d.log(`BRANCH_SWITCH ${from || "(detached)"} -> ${o.branch}`);
    }
    const ff = await d.run(["git", "merge", "-q", "--ff-only", `origin/${o.branch}`], { cwd: root });
    if (ff.code !== 0) await abort(`UPDATE_NOT_FAST_FORWARD ${o.branch} has local commits not on origin/${o.branch}; nothing changed, reconcile it by hand in ${root}`);
    if (stash) {
      const pop = await d.run(["git", "stash", "pop", "-q"], { cwd: root });
      if (pop.code !== 0) {
        throw new UpdateStop(`UPDATE_STASH_CONFLICT local changes did not reapply on ${o.branch}; the stash is kept as ${stash.slice(0, 12)} (git stash list); resolve in ${root}; supervisor not restarted`);
      }
    }
    const now = await git(["rev-parse", "HEAD"]);
    const short = (sha: string) => sha.slice(0, 7);
    if (now !== old && (await git(["diff", "--name-only", old, now, "--", "package.json", "bun.lock"], o.packageDir)) !== "") {
      const install = await d.run(["bun", "install", "--frozen-lockfile"], { cwd: o.packageDir, timeoutMs: 600_000 });
      if (install.code !== 0) throw new UpdateStop(`UPDATE_FAILED bun install: ${(install.err || install.out).split("\n").at(-1)}; supervisor not restarted`);
      d.log(`DEPENDENCIES_INSTALLED ${o.packageDir}`);
      changed.push("dependencies");
    }
    if (now !== old) changed.unshift(`checkout ${short(old)}..${short(now)}`);
    // pi-quota is not pinned: re-resolve it on every run so its newest commit installs even when this checkout did not
    // move. A lockfile that was clean is put back afterwards, so later fast-forwards never carry it through a stash.
    const lockHash = () => git(["hash-object", "bun.lock"], o.packageDir);
    const lockClean = (await git(["status", "--porcelain", "--", "bun.lock"], o.packageDir)) === "";
    const lockBefore = await lockHash();
    const refresh = await d.run(["bun", "update", "pi-quota"], { cwd: o.packageDir, timeoutMs: 600_000 });
    const quotaMoved = refresh.code === 0 && (await lockHash()) !== lockBefore;
    if (lockClean) await git(["checkout", "-q", "--", "bun.lock"], o.packageDir);
    if (refresh.code !== 0) { d.log(`WARN bun update pi-quota: ${(refresh.err || refresh.out).split("\n").at(-1)}`); failed.push("pi-quota"); }
    else if (quotaMoved) { d.log(`PI_QUOTA_UPDATED ${o.packageDir}`); changed.push("pi-quota"); }
    if (now === old && !quotaMoved && !o.force) {
      d.log(`UP_TO_DATE ${o.branch} ${short(now)}`);
      refreshSandbox();
      refreshBootPrep();
      await migrateConfig();
      await upgradeRunners();
      return finish(0);
    }
    refreshSandbox();
    refreshBootPrep();
    await migrateConfig();
    const restart = await d.run(["systemctl", "--user", "restart", SUPERVISOR_UNIT], { timeoutMs: 120_000 });
    if (restart.code !== 0) { d.log(`WARN systemctl restart ${SUPERVISOR_UNIT}: ${(restart.err || restart.out).split("\n")[0]}`); failed.push("supervisor restart"); }
    let state = "unknown";
    for (let i = 0; i < ACTIVE_POLLS; i++) {
      state = (await d.run(["systemctl", "--user", "is-active", SUPERVISOR_UNIT], { timeoutMs: 10_000 })).out || "unknown";
      if (state !== "activating" && state !== "reloading") break;
      await d.sleep(ACTIVE_POLL_MS);
    }
    d.log(`UPDATED ${o.branch} ${short(old)}..${short(now)} supervisor=${state}`);
    if (state !== "active") { failed.push(`supervisor=${state}`); return finish(1); }
    changed.push("supervisor restarted");
    await upgradeRunners();
    return finish(0);
  } catch (e) {
    if (!(e instanceof UpdateStop)) throw e;
    d.log(e.message);
    return 1;
  }
};

/**
 * Automatic `dori update --dev` after the supervisor merges a PR of dori's own repo into dev. The merge only records
 * itself (noteDevMerge, a list in <stateDir>/auto-update.json, so merges in a row become one run); the supervisor's
 * auto-update sweep (AutoUpdate.tick) starts the update once no lane of dori's repo is working or waiting on its claim.
 * The update restarts the supervisor, so it never runs inline: it runs as the transient user unit dori-auto-update
 * (`systemd-run --user`), outside the supervisor's cgroup, and writes its exit code and log lines to
 * <stateDir>/auto-update-result.json. The supervisor that reads that file (usually the restarted one) reports it: digest
 * AUTO_UPDATE_DONE on exit 0, urgent AUTO_UPDATE_FAILED on anything else, a unit that could not start, or one that ended
 * without a result.
 */
export const AUTO_UPDATE_UNIT = "dori-auto-update";
export const AUTO_UPDATE_STATE = "auto-update.json";
export const AUTO_UPDATE_RESULT = "auto-update-result.json";
/** The environment the unit gets from the supervisor (systemd's user manager has its own, which may lack these). */
export const AUTO_UPDATE_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DORI_CONFIG", "DORI_STATE_DIR"] as const;
const UNIT_RUNNING = new Set(["active", "activating", "deactivating", "reloading"]);

export type AutoUpdateState = {
  /** Merges (`owner/repo#N`) not yet covered by a started update. */
  readonly pending?: readonly string[];
  /** The update started for these merges, still waiting for its result. */
  readonly running?: { readonly at: number; readonly merges: readonly string[] };
};
export type UpdateResult = { readonly at: number; readonly code: number; readonly lines: readonly string[] };

const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
};
const writeJson = (path: string, value: unknown): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
};

export const readAutoUpdateState = (stateDir: string): AutoUpdateState => readJson<AutoUpdateState>(join(stateDir, AUTO_UPDATE_STATE)) ?? {};

/** Records a merge into dev of dori's own repo; the next auto-update run covers it (once, however many are recorded). */
export const noteDevMerge = (stateDir: string, ref: string): void => {
  const state = readAutoUpdateState(stateDir);
  const pending = state.pending ?? [];
  if (!pending.includes(ref)) writeJson(join(stateDir, AUTO_UPDATE_STATE), { ...state, pending: [...pending, ref] });
};

/** What `dori update --result <path>` leaves for the supervisor: its exit code and every line it logged. */
export const writeUpdateResult = (path: string, result: UpdateResult): void => writeJson(path, result);

/** `owner/repo` (lowercased) of a GitHub remote URL, else undefined. */
export const githubRepoOf = (remote: string): string | undefined =>
  /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1]?.toLowerCase();

/** dori's own repo: the GitHub origin of the checkout holding `packageDir`; undefined when it has none. */
export const doriRepoOf = async (run: Runner, packageDir: string): Promise<string | undefined> => {
  const r = await run(["git", "remote", "get-url", "origin"], { cwd: packageDir, timeoutMs: 10_000 });
  return r.code === 0 ? githubRepoOf(r.out) : undefined;
};

export type AutoUpdateDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly now: () => number;
  /** The update command the unit runs, before `--result <path>` (e.g. bun, cli.ts, update, --dev). */
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Open lanes of dori's repo that are working or wait on their claim; the update waits while there is one. */
  readonly busy: () => Promise<readonly string[]>;
  readonly log: (line: string) => void;
};

const STOP_LINE = /^(UPDATE_FAILED|UPDATE_STASH_CONFLICT|UPDATE_NOT_FAST_FORWARD)\b/;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);

/** The line the lead gets for a finished run. */
export const autoUpdateLine = (result: UpdateResult, merges: readonly string[]): string => {
  const after = merges.length ? merges.join(", ") : "an earlier merge";
  const summary = result.lines.find((l) => l.startsWith("UPDATE_SUMMARY "));
  if (result.code === 0) {
    const head = result.lines.find((l) => l.startsWith("UPDATED ") || l.startsWith("UP_TO_DATE "));
    return oneLine(`AUTO_UPDATE_DONE after ${after}: ${[head, summary].filter(Boolean).join("; ") || "exit 0"}`);
  }
  const why = result.lines.find((l) => STOP_LINE.test(l)) ?? summary ?? result.lines.at(-1) ?? "no output";
  return oneLine(`AUTO_UPDATE_FAILED exit ${result.code} after ${after}: ${why}; log: journalctl --user -u ${AUTO_UPDATE_UNIT}; run dori update --dev by hand once fixed`);
};

/** The merges still pending once `covered` are taken by a run. */
const rest = (state: AutoUpdateState, covered: readonly string[]): readonly string[] => (state.pending ?? []).filter((ref) => !covered.includes(ref));

/** The supervisor's side of the automatic update; one per supervisor process. */
export class AutoUpdate {
  private deferred = "";

  constructor(private readonly d: AutoUpdateDeps) {}

  private get statePath(): string { return join(this.d.stateDir, AUTO_UPDATE_STATE); }
  private get resultPath(): string { return join(this.d.stateDir, AUTO_UPDATE_RESULT); }

  /** Rewrites the state from a fresh read: a merge noted while this tick awaited is kept. */
  private save(mutate: (state: AutoUpdateState) => AutoUpdateState): AutoUpdateState {
    const next = mutate(readAutoUpdateState(this.d.stateDir));
    writeJson(this.statePath, next);
    return next;
  }

  private async unitRunning(): Promise<boolean> {
    const r = await this.d.run(["systemctl", "--user", "is-active", AUTO_UPDATE_UNIT], { timeoutMs: 10_000 });
    return UNIT_RUNNING.has(r.out.trim());
  }

  /** Reports a result the unit left, if any, and forgets its run. Returns the state as it now stands. */
  private async report(state: AutoUpdateState, emit: (line: string, id: string) => Promise<void>): Promise<AutoUpdateState> {
    const result = readJson<UpdateResult>(this.resultPath);
    if (!result) return state;
    // Journaled before the files change: a crash in between re-emits the same id, which the journal dedupes.
    await emit(autoUpdateLine(result, state.running?.merges ?? []), `auto-update:${result.at}`);
    const next = this.save((s) => ({ pending: s.pending ?? [] }));
    rmSync(this.resultPath, { force: true });
    return next;
  }

  async tick(emit: (line: string, id: string) => Promise<void>): Promise<void> {
    const d = this.d;
    let state = await this.report(readAutoUpdateState(d.stateDir), emit);
    if (state.running) {
      if (await this.unitRunning()) return;
      // The unit may have written its result and exited since the first read.
      state = await this.report(state, emit);
      if (state.running) {
        await emit(`AUTO_UPDATE_FAILED after ${state.running.merges.join(", ")}: unit ${AUTO_UPDATE_UNIT} ended without a result; log: journalctl --user -u ${AUTO_UPDATE_UNIT}; run dori update --dev by hand`, `auto-update-lost:${state.running.at}`);
        state = this.save((s) => ({ pending: s.pending ?? [] }));
      }
    }
    const merges = state.pending ?? [];
    if (!merges.length) return;
    // A unit already running (started just before a crash that lost its record) covers these merges.
    if (await this.unitRunning()) {
      this.save((s) => ({ pending: rest(s, merges), running: { at: d.now(), merges } }));
      return;
    }
    const busy = await d.busy();
    if (busy.length) {
      const note = `AUTO_UPDATE_DEFERRED after ${merges.join(", ")}: lanes of dori's repo still open: ${busy.join(", ")}`;
      if (note !== this.deferred) d.log(note);
      this.deferred = note;
      return;
    }
    this.deferred = "";
    const env = AUTO_UPDATE_ENV.flatMap((name) => d.env[name] !== undefined ? [`--setenv=${name}=${d.env[name]}`] : []);
    const at = d.now();
    const started = await d.run([
      "systemd-run", "--user", "--unit", AUTO_UPDATE_UNIT, "--collect", "--quiet", ...env, "--", ...d.command, "--result", this.resultPath,
    ], { timeoutMs: 30_000 });
    if (started.code !== 0) {
      await emit(oneLine(`AUTO_UPDATE_FAILED after ${merges.join(", ")}: systemd-run exit ${started.code}: ${started.err || started.out}; run dori update --dev by hand`), `auto-update-start:${at}`);
      this.save((s) => ({ pending: rest(s, merges) }));
      return;
    }
    this.save((s) => ({ pending: rest(s, merges), running: { at, merges } }));
    d.log(`AUTO_UPDATE_STARTED unit=${AUTO_UPDATE_UNIT} after ${merges.join(", ")}`);
  }
}
