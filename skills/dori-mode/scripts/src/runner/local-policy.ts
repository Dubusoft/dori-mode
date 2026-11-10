import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_LANE_SANDBOX, type DoriConfig, withThinking } from "../config.ts";
import { DEFAULT_POLICY, effectiveWorktreeRoot, loadPolicy, parsePolicy, POLICY_FILE, type RunnerPolicy } from "./policy.ts";
import { BUILT_IN } from "../tunables.ts";

/**
 * The local runner's policy when `~/.dori/runner/runner-config.json` is absent (design D20): derived from the lead's
 * `config.json`, so a plain single-host install starts lanes with no new file. A present file wins unchanged (main.ts).
 *
 * - `agents.default`: `agentCommand` with `laneThinking` applied the way launch.ts applies it (only to a template with a
 *   `--model` or `--thinking` flag), its `{model}` and `{prompt}` slots left for the runner to fill.
 * - `agents.sandboxed`: `laneSandbox.command` (default `lane-sandbox`) in front of that, run with
 *   `LANE_SANDBOX_VERIFY=<leadCwd>/state/verify` so the lane can write its result files there (the lane's pane gets
 *   no environment from the runner beyond its own DORI_* variables).
 * - `sandboxCheck`: `<laneSandbox.command> --check`, so a sandboxed start on a host where the wrapper cannot sandbox is
 *   refused `sandbox-unavailable` before its pane opens. `sandbox` stays `optional`: lanes recorded unsandboxed must keep
 *   recovering, and the lead decides which new lanes need a sandbox.
 * - `allowedRoots`: `$HOME`, the temp directory, `dirname(leadCwd)` and `worktreeRoot` when set, without repeats.
 * - `worktreeRoot`: the config's `worktreeRoot` when set, so the hello reports it (workspaces.ts) and the supervisor's
 *   cleanup and merge lanes read the same root back from the runner row.
 * Guard thresholds and `heavyKill` stay unset, so the runner reads them from the same config as the supervisor.
 */

/** `laneThinking` absent: BUILT_IN.laneThinking. */
export type LocalPolicyConfig = Pick<DoriConfig, "agentCommand" | "laneSandbox" | "leadCwd" | "worktreeRoot"> & { readonly laneThinking?: string };

export const localPolicy = (cfg: LocalPolicyConfig, env: { readonly home?: string; readonly tmp?: string } = {}): RunnerPolicy => {
  const template = cfg.agentCommand;
  const takesThinking = template.some((part) => /^--(model|thinking)(=|$)/.test(part));
  const laneThinking = cfg.laneThinking ?? BUILT_IN.laneThinking;
  const thinking = takesThinking ? (typeof laneThinking === "string" ? laneThinking.trim() : "") || undefined : undefined;
  // Filling the slots with themselves keeps them for the runner's own fill (lanes.ts agentArgv).
  const lane = withThinking(template, { model: "{model}", prompt: "{prompt}" }, thinking);
  const sandbox = cfg.laneSandbox?.command ?? DEFAULT_LANE_SANDBOX.command;
  const worktreeRoot = cfg.worktreeRoot?.trim() || undefined;
  const roots = [env.home ?? homedir(), env.tmp ?? tmpdir(), dirname(cfg.leadCwd), worktreeRoot]
    .filter((r): r is string => typeof r === "string" && r !== "");
  return {
    agents: { default: lane, sandboxed: ["env", `LANE_SANDBOX_VERIFY=${join(cfg.leadCwd, "state", "verify")}`, ...sandbox, ...lane] },
    allowedRoots: [...new Set(roots)],
    sandbox: "optional",
    sandboxCheck: [...sandbox, "--check"],
    jobs: "allow",
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
  };
};

/**
 * The policy a runner serves with (at start and on every reload): runner-config.json wins when present; without it the
 * local runner derives its policy from config.json (D20) and a worker keeps the empty default (no profiles, no roots).
 * A local file with only placement keys layers them on. Throws on an unreadable or invalid file.
 */
export const runnerPolicy = (runnerDir: string, remote: boolean, cfg: LocalPolicyConfig): RunnerPolicy => {
  const hasFile = existsSync(join(runnerDir, POLICY_FILE));
  if (remote) return hasFile ? loadPolicy(runnerDir) : DEFAULT_POLICY;
  return hasFile ? localRunnerPolicy(runnerDir, cfg) : localPolicy(cfg);
};

/** The runner-config keys that only declare placement; a file holding nothing else keeps the derived local policy. */
export const PLACEMENT_ONLY_KEYS: readonly string[] = ["workspaces", "detectWorkspaces", "reposRoot", "worktreeRoot"];

/**
 * The local runner's policy when `<runnerDir>/runner-config.json` exists: a file that sets only PLACEMENT_ONLY_KEYS
 * layers them onto `localPolicy(cfg)` (the lead host declares its repos in the same format as a worker), and a file
 * with any other key is the whole policy, unchanged. A layered `reposRoot` and the effective worktree root join
 * allowedRoots, so the repos discovered there pass the root check. The file's effective worktree root (its
 * `worktreeRoot`, else `<reposRoot>/worktrees`) replaces the config's; without either the config's stays.
 */
export const localRunnerPolicy = (runnerDir: string, cfg: LocalPolicyConfig, env: { readonly home?: string; readonly tmp?: string } = {}): RunnerPolicy => {
  const raw: unknown = JSON.parse(readFileSync(join(runnerDir, POLICY_FILE), "utf8"));
  const parsed = parsePolicy(raw, env.home ?? homedir());
  const keys = typeof raw === "object" && raw !== null ? Object.keys(raw) : [];
  if (!keys.every((key) => PLACEMENT_ONLY_KEYS.includes(key))) return parsed;
  const local = localPolicy(cfg, env);
  const worktreeRoot = effectiveWorktreeRoot(parsed);
  return {
    ...local,
    allowedRoots: [...new Set([...local.allowedRoots, ...[parsed.reposRoot, worktreeRoot].filter((r): r is string => r !== undefined)])],
    ...(parsed.workspaces ? { workspaces: parsed.workspaces } : {}),
    ...(parsed.detectWorkspaces !== undefined ? { detectWorkspaces: parsed.detectWorkspaces } : {}),
    ...(parsed.reposRoot !== undefined ? { reposRoot: parsed.reposRoot } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
  };
};
