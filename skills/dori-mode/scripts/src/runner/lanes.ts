import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureLaneWorkspace } from "../managed-panes.ts";
import { procLanes, sampleProcs, type Proc } from "../lane-memory.ts";
import { ASK_SCREEN_LINES, askingLine, screenQuestion, type ScreenQuestion } from "../ask-user.ts";
import { listPanes, paneAlive, readScreen, sendGuarded, sendVerified, type Pane } from "../panes.ts";
import type { Clock, Runner } from "../run.ts";
import { ensureRunnerSubdir, RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import { cmdRefused, inspectCreated, type PaneShell, pause, resolveTargetPane, resume, resumeArgv, startupPoll, TargetError } from "./lane-control.ts";
import { checkCwd, rejectionText, type RunnerPolicy } from "./policy.ts";
import { herdrProcess } from "./herdr-watch.ts";
import { turnStop } from "./observe.ts";
import { STARTUP_GRACE_MS } from "./serve.ts";
import type {
  CommandResults, InventoryLane, LaneDeadReason, LaneStatus, PauseStep, ProcessInfo, RunnerEventBodies, RunnerEventType, StartupVerdict, SupervisorCommandBodies,
  TurnEvidence,
} from "./protocol.ts";

export { LANE_SOCKET, type LaneRequest, type LaneSocketLanes, serveLaneSocket } from "./lane-socket.ts";

/**
 * The lanes a runner starts and owns on its host (design 3.3, 3.4, 9.1 P3b; runner-audit design 2.3, 4).
 *
 * `lane.start` opens a herdr tab labelled with the lane key (or takes the idle shell pane `target` names), writes the
 * brief to `~/.dori/runner/briefs/<key>.md` (not /tmp), issues the lane a fresh 32-byte token, writes it to
 * `briefs/<key>.<gen>.token` (0600, one file per launch generation) and runs the agent of the requested profile from the runner's policy with
 * `DORI_LANE_KEY` and `DORI_LANE_TOKEN_FILE` (and `DORI_HEAVY_SLOTS` / `DORI_HEAVY_MAX_LOAD` when given) in front of it,
 * so the token itself is never on a command line (shell history, process listings). Only the token's sha256 is kept,
 * in `lanes.json` (0600) with the lane's pane, tab and cwd; that file is the hello inventory. The agent runs inside
 * the herdr pane, not as a child of the runner, so a runner restart does not end it. After the agent is admitted the
 * startup poll (lane-control.ts) judges whether it came up.
 *
 * `lane.adopt` takes an existing pane as a lane and issues it a token file; `lane.notify` stores the status the
 * supervisor holds for the lane (`notice`), which the lane reads with `dori lane status` over the lane socket
 * (lane-socket.ts). `lane.close` and `lane.stop` close the tab (else the pane), delete the brief and the token file and
 * forget the token. `askTick` reads each owned lane's pane for an on-screen question (the same `screenQuestion` the
 * supervisor's ask-user sweep uses) and publishes one `lane.asking` per distinct question.
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
  readonly key: string;
  readonly pane: string;
  readonly tab: string;
  readonly cwd: string;
  readonly tokenHash: string;
  readonly profile: string;
  readonly mode: string;
  readonly model: string;
  readonly startedAt: number;
  readonly herdrInstance?: string;
  readonly terminalId?: string;
  /** The pid of the pane's shell (herdr process-info `shell_pid`) at launch; seeds the memory sampler's lane attribution. Absent when herdr did not report it. */
  readonly shellPid?: number;
  /** The on-screen question last published as `lane.asking` (see `questionKey`), absent when none is showing. */
  readonly lastAsk?: string;
  /** Opening keywords of the start (absent: the mode's default), reused by a relaunch. */
  readonly keywords?: string;
  /** The herdr workspace the lane's tab was opened in (absent: herdr's focused one), reused by a relaunch. */
  readonly tabWorkspace?: string;
  readonly heavySlots?: number;
  readonly heavyMaxLoad?: number;
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
  readonly instance?: () => Promise<string | undefined>;
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
};

export type Effect<T extends keyof CommandResults> = { readonly detail: string; readonly result: CommandResults[T] };

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
/** One question across ticks, like ask-user's own key: header, text and options, not the pending count. */
const questionKey = (q: ScreenQuestion): string =>
  createHash("sha256").update(JSON.stringify(q.tabs && q.tabs.length > 1 ? [q.tabs] : [q.header ?? "", q.question, q.options])).digest("hex").slice(0, 16);
const quote = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The line typed into a PowerShell pane: a nested `<shell> -NoLogo -EncodedCommand <base64(utf16le(script))>`, so the
 * variables live only in the nested process and the typed text is plain base64. Windows PowerShell 5.1 mangles native
 * arguments containing a double quote, so it is refused there (`RUNNER_LANE_ARGV_UNSAFE`); pwsh passes them intact.
 */
export const powershellLaunchLine = (shell: "pwsh" | "powershell", env: readonly (readonly [string, string])[], argv: readonly string[]): string => {
  if (shell === "powershell" && argv.some((arg) => arg.includes('"'))) {
    throw new Error("RUNNER_LANE_ARGV_UNSAFE Windows PowerShell 5.1 cannot pass an argument containing a double quote; use pwsh");
  }
  const [program, ...args] = argv;
  const script = [
    ...env.map(([name, value]) => `$env:${name}=${psQuote(value)}`),
    "$env:PSExecutionPolicyPreference='Bypass'",
    `& ${[program ?? "", ...args].map(psQuote).join(" ")}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  return `${shell} -NoLogo -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
};

/** The old lane `.omo/mcp.json` (figma disabled) that launch.ts used to write; the same bytes as `LEGACY_LANE_MCP` there. */
export const LEGACY_LANE_MCP = `${JSON.stringify({ mcpServers: { figma: { enabled: false, url: "https://mcp.figma.com/mcp" } } }, null, 2)}\n`;

/**
 * Removes a `.omo/mcp.json` in `cwd` that is byte-for-byte the old lane file, so an old worktree stops keeping figma
 * off; a user's own file is never touched. Runs on the lane's host before the agent starts (moved from launch.ts).
 */
export const removeLegacyLaneMcp = async (cwd: string): Promise<boolean> => {
  const file = Bun.file(join(cwd, ".omo", "mcp.json"));
  try {
    if (!(await file.exists()) || (await file.text()) !== LEGACY_LANE_MCP) return false;
    await file.delete();
    return true;
  } catch { return false; } // unremovable: the lane still launches as before
};

/** The agent argv of `profile`, each `{prompt}`, `{model}` and `{brief}` filled in; `session` resumes it when the profile allows (`resumeArgv`). */
export const agentArgv = (
  policy: RunnerPolicy, profile: string, values: { readonly prompt: string; readonly model: string; readonly brief: string }, session?: string,
): string[] => {
  const template = policy.agents[profile];
  if (!template?.length) throw new Error(`RUNNER_LANE_PROFILE_UNKNOWN ${profile}`);
  const parts = resumeArgv(template, session) ?? template;
  return parts.map((part) => part.replaceAll("{prompt}", values.prompt).replaceAll("{model}", values.model).replaceAll("{brief}", values.brief));
};

/** What a launch needs; a relaunch takes it from the record. */
type LaunchInput = {
  readonly key: string; readonly cwd: string; readonly profile: string; readonly mode: string; readonly model: string;
  readonly keywords?: string; readonly session?: string; readonly target?: { readonly pane?: string; readonly workspace?: string };
  readonly heavySlots?: number; readonly heavyMaxLoad?: number; readonly tabWorkspace?: string;
  readonly restored?: boolean;
};
type Launched = { readonly pane: string; readonly tab: string; readonly resumed: boolean; readonly startup: StartupVerdict };

export class RunnerLanes {
  constructor(private readonly deps: RunnerLanesDeps) {}

  private instance(): Promise<string | undefined> {
    return this.deps.instance ? this.deps.instance() : herdrProcess(this.deps.run).then((p) => p.instance);
  }

  /** Pre-proto-4 records acquire identity only from a live foreground process positively attributed to their key. */
  async currentPane(record: LaneRecord, panes?: readonly Pane[]): Promise<Pane | undefined> {
    const instance = await this.instance();
    if (!instance || record.herdrInstance && record.herdrInstance !== instance) return undefined;
    const pane = (panes ?? await listPanes(this.deps.run)).find((p) => p.pane_id === record.pane);
    if (!record.herdrInstance) {
      if (!pane) return undefined;
      const got = await this.deps.run(["herdr", "pane", "process-info", "--pane", record.pane]);
      if (got.code !== 0) return undefined;
      let info: ProcessInfo | undefined;
      try { info = (JSON.parse(got.out) as { result?: { process_info?: ProcessInfo } }).result?.process_info; } catch { return undefined; }
      const owner = procLanes(await (this.deps.procs ?? (() => sampleProcs(this.deps.run)))());
      const foreground = info?.foreground_processes ?? [];
      const attributed = foreground.some((p) => p.pid !== undefined && owner.get(p.pid) === record.key);
      if (!attributed || instance !== await this.instance()) return undefined;
      this.update(record.key, (r) => ({ ...r, herdrInstance: instance, ...(pane?.terminal_id ? { terminalId: pane.terminal_id } : {}) }));
      return pane;
    }
    return pane && (!record.terminalId || record.terminalId === pane.terminal_id) ? pane : undefined;
  }

  private async requirePane(record: LaneRecord): Promise<void> {
    if (!await this.currentPane(record)) throw new Error(`RUNNER_LANE_ABSENT ${record.key} pane ${record.pane} is gone`);
  }

  /** Reuse only a single idle shell in a tab still labelled with this lane key; leave other restored tabs alone. */
  private async restoredShell(record: LaneRecord): Promise<string | undefined> {
    if (!record.tab) return undefined;
    const panes = (await listPanes(this.deps.run)).filter((p) => p.tab_id === record.tab);
    if (panes.length !== 1 || panes[0]?.agent) return undefined;
    const listed = await this.deps.run(["herdr", "tab", "list", "--workspace", panes[0]?.workspace_id ?? ""]);
    if (listed.code !== 0) throw new Error(`herdr tab list failed: ${listed.err || listed.out}`);
    const tabs = (JSON.parse(listed.out) as { result: { tabs: { tab_id: string; label?: string }[] } }).result.tabs;
    if (!tabs.some((t) => t.tab_id === record.tab && t.label === record.key)) return undefined;
    try {
      return (await resolveTargetPane(this.deps.run, { pane: panes[0]?.pane_id }, { ownerOf: () => undefined, refuseCmd: true, requireIdleProof: true })).pane;
    } catch (e) {
      if (e instanceof TargetError) return undefined;
      throw e;
    }
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
  private async checkSandbox(): Promise<void> {
    const argv = this.deps.policy.sandboxCheck;
    if (!argv?.length) return;
    let why: string | undefined;
    try {
      const ran = await this.deps.run(argv, { timeoutMs: 30_000 });
      if (ran.code !== 0) why = ran.err.trim() || ran.out.trim() || `${argv.join(" ")} exited ${ran.code}`;
    } catch (e) { why = `${argv.join(" ")}: ${e instanceof Error ? e.message : String(e)}`; }
    if (why !== undefined) throw new Error(`${rejectionText("sandbox-unavailable")} ${why}`);
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

  /** The key of the lane whose record holds `pane` (the lane socket's `whoami`). */
  keyForPane(pane: string): string | undefined {
    return Object.values(this.records()).find((r) => r.pane === pane)?.key;
  }

  async start(body: SupervisorCommandBodies["lane.start"]): Promise<Effect<"lane.start">> {
    if (this.records()[body.key]) throw new Error(`RUNNER_LANE_EXISTS ${body.key}`);
    if (body.sandbox) await this.checkSandbox();
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    writeRunnerFile(this.briefPath(body.key), body.briefText);
    const launched = await this.launch({
      key: body.key, cwd: body.cwd, profile: body.agentProfile, mode: body.mode, model: body.model,
      ...(body.keywords !== undefined ? { keywords: body.keywords } : {}), ...(body.session !== undefined ? { session: body.session } : {}),
      ...(body.target ? { target: body.target } : {}),
      ...(body.heavySlots !== undefined ? { heavySlots: body.heavySlots } : {}), ...(body.heavyMaxLoad !== undefined ? { heavyMaxLoad: body.heavyMaxLoad } : {}),
      ...(body.tabWorkspace !== undefined ? { tabWorkspace: body.tabWorkspace } : {}),
    });
    return { detail: `started pane=${launched.pane} tab=${launched.tab}`, result: { pane: launched.pane, tab: launched.tab, startup: launched.startup } };
  }

  /** Opens the lane's pane (a new tab, or the checked `target` pane) and runs its agent there; publishes `lane.started`. */
  private async launch(input: LaunchInput): Promise<Launched> {
    const { key } = input;
    const herdrInstance = await this.instance();
    if (!herdrInstance) throw new Error("RUNNER_HERDR_INSTANCE_UNKNOWN cannot identify the herdr server");
    const brief = this.briefPath(key);
    const keywords = input.keywords ?? (input.mode === "mass-ulw" ? "mass-ulw" : "ulw");
    const prompt = `${keywords}. Read and execute the lane brief at ${brief} in full. You are the ${key} lane; report as the brief's footer says.`;
    const argv = agentArgv(this.deps.policy, input.profile, { prompt, model: input.model, brief }, input.session);
    const resumed = input.session !== undefined && resumeArgv(this.deps.policy.agents[input.profile] ?? [], input.session) !== undefined;
    let pane: string;
    let tab: string;
    let terminalId: string | undefined;
    let shell: PaneShell = "posix";
    let shellPid: number | undefined;
    let cwd = input.cwd;
    /** Closes what this launch opened; a target pane is the owner's and is left open. */
    let rollback = async (): Promise<void> => {};
    if (input.target) {
      const target = await resolveTargetPane(this.deps.run, input.target, { ownerOf: (p) => {
        const owner = this.keyForPane(p);
        return input.restored && owner === key ? undefined : owner;
      }, refuseCmd: true, ...(input.restored ? { requireIdleProof: true } : {}) });
      // The checked input cwd is replaced by the pane's own directory, so that is what must lie under allowedRoots.
      if (target.cwd !== undefined) this.checkPaneCwd(target.cwd);
      pane = target.pane;
      terminalId = target.terminalId;
      shell = target.shell;
      shellPid = target.shellPid;
      tab = target.tab ?? "";
      cwd = target.cwd ?? cwd;
    } else {
      const tabWorkspace = input.tabWorkspace ?? (this.deps.remote ? await ensureLaneWorkspace(this.deps.run, this.deps.runnerDir, input.cwd, () => {}) : undefined);
      const workspace = tabWorkspace ? ["--workspace", tabWorkspace] : [];
      const created = await this.deps.run(["herdr", "tab", "create", ...workspace, "--cwd", input.cwd, "--label", key, "--no-focus"]);
      if (created.code !== 0) throw new Error(`herdr tab create failed: ${(created.err || created.out).trim()}`);
      const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
      pane = made.root_pane.pane_id;
      tab = made.tab_id ?? made.root_pane.tab_id ?? "";
      const openedTab = tab;
      rollback = async () => { await this.deps.run(["herdr", "tab", "close", openedTab]); };
      // A cmd.exe pane cannot run the POSIX launch line: the tab is closed before anything is typed.
      const inspected = await inspectCreated(this.deps.run, pane);
      terminalId = inspected.terminalId;
      shell = inspected.shell;
      shellPid = inspected.shellPid;
      if (inspected.shell === "cmd") {
        await rollback();
        throw new TargetError("RUNNER_LANE_TARGET_INVALID", cmdRefused(pane));
      }
    }
    await (this.deps.legacyMcp ?? removeLegacyLaneMcp)(cwd);
    const token = (this.deps.token ?? (() => randomBytes(32).toString("base64url")))();
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    const previous = this.records()[key];
    const gen = (previous?.gen ?? 0) + 1;
    const tokenFile = this.tokenFileOf(key, gen);
    writeRunnerFile(tokenFile, token);
    let command: string;
    if (shell === "pwsh" || shell === "powershell") {
      try {
        command = powershellLaunchLine(shell, [
          ["DORI_LANE_KEY", key], ["DORI_LANE_TOKEN_FILE", tokenFile],
          ...(input.heavySlots !== undefined ? [["DORI_HEAVY_SLOTS", String(input.heavySlots)] as const] : []),
          ...(input.heavyMaxLoad !== undefined ? [["DORI_HEAVY_MAX_LOAD", String(input.heavyMaxLoad)] as const] : []),
        ], argv);
      } catch (e) {
        rmSync(tokenFile, { force: true });
        await rollback();
        throw e;
      }
    } else {
      const env = [
        `DORI_LANE_KEY=${quote(key)}`, `DORI_LANE_TOKEN_FILE=${quote(tokenFile)}`,
        ...(input.heavySlots !== undefined ? [`DORI_HEAVY_SLOTS=${input.heavySlots}`] : []),
        ...(input.heavyMaxLoad !== undefined ? [`DORI_HEAVY_MAX_LOAD=${input.heavyMaxLoad}`] : []),
      ];
      // Only the value of each assignment is quoted, so /bin/sh still reads KEY=value as an assignment.
      command = [...env, ...argv.map(quote)].join(" ");
    }
    const ran = await this.deps.run(["herdr", "pane", "run", pane, command]);
    if (ran.code !== 0) {
      rmSync(tokenFile, { force: true });
      await rollback();
      throw new Error(`herdr pane run failed: ${(ran.err || ran.out).trim()}`);
    }
    this.save({
      ...this.records(),
      [key]: {
        key, pane, tab, cwd, tokenHash: hash(token), profile: input.profile, mode: input.mode, model: input.model, startedAt: this.deps.clock.now(), gen,
        herdrInstance, ...(terminalId ? { terminalId } : {}), ...(shellPid ? { shellPid } : {}),
        ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
        ...(input.tabWorkspace !== undefined && (!input.target || input.restored) ? { tabWorkspace: input.tabWorkspace } : {}),
        ...(input.heavySlots !== undefined ? { heavySlots: input.heavySlots } : {}), ...(input.heavyMaxLoad !== undefined ? { heavyMaxLoad: input.heavyMaxLoad } : {}),
      },
    });
    // The replaced generation's token is forgotten (its hash went with the old record) and its file deleted.
    if (previous) rmSync(this.tokenFileOf(key, previous.gen), { force: true });
    this.deps.publish("lane.started", { key, pane, tab, session: "" });
    const startup = await (this.deps.startup ?? ((p: string) => startupPoll({ run: this.deps.run, clock: this.deps.clock }, p)))(pane);
    return { pane, tab, resumed, startup };
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
   * Takes the existing pane `pane` of this host as lane `key`: the pane must exist (`RUNNER_LANE_PANE_MISSING`) and
   * belong to no other lane. Issues a token into `briefs/<key>.token`; the lane has no token variable, so the lane CLI
   * reads that file by key.
   */
  async adopt(body: SupervisorCommandBodies["lane.adopt"]): Promise<Effect<"lane.adopt">> {
    if (this.records()[body.key]) throw new Error(`RUNNER_LANE_EXISTS ${body.key}`);
    const owner = this.keyForPane(body.pane);
    if (owner) throw new Error(`RUNNER_LANE_TARGET_BUSY pane ${body.pane} is already lane ${owner}`);
    const herdrInstance = await this.instance();
    if (!herdrInstance) throw new Error("RUNNER_HERDR_INSTANCE_UNKNOWN cannot identify the herdr server");
    const got = await this.deps.run(["herdr", "pane", "get", body.pane]);
    if (got.code !== 0) throw new Error(`RUNNER_LANE_PANE_MISSING pane ${body.pane} is not on this host: ${(got.err || got.out).trim()}`);
    let info: { tab_id?: string; cwd?: string; foreground_cwd?: string; terminal_id?: string } | undefined;
    try { info = (JSON.parse(got.out) as { result?: { pane?: typeof info } }).result?.pane; } catch { info = undefined; }
    const tab = info?.tab_id ?? "";
    // The pane's own directory is where the lane works, whatever body.cwd (already checked at dispatch) says.
    const paneCwd = info?.foreground_cwd ?? info?.cwd;
    if (paneCwd === undefined && body.cwd === undefined) throw new Error(`${rejectionText("cwd-missing")} pane ${body.pane} reports no directory`);
    for (const dir of [body.cwd, paneCwd]) if (dir !== undefined) this.checkPaneCwd(dir);
    const cwd = body.cwd ?? paneCwd ?? "";
    const token = (this.deps.token ?? (() => randomBytes(32).toString("base64url")))();
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    const tokenFile = this.tokenPath(body.key);
    writeRunnerFile(tokenFile, token);
    this.save({
      ...this.records(),
      [body.key]: { key: body.key, pane: body.pane, tab, cwd, tokenHash: hash(token), profile: "", mode: body.mode, model: body.model, startedAt: this.deps.clock.now(), adopted: true, herdrInstance, ...(info?.terminal_id ? { terminalId: info.terminal_id } : {}) },
    });
    this.deps.publish("lane.started", { key: body.key, pane: body.pane, tab, session: "" });
    return { detail: `adopted pane=${body.pane} tab=${tab}`, result: { pane: body.pane, tab, tokenFile } };
  }

  /** Stores the status the supervisor holds for the lane, answered to the lane's `dori lane status`. */
  async notify(body: SupervisorCommandBodies["lane.notify"]): Promise<Effect<"lane.notify">> {
    this.record(body.key);
    const notice: LaneNotice = { status: body.status, ...(body.objection ? { objection: body.objection } : {}), ...(body.claim ? { claim: body.claim } : {}) };
    this.update(body.key, (r) => ({ ...r, notice }));
    return { detail: `noted ${body.status}`, result: {} };
  }

  /** Closes the lane's tab (else its pane), deletes its brief and token file and forgets its token; `gone` is read back from the pane list. */
  async close(key: string): Promise<Effect<"lane.close">> {
    const record = this.record(key);
    const current = await this.currentPane(record);
    const closed: "tab" | "pane" | "none" = !current ? "none" : record.tab ? "tab" : record.pane ? "pane" : "none";
    if (closed === "tab") await this.deps.run(["herdr", "tab", "close", record.tab]);
    else if (closed === "pane") await this.deps.run(["herdr", "pane", "close", record.pane]);
    rmSync(this.briefPath(key), { force: true });
    rmSync(this.tokenFileOf(key, record.gen), { force: true });
    rmSync(this.tokenFileOf(key, undefined), { force: true });
    const { [key]: _gone, ...rest } = this.records();
    this.save(rest);
    let gone = !current;
    try { if (current) gone = !(await listPanes(this.deps.run)).some((p) => p.pane_id === record.pane || (record.tab !== "" && p.tab_id === record.tab)); }
    catch { gone = false; }
    return { detail: closed === "tab" ? `closed tab=${record.tab}` : closed === "pane" ? `closed pane=${record.pane}` : "closed none", result: { closed, gone } };
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

  /** herdr names a fresh pane's agent unknown until its integration first reports: a lane this young is still starting. */
  private starting(record: { readonly startedAt: number }): boolean {
    return this.deps.clock.now() - record.startedAt < STARTUP_GRACE_MS;
  }

  async observe(key: string): Promise<Effect<"lane.observe">> {
    const record = this.record(key);
    const pane = await this.currentPane(record);
    // The same alive test as serve.ts laneStatus, so the runner and the supervisor call one pane the same.
    const status: LaneStatus = !pane ? "missing" : !paneAlive(pane) ? "dead" : pane.agent_status === "working" ? "working" : "idle";
    const reason: LaneDeadReason | undefined = !pane ? "pane-missing" : status === "dead" ? "agent-gone" : undefined;
    // herdr names a fresh pane's agent unknown until its integration first reports: a lane started less than
    // STARTUP_GRACE_MS ago whose pane is there is still starting, so its dead is answered but not published.
    const starting = reason === "agent-gone" && this.starting(record);
    if (!starting) this.deps.publish("lane.state", { key, status, pane: record.pane, ...(reason ? { reason } : {}) });
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
  async recover(key: string, session?: string, tabWorkspace?: string): Promise<Effect<"lane.recover">> {
    const record = this.record(key);
    const panes = await listPanes(this.deps.run);
    const pane = await this.currentPane(record, panes);
    // A pane still in its startup window whose agent has not reported yet is starting, not dead: closing its tab would
    // kill the launch in progress, so it is left alone like a live one.
    if (paneAlive(pane) || (pane && this.starting(record))) {
      this.deps.publish("lane.started", { key, pane: record.pane, tab: record.tab, session: "" });
      return { detail: `${paneAlive(pane) ? "alive" : "starting"} pane=${record.pane}`, result: { pane: record.pane, tab: record.tab, relaunched: false, resumed: false } };
    }
    if (record.adopted) throw new Error(`RUNNER_LANE_ADOPTED ${key} was adopted, not started here; it has no brief or profile to relaunch from`);
    const restored = record.herdrInstance && !pane && panes.some((p) => p.tab_id === record.tab) ? await this.restoredShell(record) : undefined;
    if (pane && record.tab) await this.deps.run(["herdr", "tab", "close", record.tab]);
    const launched = await this.launch({
      key, cwd: record.cwd, profile: record.profile, mode: record.mode, model: record.model,
      ...(restored ? { target: { pane: restored }, restored: true } : {}),
      ...(record.keywords !== undefined ? { keywords: record.keywords } : {}), ...(session !== undefined ? { session } : {}),
      ...((tabWorkspace ?? record.tabWorkspace) !== undefined ? { tabWorkspace: tabWorkspace ?? record.tabWorkspace } : {}),
      ...(record.heavySlots !== undefined ? { heavySlots: record.heavySlots } : {}), ...(record.heavyMaxLoad !== undefined ? { heavyMaxLoad: record.heavyMaxLoad } : {}),
    });
    // The relaunch replaced the record; a notice the supervisor pushed stays with the lane.
    if (record.notice) this.update(key, (r) => ({ ...r, notice: record.notice as LaneNotice }));
    return {
      detail: `started pane=${launched.pane} tab=${launched.tab}`,
      result: { pane: launched.pane, tab: launched.tab, relaunched: true, resumed: launched.resumed, startup: launched.startup },
    };
  }

  /**
   * One pass over the owned lanes: a question prompt on a lane's screen not published yet goes out as `lane.asking`
   * and is remembered in the record (`lastAsk`); a lane whose prompt is gone forgets it, so its next question goes out
   * again. An empty or failed screen read changes nothing. Returns the keys published.
   */
  async askTick(): Promise<string[]> {
    const asked: string[] = [];
    for (const record of Object.values(this.records())) {
      const pane = await this.currentPane(record);
      if (!pane) continue;
      const screen = await readScreen(this.deps.run, record.pane, ASK_SCREEN_LINES).catch(() => "");
      await this.noteTurn(record, pane, screen);
      if (!screen.trim()) continue;
      const q = screenQuestion(screen);
      const seen = q ? questionKey(q) : undefined;
      if (seen === record.lastAsk) continue;
      if (q) { this.deps.publish("lane.asking", { key: record.key, text: askingLine(record.key, q) }); asked.push(record.key); }
      const current = this.records()[record.key];
      if (current) {
        const { lastAsk: _was, ...rest } = current;
        this.save({ ...this.records(), [record.key]: seen ? { ...rest, lastAsk: seen } : rest });
      }
    }
    return asked;
  }
}
