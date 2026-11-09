import { listPanes, readScreen, sendGuarded, statusLookup } from "../panes.ts";
import type { Clock, Runner } from "../run.ts";
import type { CommandResults, ExecutionOutcome, GoalOutcome, PauseStep, ProcessInfo, StartupVerdict } from "./protocol.ts";

/**
 * Runner-side lane control (design section 2.3, rows A6-A8, A28, A32, A33): the pause and resume sequences behind
 * `lane.pause` / `lane.resume`, the target-pane checks behind `lane.start.target`, the startup poll behind the
 * `lane.start` / `lane.recover` startup verdict, and the resume argv rule. Every function reads and types into panes of
 * the runner's own host through `run`; nothing here reads the supervisor's registry.
 *
 * Copied from pause.ts (goalCommand, stopTurn, isWorking), launch.ts (resolveTargetPane, inspectCreated, paneShell,
 * startup poll, startupFailure, screenLines, lastLines) and recover.ts (resumeCommand as `resumeArgv`); the supervisor
 * copies are deleted by later packages.
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
  await deps.run(["herdr", "pane", "send-keys", pane, "escape"]);
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
 * does not prove the lane runs: a held session (an aborted turn, a human wait) stays idle after it. When no turn starts,
 * one message is typed to release the hold, and the turn is read back again; still idle is `held`.
 */
export const resume = async (deps: ControlDeps, pane: string): Promise<CommandResults["lane.resume"]> => {
  const goal = await goalCommand(deps, pane, "/goal resume", RESUMED_SHOWN);
  if (goal !== "confirmed") return { goal };
  let execution: ExecutionOutcome = "running";
  if (!(await turnRuns(deps, pane))) {
    execution = (await sendGuarded(deps.run, pane, RESUME_TEXT)) === "sent" && (await turnRuns(deps, pane)) ? "running" : "held";
  }
  return { goal, execution };
};

// ---------------------------------------------------------------------------------------------------------------
// Target panes (lane.start.target) and freshly created panes
// ---------------------------------------------------------------------------------------------------------------

export type PaneShell = "posix" | "pwsh" | "powershell" | "cmd";

/**
 * The shell an idle pane runs, from herdr process-info: the foreground process that is the shell (or the only one).
 * Without a readable name, a drive-letter cwd (D:\...) means a Windows pane, whose default shell is PowerShell.
 */
export const paneShell = (info: ProcessInfo | undefined, cwd?: string): PaneShell => {
  const procs = info?.foreground_processes ?? [];
  const proc = procs.find((p) => p.pid !== undefined && p.pid === info?.shell_pid) ?? (procs.length === 1 ? procs[0] : undefined);
  const name = (proc?.name || proc?.argv?.[0] || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/^-/, "").replace(/\.exe$/, "") ?? "";
  if (name === "pwsh" || name === "powershell") return name;
  if (name === "cmd") return "cmd";
  if (name) return "posix";
  return cwd && /^[A-Za-z]:[\\/]/.test(cwd) ? "powershell" : "posix";
};

type PaneInfo = { readonly pane_id: string; readonly workspace_id: string; readonly tab_id?: string; readonly terminal_id?: string; readonly agent?: string; readonly cwd?: string; readonly foreground_cwd?: string };

export type TargetPane = { readonly pane: string; readonly tab?: string; readonly terminalId?: string; readonly cwd?: string; readonly shell: PaneShell; readonly shellPid?: number };

/** A target pane that cannot take the lane. `code`: `RUNNER_LANE_TARGET_BUSY` (an agent, a foreground process or another lane holds it) or `RUNNER_LANE_TARGET_INVALID`. */
export class TargetError extends Error {
  constructor(readonly code: "RUNNER_LANE_TARGET_BUSY" | "RUNNER_LANE_TARGET_INVALID", detail: string) {
    super(`${code} ${detail}`);
    this.name = "TargetError";
  }
}

const invalid = (detail: string): TargetError => new TargetError("RUNNER_LANE_TARGET_INVALID", detail);
const busy = (detail: string): TargetError => new TargetError("RUNNER_LANE_TARGET_BUSY", detail);

const parse = <T>(text: string, what: string): T => {
  try { return JSON.parse(text) as T; } catch { throw invalid(`${what}: unreadable herdr output`); }
};

export const cmdRefused = (pane: string): string => `pane ${pane} runs cmd.exe; start pwsh or powershell in it (or a POSIX shell) and launch again`;

export type TargetOptions = {
  /** The lane key that already owns `pane` on this host, if any (the runner's own lane records). */
  readonly ownerOf: (pane: string) => string | undefined;
  /** Refuse a cmd.exe pane (no lane footer form exists for it). */
  readonly refuseCmd: boolean;
  /** Restored tabs need positive proof that the shell owns the foreground process group. */
  readonly requireIdleProof?: boolean;
};

/**
 * The existing pane a lane may start in: `target.pane`, else the one shell pane of `target.workspace`. It must exist,
 * be an idle shell (no agent, no other foreground process) and belong to no lane. Throws `TargetError` before anything
 * is written.
 */
export const resolveTargetPane = async (run: Runner, target: { readonly pane?: string; readonly workspace?: string }, opts: TargetOptions): Promise<TargetPane> => {
  let id = target.pane;
  if (!id) {
    if (!target.workspace) throw invalid("no target pane or workspace");
    const list = await run(["herdr", "pane", "list"]);
    if (list.code !== 0) throw invalid(`herdr pane list failed: ${list.err || list.out}`);
    const inWs = parse<{ result: { panes: PaneInfo[] } }>(list.out, "herdr pane list").result.panes.filter((p) => p.workspace_id === target.workspace);
    if (!inWs.length) throw invalid(`workspace ${target.workspace} has no panes (or does not exist)`);
    const shells = inWs.filter((p) => !p.agent);
    if (shells.length !== 1) throw invalid(`workspace ${target.workspace} has ${shells.length} shell panes; pass a pane to pick one`);
    id = shells[0]?.pane_id;
  }
  if (!id) throw invalid("no target pane");
  const got = await run(["herdr", "pane", "get", id]);
  if (got.code !== 0) throw invalid(`pane ${id} does not exist on this host: ${got.err || got.out}`);
  const info = parse<{ result: { pane: PaneInfo } }>(got.out, `herdr pane get ${id}`).result.pane;
  if (target.workspace && info.workspace_id !== target.workspace) throw invalid(`pane ${id} is in workspace ${info.workspace_id}, not ${target.workspace}`);
  if (info.agent) throw busy(`pane ${id} runs an agent (${info.agent}); a lane needs an idle shell`);
  const proc = await run(["herdr", "pane", "process-info", "--pane", id]);
  if (proc.code !== 0) throw invalid(`cannot read the processes of pane ${id}: ${proc.err || proc.out}`);
  const p = parse<{ result: { process_info: ProcessInfo } }>(proc.out, `herdr pane process-info ${id}`).result.process_info;
  if (opts.requireIdleProof && (!p.shell_pid || p.foreground_process_group_id !== p.shell_pid
    || p.foreground_processes?.some((proc) => proc.pid !== p.shell_pid))) throw busy(`pane ${id} is not a proven idle shell`);
  if (p.foreground_process_group_id && p.foreground_process_group_id !== p.shell_pid) throw busy(`pane ${id} has a foreground process running; a lane needs an idle shell`);
  const owner = opts.ownerOf(id);
  if (owner) throw busy(`pane ${id} is already registered to lane ${owner}`);
  const cwd = info.foreground_cwd ?? info.cwd;
  const shell = paneShell(p, cwd);
  if (opts.refuseCmd && shell === "cmd") throw invalid(cmdRefused(id));
  return { pane: id, ...(info.tab_id ? { tab: info.tab_id } : {}), ...(info.terminal_id ? { terminalId: info.terminal_id } : {}), ...(cwd ? { cwd } : {}), shell, ...(p.shell_pid ? { shellPid: p.shell_pid } : {}) };
};

/** A freshly created pane: its shell and directory, read leniently (an unreadable answer means POSIX). */
export const inspectCreated = async (run: Runner, pane: string): Promise<{ readonly shell: PaneShell; readonly cwd?: string; readonly terminalId?: string; readonly shellPid?: number }> => {
  const got = await run(["herdr", "pane", "get", pane]);
  const proc = await run(["herdr", "pane", "process-info", "--pane", pane]);
  const read = <T>(text: string): T | undefined => { try { return JSON.parse(text) as T; } catch { return undefined; } };
  const info = got.code === 0 ? read<{ result?: { pane?: PaneInfo } }>(got.out)?.result?.pane : undefined;
  const p = proc.code === 0 ? read<{ result?: { process_info?: ProcessInfo } }>(proc.out)?.result?.process_info : undefined;
  const cwd = info?.foreground_cwd ?? info?.cwd;
  return { shell: paneShell(p, cwd), ...(cwd ? { cwd } : {}), ...(info?.terminal_id ? { terminalId: info.terminal_id } : {}), ...(p?.shell_pid ? { shellPid: p.shell_pid } : {}) };
};

// ---------------------------------------------------------------------------------------------------------------
// Startup confirmation
// ---------------------------------------------------------------------------------------------------------------

/** Startup confirmation: a check every 2 s, at most 10 times, and 2 consecutive ready reads. */
export const STARTUP_POLL_MS = 2_000;
export const STARTUP_POLLS = 10;
export const STARTUP_READY_READS = 2;
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
 * Polls a just-started agent: `ok` after STARTUP_READY_READS ready reads in a row (so one early idle blip is not a
 * start), `error` with the failure word as soon as a non-working screen shows one (an agent that printed "No API key"
 * and stopped at its prompt reads idle but never started), else `unconfirmed` with why and the last screen lines.
 */
export const startupPoll = async (deps: ControlDeps, pane: string): Promise<StartupVerdict> => {
  let screen = "";
  let status: string | undefined;
  let error: string | undefined;
  let ready = 0;
  for (let poll = 0; poll < STARTUP_POLLS; poll++) {
    await deps.clock.sleep(STARTUP_POLL_MS);
    ({ status, error } = await statusLookup(deps.run, pane));
    if (status === "working") { ready++; } else {
      screen = await readScreen(deps.run, pane, STARTUP_SCREEN_LINES);
      const bad = startupFailure(screen);
      if (bad) return { verdict: "error", detail: bad };
      ready = status === "idle" ? ready + 1 : 0;
    }
    if (ready >= STARTUP_READY_READS) return { verdict: "ok", detail: "ready" };
  }
  if (!screen) screen = await readScreen(deps.run, pane, STARTUP_SCREEN_LINES);
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { verdict: "unconfirmed", detail: `${why}; last lines: ${lastLines(screen)}` };
};

/** Whether `pane` is in herdr's pane list of this host (a list that cannot be read answers false). */
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
