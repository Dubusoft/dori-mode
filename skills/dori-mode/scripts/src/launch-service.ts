import type { HostSummary } from "./autopilot.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaunchInput, LaunchError, launchLane, SandboxRefusal } from "./launch.ts";
import { machineRunner } from "./lane-ops.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";
import { doneRepos } from "./signals.ts";
import {
  checkMachine, type LaunchPlan, LOCAL_MACHINE, type MachineCheck, type PlacementInput, placementTargets, planLaunch, resolvePlacement,
  type RunnerPlacement, runnerPlacements,
} from "./placement.ts";
import type { Lane } from "./registry.ts";
import { dequeueLaunch, enqueueLaunch, type LaunchVerdict } from "./routing.ts";
import { postSandboxNotice, postSkippedNotices } from "./sandbox-notice.ts";
import { claimSlot, precheckSlots, releaseSlot } from "./launch-admission.ts";

/**
 * The launch admission every launcher shares (`dori launch`, `dori autopilot` and the supervisor's autopilot): where a
 * launch is placed, the HOLD queue when its machine has no room, the launch itself with its sandbox notices, and each
 * target machine's free slots for autopilot. Calling launchLane directly skips placement and the HOLD queue.
 */

/** What every runner reported about its repos, `online` unless its runner is offline, lost or revoked. */
export const placementReports = async (stateDir: string): Promise<RunnerPlacement[]> => {
  const { readRunnerRows } = await import("./runner/hub.ts");
  const { runnerView } = await import("./status.ts");
  const now = Date.now();
  return runnerPlacements(readRunnerRows(stateDir), (row) => !["offline", "lost", "revoked"].includes(runnerView(row, now).state));
};

/** Starts every reason {@link reviewRefusal} gives: a machine that cannot run a review lane at all, not one that is full. */
export const REVIEW_UNSUPPORTED = "REVIEW_UNSUPPORTED";

/**
 * Why `machine` cannot run a review lane, or undefined when it can: its runner reports agent profiles without
 * `review` (runner-config.json lacks agents.review, so the runner would refuse the start `agent-profile`), or it is
 * macOS, whose lane-sandbox has no review profile (lane-sandbox-macos.sh exits on LANE_SANDBOX_PROFILE=review). A runner
 * too old to report its profiles is not refused here; its own policy check still refuses the start.
 */
export const reviewRefusal = async (ops: Pick<FlowDeps["ops"], "observeMachine">, machine: string): Promise<string | undefined> => {
  const seen = await ops.observeMachine(machine === LOCAL_MACHINE ? undefined : machine);
  // lane-ops' q.machine.observe guard does not check `profiles` yet, so its shape is checked here.
  if (Array.isArray(seen.profiles) && !seen.profiles.includes("review")) {
    return `${REVIEW_UNSUPPORTED} machine ${machine}: its runner-config has no agents.review (dori runner setup${machine === LOCAL_MACHINE ? "" : ` --machine ${machine}`} adds it)`;
  }
  if (seen.os === "darwin") return `${REVIEW_UNSUPPORTED} machine ${machine}: the macOS lane sandbox has no review profile`;
  return undefined;
};

export type PlacedLaunch = {
  readonly plan: LaunchPlan;
  /** The machine the launch goes to ("local" for this host) and the --machine to launch with (undefined for local). */
  readonly target: string;
  readonly machine?: string;
  /** The input's cwd, else the checkout the owning runner declared for a remote launch. */
  readonly cwd?: string;
  /** PLACEMENT lines, then LAUNCH_WARN when the local pane limit is off. */
  readonly lines: readonly string[];
};

/** Places `input` (planLaunch over the runners' reports) and checks the machine it lands on. */
export const placeLaunch = async (deps: Pick<FlowDeps, "ops" | "config"> & Partial<Pick<FlowDeps, "clock">>, input: LaunchInput): Promise<PlacedLaunch> => {
  const { config } = deps;
  const plan = await planLaunch(input, config.placement, async (machine) => {
    const check = await checkMachine(deps.ops, config, machine);
    if (!check.verdict.ok) return check;
    const refusal = input.review ? await reviewRefusal(deps.ops, machine) : undefined;
    if (refusal) return { ...check, verdict: { ok: false, reasons: [refusal] } };
    return { ...check, verdict: precheckSlots(config.stateDir, check, deps.clock?.now() ?? Date.now(), input.key).verdict };
  }, await placementReports(config.stateDir));
  const target = plan.check.machine;
  const machine = target === LOCAL_MACHINE ? undefined : target;
  // A remote launch without --cwd starts in the checkout its owning runner declared.
  const cwd = input.cwd ?? (machine && plan.placement.machine === target ? plan.placement.cwd : undefined);
  const warn = !machine && config.guard.panesMax <= 0
    ? [`LAUNCH_WARN guard.panesMax is ${config.guard.panesMax}: the pane-count limit is off, so nothing caps concurrent lanes; set guard.panesMax to re-enable it`]
    : [];
  return { plan, target, ...(machine ? { machine } : {}), ...(cwd ? { cwd } : {}), lines: [...plan.lines, ...warn] };
};

/** `dori launch --worktree <repo>`'s base when `--base` is not given. */
export const DEFAULT_WORKTREE_BASE = "origin/dev";

/** `--worktree <repo> [--base <remote>/<branch>]`: `repo` is owner/repo or the bare repo name. */
export type LaunchWorktree = { readonly repo: string; readonly base: string };

/** The lane git ref a launch worktree op runs under: the new lane's key on the placed machine's runner. */
const worktreeRef = (key: string, machine: string | undefined) => ({ key, ...(machine ? { machine } : {}) });

/**
 * Creates the new lane's worktree for `dori launch --worktree` on the machine the launch is placed on, through that
 * machine's runner (`lane.git` fetch-branch, then worktree-add, the merge lane's ops): `<root>/<repo name>-<key>`,
 * detached at the fetched base. The root is the runner's reported worktree root (for this host, config.worktreeRoot
 * while the local runner reported none), the checkout the one its runner declared or detected for the repo. An existing
 * path is refused before any git runs, so nothing in it is overwritten.
 */
export const createLaunchWorktree = async (deps: FlowDeps, input: LaunchInput, placed: PlacedLaunch, want: LaunchWorktree): Promise<{ readonly path: string; readonly checkout: string; readonly line: string }> => {
  const [, remote, branch] = /^([\w.-]+)\/([\w./-]+)$/.exec(want.base) ?? [];
  if (!remote || !branch || want.base.startsWith("-")) throw new LaunchError(`--base ${JSON.stringify(want.base)} must be <remote>/<branch>, e.g. ${DEFAULT_WORKTREE_BASE}`);
  const name = want.repo.split("/").pop()?.toLowerCase() ?? "";
  if (!/^[\w.-]+(?:\/[\w.-]+)?$/.test(want.repo) || name.startsWith(".")) throw new LaunchError(`--worktree ${JSON.stringify(want.repo)} must be owner/repo or a repo name`);
  const machine = placed.machine ?? LOCAL_MACHINE;
  const label = machineRunner(placed.machine);
  const report = (await placementReports(deps.config.stateDir)).find((r) => r.machine === label);
  const reported = (deps.runnerWorktreeRoot ?? ((l) => runnerWorktreeRoot(deps.config.stateDir, l)))(label);
  const root = (reported || (placed.machine ? undefined : deps.config.worktreeRoot) || "").replace(/[\\/]+$/, "");
  if (!root) throw new LaunchError(`LAUNCH_WORKTREE_NO_ROOT ${input.key}: machine ${machine} reports no worktree root${placed.machine ? "" : " and config.worktreeRoot is not set"}`);
  const matches = (repo: string): boolean => want.repo.includes("/") ? repo.toLowerCase() === want.repo.toLowerCase() : repo.split("/").pop()?.toLowerCase() === name;
  const checkout = [...(report?.declared ?? []), ...(report?.detected ?? [])].find((e) => matches(e.repo))?.path;
  if (!checkout) throw new LaunchError(`LAUNCH_WORKTREE_NO_CHECKOUT ${input.key}: the runner on machine ${machine} declares or detects no checkout of ${want.repo} (dori placement lists them)`);
  // A Windows runner's root is a drive path: join with its own separator.
  const path = `${root}${/^[A-Za-z]:\\/.test(root) ? "\\" : "/"}${name}-${input.key}`;
  if ((await deps.ops.exists(placed.machine, [path]))[0]) throw new LaunchError(`LAUNCH_WORKTREE_EXISTS ${input.key}: ${path} already exists on machine ${machine}; remove it or launch with --cwd ${path}`);
  const ref = worktreeRef(input.key, placed.machine);
  const fetched = await deps.ops.git(ref, { op: "fetch-branch", root: checkout, remote, branch });
  if (fetched.code !== 0) throw new LaunchError(`LAUNCH_WORKTREE_FAILED ${input.key}: git fetch ${want.base} in ${checkout} failed: ${(fetched.err || fetched.out).trim()}`);
  const added = await deps.ops.git(ref, { op: "worktree-add", root: checkout, path, ref: `refs/remotes/${remote}/${branch}` });
  if (added.code !== 0) throw new LaunchError(`LAUNCH_WORKTREE_FAILED ${input.key}: git worktree add ${path} failed: ${(added.err || added.out).trim()}`);
  return { path, checkout, line: `WORKTREE_CREATED ${input.key} ${path} from ${want.base} (checkout ${checkout}${placed.machine ? `, machine ${machine}` : ""})` };
};

/** Removes a worktree createLaunchWorktree made for a launch that registered no lane; git refuses one that changed meanwhile. */
export const removeLaunchWorktree = async (deps: FlowDeps, input: LaunchInput, placed: PlacedLaunch, path: string, checkout: string): Promise<string> => {
  const removed = await deps.ops.git(worktreeRef(input.key, placed.machine), { op: "worktree-remove", root: checkout, path }).catch((e: unknown) => ({ code: 1, out: "", err: e instanceof Error ? e.message : String(e) }));
  return removed.code === 0 ? `WORKTREE_REMOVED ${input.key} ${path} (the launch registered no lane)` : `WORKTREE_KEPT ${input.key} ${path}: ${(removed.err || removed.out).trim()}`;
};

export type LaunchOutcome =
  /** The machine held: the launch waits in launch-hold.json (`queued` launches wait there now). */
  | { readonly kind: "held"; readonly target: string; readonly verdict: LaunchVerdict; readonly queued: number }
  /** `notices`: the lines of the owner notices posted for a launch that ran unsandboxed. */
  | { readonly kind: "launched"; readonly lane: Lane; readonly startup: string; readonly notes: readonly string[]; readonly notices: readonly string[] };

/**
 * Admits a placed launch: a held machine queues it in launch-hold.json; otherwise it launches there and leaves the
 * queue. A sandbox refusal reaches the owner (its notice lines go to `err`) before it is rethrown.
 */
export const admitLaunch = async (deps: FlowDeps, input: LaunchInput, placed: PlacedLaunch, err: (line: string) => void): Promise<LaunchOutcome> => {
  const { stateDir } = deps.config;
  const verdict = placed.plan.check.verdict.ok
    ? claimSlot(stateDir, placed.plan.check, input.key, deps.clock.now())
    : placed.plan.check.verdict;
  if (!verdict.ok) {
    const repos = doneRepos(input.done);
    const queue = enqueueLaunch(stateDir, {
      key: input.key, title: input.title, done: input.done, brief: input.brief, queuedAt: new Date().toISOString(), reasons: [verdict.reasons.join(" | ")],
      ...(placed.cwd ? { cwd: placed.cwd } : {}), ...(repos.length ? { repos } : {}), ...(input.thread ? { thread: input.thread } : {}), ...(input.model ? { model: input.model } : {}),
      ...(input.mode === "mass-ulw" ? { mode: input.mode } : {}), ...(input.task !== undefined ? { task: input.task } : {}),
      ...(placed.machine ? { machine: placed.machine } : {}),
      ...(input.grants?.length ? { grants: input.grants } : {}),
      ...(input.review ? { review: true as const } : {}),
    });
    return { kind: "held", target: placed.target, verdict, queued: queue.length };
  }
  // A refused sandbox and an allowed unsandboxed run both reach the owner on Discord (sandbox-notice.ts).
  const r = await launchLane(deps, { ...input, machine: placed.machine, ...(placed.cwd ? { cwd: placed.cwd } : {}) }).catch(async (e: unknown) => {
    releaseSlot(stateDir, input.key);
    if (e instanceof SandboxRefusal) for (const line of await postSandboxNotice(deps, input, e.message)) err(line);
    throw e;
  });
  dequeueLaunch(stateDir, input.key);
  return { kind: "launched", lane: r.lane, startup: r.startup, notes: r.notes, notices: await postSkippedNotices(deps, input, r.notes) };
};

export type MachineHosts = {
  /** The machine a launch with no placement flag goes to (placement.defaultMachine). */
  readonly defaultMachine: string;
  /** Each target machine's can-launch summary, before any reservation is subtracted. */
  readonly machines: ReadonlyMap<string, HostSummary>;
  /** Each input's target machines, most preferred first (placementTargets). */
  readonly targets: readonly (readonly string[])[];
};

export const hostSummary = (c: MachineCheck, stateDir?: string, now = Date.now()): HostSummary => {
  const admission = stateDir && c.paneCap !== undefined ? precheckSlots(stateDir, c, now) : undefined;
  const free = admission ? admission.free : c.freeSlots;
  const slots = free === undefined || free === Infinity ? {} : { slots: free };
  const verdict = admission?.verdict ?? c.verdict;
  const reserved = admission?.reservedKeys.length ? { reservedKeys: admission.reservedKeys } : {};
  return verdict.ok ? { ok: true, ...slots, ...reserved } : { ok: false, reason: verdict.reasons.join(" | "), ...slots, ...reserved };
};

/**
 * Where launches placed like `inputs` may go and how much room each of those machines has: every target machine is
 * checked once (without recording a launch verdict), through `check`.
 */
export const machineHosts = async (
  deps: Pick<FlowDeps, "config">, inputs: readonly PlacementInput[], check: (machine: string) => Promise<HostSummary>,
): Promise<MachineHosts> => {
  const { placement } = deps.config;
  const reports = await placementReports(deps.config.stateDir);
  const targets = inputs.map((input) => placementTargets(resolvePlacement(input, placement, reports), placement));
  const names = [...new Set(targets.flat())];
  const summaries = await Promise.all(names.map(check));
  return { defaultMachine: placement.defaultMachine, machines: new Map(names.map((m, i) => [m, summaries[i]!])), targets };
};
