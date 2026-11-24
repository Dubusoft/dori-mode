import type { Clock, Runner } from "../run.ts";
import { oneLine } from "../line-text.ts";

/**
 * Keeps a BrowserSkill browser connected on a macOS runner host. The extension connects bsk only while at least one
 * Chrome window is open in its profile, and closing the last window drops the connection at once, so a lane that finds
 * `bsk browsers` empty would otherwise stop and ask the owner to open Chrome. Before each lane starts, the runner (outside
 * the lane sandbox) checks once: no browser connected opens a plain new-tab window with `open -b <bundle>` and waits up
 * to `BSK_RECHECK_MS` for bsk to see it. Still none with no Chrome extension process at all means Chrome's profile or the
 * extension is the problem (a signed-out Chrome user), which only the owner can fix; that is logged, and the lane's own
 * footer rule asks. Chrome is never killed, scripted (osascript) or opened with a URL.
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
