import { listPanes, readScreen, sendGuarded, statusLookup } from "../panes.ts";
import { RUN_KILL_GRACE_MS, RUN_TIMEOUT_CODE, type Clock, type Runner } from "../run.ts";
import { sessionRuntime } from "../runtime/index.ts";
import type { CommandResults, ExecutionOutcome, GoalOutcome, PauseStep, StartupVerdict } from "./protocol.ts";

/**
 * Runner-side lane control (design section 2.3, rows A6-A8, A28, A32, A33): the pause and resume sequences behind
 * `lane.pause` / `lane.resume`, the startup poll behind the
 * `lane.start` / `lane.recover` startup verdict, and the resume argv rule. Every function reads and types into panes of
 * the runner's own host through `run`; nothing here reads the supervisor's registry.
 *
 * The lead's recovery path also uses `resumeArgv`.
 */

export type ControlDeps = { readonly run: Runner; readonly clock: Clock };

// What the goal command prints (senpi goal/command-registration.ts): its new status, or that there is no goal,
// in which case nothing can auto-continue either.
// Whole lines only, so a lane's own output that merely mentions them does not count. omo prints the no-goal
// reply with an "Error: " prefix (issue #23); only that reply may carry it.
export const PAUSED_SHOWN = /^\s*(?:Goal paused|(?:Error:\s*)?cannot update goal: no goal exists)\s*$/gm;
export const RESUMED_SHOWN = /^\s*(?:Goal active|(?:Error:\s*)?cannot update goal: no goal exists)\s*$/gm;
export const READ_BACK_TRIES = 8;
export const READ_BACK_MS = 700;
/** How many screen lines a goal command read-back compares. */
const GOAL_SCREEN_LINES = 200;

const count = (screen: string, shown: RegExp): number => screen.match(shown)?.length ?? 0;

/** Sends a goal command and confirms it from the screen: one more matching line than before it was sent. */
export const goalCommand = async (deps: ControlDeps, pane: string, text: string, shown: RegExp): Promise<GoalOutcome> => {
  const before = count(await readScreen(deps.run, pane, GOAL_SCREEN_LINES), shown);
  if ((await sendGuarded(deps.run, pane, text)) === "failed") return "failed";
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (count(await readScreen(deps.run, pane, GOAL_SCREEN_LINES), shown) > before) return "confirmed";
    await deps.clock.sleep(READ_BACK_MS);
  }
  return "unconfirmed";
};

/**
 * Escape, then reads the pane back until its turn has stopped. A paused lane can still be woken (a background result,
 * a monitor event, a queued message), so stopping is confirmed, never assumed; a failed status lookup confirms nothing.
 */
export const stopTurn = async (deps: ControlDeps, pane: string): Promise<boolean> => {
  await sessionRuntime(deps.run).key(pane, "escape");
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    const after = await statusLookup(deps.run, pane);
    if (!after.error && after.status !== "working") return true;
    await deps.clock.sleep(READ_BACK_MS);
  }
  return false;
};

export const isWorking = async (deps: ControlDeps, pane: string): Promise<boolean> => (await statusLookup(deps.run, pane)).status === "working";

/**
 * The `lane.pause` sequence on `pane`. `goal`: `/goal pause`, confirmed from the screen. `stop`: whether a turn was
 * running and, if so, whether Escape stopped it (an idle pane counts as stopped). `both` (the default): the goal first,
 * so stopping the turn cannot hand off to a goal continuation; a goal not confirmed ends the sequence before the stop.
 */
export const pause = async (deps: ControlDeps, pane: string, step: PauseStep = "both"): Promise<CommandResults["lane.pause"]> => {
  let goal: GoalOutcome | undefined;
  if (step !== "stop") {
    goal = await goalCommand(deps, pane, "/goal pause", PAUSED_SHOWN);
    if (step === "goal" || goal !== "confirmed") return { goal };
  }
  const working = await isWorking(deps, pane);
  const stopped = !working || (await stopTurn(deps, pane));
  return { ...(goal ? { goal } : {}), working, stopped };
};

/**
 * omo's footer on a session whose turn Escape cut ("Paused · N updates held · type to continue, /resume to resume"),
 * the same footer supervise-lead-lifecycle.ts `PAUSED` reads on the lead.
 */
export const ESC_PAUSED = /\bPaused\b.*\/resume\b/;

/** Typed into a lane whose turn did not start after `/goal resume`: a message releases a held session. */
export const RESUME_TEXT = "dori resume: this lane is resumed. Continue your lane work.";

const turnRuns = async (deps: ControlDeps, pane: string): Promise<boolean> => {
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (await isWorking(deps, pane)) return true;
    await deps.clock.sleep(READ_BACK_MS);
  }
  return false;
};

/**
 * The `lane.resume` sequence: `/goal resume`, confirmed from the screen, then a turn read back. An active goal alone
 * does not prove the lane runs: a held session (an aborted turn, a human wait) stays idle after it. A session whose
 * turn the pause cut with Escape shows omo's paused footer and gets `/resume`, which continues that turn; a session
 * without the footer (no turn was cut) gets none. When still no turn starts, one message is typed to release the hold,
 * and the turn is read back again; still idle is `held`.
 */
export const resume = async (deps: ControlDeps, pane: string): Promise<CommandResults["lane.resume"]> => {
  const goal = await goalCommand(deps, pane, "/goal resume", RESUMED_SHOWN);
  if (goal !== "confirmed") return { goal };
  let execution: ExecutionOutcome = "running";
  if (ESC_PAUSED.test(await readScreen(deps.run, pane))) await sendGuarded(deps.run, pane, "/resume");
  if (!(await turnRuns(deps, pane))) {
    execution = (await sendGuarded(deps.run, pane, RESUME_TEXT)) === "sent" && (await turnRuns(deps, pane)) ? "running" : "held";
  }
  return { goal, execution };
};

// ---------------------------------------------------------------------------------------------------------------
// Startup confirmation
// ---------------------------------------------------------------------------------------------------------------

/** Leave 45 s of the 90 s lane.start/recover reply budget for setup and reply delivery. */
export const STARTUP_BUDGET_MS = 45_000;
export const STARTUP_POLL_MS = 2_000;
export const STARTUP_POLLS = Math.floor(STARTUP_BUDGET_MS / STARTUP_POLL_MS);
export const STARTUP_READY_READS = 2;
const STARTUP_PROCESS_PROBE_MS = 5_000;
/** How many screen lines a startup check scans. */
export const STARTUP_SCREEN_LINES = 40;

const FAILURE_WORDS = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;
/** Without an "Error:" prefix a failure must be the start of the line, never a word inside prose. */
const FAILURE_LINE = /^(?:Cannot find module|All fallback models failed|No API key|model_not_available|unknown provider|Session crashed|(?:you(?:'ve| have) (?:hit|reached|exceeded) (?:your |the )?)?(?:(?:usage|rate) limit|quota)\s+(?:reached|exceeded|hit|exhausted|error))/i;
const LEAD_IN = /^[\s│|>•*✗✖×!⚠❌-]*/;

/**
 * The screen lines that can carry an agent's own message, with their box/bullet lead-in removed. Tips, recalled-memory
 * and Kibitzer blocks (until a blank line or the closing tag) and echoes of a lane brief are left out.
 */
export function* screenLines(screen: string): Generator<string> {
  let skipping: "tip" | "memory" | undefined;
  for (const raw of screen.split("\n")) {
    const line = raw.replace(LEAD_IN, "");
    if (!line.trim()) { skipping = undefined; continue; }
    if (/^Tip:|^Want the full story on any tip/i.test(line)) { skipping = "tip"; continue; }
    if (/<recalled-memory|Kibitzer/i.test(raw)) skipping = "memory";
    if (/<\/recalled-memory>/i.test(raw)) { skipping = undefined; continue; }
    if (skipping) continue;
    if (/lane brief at /i.test(raw)) continue;
    yield line;
  }
}

/**
 * The first real startup failure on a pane screen, or undefined. Tips, recalled-memory/Kibitzer
 * blocks and echoes of the launch prompt are skipped, and bare words only count after "Error:".
 */
export const startupFailure = (screen: string): string | undefined => {
  for (const line of screenLines(screen)) {
    const error = /^(?:error|fatal)\b[:\s-]*/i.exec(line);
    const hit = error ? FAILURE_WORDS.exec(line.slice(error[0].length)) : FAILURE_LINE.exec(line);
    if (hit) return hit[0];
  }
  return undefined;
};

/** The last three non-blank screen lines, home paths masked, at most 240 characters. */
export const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

/**
 * Polls a just-started agent, scanning non-working screens for startup errors. A process probe marks a fresh
 * argv-prompt launch: require evidence of work, and use process ownership only to explain an unconfirmed start.
 */
export const startupPoll = async (deps: ControlDeps, pane: string, processAlive?: (run: Runner) => Promise<boolean>): Promise<StartupVerdict> => {
  const deadline = deps.clock.now() + STARTUP_BUDGET_MS;
  let until = deadline - (processAlive ? STARTUP_PROCESS_PROBE_MS : 0);
  const remaining = () => until - deps.clock.now();
  const run: Runner = async (argv) => {
    const timeoutMs = remaining() - RUN_KILL_GRACE_MS;
    if (timeoutMs <= 0) return { code: RUN_TIMEOUT_CODE, out: "", err: "startup confirmation budget exhausted", timedOut: true };
    return deps.run(argv, { timeoutMs });
  };
  let screen = "";
  let status: string | undefined;
  let error: string | undefined;
  let ready = 0;
  let sawWorking = false;
  for (let poll = 0; poll < STARTUP_POLLS && remaining() > RUN_KILL_GRACE_MS; poll++) {
    await deps.clock.sleep(Math.min(STARTUP_POLL_MS, remaining() - RUN_KILL_GRACE_MS));
    if (remaining() <= RUN_KILL_GRACE_MS) break;
    ({ status, error } = await statusLookup(run, pane));
    if (status === "working") sawWorking = true;
    else if (remaining() > RUN_KILL_GRACE_MS) {
      const lines = await readScreen(run, pane, STARTUP_SCREEN_LINES);
      if (lines) screen = lines;
      const bad = startupFailure(screen);
      if (bad) return { verdict: "error", detail: bad };
    }
    ready = status === "working" || status === "idle" ? ready + 1 : 0;
    if (ready >= STARTUP_READY_READS && (!processAlive || sawWorking)) {
      return { verdict: "ok", detail: "ready" };
    }
  }
  until = deadline;
  // An idle or unreported process may still be loading; never infer that its argv prompt was lost.
  const alive = !sawWorking && processAlive && remaining() > RUN_KILL_GRACE_MS
    && await processAlive(run).catch(() => false);
  if (!screen && remaining() > RUN_KILL_GRACE_MS) screen = await readScreen(run, pane, STARTUP_SCREEN_LINES);
  const why = alive ? `agent process is alive but was never observed working (${status ?? "none"}); inspect the pane before sending the start prompt manually`
    : processAlive && !sawWorking && status === "idle" ? "no working status for the start prompt (idle)"
    : error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { verdict: "unconfirmed", detail: `${why}; last lines: ${lastLines(screen)}` };
};

/** Whether `pane` is in hc's pane list of this host (a list that cannot be read answers false). */
export const paneListed = async (run: Runner, pane: string): Promise<boolean> => {
  try { return (await listPanes(run)).some((p) => p.pane_id === pane); } catch { return false; }
};

// ---------------------------------------------------------------------------------------------------------------
// Session resume
// ---------------------------------------------------------------------------------------------------------------

/** omo's flag that continues an existing session file or id (`omo --session <path|id>`). */
export const RESUME_FLAG = "--session";

/**
 * The agent argv that resumes `session` instead of starting fresh: `--session <id>` before the prompt. Undefined when
 * it cannot (no {prompt} slot, the template already picks a session, or an id that is not a plain token).
 */
export const resumeArgv = (template: readonly string[], session: string | undefined): string[] | undefined => {
  if (!session || !/^[\w.:/-]+$/.test(session) || session.startsWith("-")) return undefined;
  if (template.some((part) => /^--(?:session|session-id|resume|continue|fork)(?:=|$)|^-[rc]$/.test(part))) return undefined;
  const at = template.findIndex((part) => part.includes("{prompt}"));
  return at < 1 ? undefined : [...template.slice(0, at), RESUME_FLAG, session, ...template.slice(at)];
};
