import type { Runner } from "./run.ts";

export const SUPERVISOR_UNIT = "dori-supervisor.service";
const ACTIVE_POLLS = 10;
const ACTIVE_POLL_MS = 1_000;

export type UpdateDeps = {
  readonly run: Runner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** Re-installs outdated remote guard agents; returns the failure count (logged by the callee, never changes the exit code). */
  readonly refreshGuardAgents?: () => Promise<number>;
  /**
   * Upgrades the runners one at a time once the restarted supervisor is active (runner/upgrade.ts); returns the failure
   * count, which is logged by the callee and never changes the exit code.
   */
  readonly upgradeRunners?: () => Promise<number>;
  /** Installs the template over an outdated lane sandbox (lane-sandbox-install.ts); returns the line to log, if any. */
  readonly refreshLaneSandbox?: () => string | undefined;
};
export type UpdateOptions = {
  readonly packageDir: string;
  readonly branch: "main" | "dev";
  readonly force: boolean;
};

class UpdateStop extends Error {}

/**
 * Updates the install checkout that holds `packageDir` to `origin/<branch>` (fast-forward only), keeping local changes
 * through a stash, runs `bun install` when the package manifest or lockfile changed, re-resolves the unpinned pi-quota
 * dependency to its newest commit, and restarts the supervisor when HEAD or pi-quota moved (or `force`). Returns the exit
 * code; every outcome is logged as one line.
 */
export const updateInstall = async (d: UpdateDeps, o: UpdateOptions): Promise<number> => {
  const git = async (args: readonly string[], cwd = root): Promise<string> => {
    const r = await d.run(["git", ...args], { cwd, timeoutMs: 120_000 });
    if (r.code !== 0) throw new UpdateStop(`UPDATE_FAILED git ${args.join(" ")}: ${(r.err || r.out).split("\n")[0]}`);
    return r.out;
  };
  let root = o.packageDir;
  const refreshAgents = async (): Promise<void> => {
    if (!d.refreshGuardAgents) return;
    try { await d.refreshGuardAgents(); } catch (e) { d.log(`WARN guard agents: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const refreshSandbox = (): void => {
    if (!d.refreshLaneSandbox) return;
    try { const line = d.refreshLaneSandbox(); if (line) d.log(line); } catch (e) { d.log(`WARN lane sandbox: ${e instanceof Error ? e.message : String(e)}`); }
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
    }
    // pi-quota is not pinned: re-resolve it on every run so its newest commit installs even when this checkout did not
    // move. A lockfile that was clean is put back afterwards, so later fast-forwards never carry it through a stash.
    const lockHash = () => git(["hash-object", "bun.lock"], o.packageDir);
    const lockClean = (await git(["status", "--porcelain", "--", "bun.lock"], o.packageDir)) === "";
    const lockBefore = await lockHash();
    const refresh = await d.run(["bun", "update", "pi-quota"], { cwd: o.packageDir, timeoutMs: 600_000 });
    const quotaMoved = refresh.code === 0 && (await lockHash()) !== lockBefore;
    if (lockClean) await git(["checkout", "-q", "--", "bun.lock"], o.packageDir);
    if (refresh.code !== 0) d.log(`WARN bun update pi-quota: ${(refresh.err || refresh.out).split("\n").at(-1)}`);
    else if (quotaMoved) d.log(`PI_QUOTA_UPDATED ${o.packageDir}`);
    if (now === old && !quotaMoved && !o.force) {
      d.log(`UP_TO_DATE ${o.branch} ${short(now)}`);
      refreshSandbox();
      await refreshAgents();
      return 0;
    }
    refreshSandbox();
    // Agents first: the restarted supervisor then samples the new agents instead of reporting the old ones OUTDATED.
    await refreshAgents();
    const restart = await d.run(["systemctl", "--user", "restart", SUPERVISOR_UNIT], { timeoutMs: 120_000 });
    if (restart.code !== 0) d.log(`WARN systemctl restart ${SUPERVISOR_UNIT}: ${(restart.err || restart.out).split("\n")[0]}`);
    let state = "unknown";
    for (let i = 0; i < ACTIVE_POLLS; i++) {
      state = (await d.run(["systemctl", "--user", "is-active", SUPERVISOR_UNIT], { timeoutMs: 10_000 })).out || "unknown";
      if (state !== "activating" && state !== "reloading") break;
      await d.sleep(ACTIVE_POLL_MS);
    }
    d.log(`UPDATED ${o.branch} ${short(old)}..${short(now)} supervisor=${state}`);
    if (state !== "active") return 1;
    if (d.upgradeRunners) {
      try { await d.upgradeRunners(); } catch (e) { d.log(`WARN runners: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return 0;
  } catch (e) {
    if (!(e instanceof UpdateStop)) throw e;
    d.log(e.message);
    return 1;
  }
};
