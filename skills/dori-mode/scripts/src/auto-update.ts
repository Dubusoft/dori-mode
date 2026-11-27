import { rmSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readJsonState, replaceFileAtomic } from "./durable-write.ts";
import { githubRepoFromRemote } from "./git-remote.ts";
import type { Runner } from "./run.ts";
import type { EventMeta } from "./supervise-journal.ts";
import { oneLine } from "./line-text.ts";

/**
 * Automatic `dori update --dev` after the supervisor merges a PR of dori's own repo into dev. The merge only records
 * itself (noteDevMerge, a list in <stateDir>/auto-update.json, so merges in a row become one run); the supervisor's
 * auto-update sweep (AutoUpdate.tick) starts the update once no lane of dori's repo is working or waiting on its claim.
 * The update restarts the supervisor, so it never runs inline: it runs as the transient user unit dori-auto-update
 * (`systemd-run --user`), outside the supervisor's cgroup, and writes its exit code and log lines to
 * <stateDir>/auto-update-result.json. The supervisor that reads that file (usually the restarted one) reports it: digest
 * AUTO_UPDATE_DONE on exit 0, urgent AUTO_UPDATE_FAILED on anything else, a unit that could not start, or one that ended
 * without a result.
 * A lane that holds the update back for `staleAfterMs` (counted from the first tick it blocked, kept in the state file)
 * is handed to `staleBlocker` at most every STALE_RECHECK_MS: it closes the lane when that is safe, and otherwise its
 * line reaches the lead once per blocking stretch.
 */
export const AUTO_UPDATE_UNIT = "dori-auto-update";
export const AUTO_UPDATE_STATE = "auto-update.json";
export const AUTO_UPDATE_RESULT = "auto-update-result.json";
/** The environment the unit gets from the supervisor (systemd's user manager has its own, which may lack these). */
export const AUTO_UPDATE_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DORI_CONFIG", "DORI_STATE_DIR"] as const;
/**
 * The GitHub tokens the update's `git fetch` of the private repo authenticates with (through gh's credential helper),
 * when the supervisor has them. They go to systemd-run by name only, so it copies each value from its own environment
 * and no token appears in its argv.
 */
export const AUTO_UPDATE_TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const UNIT_RUNNING = new Set(["active", "activating", "deactivating", "reloading"]);
/** How often a stale blocker is checked again (its close conditions may come true later). */
export const STALE_RECHECK_MS = 10 * 60_000;

export type AutoUpdateEmit = (line: string, id: string, meta?: EventMeta) => Promise<void>;

export type AutoUpdateState = {
  /** Merges (`owner/repo#N`) not yet covered by a started update. */
  readonly pending?: readonly string[];
  /** The update started for these merges, still waiting for its result. */
  readonly running?: { readonly at: number; readonly merges: readonly string[] };
  /** Lanes holding the pending merges back: since when, and whether the lead was told. A started update clears it. */
  readonly blocked?: Readonly<Record<string, { readonly since: number; readonly escalated?: true }>>;
};
export type UpdateResult = { readonly at: number; readonly code: number; readonly lines: readonly string[] };

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isState = (v: unknown): v is AutoUpdateState =>
  isRecord(v) &&
  (v.pending === undefined || isStrings(v.pending)) &&
  (v.running === undefined || (isRecord(v.running) && typeof v.running.at === "number" && isStrings(v.running.merges))) &&
  (v.blocked === undefined || (isRecord(v.blocked) && Object.values(v.blocked).every((b) => isRecord(b) && typeof b.since === "number")));
const isResult = (v: unknown): v is UpdateResult =>
  isRecord(v) && typeof v.at === "number" && typeof v.code === "number" && isStrings(v.lines);
const writeJson = (path: string, value: unknown): void => {
  replaceFileAtomic(path, `${JSON.stringify(value)}\n`, 0o666);
};

/** A corrupt state file is moved aside and read as empty: merges it held wait for the next noted one. */
export const readAutoUpdateState = (stateDir: string): AutoUpdateState =>
  readJsonState(join(stateDir, AUTO_UPDATE_STATE), "AUTO_UPDATE_STATE", isState, "no pending or running update") ?? {};

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
  githubRepoFromRemote(remote);

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
  /** How long a lane may hold the update back before `staleBlocker` is asked about it. */
  readonly staleAfterMs: number;
  /** Closes a stale blocker when that is safe (update-blocker.ts); otherwise returns the line for the lead. */
  readonly staleBlocker: (key: string, since: number, emit: AutoUpdateEmit) => Promise<{ readonly closed: true } | { readonly closed: false; readonly line: string }>;
};

const STOP_LINE = /^(UPDATE_FAILED|UPDATE_STASH_CONFLICT|UPDATE_NOT_FAST_FORWARD)\b/;

/** The line the lead gets for a finished run. */
export const autoUpdateLine = (result: UpdateResult, merges: readonly string[]): string => {
  const after = merges.length ? merges.join(", ") : "an earlier merge";
  const summary = result.lines.find((l) => l.startsWith("UPDATE_SUMMARY "));
  if (result.code === 0) {
    const head = result.lines.find((l) => l.startsWith("UPDATED ") || l.startsWith("UP_TO_DATE "));
    return oneLine(`AUTO_UPDATE_DONE after ${after}: ${[head, summary].filter(Boolean).join("; ") || "exit 0"}`, 300);
  }
  const why = result.lines.find((l) => STOP_LINE.test(l)) ?? summary ?? result.lines.at(-1) ?? "no output";
  return oneLine(`AUTO_UPDATE_FAILED exit ${result.code} after ${after}: ${why}; log: journalctl --user -u ${AUTO_UPDATE_UNIT}; run dori update --dev by hand once fixed`, 300);
};

/** The merges still pending once `covered` are taken by a run. */
const rest = (state: AutoUpdateState, covered: readonly string[]): readonly string[] => (state.pending ?? []).filter((ref) => !covered.includes(ref));

/** The supervisor's side of the automatic update; one per supervisor process. */
export class AutoUpdate {
  private deferred = "";
  private readonly checkedAt = new Map<string, number>();

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

  /** Records since when each lane in `busy` blocks, then hands the stale ones to staleBlocker; the lead hears of each once. */
  private async staleBlockers(busy: readonly string[], emit: AutoUpdateEmit): Promise<void> {
    const now = this.d.now();
    const current = readAutoUpdateState(this.d.stateDir);
    const blocked = Object.fromEntries(busy.map((key) => [key, current.blocked?.[key] ?? { since: now }]));
    if (JSON.stringify(blocked) !== JSON.stringify(current.blocked ?? {})) this.save((s) => ({ ...s, blocked }));
    for (const key of this.checkedAt.keys()) if (!busy.includes(key)) this.checkedAt.delete(key);
    for (const key of busy) {
      const entry = blocked[key]!;
      if (now - entry.since < this.d.staleAfterMs || now - (this.checkedAt.get(key) ?? -Infinity) < STALE_RECHECK_MS) continue;
      this.checkedAt.set(key, now);
      const verdict = await this.d.staleBlocker(key, entry.since, emit);
      if (verdict.closed || entry.escalated) continue;
      await emit(verdict.line, `auto-update-blocker:${key}:${entry.since}`);
      this.save((s) => (s.blocked?.[key]?.since === entry.since ? { ...s, blocked: { ...s.blocked, [key]: { since: entry.since, escalated: true } } } : s));
    }
  }

  /** Reports a result the unit left, if any, and forgets its run. Returns the state as it now stands. */
  private async report(state: AutoUpdateState, emit: AutoUpdateEmit): Promise<AutoUpdateState> {
    // A corrupt result is moved aside; a run waiting on it then ends as AUTO_UPDATE_FAILED without a result.
    const result = readJsonState(this.resultPath, "AUTO_UPDATE_RESULT", isResult, "no update result");
    if (!result) return state;
    // Journaled before the files change: a crash in between re-emits the same id, which the journal dedupes.
    await emit(autoUpdateLine(result, state.running?.merges ?? []), `auto-update:${result.at}`);
    const next = this.save((s) => ({ pending: s.pending ?? [] }));
    rmSync(this.resultPath, { force: true });
    return next;
  }

  async tick(emit: AutoUpdateEmit): Promise<void> {
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
      await this.staleBlockers(busy, emit);
      return;
    }
    this.deferred = "";
    const env = [
      ...AUTO_UPDATE_ENV.flatMap((name) => d.env[name] !== undefined ? [`--setenv=${name}=${d.env[name]}`] : []),
      ...AUTO_UPDATE_TOKEN_ENV.flatMap((name) => d.env[name] ? [`--setenv=${name}`] : []),
    ];
    const at = d.now();
    const started = await d.run([
      "systemd-run", "--user", "--unit", AUTO_UPDATE_UNIT, "--collect", "--quiet", ...env, "--", ...d.command, "--result", this.resultPath,
    ], { timeoutMs: 30_000 });
    if (started.code !== 0) {
      await emit(oneLine(`AUTO_UPDATE_FAILED after ${merges.join(", ")}: systemd-run exit ${started.code}: ${started.err || started.out}; run dori update --dev by hand`, 300), `auto-update-start:${at}`);
      this.save((s) => ({ pending: rest(s, merges) }));
      return;
    }
    this.save((s) => ({ pending: rest(s, merges), running: { at, merges } }));
    d.log(`AUTO_UPDATE_STARTED unit=${AUTO_UPDATE_UNIT} after ${merges.join(", ")}`);
  }
}
