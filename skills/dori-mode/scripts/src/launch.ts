import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { languageInstruction } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaneOpsError, machineRunner, type StartInput } from "./lane-ops.ts";
import { ensureLaneWorkspace, ManagedPanesError } from "./managed-panes.ts";
import { LANE_KEY, type Lane, type LaneMode } from "./registry.ts";
import { iso } from "./run.ts";
import { herdrDownSince } from "./runner/herdr-down.ts";
import { cmdRefused, paneShell } from "./runner/lane-control.ts";
import type { StartupVerdict } from "./runner/protocol.ts";
import { doneSyntaxErrors, parseSignal, splitDone } from "./signals.ts";
import { normalizeThreadRef } from "./messenger/target.ts";
import { acquireStateLock } from "./state-lock.ts";
import { threadIdOf } from "./thread-finality.ts";
import type { ToodoStart } from "./toodo-start.ts";

// The startup check and the pane-shell reader run inside the runner's lane.start now; re-exported for their callers.
export { paneShell, type PaneShell, screenLines, startupFailure, STARTUP_POLL_MS, STARTUP_POLLS, STARTUP_READY_READS } from "./runner/lane-control.ts";

/** Return the follow-up instruction when startup did not succeed. */
export function launchNextLine(key: string, startup: string): string | undefined {
  return startup.startsWith("STARTUP_OK")
    ? undefined
    : `LAUNCH_NEXT the lane is registered; cancel it with dori close ${key} --cancelled --reason TEXT before relaunching`;
}

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  /** Opening keywords: `ulw` (default, `launchKeywords`) or `mass-ulw` (`massLaunchKeywords`). */
  readonly mode?: LaneMode;
  readonly cwd?: string;
  /** Run the lane in this existing idle shell pane instead of creating a tab. */
  readonly pane?: string;
  /** Run the lane in this workspace's idle shell pane (the only one without an agent). */
  readonly workspace?: string;
  readonly machine?: string;
  /** A Toodo start_task response: run in its first shell pane, found again through its herdr workspace, else a new tab. */
  readonly toodo?: ToodoStart;
  /** Allow a second open lane on the same messenger thread (`--share-thread`); the lanes are recorded in `threadSharedWith`. */
  readonly shareThread?: boolean;
  /** Allow a cwd whose git remotes name none of the Done line's repos (`--allow-repo-mismatch`). */
  readonly allowRepoMismatch?: boolean;
  /** Wrap the agent in `laneSandbox.command` even where the sandbox would pass the lane through (`--sandbox`, or a relaunch of a lane recorded as sandboxed). */
  readonly sandbox?: true;
  /** Resume this agent session (recovery): the runner inserts `--session <id>` when its profile allows. */
  readonly session?: string;
};

/** A lane launched with --share-thread: the keys of the other open lanes on its thread at launch time. */
export type SharedThreadLane = Lane & { readonly threadSharedWith?: readonly string[] };

export class LaunchError extends Error {}

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  // Refused before any placement check or runner call: the runner could not open a tab there anyway.
  const herdrDown = input.machine ? herdrDownSince(deps.config.stateDir).get(machineRunner(input.machine)) : undefined;
  if (input.machine && herdrDown !== undefined) {
    throw new LaunchError(`HERDR_DOWN machine=${input.machine.replace(/\s/g, "_")} herdr there has been unreadable since ${new Date(herdrDown).toISOString()}; launch there once it reads again (HERDR_UP), or pick another machine`);
  }
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  if (input.mode === "mass-ulw") {
    // omo binds mass-ulw only when the message starts with /mass-ulw and has no "?" after it.
    const keywords: unknown = deps.config.massLaunchKeywords;
    if (typeof keywords !== "string" || !keywords.startsWith("/mass-ulw") || keywords.includes("?") || input.brief.includes("?")) throw new LaunchError("massLaunchKeywords must start with /mass-ulw and the prompt (keywords and brief path) must contain no '?'");
  }
  const unbindable = sandboxedCwdInDoriHome(deps, input);
  if (unbindable) throw new LaunchError(`--cwd ${input.cwd} is inside ${unbindable}, which the lane sandbox cannot bind; put the worktree outside it (e.g. under ${dirname(deps.config.defaultCwd)})`);
  const sharing = await threadSharers(deps, input);
  if (sharing.length && !input.shareThread) throw new LaunchError(`thread ${input.thread} already has open lane ${sharing.join(", ")}; one thread per lane, or pass --share-thread`);
};

const within = (dir: string, parent: string): boolean => { const r = relative(parent, dir); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };

/**
 * The dori home (~/.dori) when a sandboxed local launch's --cwd is inside it: lane-sandbox mounts a read-only tmpfs there and
 * binds only <home>/.dori/state read-write, so any other directory under it cannot be bound as the lane's cwd.
 */
const sandboxedCwdInDoriHome = (deps: FlowDeps, input: LaunchInput): string | undefined => {
  if (!input.cwd || !sandboxChoice(deps.config, input, deps.which ?? Bun.which).on) return undefined;
  const state = resolve(deps.config.stateDir);
  const home = basename(state) === "state" && basename(dirname(state)) === ".dori" ? dirname(state) : join(homedir(), ".dori"); // the sandbox always uses $HOME/.dori
  const cwd = resolve(input.cwd);
  return within(cwd, home) && !within(cwd, state) ? home : undefined;
};

/** Open lanes on the input's thread, by thread id: `discord:<thread>` and `discord:<channel>/<thread>` are the same thread. */
const threadSharers = async (deps: FlowDeps, input: LaunchInput): Promise<string[]> =>
  !input.thread || input.thread === "none" ? [] : (await deps.registry.open()).filter((l) => l.key !== input.key && l.thread !== "none" && threadIdOf(l.thread) === threadIdOf(input.thread ?? "")).map((l) => l.key);

/** owner/repo names in the Done line's merged/closed signals, lowercased. */
export const doneRepos = (done: string): string[] => [...new Set(splitDone(done).flatMap((part) => {
  try { const s = parseSignal(part); return s.kind === "merged" || s.kind === "closed" ? [s.repo.toLowerCase()] : []; } catch { return []; }
}))];

/** owner/repo from a git remote URL (https, ssh or scp form), lowercased. */
export const remoteRepo = (url: string): string | undefined =>
  /[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]?.toLowerCase();

/** The git toplevel and origin URL of `dir` on the lane's host, read by its runner (`q.lane.inspect`); none outside git. */
const gitOf = async (deps: FlowDeps, key: string, dir: string): Promise<{ readonly top?: string; readonly origin?: string }> => {
  const git = (await deps.ops.inspect({ key, cwd: dir }, { git: true, cwd: dir })).git;
  return { ...(git?.toplevel ? { top: git.toplevel } : {}), ...(git?.origin ? { origin: git.origin } : {}) };
};

/**
 * A local lane's directory: refused when it is the git checkout (worktree) another open local lane works in, and when
 * its origin remote names none of the Done line's repos (unless allowRepoMismatch). A directory outside git is not
 * checked. Remote lanes are not checked: their directory is not on this host. The git facts come from the local runner.
 */
export const validatePlacement = async (deps: FlowDeps, input: LaunchInput, cwd: string): Promise<void> => {
  if (input.machine) return;
  const { top, origin } = await gitOf(deps, input.key, cwd);
  if (!top) return;
  for (const other of await deps.registry.open()) {
    if (other.key === input.key || other.machine) continue;
    const dir = other.cwd ?? deps.config.defaultCwd;
    if (dir === cwd || (await gitOf(deps, other.key, dir)).top === top) throw new LaunchError(`${cwd} is the checkout open lane ${other.key} works in (${top}); give this lane its own worktree with --cwd`);
  }
  const want = doneRepos(input.done);
  if (!want.length || input.allowRepoMismatch) return;
  const have = origin ? remoteRepo(origin) : undefined;
  if (have && !want.includes(have)) throw new LaunchError(`${cwd} is a checkout of ${have}, but the Done line names ${want.join(", ")}; launch from that repo's worktree or pass --allow-repo-mismatch`);
};

/**
 * A brief's `autoClose:` declaration (a line of its own, optionally a list item): `machine` means the Done signals settle
 * the lane alone, so its claim and close never wake the lead; `lead` (or none) is the default.
 */
export const briefAutoClose = (brief: string): Lane["autoClose"] => {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?autoClose:[ \t]*(\S*?)`?[ \t]*$/im.exec(brief);
  if (!m) return undefined;
  const value = (m[1] ?? "").toLowerCase();
  if (value === "machine") return "machine";
  if (value === "lead") return undefined;
  throw new LaunchError(`the brief declares autoClose: ${m[1]}; use autoClose: machine (or lead, the default)`);
};

/**
 * A brief's `issue:` declaration (a line of its own, optionally a list item): the GitHub issue `owner/repo#N` the lane
 * was started from. CI follow-up closes it with a comment once the lane's PR is merged into ciMergeBase.
 */
export const briefIssue = (brief: string): string | undefined => {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?issue:[ \t]*(\S*?)`?[ \t]*$/m.exec(brief);
  if (!m) return undefined;
  const ref = m[1] ?? "";
  if (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ref)) throw new LaunchError(`the brief declares issue: ${ref}; use issue: owner/repo#N`);
  return ref;
};

/** The brief's autoClose and issue for a lane record. An unreadable brief declares neither. */
const autoCloseOf = async (path: string): Promise<Pick<Lane, "autoClose" | "ghIssue">> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const text = await file.text();
  const auto = briefAutoClose(text);
  const issue = briefIssue(text);
  return { ...(auto ? { autoClose: auto } : {}), ...(issue ? { ghIssue: issue } : {}) };
};

/**
 * The done rules every footer carries, ahead of the lane's own values: how to claim, what the watcher checks, what happens
 * on a refusal. Every lane reports through its runner, so only the `dori` path differs between a local and a remote lane.
 * The rules every lane shares (no quotes, ids or usage numbers; no decision records in the repo; how to ask the owner) sit
 * here so a brief need not repeat them; the owner's own policy lines (`laneRules`: merge policy, CI policy) follow them.
 * Nothing lane-specific (key, thread, pane, Done line) may appear here; that is the "### This lane" section.
 */
/** The `dori` a lane runs: the runner's lane-mode CLI on a worker (installed by `dori runner install`), else the `dori` on PATH. */
export const laneCli = (lane: Pick<Lane, "machine">): string => (lane.machine ? RUNNER_LANE_CLI : "dori");
export const RUNNER_LANE_CLI = "~/.dori/runner/bin/dori";

/** Whether a `Done =` line names a `merged <repo>#N` signal (the PR the supervisor merges after the claim). */
const hasMergedSignal = (done: string): boolean => splitDone(done).some((part) => /^merged\s/i.test(part.trim()));

export const footerDoneRules = (lane: Lane, ownerLanguage?: string, laneRules: readonly string[] = []): string => [
  "- Set a goal first: restate the deliverable and the observable condition that ends this lane. The `Done =` signals below still decide when the lane closes; your restatement does not replace them.",
  "- Work until that condition holds. Do not stop to ask permission for reversible steps the brief already covers; only a decision the brief leaves open goes to the owner, as below.",
  "- Done rules: when every `Done =` signal below is live and all work is pushed, claim done with the dori report done command below yourself, then stay idle and start no new work.",
  "  The watcher re-reads every signal live and closes the lane 5 min after your claim unless the Dori objects. It refuses to close while a worktree has uncommitted tracked changes or unpushed commits. The lane closes only when every signal reads back live.",
  "  On `[LEAD] not done: <reasons>`, fix every reason and claim again.",
  ...(hasMergedSignal(lane.done) ? ["  A `merged` signal is the supervisor's to make live: once the PR is pushed and its CI is running or green, claim done without waiting for the merge. The supervisor merges the PR at the head your claim recorded and the lane closes after it; push nothing after the claim, or claim again if you must."] : []),
  "- PR bodies, issues, commit messages, code comments and repo docs carry no owner quotes, chat message ids, or quota, usage or cost numbers.",
  "- Keep decisions and conversations out of the repo: no decision log, chat record or who-asked-what in code, comments, docs or commits. Describe the change and its evidence in your own words.",
  "- For any owner decision, run the dori report question command below and wait for the answer; never ask only through an on-screen ask-user prompt, which the owner does not see.",
  ...(languageInstruction(ownerLanguage) ? [`- ${languageInstruction(ownerLanguage)}`] : []),
  `- Start emulators, simulators and heavy builds (expo export, gradle, xcodebuild) only through \`${laneCli(lane)} heavy <label> -- <command>\`: one heavy job runs per machine at a time and the command waits for the slot. When memory runs critically low the guard kills configured heavy processes and may pause the lane.`,
  ...laneRules.map((rule) => `- ${rule}`),
  ...(lane.autoClose === "machine" ? ["- autoClose: machine. When the Done signals read back live the lane closes on its own; the lead is not woken for the claim or the close."] : []),
].join("\n");

const FOOTER_HEADING = "\n## Lane footer (written by dori launch)";

/** The kinds of a `dori report` footer and where each goes. */
const REPORT_KINDS_TEXT = 'milestone = a state change the owner would care about: what now works or landed, where the lane stands against its Done condition, and "scope unchanged" or what changed; it reaches the lead with its next update. progress = 1-2 sentences, done since last and next; it updates your work thread\'s status message. question and blocked wake the lead.';

/** The footer every lane brief gets: the shared done rules, then this lane's values and how it reports through its runner. */
export const footer = (lane: Lane, ownerLanguage?: string, laneRules?: readonly string[]): string => [
  "",
  FOOTER_HEADING.slice(1),
  footerDoneRules(lane, ownerLanguage, laneRules),
  "",
  "### This lane",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}`,
  ...(lane.machine
    ? [
      `- This lane runs on machine ${lane.machine} under its runner. Report to the lead with ${RUNNER_LANE_CLI} report, never by typing into any pane: ${RUNNER_LANE_CLI} report ${lane.key} <milestone|progress|question|blocked> --text "<what, with links>". ${REPORT_KINDS_TEXT} That CLI takes only report, claim-done, report ack, lane status and heavy, and only for this lane's key.`,
      `- When done: ${RUNNER_LANE_CLI} report ${lane.key} done --text "<one line>" --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
    ]
    : [
      `- Report to the lead with dori report, never by typing into the lead's pane: dori report ${lane.key} <milestone|progress|question|blocked> --text "<what, with links>". ${REPORT_KINDS_TEXT}`,
      `- When done: dori report ${lane.key} done --text "<one line>" --evidence "<merge SHA, closed issue, version>" (the same claim as dori claim-done). See references/done-protocol.md.`,
    ]),
  "",
].join("\n");

/** Where a lane's directory lives: a remote path is kept apart from the local cwd that signals and git checks use. */
const laneDirs = (machine: string | undefined, dir: string | undefined, defaultCwd: string): Pick<Lane, "cwd" | "remoteCwd"> =>
  machine ? (dir ? { remoteCwd: dir } : {}) : { cwd: dir ?? defaultCwd };

/** The hint for a pane id this host's herdr does not list: lanes without --machine are local lanes. */
const REMOTE_PANE_HINT = "a pane on another machine needs --machine LABEL";

/** A runner failure that leaves nothing started (refused, failed, or a runner that was never reached): the reservation can go. */
const nothingStarted = (e: unknown): boolean =>
  e instanceof LaneOpsError && (e.code === "LANE_OP_FAILED" || e.code === "RUNNER_OUTDATED" || (e.code === "RUNNER_UNAVAILABLE" && e.detail.startsWith("disconnected")));

/**
 * Registers an existing pane as a lane: the lane's runner takes the pane over (`lane.adopt`, which checks the pane is on
 * its host and issues the lane token). Without --machine the lane is local, so the local runner must see the pane.
 */
export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  const draft: Lane = {
    key: input.key, title: input.title, thread: normalizeThreadRef(input.thread ?? "none"), pane: input.pane, ...(input.machine ? { machine: input.machine } : {}),
    runner: machineRunner(input.machine), runnerAdoptedAt: deps.clock.now(), brief: input.brief, done: input.done, ...(await autoCloseOf(input.brief)),
    ...laneDirs(input.machine, input.cwd, deps.config.defaultCwd), openedAt: iso(deps.clock),
  };
  const token = randomUUID();
  const reserved = await reserveLane(deps, input, draft, token);
  let adopted;
  try {
    adopted = await deps.ops.adopt({
      key: input.key, pane: input.pane, mode: input.mode ?? "ulw", model: input.model ?? deps.config.defaultModel,
      ...(input.machine ? { machine: input.machine } : {}), ...(input.cwd ? { cwd: input.cwd } : {}),
    });
  } catch (error) {
    if (nothingStarted(error)) {
      await deps.registry.releaseReservation(input.key, token);
      const detail = error instanceof Error ? error.message : String(error);
      throw new LaunchError(`pane ${input.pane} cannot be adopted on ${input.machine ?? "this host"} (${detail})${input.machine ? "" : `; ${REMOTE_PANE_HINT}`}`);
    }
    throw error;
  }
  const lane: SharedThreadLane = { ...reserved, pane: adopted.pane, ...(adopted.tab ? { tab: adopted.tab } : {}) };
  await deps.registry.update(input.key, (current) => {
    if (current?.launchReservation !== token) throw new LaunchError(`lane ${input.key} lost its launch reservation`);
    return { ...current, ...lane, status: current.status === "paused" ? lane.status : current.status, launchReservation: undefined };
  });
  return lane;
};

/** Serialize admissions across keys: thread and checkout checks and the key reservation are one transaction. */
const reserveLane = async (deps: FlowDeps, input: LaunchInput, lane: Lane, token?: string): Promise<SharedThreadLane> => {
  const release = await acquireStateLock(join(deps.registry.dir, "launch.lock.sqlite"));
  try {
    await validateLaunch(deps, input);
    await validatePlacement(deps, input, lane.cwd ?? deps.config.defaultCwd);
    const shared = await threadSharers(deps, input);
    const draft: SharedThreadLane = { ...lane, ...(shared.length ? { threadSharedWith: shared } : {}) };
    await deps.registry.update(input.key, (current) => {
      if (current) throw new LaunchError(`lane ${input.key} is already registered`);
      // A crash leaves a visible paused reservation, not an apparently working lane that recovery might spawn.
      return token ? { ...draft, status: "paused", launchReservation: token } : draft;
    });
    return draft;
  } finally { release(); }
};

type TargetPane = { readonly pane: string; readonly tab?: string; readonly cwd?: string };

type ProcessInfo = { readonly shell_pid?: number; readonly foreground_process_group_id?: number };

const parse = <T>(text: string, what: string): T => {
  try { return JSON.parse(text) as T; } catch { throw new LaunchError(`${what}: unreadable process info`); }
};

/**
 * The existing pane a lane may start in, checked before anything is written: it exists on the lane's host, is an idle
 * shell (no agent, no other foreground process) and no lane owns it. The pane list and process info come from the
 * lane's runner, which checks the pane again when it starts the lane (`lane.start` target).
 */
const resolveTargetPane = async (deps: FlowDeps, input: LaunchInput): Promise<TargetPane> => {
  const panes = await deps.ops.panes(input.machine);
  let id = input.pane;
  if (!id) {
    const inWs = panes.filter((p) => p.workspace_id === input.workspace);
    if (!inWs.length) throw new LaunchError(`workspace ${input.workspace} has no panes (or does not exist)`);
    const shells = inWs.filter((p) => !p.agent);
    if (shells.length !== 1) throw new LaunchError(`workspace ${input.workspace} has ${shells.length} shell panes; pass --pane to pick one`);
    id = shells[0]?.pane_id;
  }
  if (!id) throw new LaunchError("no target pane");
  const info = panes.find((p) => p.pane_id === id);
  if (!info) throw new LaunchError(`pane ${id} does not exist on ${input.machine ?? "this host"}${input.machine ? "" : `; ${REMOTE_PANE_HINT}`}`);
  if (input.workspace && info.workspace_id !== input.workspace) throw new LaunchError(`pane ${id} is in workspace ${info.workspace_id}, not ${input.workspace}`);
  if (info.agent) throw new LaunchError(`pane ${id} runs an agent (${info.agent}); a lane needs an idle shell`);
  const proc = await deps.ops.processInfo({ ...(input.machine ? { machine: input.machine } : {}), pane: id });
  if (proc.code !== 0) throw new LaunchError(`cannot read the processes of pane ${id}: ${proc.err || proc.out}`);
  const p = parse<{ result: { process_info: ProcessInfo } }>(proc.out, `process info of pane ${id}`).result.process_info;
  if (p.foreground_process_group_id && p.foreground_process_group_id !== p.shell_pid) throw new LaunchError(`pane ${id} has a foreground process running; a lane needs an idle shell`);
  const owner = (await deps.registry.open()).find((l) => l.pane === id && l.machine === input.machine);
  if (owner) throw new LaunchError(`pane ${id} is already registered to lane ${owner.key}`);
  // The runner refuses a cmd.exe pane (no launch line exists for it); say so before anything is written.
  if (paneShell(p, info.cwd) === "cmd") throw new LaunchError(cmdRefused(id));
  return { pane: id, ...(info.tab_id ? { tab: info.tab_id } : {}), ...(info.cwd ? { cwd: info.cwd } : {}) };
};

/**
 * Where a Toodo task's lane runs: the first shell pane start_task listed, else the one shell pane of the task's herdr
 * workspace (a listed id goes stale when herdr restarts), else a new tab, with the reason in a LAUNCH_FALLBACK line.
 */
const toodoTarget = async (deps: FlowDeps, input: LaunchInput, start: ToodoStart): Promise<{ readonly target?: TargetPane; readonly notes: readonly string[] }> => {
  const attempts = [
    ...start.shellPanes.slice(0, 1).map((pane) => ({ pane, workspace: undefined })),
    ...(start.herdrWorkspaceId ? [{ pane: undefined, workspace: start.herdrWorkspaceId }] : []),
  ];
  const failed: string[] = start.shellPanes.length ? [] : [`start_task listed no shell pane (${start.paneError ?? "panes is empty"})`];
  for (const at of attempts) {
    try {
      const target = await resolveTargetPane(deps, { ...input, ...at });
      return { target, notes: failed.length ? [`LAUNCH_PANE_REFOUND ${input.key} pane=${target.pane}: ${failed.join("; ")}`] : [] };
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      failed.push(error.message);
    }
  }
  return { notes: [`LAUNCH_FALLBACK ${input.key} new tab: ${failed.join("; ")}`] };
};

/**
 * The herdr workspace a local lane's new tab opens in: the supervisor-managed lanes workspace, found again or created and
 * recorded when herdr lost it. A launch never falls back to herdr's focused workspace, so a herdr failure refuses it.
 */
export const laneTabWorkspace = async (deps: Pick<FlowDeps, "run" | "config">, log: (line: string) => void): Promise<string> => {
  try {
    return await ensureLaneWorkspace(deps.run, deps.config.stateDir, deps.config.defaultCwd, log);
  } catch (error) {
    if (error instanceof ManagedPanesError) throw new LaunchError(`no lanes workspace: ${error.message}`);
    throw error;
  }
};

/** The STARTUP_OK / STARTUP_ERROR / STARTUP_UNCONFIRMED line of a runner's startup verdict for `pane`. */
export const startupLine = (key: string, pane: string, startup: StartupVerdict): string =>
  startup.verdict === "ok" ? `STARTUP_OK ${key} ${pane}` : `STARTUP_${startup.verdict === "error" ? "ERROR" : "UNCONFIRMED"} ${key} ${pane}: ${startup.detail}`;

/**
 * Whether this launch wraps its agent in laneSandbox.command. Every local lane is wrapped; there is no opt-out. `--sandbox` (and a
 * relaunch's recorded choice) wraps it even where it would otherwise pass through, with the reason, because the sandbox does not fit.
 * A config without laneSandbox (only an in-code config: loadConfig always fills it) wraps nothing.
 */
export const sandboxChoice = (config: FlowDeps["config"], input: LaunchInput, which: (cmd: string) => string | null): { readonly on: boolean; readonly skipped?: string } => {
  if (input.sandbox) return { on: true };
  const configured = config.laneSandbox;
  if (!configured) return { on: false };
  if (input.machine) return { on: false, skipped: `remote lane on ${input.machine}; laneSandbox wraps local lanes only` };
  if (input.pane) return { on: false, skipped: `--pane ${input.pane} reuses an existing pane whose directory the sandbox may not bind; pass --sandbox to wrap it anyway` };
  const exe = configured.command[0] ?? "";
  if (!which(exe)) return { on: false, skipped: `${exe} is not on PATH; install scripts/templates/lane-sandbox.sh as ${exe} or set laneSandbox.command` };
  return { on: true };
};

/**
 * Starts a lane through its runner (`lane.start`): the lane is reserved (paused, with a token), its brief gets the
 * footer, and the runner opens the pane (a new tab, or the checked target pane), runs the agent from its own profile
 * (`sandboxed` for a sandboxed local lane), and confirms the startup. The returned pane is recorded on the lane.
 * `existing` relaunches a registered lane (recovery) without a reservation.
 */
export const launchLane = async (deps: FlowDeps, input: LaunchInput, existing?: Lane): Promise<{ readonly lane: Lane; readonly startup: string; readonly notes: readonly string[] }> => {
  const model = input.model ?? deps.config.defaultModel;
  const mode = input.mode ?? "ulw";
  if (!existing) await validateLaunch(deps, input);
  const choice = sandboxChoice(deps.config, input, deps.which ?? Bun.which);
  const sandbox = choice.on;
  if (sandbox && !deps.config.laneSandbox) throw new LaunchError("--sandbox needs laneSandbox in the config (laneSandbox.command, e.g. [\"lane-sandbox\"])");
  if (sandbox && input.machine) throw new LaunchError(`--sandbox wraps local lanes only; machine ${input.machine} cannot run it, drop --sandbox`);
  const placed = input.toodo && !input.pane && !input.workspace ? await toodoTarget(deps, input, input.toodo) : undefined;
  const target = placed ? placed.target : input.pane || input.workspace ? await resolveTargetPane(deps, input) : undefined;
  const notes = [...(placed?.notes ?? []), ...(choice.skipped ? [`SANDBOX_SKIPPED ${input.key}: ${choice.skipped}`] : [])];
  const tabWorkspace = target || input.machine ? undefined : await laneTabWorkspace(deps, (line) => { notes.push(line); });
  const dir = input.cwd ?? target?.cwd;
  // The runner starts every lane in a directory on its own host; the lead's defaultCwd means nothing on another machine.
  if (input.machine && !dir) throw new LaunchError(`a lane on machine ${input.machine} needs --cwd (a directory on that machine)`);
  const cwd = dir ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  let draft: SharedThreadLane = {
    ...(existing ?? {}), key: input.key, title: input.title, thread: normalizeThreadRef(input.thread ?? "none"), ...(input.machine ? { machine: input.machine } : {}),
    runner: machineRunner(input.machine), runnerAdoptedAt: existing?.runnerAdoptedAt ?? deps.clock.now(),
    brief: input.brief, done: input.done, ...(existing ? {} : await autoCloseOf(input.brief)),
    reportVia: "cli" as const, // every lane reports through its runner; an old-footer lane moves onto dori report when recovery relaunches it
    ...laneDirs(input.machine, dir, deps.config.defaultCwd), ...(sandbox ? { sandbox: true as const } : {}), model, mode, openedAt: existing?.openedAt ?? iso(deps.clock),
  };
  const token = existing ? undefined : randomUUID();
  if (token) draft = await reserveLane(deps, input, draft, token);
  let started = false;
  try {
    // A relaunched lane still on an old footer ([REPORT] lines, or a remote lane printing them) gets the dori report one.
    const migrate = Boolean(existing && (!existing.reportVia || (existing.machine && !existing.runner)));
    const text = await briefFile.text();
    const body = migrate ? text.slice(0, text.includes(FOOTER_HEADING) ? text.indexOf(FOOTER_HEADING) : undefined) : text;
    const brief = existing && !migrate ? text : `${body.replace(/\s*$/, "")}\n${footer(draft, deps.config.ownerLanguage, deps.config.laneRules)}`;
    // The lead-side brief keeps the footer for reference; the runner writes its own copy on the lane's host.
    if (!existing || migrate) await Bun.write(input.brief, brief);
    const start: StartInput = {
      key: input.key, briefText: brief, done: input.done, thread: draft.thread, cwd, sandbox, mode, model,
      keywords: mode === "mass-ulw" ? deps.config.massLaunchKeywords : deps.config.launchKeywords,
      ...(input.machine ? { machine: input.machine } : { heavySlots: deps.config.heavySlots, heavyMaxLoad: deps.config.heavyMaxLoad }),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(target ? { target: { pane: target.pane } } : {}),
      ...(tabWorkspace ? { tabWorkspace } : {}),
    };
    let result;
    try {
      result = await deps.ops.start(start);
    } catch (error) {
      if (nothingStarted(error)) throw new LaunchError(`${input.key}: ${error instanceof Error ? error.message : String(error)}`);
      started = true; // a timeout or an ambiguous answer: the runner may have started the agent, so the reservation stays visible
      throw new LaunchError(`${input.key}: the start may have happened (${error instanceof Error ? error.message : String(error)}); the lane stays reserved and paused: check dori status, or cancel it with dori close ${input.key} --cancelled --reason TEXT`);
    }
    started = true;
    const lane: Lane = { ...draft, pane: result.pane, ...(result.tab ? { tab: result.tab } : target?.tab ? { tab: target.tab } : {}) };
    // A relaunch writes only what this launch changed, so a pause or objection that landed meanwhile survives.
    const launched = (current: Lane): Lane => existing
      ? { ...current, ...Object.fromEntries(Object.entries(lane).filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)), key: lane.key } as Lane
      : { ...current, ...lane, status: current.status === "paused" ? lane.status : current.status, launchReservation: undefined };
    await deps.registry.update(lane.key, (current) => {
      if (token && current?.launchReservation !== token) throw new LaunchError(`lane ${lane.key} lost its launch reservation`);
      return current ? launched(current) : lane;
    });
    return { lane, notes, startup: startupLine(input.key, result.pane, result.startup) };
  } catch (error) {
    if (token && !started) await deps.registry.releaseReservation(input.key, token);
    throw error;
  }
};

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
