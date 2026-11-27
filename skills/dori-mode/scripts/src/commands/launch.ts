import { envFilePath, resolveCredential } from "../credentials.ts";
import { type LaunchInput, launchNextLine, parseLaneTask, validateLaunch } from "../launch.ts";
import { admitLaunch, createLaunchWorktree, DEFAULT_WORKTREE_BASE, placeLaunch, removeLaunchWorktree } from "../launch-service.ts";
import { assembleBrief, generatedBriefPath, launchBriefArgs, linkLaunchMessages, ownerMessageText, writeGeneratedBrief } from "../brief-from-message.ts";
import { LANE_MODES, type LaneMode } from "../registry.ts";
import { realClock } from "../run.ts";
import { verdictLine } from "../placement.ts";
import { fetchHttp } from "../messenger/http.ts";
import { Discord } from "../messenger/discord.ts";
import { AckError } from "../ack.ts";
import { openOperations } from "../operations.ts";
import { type CliCommand, die, laneThreadRef } from "./context.ts";

/** `dori launch <key> ...`: start a lane; --from-message and --note are also read from the raw arguments (launchBriefArgs). */
export const launchCommand: CliCommand = {
  options: {
    title: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    task: { type: "string" },
    cwd: { type: "string" },
    machine: { type: "string" },
    note: { type: "string" },
    grant: { type: "string", multiple: true },
    worktree: { type: "string" },
    base: { type: "string" },
    "share-thread": { type: "boolean" },
    "allow-repo-mismatch": { type: "boolean" },
    sandbox: { type: "boolean" },
    "no-handled": { type: "boolean" },
  },
  ownFlags: true,
  run: async ({ config, deps, flags, key, rest, opt, need }) => {
    const mode = opt("mode");
    if (mode !== undefined && !(LANE_MODES as readonly string[]).includes(mode)) die(`--mode must be one of ${LANE_MODES.join(", ")}`);
    if (flags.values["no-sandbox"]) console.error("LAUNCH_NO_SANDBOX_REMOVED --no-sandbox was removed and is ignored: every lane runs in the sandbox unless its machine is opted in with runners.<label>.allowUnsandboxed");
    const sandbox = flags.values.sandbox ? (true as const) : undefined;
    if (flags.values["toodo-start"] !== undefined) die("LAUNCH_TOODO_START_REMOVED --toodo-start was removed: launch the lane with --cwd like any other and record the task in Toodo yourself over MCP");
    const fromArgs = (() => { try { return launchBriefArgs(rest); } catch (e) { return die(e instanceof Error ? e.message : String(e)); } })();
    const fromMessage = fromArgs.refs.length > 0;
    if (fromMessage === (flags.values.brief !== undefined)) die("launch needs exactly one of --brief FILE or --from-message <channel> <messageId> (repeatable)");
    if (!fromMessage && fromArgs.notes.length) die("--note goes with --from-message; with --brief put lead notes in the brief file");
    if (!fromMessage && flags.values["no-handled"]) die("--no-handled goes with --from-message; a --brief launch links no owner message");
    const taskArg = opt("task");
    const flagTask = taskArg === undefined ? undefined : (parseLaneTask(taskArg) ?? die(`--task must be a positive integer (a Toodo task id), got ${JSON.stringify(taskArg)}`));
    // An autopilot lane carries its reservation's task id; a --task naming another task is refused.
    const reservedTask = await (async () => {
      const { ledgerRows, reservedTaskOf } = await import("../autopilot.ts");
      const store = openOperations(config);
      try { return reservedTaskOf(ledgerRows(store), key ?? ""); } finally { store.close(); }
    })();
    if (flagTask !== undefined && reservedTask !== undefined && flagTask !== reservedTask) die(`LAUNCH_TASK_MISMATCH lane ${key} is reserved by autopilot for task #${reservedTask}, not --task ${flagTask}`);
    const task = flagTask ?? reservedTask;
    const grantArgs = (flags.values.grant as string[] | undefined ?? []).map((g) => g.trim());
    const { GRANT_NAME } = await import("../runner/policy.ts");
    for (const g of grantArgs) if (!GRANT_NAME.test(g)) die(`--grant ${JSON.stringify(g)} is not a grant name (${GRANT_NAME.source})`);
    const grants = [...new Set(grantArgs)];
    const title = need("title");
    const generated = fromMessage ? (() => {
      try {
        return { path: generatedBriefPath(config.stateDir, key ?? ""), text: assembleBrief(title, fromArgs.refs.map((ref) => ownerMessageText(config.stateDir, ref)), fromArgs.notes) };
      } catch (e) { return die(e instanceof Error ? e.message : String(e)); }
    })() : undefined;
    const input: LaunchInput = { key: key ?? "", title, brief: generated ? generated.path : need("brief"), done: need("done"), thread: await laneThreadRef(opt("thread"), config.discordChannels), model: opt("model"), ...(mode ? { mode: mode as LaneMode } : {}), ...(task !== undefined ? { task } : {}), cwd: opt("cwd"), machine: opt("machine"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]), ...(sandbox === undefined ? {} : { sandbox }), ...(grants.length ? { grants } : {}) };
    const worktree = opt("worktree");
    if (worktree === undefined && opt("base") !== undefined) die("--base goes with --worktree");
    if (worktree !== undefined && input.cwd) die("--worktree creates the lane's directory; drop --cwd");
    await validateLaunch(deps, input);
    if (generated) writeGeneratedBrief(generated.path, generated.text);
    const placement = await placeLaunch(deps, input);
    for (const line of placement.lines) console.log(line);
    // --worktree: the lane's own worktree on the machine it was placed on, which becomes its cwd (and a held launch's).
    const made = worktree === undefined ? undefined : await createLaunchWorktree(deps, input, placement, { repo: worktree, base: opt("base") ?? DEFAULT_WORKTREE_BASE });
    if (made) console.log(made.line);
    const placed = made ? { ...placement, cwd: made.path } : placement;
    const r = await admitLaunch(deps, made ? { ...input, cwd: made.path } : input, placed, (line) => { console.error(line); }).catch(async (e: unknown) => {
      if (made && !(await deps.registry.read(input.key))) console.error(await removeLaunchWorktree(deps, input, placed, made.path, made.checkout));
      throw e;
    });
    if (r.kind === "held") {
      console.log(verdictLine(r.target, r.verdict));
      console.log(`QUEUED ${input.key} (${r.queued} waiting; dori hold list)`);
      process.exit(4);
    }
    for (const note of r.notes) console.log(note);
    for (const line of r.notices) console.error(line);
    console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
    console.log(r.startup);
    const next = launchNextLine(r.lane.key, r.startup); if (next) console.log(next);
    // The lane is registered whatever its startup check said, so it covers the owner messages it was launched from.
    if (fromMessage && !flags.values["no-handled"]) {
      const discord = (): Discord => new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ??
        (() => { throw new AckError(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`); })());
      const linked = await linkLaunchMessages(config.stateDir, r.lane.key, fromArgs.refs, discord, realClock.now());
      for (const line of linked.out) console.log(line);
      for (const line of linked.err) console.error(line);
    }
    process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
  },
};
