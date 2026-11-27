import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { LaneOpsError, machineRunner, type StartInput } from "./lane-ops.ts";
import { LANE_KEY, type Lane, type LaneMode } from "./registry.ts";
import { iso } from "./run.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";
import { runnerOs } from "./runner-sandbox.ts";
import type { StartupVerdict } from "./runner/protocol.ts";
import { doneRepos, doneSyntaxErrors } from "./signals.ts";
import { normalizeThreadRef } from "./messenger/target.ts";
import { acquireStateLock } from "./state-lock.ts";
import { threadIdOf } from "./thread-finality.ts";
import { githubRepoFromRemote } from "./git-remote.ts";
import { briefBody, FILE_FOOTER_HEADING, prepareLaneAttachment, prepareLaneBrief, readLaneAttachmentPin, writeLaneAttachmentPin } from "./lane-files.ts";
import { LaneFileError } from "./lane-file-contract.ts";
import { runnerJournalHead } from "./runner/lanes-hub.ts";
import type { LaneBriefFiles } from "./runner/protocol.ts";
import type { RecoveryLane } from "./recover.ts";
import { footer } from "./launch-footer.ts";
import { checkLocalSandbox, runnerSandboxRefusal, sandboxChoice } from "./launch-sandbox.ts";

// The startup check runs inside the runner's lane.start; re-exported for its callers.
export { screenLines, startupFailure, STARTUP_POLL_MS, STARTUP_POLLS, STARTUP_READY_READS } from "./runner/lane-control.ts";

/** Return the follow-up instruction when startup did not succeed. */
export function launchNextLine(key: string, startup: string): string | undefined {
  return startup.startsWith("STARTUP_OK")
    ? undefined
    : `LAUNCH_NEXT the lane is registered; cancel it with dori close ${key} --cancelled --reason TEXT before relaunching`;
}

export type LaunchInput = {
  /** Internal review launch; selects the review profile (it takes an ordinary lane slot). */
  readonly review?: true;
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  /** Opening keywords: `ulw` (default, `launchKeywords`) or `mass-ulw` (`massLaunchKeywords`). */
  readonly mode?: LaneMode;
  readonly cwd?: string;
  readonly machine?: string;
  /** Allow a second open lane on the same messenger thread (`--share-thread`); the lanes are recorded in `threadSharedWith`. */
  readonly shareThread?: boolean;
  /** Allow a cwd whose git remotes name none of the Done line's repos (`--allow-repo-mismatch`). */
  readonly allowRepoMismatch?: boolean;
  /** `--sandbox` (or a relaunch of a lane recorded as sandboxed): every lane is sandboxed by default now, so this changes nothing. */
  readonly sandbox?: true;
  /** Resume this agent session (recovery): the runner inserts `--session <id>` when its profile allows. */
  readonly session?: string;
  /** The Toodo task id (`--task`), recorded on the lane as `task`. */
  readonly task?: number;
  /** `--grant NAME` (repeatable): names in the lane's runner's runner-config `grants`, recorded on the lane as `grants`. */
  readonly grants?: readonly string[];
};

/** A `--task` value: a positive integer in decimal, else undefined. Toodo itself is not asked whether the task exists. */
export const parseLaneTask = (value: string): number | undefined => {
  if (!/^[1-9]\d*$/.test(value.trim())) return undefined;
  const id = Number(value.trim());
  return Number.isSafeInteger(id) ? id : undefined;
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
  if (input.task !== undefined && !(Number.isSafeInteger(input.task) && input.task > 0)) throw new LaunchError(`--task must be a positive integer (a Toodo task id), got ${input.task}`);
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
 * lane-sandbox mounts a read-only tmpfs there and hides the state dir, so no directory under it can be bound as the
 * lane's cwd. A remote lane's directory is on its own machine.
 */
const sandboxedCwdInDoriHome = (deps: FlowDeps, input: LaunchInput): string | undefined => {
  if (!input.cwd || input.machine) return undefined;
  const state = resolve(deps.config.stateDir);
  const home = basename(state) === "state" && basename(dirname(state)) === ".dori" ? dirname(state) : join(homedir(), ".dori"); // the sandbox always uses $HOME/.dori
  const cwd = resolve(input.cwd);
  return within(cwd, home) ? home : undefined;
};

/** Open lanes on the input's thread, by thread id: `discord:<thread>` and `discord:<channel>/<thread>` are the same thread. */
const threadSharers = async (deps: FlowDeps, input: LaunchInput): Promise<string[]> =>
  !input.thread || input.thread === "none" ? [] : (await deps.registry.open()).filter((l) => l.key !== input.key && l.thread !== "none" && threadIdOf(l.thread) === threadIdOf(input.thread ?? "")).map((l) => l.key);

/** owner/repo from a git remote URL (https, ssh or scp form), lowercased. */
export const remoteRepo = (url: string): string | undefined =>
  githubRepoFromRemote(url);

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

/**
 * `dori attach`: adds lead files to a running lane's briefs/<key>.files through its runner and returns one
 * `LANE_FILES_ATTACHED` line per named path, with the path the lane reads it at. A relaunch rebuilds that directory from
 * the brief, so added files last until the lane is recovered.
 */
export const attachLaneFiles = async (deps: FlowDeps, lane: Lane, paths: readonly string[]): Promise<string[]> => {
  if (!lane.fileRun) throw new LaunchError(`LANE_ATTACH_UNMANAGED ${lane.key}: this lane was not launched with lane files (adopted or launched by an older dori); relaunch it to attach files`);
  let prepared: ReturnType<typeof prepareLaneAttachment>;
  try { prepared = prepareLaneAttachment({ key: lane.key, stateDir: deps.config.stateDir, paths }); }
  catch (e) { if (e instanceof LaneFileError) throw new LaunchError(e.message); throw e; }
  const { dir } = await deps.ops.attach(lane, prepared.tree);
  // The runner's own separator: a Windows runner answers a backslash path.
  const sep = /^[A-Za-z]:\\/.test(dir) ? "\\" : "/";
  return prepared.targets.map((t) => `LANE_FILES_ATTACHED ${lane.key}: ${JSON.stringify(t.source)} -> ${JSON.stringify([dir, ...t.target.split("/")].join(sep))}`);
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
 * A `--grant` launch its runner refused for the grant: a name its table lacks or a path it may not name (`grant-unknown`,
 * `grant-path`, `grant-unsandboxed`), or a runner too old to know grants at all (`unknown-field ...grants`).
 */
const grantRefusal = (input: LaunchInput, error: unknown): string | undefined => {
  if (!input.grants?.length) return undefined;
  const text = error instanceof Error ? error.message : String(error);
  const where = input.machine ? `machine ${input.machine}` : "this host's runner";
  // The start's only field an older runner lacks is grants: its refusal names the rule, not the field.
  if (/RUNNER_CMD_REJECTED unknown-field/.test(text)) {
    return `LAUNCH_GRANT_UNSUPPORTED ${input.key}: ${where} predates --grant (${text.replace(/\s+/g, " ").trim()}); run dori runner update there, or launch without --grant`;
  }
  const rule = /RUNNER_CMD_REJECTED (grant-[a-z]+)[^\r\n]*/.exec(text);
  return rule ? `LAUNCH_GRANT_REFUSED ${input.key}: ${where} refused --grant ${input.grants.join(",")} (${rule[0]}); the owner edits its runner-config.json grants table` : undefined;
};

/** Where a lane's directory lives: a remote path is kept apart from the local cwd that signals and git checks use. */
const laneDirs = (machine: string | undefined, dir: string | undefined, leadCwd: string): Pick<Lane, "cwd" | "remoteCwd"> =>
  machine ? (dir ? { remoteCwd: dir } : {}) : { cwd: dir ?? leadCwd };

/** The lane fields a launch and an adoption both record; a relaunch (`existing`) keeps its other fields and its recorded times. */
const baseDraft = (deps: FlowDeps, input: LaunchInput, dir: string | undefined, existing?: Lane): Lane => ({
  ...(existing ?? {}), key: input.key, title: input.title, thread: normalizeThreadRef(input.thread ?? "none"), ...(input.machine ? { machine: input.machine } : {}),
  runner: machineRunner(input.machine), runnerAdoptedAt: existing?.runnerAdoptedAt ?? deps.clock.now(),
  brief: input.brief, done: input.done, ...laneDirs(input.machine, dir, deps.config.leadCwd), openedAt: existing?.openedAt ?? iso(deps.clock),
});

/** The hint for a pane id this host's runner does not hold: lanes without --machine are local lanes. */
const REMOTE_PANE_HINT = "a pane on another machine needs --machine LABEL";

/** A runner failure that leaves nothing started (refused, failed, or a runner that was never reached): the reservation can go. */
const nothingStarted = (e: unknown): boolean =>
  e instanceof LaneOpsError && (e.code === "LANE_OP_FAILED" || e.code === "RUNNER_OUTDATED" || (e.code === "RUNNER_UNAVAILABLE" && e.detail.startsWith("disconnected")));

/**
 * Registers an existing pane as a lane: the lane's runner takes the pane over (`lane.adopt`, which checks the pane is on
 * its host and issues the lane token). Without --machine the lane is local, so the local runner must see the pane.
 */
export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  const draft: Lane = { ...baseDraft(deps, input, input.cwd), pane: input.pane, ...(await autoCloseOf(input.brief)) };
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

/** The STARTUP_OK / STARTUP_ERROR / STARTUP_UNCONFIRMED line of a runner's startup verdict for `pane`. */
export const startupLine = (key: string, pane: string, startup: StartupVerdict): string =>
  startup.verdict === "ok" ? `STARTUP_OK ${key} ${pane}` : `STARTUP_${startup.verdict === "error" ? "ERROR" : "UNCONFIRMED"} ${key} ${pane}: ${startup.detail}`;

type PreparedBrief = Awaited<ReturnType<typeof prepareLeadLaneBrief>>;

/** How far a launch got, for its cleanup: whether the runner may have started the agent, and whether a relaunch's file proposal was written. */
type LaunchProgress = { started: boolean; proposalPersisted: boolean };

/** A relaunch records its pending file run and recovery proposal before the start, refusing a lane that changed meanwhile. */
const persistRecoveryProposal = async (deps: FlowDeps, input: LaunchInput, existing: Lane, draft: Lane, prepared: PreparedBrief, cmdId: string, progress: LaunchProgress): Promise<void> => {
  await deps.registry.update(input.key, (current) => {
    if (!current || current.closedAt || (current.runner !== undefined && current.runner !== draft.runner)
      || current.fileRun?.id !== existing.fileRun?.id || current.pendingFileRun?.id !== existing.pendingFileRun?.id)
      throw new LaunchError(`lane ${input.key} changed during launch preparation`);
    progress.proposalPersisted = true;
    return { ...current, runner: draft.runner, pendingFileRun: prepared.files.run, recoveryPending: true,
      fileProposal: { cmdId, runId: prepared.files.run.id, prior: recoveryFields(current) },
      recoveryAfter: runnerJournalHead(deps.config.stateDir), recoveryPreviousPane: current.pane };
  });
};

/** Maps a failed runner start to the error the launch throws; an ambiguous failure keeps the reservation, marked unconfirmed. */
const startFailure = async (deps: FlowDeps, input: LaunchInput, error: unknown, token: string | undefined, draft: Lane, progress: LaunchProgress): Promise<never> => {
  const leaf = /(?:LANE_FILES_|LANE_REPORT_)[A-Z_]+ [^\r\n]*/.exec(error instanceof Error ? error.message : String(error))?.[0];
  if (leaf) throw new LaunchError(leaf);
  const grantHint = grantRefusal(input, error);
  if (grantHint) throw new LaunchError(grantHint);
  // A sandbox refusal started nothing, whatever error shape carried it.
  const refusal = runnerSandboxRefusal(input.key, input.machine, error);
  if (refusal) throw refusal;
  if (nothingStarted(error)) throw new LaunchError(`${input.key}: ${error instanceof Error ? error.message : String(error)}`);
  progress.started = true; // a timeout or an ambiguous answer: the runner may have started the agent, so the reservation stays visible
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
};

/** Records the started lane in the registry and returns it as the registry now holds it. */
const commitLaunched = async (deps: FlowDeps, lane: Lane, existing: Lane | undefined, token: string | undefined, prepared: PreparedBrief): Promise<Lane> => {
  // A relaunch writes only what this launch changed, so a pause or objection that landed meanwhile survives.
  const launched = (current: Lane): Lane => existing
    ? { ...current, ...Object.fromEntries(Object.entries(lane).filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)), key: lane.key } as Lane
    : { ...current, ...lane, status: current.status === "paused" ? lane.status : current.status, launchReservation: undefined };
  await deps.registry.update(lane.key, (current) => {
    if (existing && current?.pendingFileRun?.id !== prepared.files.run.id && current?.fileRun?.id !== prepared.files.run.id) return undefined;
    // The run's lane.started landed first and confirmed it: only a model the runner reported in place of the stored one is left.
    if (existing && current?.fileRun?.id === prepared.files.run.id && !current.pendingFileRun) {
      return current.closedAt || lane.model === existing.model || current.model === lane.model ? undefined : { ...current, model: lane.model };
    }
    if (token && current?.launchReservation !== token) throw new LaunchError(`lane ${lane.key} lost its launch reservation`);
    const next = current ? launched(current) : lane;
    return { ...next, pendingFileRun: undefined, fileProposal: undefined, recoveryPending: undefined, recoveryAfter: undefined, recoveryPreviousPane: undefined };
  });
  return await deps.registry.read(lane.key) ?? lane;
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
  if (input.grants?.length && !sandbox) throw new LaunchError(`LAUNCH_GRANT_REFUSED ${input.key}: --grant needs a sandboxed lane (${choice.skipped ?? "no sandbox"})`);
  // All attachment reads and declaration validation precede reservations and brief writes.
  const prepared = await prepareLeadLaneBrief(deps, {
    ...(existing ?? {}), key: input.key, title: input.title, thread: normalizeThreadRef(input.thread ?? "none"),
    brief: input.brief, done: input.done, openedAt: existing?.openedAt ?? iso(deps.clock), ...(input.machine ? { machine: input.machine } : {}),
    ...(sandbox ? { sandbox: true as const } : {}), ...(input.grants?.length ? { grants: input.grants } : {}),
  }, undefined, Boolean(existing));
  if (sandbox && !input.machine) await checkLocalSandbox(deps, input.key);
  const notes = [...prepared.notes, ...(choice.skipped ? [`SANDBOX_SKIPPED ${input.key}: ${choice.skipped}`] : [])];
  const dir = input.cwd;
  // The lead's leadCwd (a local directory) means nothing on another machine: without --cwd the start names none and that machine's
  // runner starts the lane in its own directory (~/.dori/runner/lanes/<key>), reporting the directory back in the result.
  const cwd = dir ?? (input.machine ? undefined : deps.config.leadCwd);
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  let draft: SharedThreadLane = {
    ...baseDraft(deps, input, dir, existing), autoClose: prepared.autoClose, ghIssue: prepared.ghIssue,
    ...(input.task !== undefined ? { task: input.task } : {}),
    ...(input.review ? { review: true as const } : {}),
    ...(!existing ? { fileRun: prepared.files.run } : {}),
    reportVia: "cli" as const, // every lane reports through its runner; an old-footer lane moves onto dori report when recovery relaunches it
    ...(sandbox ? { sandbox: true as const } : {}), ...(input.grants?.length ? { grants: input.grants } : {}), model, mode,
  };
  const token = existing ? undefined : randomUUID();
  if (token) draft = await reserveLane(deps, input, draft, token);
  const progress: LaunchProgress = { started: false, proposalPersisted: false };
  const cmdId = `lane-start:${input.key}:${deps.clock.now()}`;
  try {
    const brief = prepared.briefText;
    if (existing) await persistRecoveryProposal(deps, input, existing, draft, prepared, cmdId, progress);
    // Only a fresh launch decides what recovery may ship again; it lives where no lane can write.
    if (!existing) writeLaneAttachmentPin(deps.config.stateDir, input.key, prepared.sources);
    // The lead-side brief keeps the footer for reference; the runner writes its own copy on the lane's host.
    await Bun.write(input.brief, brief);
    const start: StartInput = {
      key: input.key, cmdId, briefText: brief, files: prepared.files, done: input.done, thread: draft.thread, ...(cwd !== undefined ? { cwd } : {}), sandbox, mode, model,
      ...((input.review ?? existing?.review) ? { review: true as const } : {}),
      keywords: mode === "mass-ulw" ? deps.tunables.massLaunchKeywords : deps.tunables.launchKeywords,
      ...(input.machine ? { machine: input.machine } : { heavySlots: deps.config.heavySlots, heavyMaxLoad: deps.config.heavyMaxLoad }),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.grants?.length ? { grants: input.grants } : {}),
    };
    let result;
    try {
      result = await deps.ops.start(start);
    } catch (error) {
      return await startFailure(deps, input, error, token, draft, progress);
    }
    progress.started = true;
    // A runner profile that pins its own model runs that one instead of `model`: recovery judges the lane against it.
    const lane: Lane = { ...draft, ...(result.model ? { model: result.model } : {}), ...(input.machine && !dir && result.cwd ? { remoteCwd: result.cwd } : {}), fileRun: prepared.files.run, pendingFileRun: undefined, pane: result.pane, ...(result.tab ? { tab: result.tab } : {}) };
    return { lane: await commitLaunched(deps, lane, existing, token, prepared), notes, startup: startupLine(input.key, result.pane, result.startup) };
  } catch (error) {
    if (token && !progress.started) await deps.registry.releaseReservation(input.key, token);
    if (existing && progress.proposalPersisted && !progress.started) await restoreFileProposal(deps, input.key, prepared.files.run.id, existing);
    throw error;
  }
};
