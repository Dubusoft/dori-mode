import { runnerMode, type DoriConfig } from "../config.ts";
import type { FlowDeps } from "../done-flow.ts";
import { footer, type LaunchInput } from "../launch.ts";
import type { Lane } from "../registry.ts";
import { iso } from "../run.ts";
import { queueRunnerAdmin } from "./serve.ts";

/**
 * Starting a lane on a worker through its runner (design 7.4, 9 P3b). Only a machine whose `runners.mode` is
 * `authoritative` takes new lanes this way; `shadow` and `off` (and a machine without a runners entry) keep the direct
 * herdr path. `off` therefore stops new runner launches only: a lane a runner already owns keeps reporting and being
 * controlled through it until it closes.
 *
 * The lane is registered at once as owned by that runner (`Lane.runner`) with the runner footer appended to its brief,
 * then `lane.start` is queued for the supervisor, which sends it as soon as the runner is connected (requests expire
 * after 2 minutes). The runner's `lane.started` fills in the pane and tab. The runner chooses the agent command from
 * its own `runner-config.json` profile `default`; the lead never sends an argv.
 */

export const RUNNER_AGENT_PROFILE = "default";

export const launchesThroughRunner = (config: Pick<DoriConfig, "runners">, machine: string | undefined): machine is string =>
  machine !== undefined && runnerMode(config, machine) === "authoritative";

export type RunnerLaunch = { readonly lane: Lane; readonly request: number };

export const launchThroughRunner = async (
  deps: Pick<FlowDeps, "registry" | "config" | "clock">, input: LaunchInput & { readonly machine: string },
  queue: typeof queueRunnerAdmin = queueRunnerAdmin,
): Promise<RunnerLaunch> => {
  if (!input.cwd) throw new Error(`RUNNER_LAUNCH_NO_CWD ${input.key}: a lane started through a runner needs --cwd on ${input.machine}`);
  if (input.pane || input.workspace || input.toodo) throw new Error(`RUNNER_LAUNCH_UNSUPPORTED ${input.key}: --pane, --workspace and --toodo-start are not available through a runner`);
  const now = deps.clock.now();
  const lane = {
    key: input.key, title: input.title, thread: input.thread ?? "none", brief: input.brief, done: input.done,
    machine: input.machine, runner: input.machine, runnerAdoptedAt: now, remoteCwd: input.cwd, reportVia: "cli",
    model: input.model ?? deps.config.defaultModel, mode: input.mode ?? "ulw", status: "working", openedAt: iso(deps.clock),
    ...(input.sandbox ? { sandbox: true } : {}),
  } as Lane;
  const text = await Bun.file(input.brief).text();
  const briefText = `${text.replace(/\s*$/, "")}\n${footer(lane, deps.config.leadPane, deps.config.ownerLanguage, deps.config.laneRules)}`;
  await Bun.write(input.brief, briefText);
  await deps.registry.write(lane);
  const request = queue(deps.config.stateDir, "lane.start", input.machine, now, {
    cmdId: `lane-start:${input.key}:${now}`, key: input.key, briefText, done: input.done, thread: lane.thread, cwd: input.cwd,
    agentProfile: RUNNER_AGENT_PROFILE, mode: lane.mode ?? "ulw", model: lane.model ?? "", sandbox: input.sandbox === true, expectedLaneGen: 0,
  });
  return { lane, request };
};
