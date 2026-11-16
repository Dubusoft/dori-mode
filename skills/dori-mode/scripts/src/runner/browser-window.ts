import type { Clock, Runner } from "../run.ts";

/**
 * Keeps a BrowserSkill browser connected on a macOS runner host. The extension connects bsk only while at least one
 * Chrome window is open in its profile, and closing the last window drops the connection at once, so a lane that finds
 * `bsk browsers` empty would otherwise stop and ask the owner to open Chrome. Before each lane starts, the runner (outside
 * the lane sandbox) checks once: no browser connected opens a plain new-tab window with `open -b <bundle>` and waits up
 * to `BSK_RECHECK_MS` for bsk to see it. Still none with no Chrome extension process at all means Chrome's profile or the
 * extension is the problem (a signed-out Chrome user), which only the owner can fix; that is logged, and the lane's own
 * footer rule asks. Between lane starts a watch (`browserWatch`) runs the same check once no browser has connected for a
 * few minutes. Chrome is never killed, scripted (osascript) or opened with a URL.
 */

export const CHROME_BUNDLE = "com.google.Chrome";
export const BSK_RECHECK_MS = 10_000;
export const BSK_RECHECK_STEP_MS = 1_000;
/** What `bsk browsers` prints when the daemon runs but no extension is connected. */
export const BSK_NO_BROWSERS = "no browsers connected";

export type BrowserWindowDeps = {
  readonly run: Runner;
  readonly clock: Pick<Clock, "sleep">;
  readonly log: (line: string) => void;
};

type BrowserCount = "connected" | "none" | { readonly unavailable: string };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const browsers = async (run: Runner): Promise<BrowserCount> => {
  const ran = await run(["bsk", "browsers"], { timeoutMs: 15_000 });
  if (ran.code !== 0) return { unavailable: oneLine(ran.err || ran.out) || `exit ${ran.code}` };
  return `${ran.out}\n${ran.err}`.includes(BSK_NO_BROWSERS) ? "none" : "connected";
};

const extensionProcesses = async (run: Runner): Promise<number> => {
  const ran = await run(["pgrep", "-f", "--", "--extension-process"], { timeoutMs: 5_000 });
  return ran.code === 0 ? ran.out.split("\n").filter((line) => line.trim() !== "").length : 0;
};

export const ensureBrowserWindow = async (deps: BrowserWindowDeps, key: string): Promise<void> => {
  const first = await browsers(deps.run);
  if (first === "connected") return deps.log(`RUNNER_BSK_OK lane=${key} browsers connected`);
  if (first !== "none") return deps.log(`RUNNER_BSK_UNAVAILABLE lane=${key} ${first.unavailable}`);
  const opened = await deps.run(["open", "-b", CHROME_BUNDLE], { timeoutMs: 15_000 });
  if (opened.code !== 0) return deps.log(`RUNNER_BSK_OPEN_FAILED lane=${key} open -b ${CHROME_BUNDLE} exit ${opened.code}: ${oneLine(opened.err || opened.out)}`);
  for (let waited = 0; waited < BSK_RECHECK_MS; waited += BSK_RECHECK_STEP_MS) {
    await deps.clock.sleep(BSK_RECHECK_STEP_MS);
    if (await browsers(deps.run) === "connected") return deps.log(`RUNNER_BSK_WINDOW_OPENED lane=${key} bsk connected after opening a Chrome window`);
  }
  const extensions = await extensionProcesses(deps.run);
  deps.log(extensions === 0
    ? `RUNNER_BSK_PROFILE_PROBLEM lane=${key} no browser after opening a Chrome window and no Chrome extension process; check the Chrome sign-in and the BrowserSkill extension`
    : `RUNNER_BSK_STILL_NONE lane=${key} no browser ${BSK_RECHECK_MS / 1000}s after opening a Chrome window (${extensions} extension processes)`);
};

/** How often the runner's watch asks `bsk browsers` between lane starts. */
export const BSK_WATCH_EVERY_MS = 60_000;
export const BSK_WATCH_DEFAULT_MINUTES = 5;
export const BSK_WATCH_DEFAULT_COOLDOWN_MINUTES = 30;

export type BrowserWatchSettings = {
  /** No browser this long opens a Chrome window; 0 turns the watch off. */
  readonly graceMs: number;
  /** At least this long between two windows the watch opens. */
  readonly cooldownMs: number;
  /** Settings that were not understood (their defaults apply), for the log. */
  readonly ignored: readonly string[];
};

/**
 * The watch's settings from the runner's environment: `DORI_BSK_WATCH_MINUTES` (default 5, `0` turns it off) and
 * `DORI_BSK_WATCH_COOLDOWN_MINUTES` (default 30), each a whole number of minutes.
 */
export const browserWatchSettings = (env: Readonly<Record<string, string | undefined>>): BrowserWatchSettings => {
  const ignored: string[] = [];
  const minutes = (name: string, fallback: number): number => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return fallback;
    if (/^\d+$/.test(raw)) return Number(raw);
    ignored.push(`${name}=${JSON.stringify(raw)} ignored: want whole minutes, using ${fallback}`);
    return fallback;
  };
  return {
    graceMs: minutes("DORI_BSK_WATCH_MINUTES", BSK_WATCH_DEFAULT_MINUTES) * 60_000,
    cooldownMs: minutes("DORI_BSK_WATCH_COOLDOWN_MINUTES", BSK_WATCH_DEFAULT_COOLDOWN_MINUTES) * 60_000,
    ignored,
  };
};

export type BrowserWatchDeps = {
  readonly run: Runner;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** The shared window check (`browserWindowCheck`), so a watch and a lane start never open two windows. */
  readonly check: (key: string) => Promise<void>;
};

/**
 * The runner's watch between lane starts: Chrome can run for many minutes with its extension not connected (it closes
 * the link whenever it stops the extension's worker), and a lane that starts then finds `bsk browsers` empty. Each tick
 * asks `bsk browsers`; once no browser has been connected for `graceMs`, it runs the same window check a lane start
 * runs, at most once per `cooldownMs`. A bsk that does not answer neither starts nor ends the count. Only state changes
 * and checks are logged.
 */
export const browserWatch = (deps: BrowserWatchDeps, settings: BrowserWatchSettings): (() => Promise<void>) => {
  let noneSince: number | undefined;
  let lastCheck: number | undefined;
  let unavailable = false;
  let busy = false;
  const tick = async (): Promise<void> => {
    const seen = await browsers(deps.run);
    if (typeof seen === "object") {
      if (!unavailable) deps.log(`RUNNER_BSK_WATCH_UNAVAILABLE ${seen.unavailable}`);
      unavailable = true;
      return;
    }
    unavailable = false;
    const now = deps.now();
    if (seen === "connected") {
      if (noneSince !== undefined) deps.log(`RUNNER_BSK_WATCH_RECONNECTED after ${Math.round((now - noneSince) / 1000)}s without a browser`);
      noneSince = undefined;
      return;
    }
    if (noneSince === undefined) {
      noneSince = now;
      return deps.log(`RUNNER_BSK_WATCH_NONE no browser connected; a Chrome window opens if none connects within ${settings.graceMs / 60_000}m`);
    }
    if (now - noneSince < settings.graceMs) return;
    if (lastCheck !== undefined && now - lastCheck < settings.cooldownMs) return;
    lastCheck = now;
    deps.log(`RUNNER_BSK_WATCH_OPEN no browser for ${Math.round((now - noneSince) / 60_000)}m; running the window check (next at most every ${settings.cooldownMs / 60_000}m)`);
    await deps.check("watch");
  };
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (error) {
      deps.log(`RUNNER_BSK_WATCH_FAILED ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  };
};

/**
 * The lane-start hook for a host: the check on macOS, nothing elsewhere. Starts that overlap share one check, so two
 * lanes starting together open at most one window.
 */
export const browserWindowCheck = (os: string, deps: BrowserWindowDeps): ((key: string) => Promise<void>) | undefined => {
  if (os !== "darwin") return undefined;
  let running: Promise<void> | undefined;
  return (key) => running ??= ensureBrowserWindow(deps, key)
    .catch((error: unknown) => { deps.log(`RUNNER_BSK_CHECK_FAILED lane=${key} ${error instanceof Error ? error.message : String(error)}`); })
    .finally(() => { running = undefined; });
};
