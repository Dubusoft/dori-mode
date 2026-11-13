import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { DEFAULT_LANE_SANDBOX, languageInstruction } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaneOpsError, machineRunner, type StartInput } from "./lane-ops.ts";
import { ensureLaneWorkspace, ManagedPanesError } from "./managed-panes.ts";
import { LANE_KEY, type Lane, type LaneMode } from "./registry.ts";
import { iso } from "./run.ts";
import { herdrDownSince } from "./runner/herdr-down.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";
import { runnerOs, unsandboxedReason } from "./runner-sandbox.ts";
import { cmdRefused, paneShell } from "./runner/lane-control.ts";
import type { StartupVerdict } from "./runner/protocol.ts";
import { doneSyntaxErrors, parseSignal, splitDone } from "./signals.ts";
import { normalizeThreadRef } from "./messenger/target.ts";
import { acquireStateLock } from "./state-lock.ts";
import { threadIdOf } from "./thread-finality.ts";
import { briefBody, FILE_FOOTER_HEADING, LaneFileError, prepareLaneBrief, readLaneAttachmentPin, writeLaneAttachmentPin } from "./lane-files.ts";
import { runnerJournalHead } from "./runner/lanes-hub.ts";
import type { LaneBriefFiles } from "./runner/protocol.ts";
import type { RecoveryLane } from "./recover.ts";

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
  /** Allow a second open lane on the same messenger thread (`--share-thread`); the lanes are recorded in `threadSharedWith`. */
  readonly shareThread?: boolean;
  /** Allow a cwd whose git remotes name none of the Done line's repos (`--allow-repo-mismatch`). */
  readonly allowRepoMismatch?: boolean;
  /** `--sandbox` (or a relaunch of a lane recorded as sandboxed): every lane is sandboxed by default now, so this changes nothing. */
  readonly sandbox?: true;
  /** Resume this agent session (recovery): the runner inserts `--session <id>` when its profile allows. */
  readonly session?: string;
};

/** A lane launched with --share-thread: the keys of the other open lanes on its thread at launch time. */
export type SharedThreadLane = Lane & { readonly threadSharedWith?: readonly string[] };

export class LaunchError extends Error {}

export type SandboxRefusalCode = "SANDBOX_MISSING" | "SANDBOX_BROKEN" | "SANDBOX_UNAVAILABLE";

/** A launch refused because its lane would run without a working sandbox; the message starts `<code> <key>: `. */
export class SandboxRefusal extends LaunchError {
  constructor(readonly code: SandboxRefusalCode, key: string, detail: string) { super(`${code} ${key}: ${detail}`); }
}

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
    const keywords: unknown = deps.tunables.massLaunchKeywords;
    if (typeof keywords !== "string" || !keywords.startsWith("/mass-ulw") || keywords.includes("?") || input.brief.includes("?")) throw new LaunchError("massLaunchKeywords must start with /mass-ulw and the prompt (keywords and brief path) must contain no '?'");
  }
  const unbindable = sandboxedCwdInDoriHome(deps, input);
  if (unbindable) throw new LaunchError(`--cwd ${input.cwd} is inside ${unbindable}, which the lane sandbox cannot bind; put the worktree outside it (e.g. under ${dirname(deps.config.leadCwd)})`);
  const sharing = await threadSharers(deps, input);
  if (sharing.length && !input.shareThread) throw new LaunchError(`thread ${input.thread} already has open lane ${sharing.join(", ")}; one thread per lane, or pass --share-thread`);
};

const within = (dir: string, parent: string): boolean => { const r = relative(parent, dir); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };

/**
 * The dori home (~/.dori) when a local launch's --cwd is inside it (every new local lane, --pane ones too, is sandboxed):
 * lane-sandbox mounts a read-only tmpfs there and binds only <home>/.dori/state read-write, so any other directory under
 * it cannot be bound as the lane's cwd. A remote lane's directory is on its own machine.
 */
const sandboxedCwdInDoriHome = (deps: FlowDeps, input: LaunchInput): string | undefined => {
  if (!input.cwd || input.machine) return undefined;
  const state = resolve(deps.config.stateDir);
  const home = basename(state) === "state" && basename(dirname(state)) === ".dori" ? dirname(state) : join(homedir(), ".dori"); // the sandbox always uses $HOME/.dori
  const cwd = resolve(input.cwd);
  return within(cwd, home) && !within(cwd, state) ? home : undefined;
};

/** Open lanes on the input's thread, by thread id: `discord:<thread>` and `discord:<channel>/<thread>` are the same thread. */
const threadSharers = async (deps: FlowDeps, input: LaunchInput): Promise<string[]> =>
  !input.thread || input.thread === "none" ? [] : (await deps.registry.open()).filter((l) => l.key !== input.key && l.thread !== "none" && threadIdOf(l.thread) === threadIdOf(input.thread ?? "")).map((l) => l.key);

/** owner/repo names in the Done line's merged/closed/pr signals, lowercased. */
export const doneRepos = (done: string): string[] => [...new Set(splitDone(done).flatMap((part) => {
  try { const s = parseSignal(part); return s.kind === "merged" || s.kind === "closed" || s.kind === "pr" ? [s.repo.toLowerCase()] : []; } catch { return []; }
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
    const dir = other.cwd ?? deps.config.leadCwd;
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

/** Only a `deliverable: report` line declares a required report; any other `deliverable:` line is ordinary brief text. */
export const briefDeliverable = (body: string): boolean =>
  /^[ \t]*(?:[-*][ \t]+)?`?deliverable:[ \t]*report`?[ \t]*$/im.test(body);

export const prepareLeadLaneBrief = async (deps: FlowDeps, lane: Lane, runId?: string, existing = false): Promise<{
  readonly briefText: string; readonly files: LaneBriefFiles; readonly notes: readonly string[];
  readonly autoClose?: Lane["autoClose"]; readonly ghIssue?: string; readonly sources: readonly string[];
}> => {
  const file = Bun.file(lane.brief);
  if (!(await file.exists())) throw new LaunchError(`brief not found: ${lane.brief}`);
  // Read only enough to recognize a footer after the largest permitted user body.
  const raw = await file.slice(0, 65536 + Buffer.byteLength(FILE_FOOTER_HEADING) + 2).text();
  const scannedBody = briefBody(raw);
  // The separator written before our footer is generated, rather than part of the raw user brief.
  const body = raw === scannedBody ? scannedBody : scannedBody.replace(/\n$/, "");
  if (Buffer.byteLength(body) > 65536) throw new LaunchError(`LANE_FILES_LIMIT ${lane.key}: briefBytes is ${Buffer.byteLength(body)}, above 65536; reduce the attachment tree or brief and launch again`);
  // An existing lane keeps the policy its launch recorded: the brief lives where the lane itself can rewrite it.
  const requiredReport = existing ? lane.fileRun?.requiredReport ?? false : briefDeliverable(body);
  const autoClose = existing ? lane.autoClose : briefAutoClose(body), ghIssue = existing ? lane.ghIssue : briefIssue(body);
  const forFooter = { ...lane, autoClose, fileRun: { id: runId ?? deps.newFileRunId?.() ?? randomUUID(), requiredReport } };
  const worktreeRoot = (deps.runnerWorktreeRoot ?? ((label) => runnerWorktreeRoot(deps.config.stateDir, label)))(machineRunner(lane.machine));
  const briefText = `${body.replace(/\s*$/, "")}\n${footer(forFooter, deps.config.ownerLanguage, deps.config.laneRules, worktreeRoot)}`;
  const prepare = (allowed?: readonly string[]) => prepareLaneBrief({
    key: lane.key, stateDir: deps.config.stateDir, briefText, rawBriefText: body, requiredReport, runId: forFooter.fileRun.id, ...(allowed ? { allowed } : {}),
  });
  try {
    if (!existing) return { briefText, ...prepare(), autoClose, ghIssue };
    const pinned = readLaneAttachmentPin(deps.config.stateDir, lane.key);
    try {
      return { briefText, ...prepare(pinned), autoClose, ghIssue };
    } catch (e) {
      // Attachments that no longer pass the caps or safety checks must not keep a running lane from coming back.
      if (!(e instanceof LaneFileError) || pinned.length === 0) throw e;
      const bare = prepare([]);
      return { briefText, ...bare, notes: [`LANE_FILES_SKIPPED ${lane.key}: relaunched without attachments (${e.message})`, ...bare.notes], autoClose, ghIssue };
    }
  } catch (e) {
    if (e instanceof LaneFileError) throw new LaunchError(e.message);
    throw e;
  }
};

export const recoveryFields = (lane: Partial<RecoveryLane>): Partial<RecoveryLane> => ({
  pendingFileRun: lane.pendingFileRun, recoveryPending: lane.recoveryPending, recoveryAfter: lane.recoveryAfter,
  recoveryPreviousPane: lane.recoveryPreviousPane, recoveryExhausted: lane.recoveryExhausted, fileProposal: lane.fileProposal,
});
export const restoreFileProposal = async (deps: FlowDeps, key: string, runId: string, prior: Lane): Promise<void> => {
  await deps.registry.update(key, (current) => current?.pendingFileRun?.id === runId ? { ...current, ...recoveryFields(prior) } : undefined);
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
  "- Rewritten paths under briefs/<key>.files are read-only snapshots of lead files; do not edit them. Write every output to DORI_LANE_OUT, including updated versions of an attached file.",
  '- Write report files in DORI_LANE_OUT (POSIX: "$DORI_LANE_OUT"; PowerShell: "$env:DORI_LANE_OUT"). Finish writing before claiming done. dori ships that entire directory to the lead when you run claim-done or report done; files elsewhere are not collected. Keep each file at or below 262144 bytes and the directory at or below 393216 bytes total, with at most 64 files.',
  "- Set a goal restating the deliverable and its end condition (the `Done =` signals below decide the close), and work until it holds without asking leave for reversible steps the brief covers.",
  "- Done: once every `Done =` signal is live and all work is pushed, run the done command below, then stop and stay idle. A lane ends at its green PR: never wait for the merge (no monitor, wait, sleep, polling loop or `gh pr checks --watch` on it). The supervisor merges the PR at the head your claim recorded and the watcher closes the lane after that merge (5 min after the claim when nothing is left to merge) unless the Dori objects; it refuses while a worktree has uncommitted or unpushed changes. On `[LEAD] not done: <reasons>`, fix them and claim again.",
  ...(hasMergedSignal(lane.done) ? ["  A `merged` signal is the supervisor's to make live: claim done once the PR is pushed and its CI is running or green. Push nothing after the claim, or claim again if you must."] : []),
  "- Repo text (PRs, issues, commits, comments, docs) carries no owner quotes, chat ids, usage or cost numbers, decision logs or chat records; describe the change in your own words.",
  "- Owner decisions go only through the dori report question command below (the owner never sees on-screen prompts); wait for the answer. Form: `dori report <key> question --text \"<question>\" --option \"<A>\" --option \"<B>\" --recommend 1 --reason \"<why>\" [--waiting \"<what is paused>\"] [--nonblocking]` (2-9 options; a question without --option is refused, use `blocked` for an open-ended blocker). The owner gets one decision thread per question. If an older dori on a worker machine rejects --option (an unknown-option error of any shape), send the same question with --text only, listing the options in the text.",
  "- The lane's omo never stops on a permission prompt: access outside the lane sandbox (on a lane without one, outside its directory, the runner directory, the repos and worktree roots and the temp directory) is refused with an error instead. Work inside those paths (the worktree, the brief, DORI_LANE_OUT); when the work needs another path, ask with the dori report question command.",
  ...(languageInstruction(ownerLanguage) ? [`- ${languageInstruction(ownerLanguage)}`] : []),
  `- Run emulators, simulators and heavy builds (expo export, gradle, xcodebuild) only through \`${laneCli(lane)} heavy <label> -- <command>\` (one per machine; it waits for the slot).`,
  ...laneRules.map((rule) => `- ${rule}`),
  ...(lane.autoClose === "machine" ? ["- autoClose: machine. When the Done signals read back live the lane closes on its own; the lead is not woken for the claim or the close."] : []),
].join("\n");

const FOOTER_HEADING = "\n## Lane footer (written by dori launch)";

/** The footer line placing a lane's git worktrees under its machine's reported worktree root. */
const worktreeLine = (root: string, key: string): string =>
  `- Create every git worktree this lane needs under ${root}, as ${root}/<repo name>-${key} (<repo name>: the last segment of owner/repo).`;

/** The kinds of a `dori report` footer and where each goes. */
const REPORT_KINDS_TEXT = "milestone = what landed, standing vs Done, scope change; progress = 1-2 lines (updates the thread status); question (with --option choices, see the owner-decision rule above) and blocked wake the lead.";

/**
 * The footer every lane brief gets: the shared done rules, then this lane's values and how it reports through its runner.
 * `worktreeRoot`, the lane worktree root its machine's runner reported, adds where the lane creates its git worktrees.
 */
export const footer = (lane: Lane, ownerLanguage?: string, laneRules?: readonly string[], worktreeRoot?: string): string => [
  "",
  FOOTER_HEADING.slice(1),
  footerDoneRules(lane, ownerLanguage, laneRules),
  "",
  "### This lane",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}`,
  ...(worktreeRoot ? [worktreeLine(worktreeRoot.replace(/\/+$/, ""), lane.key)] : []),
  ...(lane.fileRun?.requiredReport ? ["- This lane declares deliverable: report. Write at least one regular report file in DORI_LANE_OUT before claiming done."] : []),
  ...(lane.machine
    ? [
      `- Runs on machine ${lane.machine} under its runner. Report only with: ${RUNNER_LANE_CLI} report ${lane.key} <milestone|progress|question|blocked> --text "<what, with links>" (never type into a pane). ${REPORT_KINDS_TEXT} That CLI takes only report, claim-done, report ack, lane status and heavy, and only for this lane's key.`,
      `- When done: ${RUNNER_LANE_CLI} report ${lane.key} done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version>".`,
    ]
    : [
      `- Report only with: dori report ${lane.key} <milestone|progress|question|blocked> --text "<what, with links>" (never type into a pane). ${REPORT_KINDS_TEXT}`,
      `- When done: dori report ${lane.key} done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version>".`,
    ]),
  "",
].join("\n");

/** Where a lane's directory lives: a remote path is kept apart from the local cwd that signals and git checks use. */
const laneDirs = (machine: string | undefined, dir: string | undefined, leadCwd: string): Pick<Lane, "cwd" | "remoteCwd"> =>
  machine ? (dir ? { remoteCwd: dir } : {}) : { cwd: dir ?? leadCwd };

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
    ...laneDirs(input.machine, input.cwd, deps.config.leadCwd), openedAt: iso(deps.clock),
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
    await validatePlacement(deps, input, lane.cwd ?? deps.config.leadCwd);
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
 * The herdr workspace a local lane's new tab opens in: the supervisor-managed lanes workspace, found again or created and
 * recorded when herdr lost it. A launch never falls back to herdr's focused workspace, so a herdr failure refuses it.
 */
export const laneTabWorkspace = async (deps: Pick<FlowDeps, "run" | "config">, log: (line: string) => void): Promise<string> => {
  try {
    return await ensureLaneWorkspace(deps.run, deps.config.stateDir, deps.config.leadCwd, log);
  } catch (error) {
    if (error instanceof ManagedPanesError) throw new LaunchError(`no lanes workspace: ${error.message}`);
    throw error;
  }
};

/** The STARTUP_OK / STARTUP_ERROR / STARTUP_UNCONFIRMED line of a runner's startup verdict for `pane`. */
export const startupLine = (key: string, pane: string, startup: StartupVerdict): string =>
  startup.verdict === "ok" ? `STARTUP_OK ${key} ${pane}` : `STARTUP_${startup.verdict === "error" ? "ERROR" : "UNCONFIRMED"} ${key} ${pane}: ${startup.detail}`;

/** The local sandbox wrapper argv: the config's laneSandbox, or the default for an in-code config (loadConfig always fills it). */
const laneSandboxCommand = (config: FlowDeps["config"]): readonly string[] => (config.laneSandbox ?? DEFAULT_LANE_SANDBOX).command;

/**
 * Whether this launch runs its agent in a sandbox. Every lane is sandboxed: a local one (--pane too) in laneSandbox.command,
 * a remote one under its runner's `sandboxed` profile. The only unsandboxed runs (`skipped`, the SANDBOX_SKIPPED note) are a
 * new lane on a Windows runner (`os`, which has no lane sandbox) or on a machine opted in with
 * `runners.<label>.allowUnsandboxed` (runner-sandbox.ts), and a relaunch of a lane recorded without a sandbox
 * (`existing`), which keeps its recorded choice. A local wrapper missing from PATH throws SANDBOX_MISSING.
 */
export const sandboxChoice = (config: FlowDeps["config"], input: LaunchInput, which: (cmd: string) => string | null, existing?: Pick<Lane, "sandbox">, os?: string): { readonly on: boolean; readonly skipped?: string } => {
  if (existing && !existing.sandbox) return { on: false, skipped: "relaunch of a lane recorded without a sandbox" };
  if (input.machine) {
    const why = existing ? undefined : unsandboxedReason(config, machineRunner(input.machine), os);
    if (why) return { on: false, skipped: `machine ${input.machine} ${why}; this lane runs WITHOUT a sandbox` };
    return { on: true };
  }
  const exe = laneSandboxCommand(config)[0] ?? "";
  if (!which(exe)) throw new SandboxRefusal("SANDBOX_MISSING", input.key, `${exe} is not on PATH; install scripts/templates/lane-sandbox.sh as ${exe} or set laneSandbox.command (dori doctor shows it)`);
  return { on: true };
};

/** Runs `<laneSandbox.command> --check` once before a sandboxed local start; a wrapper that cannot sandbox throws SANDBOX_BROKEN. */
const checkLocalSandbox = async (deps: FlowDeps, key: string): Promise<void> => {
  const argv = [...laneSandboxCommand(deps.config), "--check"];
  const ran = await deps.run(argv);
  if (ran.code !== 0) throw new SandboxRefusal("SANDBOX_BROKEN", key, `${argv.join(" ")} failed (exit ${ran.code}): ${(ran.err || ran.out).replace(/\s+/g, " ").trim() || "no output"}; fix the sandbox (dori doctor shows it) before launching`);
};

/**
 * The runner refused the start for its sandbox rules: no `sandboxed` profile (`RUNNER_CMD_REJECTED agent-profile sandboxed`),
 * sandbox required (`... sandbox-required sandbox:false`), or its async sandbox check failed (`RUNNER_CMD_FAILED
 * RUNNER_CMD_REJECTED sandbox-unavailable <why>`). Matched as substrings, since the wrapping differs by path.
 */
const SANDBOX_RULE = /agent-profile|sandbox-required|sandbox-unavailable/;

const runnerSandboxRefusal = (key: string, machine: string | undefined, error: unknown): SandboxRefusal | undefined => {
  const detail = error instanceof LaneOpsError ? error.detail : error instanceof Error ? error.message : String(error);
  if (!SANDBOX_RULE.test(`${detail} ${error instanceof Error ? error.message : ""}`)) return undefined;
  const label = machineRunner(machine);
  return new SandboxRefusal("SANDBOX_UNAVAILABLE", key, `${machine ? `machine ${machine}` : "this host's runner"} refused the sandboxed start (${detail.replace(/\s+/g, " ").trim()}); install lane-sandbox on that runner (dori runner install), or opt the machine in with runners.${label}.allowUnsandboxed in the lead config and set "sandbox": "optional" in its runner-config.json`);
};

/**
 * Starts a lane through its runner (`lane.start`): the lane is reserved (paused, with a token), its brief gets the
 * footer, and the runner opens the pane (a new tab, or the checked target pane), runs the agent from its own profile
 * (`sandboxed` for a sandboxed lane), and confirms the startup. The returned pane is recorded on the lane.
 * `existing` relaunches a registered lane (recovery) without a reservation, keeping its recorded sandbox choice.
 * A lane that cannot be sandboxed is refused with a SandboxRefusal (sandboxChoice, checkLocalSandbox, runnerSandboxRefusal).
 */
export const launchLane = async (deps: FlowDeps, input: LaunchInput, existing?: Lane): Promise<{ readonly lane: Lane; readonly startup: string; readonly notes: readonly string[] }> => {
  const model = input.model ?? deps.config.defaultModel;
  const mode = input.mode ?? "ulw";
  if (!existing) await validateLaunch(deps, input);
  const os = input.machine ? (deps.runnerOs ?? ((label) => runnerOs(deps.config.stateDir, label)))(machineRunner(input.machine)) : undefined;
  const choice = sandboxChoice(deps.config, input, deps.which ?? Bun.which, existing, os);
  const sandbox = choice.on;
  // All attachment reads and declaration validation precede reservations, workspace creation and brief writes.
  const prepared = await prepareLeadLaneBrief(deps, {
    ...(existing ?? {}), key: input.key, title: input.title, thread: normalizeThreadRef(input.thread ?? "none"),
    brief: input.brief, done: input.done, openedAt: existing?.openedAt ?? iso(deps.clock), ...(input.machine ? { machine: input.machine } : {}),
  }, undefined, Boolean(existing));
  if (sandbox && !input.machine) await checkLocalSandbox(deps, input.key);
  const target = input.pane || input.workspace ? await resolveTargetPane(deps, input) : undefined;
  const notes = [...prepared.notes, ...(choice.skipped ? [`SANDBOX_SKIPPED ${input.key}: ${choice.skipped}`] : [])];
  const tabWorkspace = target || input.machine ? undefined : await laneTabWorkspace(deps, (line) => { notes.push(line); });
  const dir = input.cwd ?? target?.cwd;
  // The lead's leadCwd (a local directory) means nothing on another machine: without --cwd the start names none and that machine's
  // runner starts the lane in its own directory (~/.dori/runner/lanes/<key>), reporting the directory back in the result.
  const cwd = dir ?? (input.machine ? undefined : deps.config.leadCwd);
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  let draft: SharedThreadLane = {
    ...(existing ?? {}), key: input.key, title: input.title, thread: normalizeThreadRef(input.thread ?? "none"), ...(input.machine ? { machine: input.machine } : {}),
    runner: machineRunner(input.machine), runnerAdoptedAt: existing?.runnerAdoptedAt ?? deps.clock.now(),
    brief: input.brief, done: input.done, autoClose: prepared.autoClose, ghIssue: prepared.ghIssue,
    ...(!existing ? { fileRun: prepared.files.run } : {}),
    reportVia: "cli" as const, // every lane reports through its runner; an old-footer lane moves onto dori report when recovery relaunches it
    ...laneDirs(input.machine, dir, deps.config.leadCwd), ...(sandbox ? { sandbox: true as const } : {}), model, mode, openedAt: existing?.openedAt ?? iso(deps.clock),
  };
  const token = existing ? undefined : randomUUID();
  if (token) draft = await reserveLane(deps, input, draft, token);
  let started = false;
  let proposalPersisted = false;
  const cmdId = `lane-start:${input.key}:${deps.clock.now()}`;
  try {
    const brief = prepared.briefText;
    if (existing) {
      await deps.registry.update(input.key, (current) => {
        if (!current || current.closedAt || (current.runner !== undefined && current.runner !== draft.runner)
          || current.fileRun?.id !== existing.fileRun?.id || current.pendingFileRun?.id !== existing.pendingFileRun?.id)
          throw new LaunchError(`lane ${input.key} changed during launch preparation`);
        proposalPersisted = true;
        return { ...current, runner: draft.runner, pendingFileRun: prepared.files.run, recoveryPending: true,
          fileProposal: { cmdId, runId: prepared.files.run.id, prior: recoveryFields(current) },
          recoveryAfter: runnerJournalHead(deps.config.stateDir), recoveryPreviousPane: current.pane };
      });
    }
    // Only a fresh launch decides what recovery may ship again; it lives where no lane can write.
    if (!existing) writeLaneAttachmentPin(deps.config.stateDir, input.key, prepared.sources);
    // The lead-side brief keeps the footer for reference; the runner writes its own copy on the lane's host.
    await Bun.write(input.brief, brief);
    const start: StartInput = {
      key: input.key, cmdId, briefText: brief, files: prepared.files, done: input.done, thread: draft.thread, ...(cwd !== undefined ? { cwd } : {}), sandbox, mode, model,
      keywords: mode === "mass-ulw" ? deps.tunables.massLaunchKeywords : deps.tunables.launchKeywords,
      ...(input.machine ? { machine: input.machine } : { heavySlots: deps.config.heavySlots, heavyMaxLoad: deps.config.heavyMaxLoad }),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(target ? { target: { pane: target.pane } } : {}),
      ...(tabWorkspace ? { tabWorkspace } : {}),
    };
    let result;
    try {
      result = await deps.ops.start(start);
    } catch (error) {
      const leaf = /(?:LANE_FILES_|LANE_REPORT_)[A-Z_]+ [^\r\n]*/.exec(error instanceof Error ? error.message : String(error))?.[0];
      if (leaf) throw new LaunchError(leaf);
      // A sandbox refusal started nothing, whatever error shape carried it.
      const refusal = runnerSandboxRefusal(input.key, input.machine, error);
      if (refusal) throw refusal;
      if (nothingStarted(error)) throw new LaunchError(`${input.key}: ${error instanceof Error ? error.message : String(error)}`);
      started = true; // a timeout or an ambiguous answer: the runner may have started the agent, so the reservation stays visible
      if (token) {
        // Marked unconfirmed, the runner's late lane.started confirms the reservation (lanes-hub.ts); one already in confirms it now.
        await deps.registry.update(input.key, (current) => {
          if (!current || current.launchReservation !== token) return undefined;
          return current.pane
            ? { ...current, status: current.status === "paused" ? draft.status : current.status, launchReservation: undefined }
            : { ...current, launchUnconfirmed: true };
        });
      }
      throw new LaunchError(`${input.key}: the start may have happened (${error instanceof Error ? error.message : String(error)}); the lane stays reserved and paused: check dori status, or cancel it with dori close ${input.key} --cancelled --reason TEXT`);
    }
    started = true;
    const lane: Lane = { ...draft, ...(input.machine && !dir && result.cwd ? { remoteCwd: result.cwd } : {}), fileRun: prepared.files.run, pendingFileRun: undefined, pane: result.pane, ...(result.tab ? { tab: result.tab } : target?.tab ? { tab: target.tab } : {}) };
    // A relaunch writes only what this launch changed, so a pause or objection that landed meanwhile survives.
    const launched = (current: Lane): Lane => existing
      ? { ...current, ...Object.fromEntries(Object.entries(lane).filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)), key: lane.key } as Lane
      : { ...current, ...lane, status: current.status === "paused" ? lane.status : current.status, launchReservation: undefined };
    await deps.registry.update(lane.key, (current) => {
      if (existing && current?.pendingFileRun?.id !== prepared.files.run.id && current?.fileRun?.id !== prepared.files.run.id) return undefined;
      if (existing && current?.fileRun?.id === prepared.files.run.id && !current.pendingFileRun) return undefined;
      if (token && current?.launchReservation !== token) throw new LaunchError(`lane ${lane.key} lost its launch reservation`);
      const next = current ? launched(current) : lane;
      return { ...next, pendingFileRun: undefined, fileProposal: undefined, recoveryPending: undefined, recoveryAfter: undefined, recoveryPreviousPane: undefined };
    });
    return { lane: await deps.registry.read(lane.key) ?? lane, notes, startup: startupLine(input.key, result.pane, result.startup) };
  } catch (error) {
    if (token && !started) await deps.registry.releaseReservation(input.key, token);
    if (existing && proposalPersisted && !started) await restoreFileProposal(deps, input.key, prepared.files.run.id, existing);
    throw error;
  }
};

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
