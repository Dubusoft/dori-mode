import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Proc } from "../lane-memory.ts";
import { ASK_SCREEN_LINES, askingLine, screenQuestion, type ScreenQuestion } from "../ask-user.ts";
import { listPanes, paneAlive, readScreen, sendGuarded, sendVerified, type Pane } from "../panes.ts";
import type { Clock, Runner } from "../run.ts";
import { agentArgv, argvModel, outsideDenyRules, quote, removeLegacyLaneMcp } from "./lane-launch.ts";
import { ensureRunnerSubdir, RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import { pause, resume, resumeArgv, startupPoll } from "./lane-control.ts";
import { checkCwd, effectiveWorktreeRoot, laneCwd, rejectionText, resolveGrants, runnerPaths, runtimeDirOption, type RunnerPolicy } from "./policy.ts";
import { sessionRuntime } from "../runtime/index.ts";
import { addInput, captureOutput, laneFilePaths, prepareInput, removeLaneTree, validateBriefFiles, type FileReaders } from "./lane-files.ts";
import { checkLaneFilesBody, LaneFileError, treeDigest } from "../lane-file-contract.ts";
import { laneProcessAlive, turnStop } from "./observe.ts";
import { STARTUP_GRACE_MS } from "./serve.ts";
import type {
  CommandResults, InventoryLane, LaneDeadReason, LaneStatus, PauseStep, RunnerEventBodies, RunnerEventType, StartupVerdict, SupervisorCommandBodies,
  TurnEvidence, LaneBriefFiles, LaneFileRun, LaneOutputFiles,
} from "./protocol.ts";

export { LANE_SOCKET, type LaneRequest, type LaneSocketLanes, serveLaneSocket } from "./lane-socket.ts";

/**
 * The lanes a runner starts and owns on its host (design 3.3, 3.4, 9.1 P3b; runner-audit design 2.3, 4).
 *
 * `lane.start` opens an hc terminal labelled with the lane key, writes the
 * brief to `~/.dori/runner/briefs/<key>.md` (not /tmp), issues the lane a fresh 32-byte token, writes it to
 * `briefs/<key>.<gen>.token` (0600, one file per launch generation) and runs the agent of the requested profile from the runner's policy with
 * `DO_NOT_TRACK=1`, `DORI_LANE_KEY` and `DORI_LANE_TOKEN_FILE` (and `DORI_HEAVY_SLOTS` / `DORI_HEAVY_MAX_LOAD` when given, and
 * `LANE_SANDBOX_REPOS` / `LANE_SANDBOX_WORKTREES` when the policy has a repos or worktree root) in front of it,
 * so the token itself is never on a command line (shell history, process listings). Only the token's sha256 is kept,
 * in `lanes.json` (0600) with the lane's pane, tab and cwd; that file is the hello inventory. The agent runs inside
 * the hc terminal, not as a child of the runner, so a runner restart does not end it. After the agent is admitted the
 * startup poll (lane-control.ts) judges whether it came up.
 *
 * `lane.adopt` takes an existing pane as a lane and issues it a token file; `lane.notify` stores the status the
 * supervisor holds for the lane (`notice`), which the lane reads with `dori lane status` over the lane socket
 * (lane-socket.ts). `lane.close` and `lane.stop` close the pane and, once the pane list no longer shows it,
 * delete the brief and the token file and forget the token. `askTick` reads each owned lane's pane for an on-screen
 * question (the same `screenQuestion` the supervisor's ask-user sweep uses) and publishes one `lane.asking` per distinct question.
 *
 * Turn evidence (read-only): each pass and each `lane.observe` notes whether an owned lane's turn runs. A live lane
 * seen stopped after a running turn (or stopped for the first time after its startup window) gets one new
 * `turnStop` record for its generation: how the turn ended, what holds the lane, and whether a continuation is
 * pending (observe.ts `turnStop`). The same stop is never recorded twice, across runner restarts too (lanes.json);
 * `lane.observe` answers an idle lane's last stop, so the supervisor can tell an aborted turn from an owner pause or
 * an intended end before it recovers anything. Nothing is typed into the pane for it.
 */

export const LANES_FILE = "lanes.json";

type Publish = <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;

/** The lane's status as the supervisor last pushed it (`lane.notify`), answered to the lane's `dori lane status`. */
export type LaneNotice = {
  readonly status: string;
  readonly objection?: { readonly at: string; readonly reasons: readonly string[] };
  readonly claim?: { readonly at: string; readonly evidence: string };
};

export type LaneRecord = {
  readonly sandbox?: boolean;
  /** POSIX env and wrapper before the agent argv; absent in records written before pane run support. */
  readonly sandboxPrefix?: string;
  readonly fileRun?: LaneFileRun;
  readonly fileRevision?: number;
  readonly fileDigest?: string;
  readonly key: string;
  readonly pane: string;
  /** Always "" for an hc terminal (no tabs); kept because the hello inventory and lane events carry it. */
  readonly tab: string;
  readonly cwd: string;
  readonly tokenHash: string;
  readonly profile: string;
  readonly mode: string;
  readonly model: string;
  readonly startedAt: number;
  /** The hc server instance the lane was opened on; another instance's same address is another terminal. */
  readonly hcInstance: string;
  readonly terminalId?: string;
  /** The pid of the pane's shell at launch; seeds the memory sampler's lane attribution. Absent when hc did not report it. */
  readonly shellPid?: number;
  /** The on-screen question last published as `lane.asking` (see `questionKey`), absent when none is showing. */
  readonly lastAsk?: string;
  /** Opening keywords of the start (absent: the mode's default), reused by a relaunch. */
  readonly keywords?: string;
  readonly heavySlots?: number;
  readonly heavyMaxLoad?: number;
  /** The runner-config `grants` names of the start, resolved again against the current policy by a relaunch. */
  readonly grants?: readonly string[];
  /** The status the supervisor last pushed with `lane.notify`. */
  readonly notice?: LaneNotice;
  /** A pane the runner took over with `lane.adopt` rather than started; it has no brief or profile to relaunch from. */
  readonly adopted?: true;
  /** The launch generation: its token is in `briefs/<key>.<gen>.token`. Absent (adopted, or an older runner's record): `briefs/<key>.token`. */
  readonly gen?: number;
  /** A turn was seen running since `turnStop` was recorded. */
  readonly turnRunning?: true;
  /** The last stopped turn of this generation; a launch starts a record without it. */
  readonly turnStop?: TurnEvidence;
};

export type RunnerLanesDeps = {
  readonly fileReaders?: Partial<FileReaders>;
  readonly remote?: boolean;
  readonly procs?: () => Promise<readonly Proc[]>;
  readonly runnerDir: string;
  readonly run: Runner;
  readonly clock: Clock;
  readonly policy: RunnerPolicy;
  readonly publish: Publish;
  readonly token?: () => string;
  /** The startup verdict of a just-admitted agent (default: lane-control.ts `startupPoll`). */
  readonly startup?: (pane: string) => Promise<StartupVerdict>;
  /** Removes a stale lane `.omo/mcp.json` in the lane's cwd before the agent starts (default: `removeLegacyLaneMcp`). */
  readonly legacyMcp?: (cwd: string) => Promise<boolean>;
  /** Resolves a pane's directory for the allowedRoots check (default `fs.realpathSync`). */
  readonly realpath?: (path: string) => string;
  /** Runs before each start without holding it up: on macOS the BrowserSkill window check (browser-window.ts). */
  readonly browserCheck?: (key: string) => Promise<void>;
};

export type Effect<T extends keyof CommandResults> = { readonly detail: string; readonly result: CommandResults[T] };

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
/** One question across ticks, like ask-user's own key: header, text and options, not the pending count. */
const questionKey = (q: ScreenQuestion): string =>
  createHash("sha256").update(JSON.stringify(q.tabs && q.tabs.length > 1 ? [q.tabs] : [q.header ?? "", q.question, q.options])).digest("hex").slice(0, 16);
/** The agent profile of a review lane: always sandboxed, launched with `LANE_SANDBOX_PROFILE=review` (lane-sandbox.sh). */
export const REVIEW_PROFILE = "review";

/** Whether a lane of `profile` (with its recorded `sandbox` flag) runs in the lane sandbox; a review lane always does. */
export const sandboxedLane = (profile: string, sandbox?: boolean): boolean =>
  sandbox === true || profile === "sandboxed" || profile === REVIEW_PROFILE;

/** What a launch needs; a relaunch takes it from the record. */
type LaunchInput = {
  readonly sandbox?: boolean;
  readonly fileRun?: LaneFileRun;
  readonly mayStart?: (value: boolean) => void;
  readonly key: string; readonly cwd: string; readonly profile: string; readonly mode: string; readonly model: string;
  readonly keywords?: string; readonly session?: string;
  readonly heavySlots?: number; readonly heavyMaxLoad?: number;
  readonly grants?: readonly string[];
};
type LaunchOptions = Pick<LaunchInput, "keywords" | "session" | "heavySlots" | "heavyMaxLoad" | "grants">;
/** The optional `LaunchInput` fields a start body or a lane record carries, each set only when present (no explicit undefined). */
const launchOptions = (o: { [K in keyof LaunchOptions]?: LaunchOptions[K] | undefined }): LaunchOptions => ({
  ...(o.keywords !== undefined ? { keywords: o.keywords } : {}), ...(o.session !== undefined ? { session: o.session } : {}),
  ...(o.heavySlots !== undefined ? { heavySlots: o.heavySlots } : {}), ...(o.heavyMaxLoad !== undefined ? { heavyMaxLoad: o.heavyMaxLoad } : {}),
  ...(o.grants?.length ? { grants: o.grants } : {}),
});
/** `model`: the model the agent argv names (a profile may pin its own over the requested one). */
type Launched = { readonly pane: string; readonly resumed: boolean; readonly startup: StartupVerdict; readonly cwd: string; readonly model?: string };

export class RunnerLanes {
  constructor(private readonly deps: RunnerLanesDeps) {}

  /**
   * `outsideDenyRules` for this host: what a sandboxed lane may also reach, its own `cwd` (named, not left to omo's
   * working directory), the runner directory (its brief, attachments, output and the lane-mode dori), the repos and
   * worktree roots, the temp directory and omo's own ~/.omo.
   */
  private outsideRules(cwd: string): string {
    const paths = runnerPaths();
    const { policy } = this.deps;
    const dirs = [cwd, this.deps.runnerDir, policy.reposRoot, effectiveWorktreeRoot(policy), tmpdir(), paths.join(homedir(), ".omo")];
    return outsideDenyRules(dirs.filter((dir): dir is string => dir !== undefined), paths.join);
  }

  /** The running hc server's identity (stored in a record's `hcInstance`). */
  private instance(): Promise<string | undefined> {
    return sessionRuntime(this.deps.run).instance();
  }

  /**
   * The lane's live pane, or undefined when it is gone: another hc instance, not listed, or another terminal at that
   * address. `knownInstance` is the hc server's, when the caller already read it.
   */
  async currentPane(record: LaneRecord, panes?: readonly Pane[], knownInstance?: string): Promise<Pane | undefined> {
    const instance = knownInstance ?? await this.instance();
    if (!instance || record.hcInstance !== instance) return undefined;
    const pane = (panes ?? await sessionRuntime(this.deps.run).listPanes()).find((p) => p.pane_id === record.pane);
    return pane && (!record.terminalId || record.terminalId === pane.terminal_id) ? pane : undefined;
  }

  private async requirePane(record: LaneRecord): Promise<void> {
    if (!await this.currentPane(record)) throw new Error(`RUNNER_LANE_ABSENT ${record.key} pane ${record.pane} is gone`);
  }

  private get file(): string { return join(this.deps.runnerDir, LANES_FILE); }

  records(): Record<string, LaneRecord> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, LaneRecord>) : {};
  }

  private save(records: Record<string, LaneRecord>): void {
    writeRunnerFile(this.file, `${JSON.stringify(records, null, 2)}\n`);
  }

  briefPath(key: string): string {
    return join(this.deps.runnerDir, RUNNER_PATHS.briefs, `${key}.md`);
  }

  /**
   * The lane's current token file, next to its brief in the owner-only briefs directory: each launch generation has its
   * own (`<key>.<gen>.token`), so a session from before a relaunch, which keeps re-reading its old DORI_LANE_TOKEN_FILE,
   * finds no token once that file is deleted. An adopted lane (never relaunched) keeps the stable `<key>.token`.
   */
  tokenPath(key: string): string {
    return this.tokenFileOf(key, this.records()[key]?.gen);
  }

  private tokenFileOf(key: string, gen: number | undefined): string {
    return join(this.deps.runnerDir, RUNNER_PATHS.briefs, gen === undefined ? `${key}.token` : `${key}.${gen}.token`);
  }

  private newToken(): string {
    return (this.deps.token ?? (() => randomBytes(32).toString("base64url")))();
  }

  /** Deletes the lane's brief and both token files (generation `gen` and the stable adopted one), and its file trees when `trees`. */
  private forgetLaneFiles(key: string, gen: number | undefined, trees: boolean): void {
    rmSync(this.briefPath(key), { force: true });
    rmSync(this.tokenFileOf(key, gen), { force: true });
    rmSync(this.tokenFileOf(key, undefined), { force: true });
    if (!trees) return;
    const paths = laneFilePaths(this.deps.runnerDir, key);
    for (const path of [paths.input, paths.output, paths.stage]) removeLaneTree(this.deps.runnerDir, path);
  }

  /** Throws `RUNNER_CMD_REJECTED <rule>` when a pane directory found on this host is not under the policy's allowedRoots. */
  private checkPaneCwd(cwd: string): void {
    const refused = checkCwd(this.deps.policy, cwd, this.deps.realpath ?? realpathSync);
    if (refused) throw new Error(`${rejectionText(refused.rule)} ${refused.detail}`);
  }

  /**
   * Runs the policy's `sandboxCheck` (when set) before a sandboxed start writes or opens anything: a wrapper that cannot
   * sandbox on this host (no bwrap, user namespaces off) would otherwise run the agent unsandboxed or not at all.
   * Throws `RUNNER_CMD_REJECTED sandbox-unavailable <stderr>`, the shape checkPaneCwd uses, so the lead sees the rule.
   */
  private async checkSandbox(key: string): Promise<void> {
    const argv = this.deps.policy.sandboxCheck;
    if (!argv?.length) throw new LaneFileError("LANE_FILES_SANDBOX_CHECK_MISSING", key,
      `no sandboxCheck argv is configured; add "sandboxCheck": [<wrapper>, "--check"] to ${JSON.stringify(join(this.deps.runnerDir, "runner-config.json"))} using the sandbox wrapper argv, then retry`);
    let why: string | undefined;
    let marker = false;
    try {
      const ran = await this.deps.run(argv, { timeoutMs: 30_000 });
      if (ran.code !== 0) why = ran.err.trim() || ran.out.trim() || `${argv.join(" ")} exited ${ran.code}`;
      marker = ran.out.split(/\r?\n/).includes("DORI_LANE_FILES=1");
    } catch (e) { why = `${argv.join(" ")}: ${e instanceof Error ? e.message : String(e)}`; }
    if (why !== undefined) throw new Error(`${rejectionText("sandbox-unavailable")} ${why}`);
    if (!marker) throw new LaneFileError("LANE_FILES_SANDBOX_OLD", key,
      "sandboxCheck succeeded without DORI_LANE_FILES=1; run dori runner update and refresh the maintained lane-sandbox wrapper, or update the configured custom wrapper to grant own-key .files read-only and .out read-write and print DORI_LANE_FILES=1 after its successful --check; then retry");
  }

  inventory(): InventoryLane[] {
    return Object.values(this.records()).map((r) => ({ key: r.key, pane: r.pane, tab: r.tab }));
  }

  /** Whether `token` is the one issued to lane `key`, compared in constant time. */
  tokenFor(key: string, token: string): boolean {
    const record = this.records()[key];
    if (!record) return false;
    const want = Buffer.from(record.tokenHash, "hex");
    const got = Buffer.from(hash(token), "hex");
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** The status the supervisor last pushed for lane `key` (`lane.notify`), if any. */
  notice(key: string): LaneNotice | undefined {
    return this.records()[key]?.notice;
  }

  /** The key of the lane whose record holds `pane` (adopt refuses a pane another lane holds). */
  keyForPane(pane: string): string | undefined {
    return Object.values(this.records()).find((r) => r.pane === pane)?.key;
  }

  /** The working directory recorded for lane `key`, if the runner owns it. */
  cwdOf(key: string): string | undefined {
    return this.records()[key]?.cwd;
  }

  reportFiles(key: string): LaneOutputFiles | undefined {
    const record = this.record(key);
    if (!record.fileRun) return undefined;
    const tree = captureOutput(this.deps.runnerDir, key, record.fileRun, this.deps.remote, this.deps.fileReaders);
    const sha256 = treeDigest(tree);
    const revision = record.fileDigest === sha256 ? record.fileRevision! : (record.fileRevision ?? 0) + 1;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new LaneFileError("LANE_FILES_INVALID", key, "invalid file payload (revision); regenerate the brief or report and retry");
    try { this.update(key, (r) => ({ ...r, fileRevision: revision, fileDigest: sha256 })); }
    catch { throw new LaneFileError("LANE_REPORT_STORE_FAILED", key, "the complete report was not stored by the runner; fix runner disk space and permissions, then claim done again"); }
    return { run: record.fileRun, revision, sha256, tree };
  }

  async start(body: SupervisorCommandBodies["lane.start"]): Promise<Effect<"lane.start">> {
    if (this.records()[body.key]) throw new Error(`RUNNER_LANE_EXISTS ${body.key}`);
    if (!body.files) throw new LaneFileError("LANE_FILES_INPUT_REQUIRED", body.key, "this start needs a fresh lead brief and attachment scan; launch the lane again from the lead");
    validateBriefFiles(body.key, body.briefText, body.files);
    checkLaneFilesBody(body.key, body);
    // policy.ts checkCommand fills a missing cwd (the lane's own laneCwd) at dispatch; a body without one never got checked.
    const cwd = body.cwd;
    if (cwd === undefined) throw new Error(`${rejectionText("cwd-missing")} ${body.key}`);
    if (cwd === laneCwd(this.deps.runnerDir, body.key)) {
      ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.lanes);
      ensureRunnerSubdir(this.deps.runnerDir, join(RUNNER_PATHS.lanes, body.key));
    }
    if (body.sandbox || body.agentProfile === REVIEW_PROFILE) await this.checkSandbox(body.key);
    void this.deps.browserCheck?.(body.key);
    let mayStart = false;
    try {
      prepareInput(this.deps.runnerDir, body.key, body.briefText, body.files, false);
      const launched = await this.launch({
        sandbox: body.sandbox,
        fileRun: body.files.run, mayStart: (value) => { mayStart = value; },
        key: body.key, cwd, profile: body.agentProfile, mode: body.mode, model: body.model,
        ...launchOptions(body),
      });
      return { detail: `started pane=${launched.pane}`, result: {
        pane: launched.pane, tab: "", startup: launched.startup, cwd: launched.cwd, ...(launched.model ? { model: launched.model } : {}),
      } };
    } catch (error) {
      if (!mayStart && !this.records()[body.key]) this.forgetLaneFiles(body.key, 1, true);
      throw error;
    }
  }

  /** Opens the lane's hc terminal and runs its agent there; publishes `lane.started`. */
  private async launch(input: LaunchInput): Promise<Launched> {
    const { key, cwd } = input;
    const hcInstance = await this.instance();
    if (!hcInstance) throw new Error("RUNNER_HC_INSTANCE_UNKNOWN cannot identify the hc server");
    const brief = this.briefPath(key);
    const keywords = input.keywords ?? (input.mode === "mass-ulw" ? "mass-ulw" : "ulw");
    const prompt = `${keywords}. Read and execute the lane brief at ${brief} in full. You are the ${key} lane; report as the brief's footer says.`;
    const agentValues = { prompt, model: input.model, brief };
    // Grants resolve before a terminal opens: a name the table no longer has, or a path it may not name, starts nothing.
    const granted = input.grants?.length
      ? resolveGrants(this.deps.policy, input.grants, {
        home: homedir(), ...runtimeDirOption(), realpath: this.deps.realpath ?? realpathSync, isCheckout: (path) => existsSync(join(path, ".git")),
      })
      : undefined;
    const outside = sandboxedLane(input.profile, input.sandbox) ? undefined : this.outsideRules(cwd);
    const argv = agentArgv(this.deps.policy, input.profile, agentValues, input.session, outside);
    const resumed = input.session !== undefined && resumeArgv(this.deps.policy.agents[input.profile] ?? [], input.session) !== undefined;
    const runtime = sessionRuntime(this.deps.run);
    const { pane, terminalId, shellPid } = await runtime.open({ key, cwd });
    await (this.deps.legacyMcp ?? removeLegacyLaneMcp)(cwd);
    const token = this.newToken();
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    const previous = this.records()[key];
    const gen = (previous?.gen ?? 0) + 1;
    const tokenFile = this.tokenFileOf(key, gen);
    writeRunnerFile(tokenFile, token);
    const { command, sandboxPrefix } = this.buildLaunchCommand(input, argv, tokenFile, granted);
    input.mayStart?.(true);
    const ran = await runtime.run(pane, command);
    if (ran.code !== 0) {
      input.mayStart?.(false);
      rmSync(tokenFile, { force: true });
      await runtime.close(pane);
      throw new Error(`hc send failed: ${(ran.err || ran.out).trim()}`);
    }
    this.save({
      ...this.records(),
      [key]: {
        key, pane, tab: "", cwd, tokenHash: hash(token), profile: input.profile, mode: input.mode, model: input.model, startedAt: this.deps.clock.now(), gen,
        ...(input.fileRun ? { fileRun: input.fileRun } : {}),
        ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
        ...(sandboxPrefix !== undefined ? { sandboxPrefix } : {}),
        hcInstance, ...(terminalId ? { terminalId } : {}), ...(shellPid ? { shellPid } : {}),
        ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
        ...(input.heavySlots !== undefined ? { heavySlots: input.heavySlots } : {}), ...(input.heavyMaxLoad !== undefined ? { heavyMaxLoad: input.heavyMaxLoad } : {}),
        ...(input.grants?.length ? { grants: input.grants } : {}),
      },
    });
    // The replaced generation's token is forgotten (its hash went with the old record) and its file deleted.
    if (previous) rmSync(this.tokenFileOf(key, previous.gen), { force: true });
    this.deps.publish("lane.started", { key, pane, tab: "", session: "", ...(input.fileRun ? { fileRun: input.fileRun } : {}) });
    const startup = await (this.deps.startup?.(pane) ?? startupPoll(
      { run: this.deps.run, clock: this.deps.clock }, pane,
      !resumed && argv.includes(prompt) ? (run) => laneProcessAlive(run, pane, key) : undefined,
    ));
    const model = argvModel(argv);
    return { pane, resumed, startup, cwd, ...(model ? { model } : {}) };
  }

  /** Builds the POSIX launch line and the sandbox wrapper argv for commands running with the same lane permissions. */
  private buildLaunchCommand(
    input: LaunchInput, argv: readonly string[], tokenFile: string, granted: ReturnType<typeof resolveGrants> | undefined,
  ): { readonly command: string; readonly sandboxPrefix: string | undefined } {
    const { key } = input;
    const review = input.profile === REVIEW_PROFILE;
    const worktreeRoot = effectiveWorktreeRoot(this.deps.policy);
    const env = [
      // omo 5.1.84+ asks a first-run telemetry consent question on screen; a lane cannot answer it (and a sandboxed
      // lane may not keep the answer), so every lane starts opted out and never stops at that dialog.
      "DO_NOT_TRACK=1",
      `DORI_LANE_KEY=${quote(key)}`, `DORI_LANE_TOKEN_FILE=${quote(tokenFile)}`,
      ...(input.fileRun ? [`DORI_LANE_OUT=${quote(laneFilePaths(this.deps.runnerDir, key).output)}`] : []),
      ...(input.heavySlots !== undefined ? [`DORI_HEAVY_SLOTS=${input.heavySlots}`] : []),
      ...(input.heavyMaxLoad !== undefined ? [`DORI_HEAVY_MAX_LOAD=${input.heavyMaxLoad}`] : []),
      // A review lane writes no worktree, repo or grant: it gets the review profile and none of the rw roots below.
      ...(review ? [`LANE_SANDBOX_PROFILE=${REVIEW_PROFILE}`] : []),
      // Where a lane started without --cwd makes its worktree; the macOS lane-sandbox makes them writable.
      ...(!review && this.deps.policy.reposRoot !== undefined ? [`LANE_SANDBOX_REPOS=${quote(this.deps.policy.reposRoot)}`] : []),
      ...(!review && worktreeRoot !== undefined ? [`LANE_SANDBOX_WORKTREES=${quote(worktreeRoot)}`] : []),
      // The lane's runner-config grants: the wrapper binds these on top of its own, under its hide list.
      ...(!review && granted?.write.length ? [`LANE_SANDBOX_RW=${quote(granted.write.join(":"))}`] : []),
      ...(granted?.read.length ? [`LANE_SANDBOX_RO=${quote(granted.read.join(":"))}`] : []),
    ];
    const wrapper = this.deps.policy.sandboxCheck?.slice(0, -1) ?? [];
    // A sandboxed lane gets the wrapper its start was checked with even when its profile names it another way
    // (a bare `lane-sandbox`, a `~` path) or puts something before it. An unsandboxed lane gets it only when
    // its argv runs behind that wrapper.
    const sandboxPrefix = wrapper.length > 0 && (sandboxedLane(input.profile, input.sandbox) || wrapper.every((part, at) => argv[at] === part))
      ? ["env", ...env, ...wrapper.map(quote)].join(" ")
      : undefined;
    // Only the value of each assignment is quoted, so /bin/sh still reads KEY=value as an assignment.
    const command = `export ${env.join(" ")}; eval "$(${quote(this.deps.remote ? join(this.deps.runnerDir, "bin", "dori") : "dori")} secret env)"; ${argv.map(quote).join(" ")}`;
    return { command, sandboxPrefix };
  }

  private record(key: string): LaneRecord {
    const record = this.records()[key];
    if (!record) throw new Error(`RUNNER_LANE_UNKNOWN ${key}`);
    return record;
  }

  private update(key: string, change: (record: LaneRecord) => LaneRecord): void {
    const records = this.records();
    const current = records[key];
    if (current) this.save({ ...records, [key]: change(current) });
  }

  /**
   * Takes the existing hc terminal `pane` of this host as lane `key`: hc must list it (`RUNNER_LANE_PANE_MISSING`) and it
   * must belong to no other lane. Issues a token into `briefs/<key>.token`;
   * the lane has no token variable, so the lane CLI reads that file by key.
   */
  async adopt(body: SupervisorCommandBodies["lane.adopt"]): Promise<Effect<"lane.adopt">> {
    if (this.records()[body.key]) throw new Error(`RUNNER_LANE_EXISTS ${body.key}`);
    const owner = this.keyForPane(body.pane);
    if (owner) throw new Error(`RUNNER_LANE_TARGET_BUSY pane ${body.pane} is already lane ${owner}`);
    const hcInstance = await this.instance();
    if (!hcInstance) throw new Error("RUNNER_HC_INSTANCE_UNKNOWN cannot identify the hc server");
    const info = (await sessionRuntime(this.deps.run).listPanes()).find((p) => p.pane_id === body.pane);
    if (!info) throw new Error(`RUNNER_LANE_PANE_MISSING pane ${body.pane} is not an hc terminal on this host`);
    // The pane's own directory is where the lane works, whatever body.cwd (already checked at dispatch) says.
    const paneCwd = info.cwd;
    if (paneCwd === undefined && body.cwd === undefined) throw new Error(`${rejectionText("cwd-missing")} pane ${body.pane} reports no directory`);
    for (const dir of [body.cwd, paneCwd]) if (dir !== undefined) this.checkPaneCwd(dir);
    const cwd = body.cwd ?? paneCwd ?? "";
    const token = this.newToken();
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    const tokenFile = this.tokenPath(body.key);
    writeRunnerFile(tokenFile, token);
    this.save({
      ...this.records(),
      [body.key]: { key: body.key, pane: body.pane, tab: "", cwd, tokenHash: hash(token), profile: "", mode: body.mode, model: body.model, startedAt: this.deps.clock.now(), adopted: true, hcInstance, ...(info.terminal_id ? { terminalId: info.terminal_id } : {}) },
    });
    this.deps.publish("lane.started", { key: body.key, pane: body.pane, tab: "", session: "" });
    return { detail: `adopted pane=${body.pane}`, result: { pane: body.pane, tab: "", tokenFile } };
  }

  /** Stores the status the supervisor holds for the lane, answered to the lane's `dori lane status`. */
  async notify(body: SupervisorCommandBodies["lane.notify"]): Promise<Effect<"lane.notify">> {
    this.record(body.key);
    const notice: LaneNotice = { status: body.status, ...(body.objection ? { objection: body.objection } : {}), ...(body.claim ? { claim: body.claim } : {}) };
    this.update(body.key, (r) => ({ ...r, notice }));
    return { detail: `noted ${body.status}`, result: {} };
  }

  /** Adds lead files to a running lane's briefs/<key>.files (`dori attach`); only a lane started with lane files has one. */
  async attach(body: SupervisorCommandBodies["lane.attach"]): Promise<Effect<"lane.attach">> {
    const record = this.record(body.key);
    if (!record.fileRun) throw new LaneFileError("LANE_ATTACH_UNMANAGED", body.key, "this lane was not started with lane files (adopted or started by an older dori); relaunch it from the lead to attach files");
    checkLaneFilesBody(body.key, body);
    const dir = addInput(this.deps.runnerDir, body.key, body.tree);
    return { detail: `attached files=${body.tree.files.length} dir=${dir}`, result: { dir } };
  }

  /**
   * Closes the lane's terminal and reads the pane list back (`gone`); only once the pane is gone are its brief and token
   * file deleted and its token forgotten. A pane still listed keeps the lane's record.
   */
  async close(key: string): Promise<Effect<"lane.close">> {
    const record = this.record(key);
    const current = await this.currentPane(record);
    const closed: "pane" | "none" = current ? "pane" : "none";
    if (current) await sessionRuntime(this.deps.run).close(record.pane);
    let gone = !current;
    try { if (current) gone = !(await sessionRuntime(this.deps.run).listPanes()).some((p) => p.pane_id === record.pane); }
    catch { gone = false; }
    // A pane still listed (or a list that cannot be read) may still run the agent: its record and token stay, so it can
    // still report and a later close can reach it.
    if (!gone) return { detail: `close left pane=${record.pane} listed; lane kept`, result: { closed, gone } };
    this.forgetLaneFiles(key, record.gen, record.fileRun !== undefined);
    const { [key]: _gone, ...rest } = this.records();
    this.save(rest);
    return { detail: current ? `closed pane=${record.pane}` : "closed none", result: { closed, gone } };
  }

  /**
   * Types `text` into the lane. `verified` (the default) confirms delivery from the pane (`sendVerified`); `guarded`
   * types through the same guard without waiting (`sendGuarded`, delivery `sent`). With `refuseWhileAsking` a lane
   * showing a question prompt (`lastAsk`) gets nothing: `{delivery: "failed", refusal}`. A send the pane did not take
   * throws `RUNNER_LANE_SEND_FAILED` with the reason the pane gave (other text in its input line, no prompt, ...).
   */
  async send(key: string, text: string, verify: boolean, opts: { readonly mode?: "verified" | "guarded"; readonly refuseWhileAsking?: boolean } = {}): Promise<Effect<"lane.send">> {
    const record = this.record(key);
    if (opts.refuseWhileAsking && record.lastAsk) {
      return { detail: `refused asking`, result: { delivery: "failed", refusal: `RUNNER_LANE_ASKING ${key} shows a question prompt; not typed` } };
    }
    await this.requirePane(record);
    let refusal: string | undefined;
    const delivery = opts.mode === "guarded"
      ? await sendGuarded(this.deps.run, record.pane, text)
      : await sendVerified(this.deps.run, this.deps.clock, record.pane, text, verify, (why) => { refusal = why; });
    if (delivery === "failed") throw new Error(`RUNNER_LANE_SEND_FAILED ${key}${refusal ? `: ${refusal}` : ""}`);
    return { detail: `sent ${delivery}`, result: { delivery } };
  }

  /** `lane.pause` on the lane's pane (lane-control.ts `pause`). */
  async pause(key: string, step: PauseStep = "both"): Promise<Effect<"lane.pause">> {
    await this.requirePane(this.record(key));
    const result = await pause({ run: this.deps.run, clock: this.deps.clock }, this.record(key).pane, step);
    return { detail: `paused ${step} goal=${result.goal ?? "-"} working=${result.working ?? "-"} stopped=${result.stopped ?? "-"}`, result };
  }

  /** `lane.resume` on the lane's pane (lane-control.ts `resume`). */
  async resume(key: string): Promise<Effect<"lane.resume">> {
    await this.requirePane(this.record(key));
    const result = await resume({ run: this.deps.run, clock: this.deps.clock }, this.record(key).pane);
    return { detail: `resumed goal=${result.goal}`, result };
  }

  /** A fresh pane's agent reads unknown until it first reports its state: a lane this young is still starting. */
  private starting(record: { readonly startedAt: number }): boolean {
    return this.deps.clock.now() - record.startedAt < STARTUP_GRACE_MS;
  }

  /** Whether the lane's agent process still runs in `pane` though hc no longer detects it (observe.ts `laneProcessAlive`). */
  private processAlive(key: string, pane: Pane | undefined): Promise<boolean> {
    return pane ? laneProcessAlive(this.deps.run, pane.pane_id, key, this.deps.procs) : Promise.resolve(false);
  }

  async observe(key: string): Promise<Effect<"lane.observe">> {
    const record = this.record(key);
    const pane = await this.currentPane(record);
    // The same alive test as serve.ts observeHost, so the runner and the supervisor call one pane the same: hc's
    // agent status, and the lane's agent process when hc misses it.
    let status: LaneStatus = !pane ? "missing" : !paneAlive(pane) ? "dead" : pane.agent_status === "working" ? "working" : "idle";
    if (status === "dead" && await this.processAlive(key, pane)) status = "idle";
    const reason: LaneDeadReason | undefined = !pane ? "pane-missing" : undefined;
    // A dead agent is answered but published only by the serve loop, which holds it back through the startup and dead
    // grace windows (serve.ts serveRunner); a one-off read here would skip them.
    if (status !== "dead") this.deps.publish("lane.state", { key, status, pane: record.pane, ...(reason ? { reason } : {}) });
    if (!pane) throw new Error(`RUNNER_LANE_ABSENT ${key} pane ${record.pane} is gone`);
    await this.noteTurn(record, pane);
    const turn = status === "idle" ? this.records()[key]?.turnStop : undefined;
    return { detail: `observed ${status}`, result: { status, ...(turn ? { turn } : {}) } };
  }

  /**
   * Notes the lane's turn: a working pane marks a turn running; a stopped live pane after a running turn (or with no
   * stop recorded yet, once past its startup window) records the next stop from its screen (`screen`, else read here).
   * An unreadable or empty screen records nothing, so the next pass tries again.
   */
  private async noteTurn(record: LaneRecord, pane: Pane, screen?: string): Promise<void> {
    if (!paneAlive(pane)) return;
    if (pane.agent_status === "working") {
      if (!record.turnRunning) this.update(record.key, (r) => ({ ...r, turnRunning: true }));
      return;
    }
    if ((record.turnStop && !record.turnRunning) || this.starting(record)) return;
    const text = screen ?? await readScreen(this.deps.run, record.pane, ASK_SCREEN_LINES).catch(() => "");
    if (!text.trim()) return;
    const evidence: TurnEvidence = {
      gen: record.gen ?? 0, stop: (record.turnStop?.stop ?? 0) + 1, at: this.deps.clock.now(), ...turnStop(text, screenQuestion(text) !== null),
    };
    this.update(record.key, ({ turnRunning: _ran, ...rest }) => ({ ...rest, turnStop: evidence }));
  }

  /**
   * Starts the lane again from its brief when its pane or agent is gone (`paneAlive`); a live lane is left alone. The old
   * record stays until the relaunch has a new pane, so a failed relaunch throws and a later recover can retry it. A live
   * lane publishes `lane.started` for its current record, which completes the supervisor's pending recovery. `session`
   * resumes that agent session when the profile allows (`resumed` says whether it did).
   */
  async recover(key: string, session?: string, briefText?: string, files?: LaneBriefFiles): Promise<Effect<"lane.recover">> {
    const record = this.record(key);
    if ((briefText === undefined) !== (files === undefined)) throw new LaneFileError("LANE_FILES_INVALID", key, "invalid file payload (recover-pair); regenerate the brief or report and retry");
    const pane = await this.currentPane(record);
    // A pane still in its startup window whose agent has not reported yet is starting, not dead: closing its terminal would
    // kill the launch in progress, so it is left alone like a live one. So is a pane whose agent process still runs.
    const alive = paneAlive(pane) || await this.processAlive(key, pane);
    if (alive || (pane && this.starting(record))) {
      this.deps.publish("lane.started", { key, pane: record.pane, tab: record.tab, session: "", ...(record.fileRun ? { fileRun: record.fileRun } : {}) });
      return { detail: `${alive ? "alive" : "starting"} pane=${record.pane}`, result: { pane: record.pane, tab: record.tab, relaunched: false, resumed: false } };
    }
    if (record.adopted) throw new Error(`RUNNER_LANE_ADOPTED ${key} was adopted, not started here; it has no brief or profile to relaunch from`);
    if (briefText === undefined || files === undefined) throw new LaneFileError("LANE_FILES_RECOVER_INPUT_REQUIRED", key, "recovery needs a fresh lead brief and attachment scan; recover the lane again from the lead");
    validateBriefFiles(key, briefText, files);
    if (sandboxedLane(record.profile, record.sandbox)) await this.checkSandbox(key);
    prepareInput(this.deps.runnerDir, key, briefText, files, true);
    // The dead terminal (its shell left behind) is removed before the relaunch opens a new one.
    if (pane) await sessionRuntime(this.deps.run).close(record.pane);
    const launched = await this.launch({
      sandbox: record.sandbox,
      fileRun: files.run,
      key, cwd: record.cwd, profile: record.profile, mode: record.mode, model: record.model,
      ...launchOptions({ ...record, session }),
    });
    // The relaunch replaced the record; a notice the supervisor pushed stays with the lane.
    if (record.notice) this.update(key, (r) => ({ ...r, notice: record.notice as LaneNotice }));
    return {
      detail: `started pane=${launched.pane}`,
      result: { pane: launched.pane, tab: "", relaunched: true, resumed: launched.resumed, startup: launched.startup, ...(launched.model ? { model: launched.model } : {}) },
    };
  }

  /**
   * One pass over the owned lanes: a question prompt on a lane's screen not published yet goes out as `lane.asking`
   * and is remembered in the record (`lastAsk`); a lane whose prompt is gone forgets it, so its next question goes out
   * again. An empty or failed screen read changes nothing. Returns the keys published.
   */
  async askTick(panes?: readonly Pane[], instance?: string): Promise<string[]> {
    const asked: string[] = [];
    const records = this.records();
    const next = { ...records };
    let changed = false;
    for (const record of Object.values(records)) {
      const pane = await this.currentPane(record, panes, instance);
      if (!pane) continue;
      const screen = await readScreen(this.deps.run, record.pane, ASK_SCREEN_LINES).catch(() => "");
      await this.noteTurn(record, pane, screen);
      if (!screen.trim()) continue;
      const q = screenQuestion(screen);
      const seen = q ? questionKey(q) : undefined;
      if (seen === record.lastAsk) continue;
      if (q) { this.deps.publish("lane.asking", { key: record.key, text: askingLine(record.key, q) }); asked.push(record.key); }
      const current = next[record.key];
      if (current) {
        const { lastAsk: _was, ...rest } = current;
        next[record.key] = seen ? { ...rest, lastAsk: seen } : rest;
        changed = true;
      }
    }
    if (changed) this.save(next);
    return asked;
  }
}
