import { DEFAULT_LANE_SANDBOX } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaneOpsError, machineRunner } from "./lane-ops.ts";
import { type LaunchInput, SandboxRefusal } from "./launch.ts";
import type { Lane } from "./registry.ts";
import { unsandboxedReason } from "./runner-sandbox.ts";

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
export const checkLocalSandbox = async (deps: FlowDeps, key: string): Promise<void> => {
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

export const runnerSandboxRefusal = (key: string, machine: string | undefined, error: unknown): SandboxRefusal | undefined => {
  const detail = error instanceof LaneOpsError ? error.detail : error instanceof Error ? error.message : String(error);
  if (!SANDBOX_RULE.test(`${detail} ${error instanceof Error ? error.message : ""}`)) return undefined;
  const label = machineRunner(machine);
  return new SandboxRefusal("SANDBOX_UNAVAILABLE", key, `${machine ? `machine ${machine}` : "this host's runner"} refused the sandboxed start (${detail.replace(/\s+/g, " ").trim()}); install lane-sandbox on that runner (dori runner install), or opt the machine in with runners.${label}.allowUnsandboxed in the lead config and set "sandbox": "optional" in its runner-config.json`);
};
