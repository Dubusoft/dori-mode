import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { DEFAULT_LANE_SANDBOX, type DoriConfig, withThinking } from "../config.ts";
import type { RunnerPolicy } from "./policy.ts";

/**
 * The local runner's policy when `~/.dori/runner/runner-config.json` is absent (design D20): derived from the lead's
 * `config.json`, so a plain single-host install starts lanes with no new file. A present file wins unchanged (main.ts).
 *
 * - `agents.default`: `agentCommand` with `laneThinking` applied the way launch.ts applies it (only to a template with a
 *   `--model` or `--thinking` flag), its `{model}` and `{prompt}` slots left for the runner to fill.
 * - `agents.sandboxed`: `laneSandbox.command` (default `lane-sandbox`) in front of that.
 * - `allowedRoots`: `$HOME`, the temp directory, `dirname(defaultCwd)` and `worktreeRoot` when set, without repeats.
 * Guard thresholds and `heavyKill` stay unset, so the runner reads them from the same config as the supervisor.
 */

export type LocalPolicyConfig = Pick<DoriConfig, "agentCommand" | "laneThinking" | "laneSandbox" | "defaultCwd" | "worktreeRoot">;

export const localPolicy = (cfg: LocalPolicyConfig, env: { readonly home?: string; readonly tmp?: string } = {}): RunnerPolicy => {
  const template = cfg.agentCommand;
  const takesThinking = template.some((part) => /^--(model|thinking)(=|$)/.test(part));
  const thinking = takesThinking ? (typeof cfg.laneThinking === "string" ? cfg.laneThinking.trim() : "") || undefined : undefined;
  // Filling the slots with themselves keeps them for the runner's own fill (lanes.ts agentArgv).
  const lane = withThinking(template, { model: "{model}", prompt: "{prompt}" }, thinking);
  const sandbox = cfg.laneSandbox?.command ?? DEFAULT_LANE_SANDBOX.command;
  const roots = [env.home ?? homedir(), env.tmp ?? tmpdir(), dirname(cfg.defaultCwd), cfg.worktreeRoot?.trim() || undefined]
    .filter((r): r is string => typeof r === "string" && r !== "");
  return {
    agents: { default: lane, sandboxed: [...sandbox, ...lane] },
    allowedRoots: [...new Set(roots)],
    sandbox: "optional",
    jobs: "allow",
  };
};
