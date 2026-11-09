import { replaceInPlace } from "../config-watch.ts";
import type { RunnerPolicy } from "./policy.ts";
import type { RunnerEventBodies } from "./protocol.ts";

export type PolicyReloadDeps = {
  /** The live policy every part of the runner holds; a reload rewrites it in place. */
  readonly policy: RunnerPolicy;
  /** Reads and validates the files again; throws on a broken one. `restart` names settings that need a runner restart. */
  readonly load: () => Promise<{ readonly policy: RunnerPolicy; readonly restart?: readonly string[] }>;
  /** Runs after a changed policy is in place (guard thresholds, a fresh hello for new workspaces). */
  readonly applied?: (before: RunnerPolicy, after: RunnerPolicy) => void;
  readonly publish: (body: RunnerEventBodies["runner.config"]) => void;
  readonly log: (line: string) => void;
};

export type PolicyReload = "reloaded" | "unchanged" | "invalid";

/**
 * One runner policy reload: a file that fails to load or validate keeps the last good policy (`RUNNER_CONFIG_INVALID`,
 * logged and sent to the supervisor as `runner.config` `invalid`); a changed one is written into the live policy
 * (`RUNNER_CONFIG_RELOADED <keys>`), so the next command, query and hello use it. Lanes already running are not touched.
 */
export const policyReloader = (deps: PolicyReloadDeps) => async (): Promise<PolicyReload> => {
  let next: Awaited<ReturnType<PolicyReloadDeps["load"]>>;
  try {
    next = await deps.load();
  } catch (e) {
    const detail = `${e instanceof Error ? e.message : String(e)}; the runner keeps its last good policy`;
    deps.log(`RUNNER_CONFIG_INVALID ${detail}`);
    deps.publish({ state: "invalid", detail });
    return "invalid";
  }
  if (next.restart?.length) {
    const detail = `${next.restart.join(", ")} changed; it applies after the runner restarts`;
    deps.log(`RUNNER_CONFIG_RESTART_NEEDED ${detail}`);
    deps.publish({ state: "restart", detail });
  }
  const before = structuredClone(deps.policy);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(next.policy)])]
    .filter((key) => !Bun.deepEquals((before as Record<string, unknown>)[key], (next.policy as Record<string, unknown>)[key]));
  if (!keys.length) return "unchanged";
  replaceInPlace(deps.policy, next.policy);
  deps.applied?.(before, deps.policy);
  const detail = keys.sort().join(", ");
  deps.log(`RUNNER_CONFIG_RELOADED ${detail}`);
  deps.publish({ state: "reloaded", detail });
  return "reloaded";
};
