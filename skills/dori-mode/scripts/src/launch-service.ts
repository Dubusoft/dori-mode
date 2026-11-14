import type { HostSummary } from "./autopilot.ts";
import type { FlowDeps } from "./done-flow.ts";
import { doneRepos, type LaunchInput, launchLane, SandboxRefusal } from "./launch.ts";
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
    return check.verdict.ok ? { ...check, verdict: precheckSlots(config.stateDir, check, deps.clock?.now() ?? Date.now(), input.review ? "review" : "author", input.key).verdict } : check;
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
    ? claimSlot(stateDir, placed.plan.check, input.key, input.review ? "review" : "author", deps.clock.now())
    : placed.plan.check.verdict;
  if (!verdict.ok) {
    const repos = doneRepos(input.done);
    const queue = enqueueLaunch(stateDir, {
      key: input.key, title: input.title, done: input.done, brief: input.brief, queuedAt: new Date().toISOString(), reasons: [verdict.reasons.join(" | ")],
      ...(placed.cwd ? { cwd: placed.cwd } : {}), ...(repos.length ? { repos } : {}), ...(input.thread ? { thread: input.thread } : {}), ...(input.model ? { model: input.model } : {}),
      ...(input.mode === "mass-ulw" ? { mode: input.mode } : {}), ...(input.task !== undefined ? { task: input.task } : {}),
      ...(placed.machine ? { machine: placed.machine } : {}), ...(input.pane ? { pane: input.pane } : {}), ...(input.workspace ? { workspace: input.workspace } : {}),
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
  const free = admission ? admission.authorAdmissible : c.freeSlots;
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
