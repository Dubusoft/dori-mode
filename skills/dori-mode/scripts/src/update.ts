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
