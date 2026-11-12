import { createHash } from "node:crypto";
import { type FSWatcher, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import { assignConfig, CONFIG_FILE_KEYS, type DoriConfig, loadConfig } from "./config.ts";

/*
 * Config hot reload. `watchConfigFiles` notices edits to a set of files (a directory watch per file, debounced, plus a
 * periodic stat check for filesystems where watching misses events) and calls one reload at a time. `configReloader` is
 * the supervisor's reload of config.json: it validates the whole file first, applies the keys that can change live in
 * place, and reports the rest as needing a restart. An invalid file changes nothing.
 */

/** Edits closer together than this are one reload (an editor's write-and-rename, a burst of saves). */
export const CONFIG_DEBOUNCE_MS = 500;
/** The fallback check: a changed mtime, size or inode is noticed within this long even when no watch event arrives. */
export const CONFIG_POLL_MS = 30_000;

export type ConfigWatchOptions = {
  readonly debounceMs?: number;
  readonly pollMs?: number;
  readonly log?: (line: string) => void;
};

/** `mtime:size:inode` of `path`, or `absent`. */
const signature = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "absent";
  }
};

/**
 * Calls `reload` after any of `paths` changes, never two at once: a change during a reload runs one more reload after it.
 * A reload that throws is logged `CONFIG_WATCH_ERROR`. Returns the stop function.
 */
export const watchConfigFiles = (paths: readonly string[], reload: () => Promise<unknown>, options: ConfigWatchOptions = {}): (() => void) => {
  const log = options.log ?? ((line: string) => { console.error(line); });
  const debounceMs = options.debounceMs ?? CONFIG_DEBOUNCE_MS;
  let seen = paths.map(signature);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  const runReload = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        seen = paths.map(signature);
        try { await reload(); }
        catch (e) { log(`CONFIG_WATCH_ERROR ${e instanceof Error ? e.message : String(e)}`); }
      } while (again && !stopped);
    } finally { running = false; }
  };
  const schedule = (): void => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void runReload(); }, debounceMs);
    timer.unref?.();
  };
  // The directory is watched, not the file: editors and atomic writers replace the file, which ends a file watch.
  const watchers: FSWatcher[] = [];
  for (const dir of new Set(paths.map((path) => dirname(path)))) {
    const names = new Set(paths.filter((path) => dirname(path) === dir).map((path) => basename(path)));
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => { if (!name || names.has(String(name))) schedule(); });
      watcher.on("error", (e) => { log(`CONFIG_WATCH_FALLBACK ${dir}: ${e instanceof Error ? e.message : String(e)}; checking every ${Math.round((options.pollMs ?? CONFIG_POLL_MS) / 1_000)} s`); });
      watchers.push(watcher);
    } catch (e) {
      log(`CONFIG_WATCH_FALLBACK ${dir}: ${e instanceof Error ? e.message : String(e)}; checking every ${Math.round((options.pollMs ?? CONFIG_POLL_MS) / 1_000)} s`);
    }
  }
  const poll = setInterval(() => {
    if (paths.map(signature).some((s, i) => s !== seen[i])) schedule();
  }, options.pollMs ?? CONFIG_POLL_MS);
  poll.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
    for (const watcher of watchers) watcher.close();
  };
};

/** Makes `target` equal to `next` key by key (keys `next` lacks are deleted), so every holder of `target` sees `next`. */
export const replaceInPlace = <T extends object>(target: T, next: T): void => {
  const t = target as Record<string, unknown>;
  for (const key of Object.keys(t)) if (!(key in next)) delete t[key];
  Object.assign(t, next);
};

/**
 * config.json keys the running supervisor cannot take without a restart: the Discord application (the gateway and the
 * slash commands are registered with it at startup), where its state lives, and the button hooks its slash command
 * handler was built with. `DORI_DISCORD_TOKEN` is not a config key: it is read once at
 * startup, so a new token also needs a restart. Every other config.json key is read where it is used, so it applies live.
 */
export const RESTART_CONFIG_KEYS: readonly string[] = ["discord", "stateDir", "buttonHooks"];

const strings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * What loadConfig accepts but a running supervisor must not take: a wrong type for a key it reads live. Startup
 * defaults these by spreading the file, so a reload checks them itself. Undefined when the config is usable.
 */
export const configReloadError = (c: DoriConfig): string | undefined => {
  for (const key of ["discordChannels", "githubIssueAuthors", "ignorePanes", "leadArgs"] as const) {
    if (!strings(c[key])) return `${key} must be an array of strings`;
  }
  if (!strings(c.agentCommand) || c.agentCommand.length === 0) return "agentCommand must be a non-empty array of strings";
  for (const key of ["defaultModel", "leadCwd", "worktreeRoot", "ciMergeBase"] as const) {
    if (typeof c[key] !== "string") return `${key} must be a string`;
  }
  for (const key of ["alertsChannel", "decisionsChannel"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "string") return `${key} must be a string`;
  }
  if (!c.defaultModel.trim()) return "defaultModel must not be empty";
  if (!c.ciMergeBase.trim()) return "ciMergeBase must not be empty";
  for (const [name, argv] of Object.entries(c.hooks ?? {})) if (argv !== undefined && !strings(argv)) return `hooks.${name} must be an array of strings`;
  return undefined;
};

export type ConfigReload =
  | { readonly state: "invalid"; readonly detail: string }
  | { readonly state: "applied"; readonly live: readonly string[]; readonly restart: readonly string[] };

export type ConfigReloaderDeps = {
  readonly path: string;
  /** The config in use now (one of the objects `apply` updates). */
  readonly current: () => DoriConfig;
  /** Applies the changed live keys in place to every config object the supervisor holds. */
  readonly apply: (patch: Partial<DoriConfig>) => void;
  /** Journals one lead event (digest by default: these kinds are not urgent). */
  readonly enqueue: (id: string, line: string) => void;
  readonly log: (line: string) => void;
  readonly load?: (path: string) => Promise<DoriConfig>;
};

/**
 * One reload of config.json: read and validate the whole file; on failure keep everything and report
 * `CONFIG_RELOAD_INVALID`. Otherwise apply the changed live keys in place (`CONFIG_RELOADED <keys>`) and report changed
 * restart-only keys as `CONFIG_RELOAD_RESTART_NEEDED <keys>` (their running values stay). Each line is logged and
 * journaled for the lead under an id derived from the file content, so the same content is reported once.
 */
export const configReloader = (deps: ConfigReloaderDeps) => async (): Promise<ConfigReload> => {
  let text: string;
  try { text = await Bun.file(deps.path).text(); }
  catch { text = ""; }
  const tag = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const invalid = (detail: string): ConfigReload => {
    const line = `CONFIG_RELOAD_INVALID ${deps.path}: ${detail}; the supervisor keeps the last good config`;
    deps.log(line);
    deps.enqueue(`config-reload-invalid:${tag}`, line);
    return { state: "invalid", detail };
  };
  // A missing file would load as the defaults (no channels, no Discord app): treat it as a broken edit, not a reset.
  if (!text.trim()) return invalid("the file is missing or empty");
  let next: DoriConfig;
  try { next = await (deps.load ?? loadConfig)(deps.path); }
  catch (e) { return invalid(e instanceof Error ? e.message : String(e)); }
  const problem = configReloadError(next);
  if (problem) return invalid(problem);
  const current = deps.current();
  const changed = CONFIG_FILE_KEYS.filter((key) => !Bun.deepEquals(current[key], next[key]));
  const live = changed.filter((key) => !RESTART_CONFIG_KEYS.includes(key));
  const restart = changed.filter((key) => RESTART_CONFIG_KEYS.includes(key));
  if (live.length) {
    deps.apply(Object.fromEntries(live.map((key) => [key, next[key]])) as Partial<DoriConfig>);
    const line = `CONFIG_RELOADED ${live.join(", ")} from ${deps.path}`;
    deps.log(line);
    deps.enqueue(`config-reloaded:${tag}`, line);
  }
  if (restart.length) {
    const line = `CONFIG_RELOAD_RESTART_NEEDED ${restart.join(", ")} changed in ${deps.path}; the running supervisor keeps the old values until it restarts (systemctl --user restart dori-supervisor)`;
    deps.log(line);
    deps.enqueue(`config-reload-restart:${tag}`, line);
  }
  return { state: "applied", live, restart };
};

/** Applies `patch` to each distinct config object in `targets`. */
export const applyConfigPatch = (targets: readonly DoriConfig[], patch: Partial<DoriConfig>): void => {
  for (const target of new Set(targets)) assignConfig(target, patch);
};
