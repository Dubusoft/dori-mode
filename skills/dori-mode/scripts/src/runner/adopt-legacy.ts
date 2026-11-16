import { machineRunner, type LaneOps } from "../lane-ops.ts";
import type { Lane, Registry } from "../registry.ts";

/**
 * Legacy open lanes at upgrade (design D18). A lane opened before every lane was runner-owned has no `Lane.runner`.
 * `adoptLegacyLanes` gives each such open lane its runner (`machine ?? "local"`) after the runner accepted `lane.adopt`
 * for its pane, so a lane is adopted once: with `runner` set it is never looked at again, and a failed adopt leaves it
 * unowned for the next pass.
 *
 * Two kinds cannot be adopted and get one urgent `LANE_RUNNER_MIGRATION <key> ...` (a stable id, so the digest has it once):
 * a legacy sandboxed local lane (the old sandbox hides `~/.dori/runner`, so it cannot reach the lane socket) and a legacy
 * lane on a machine whose runner is not connected. They stay unowned; the lead closes or relaunches them.
 */
export type AdoptLegacyDeps = {
  readonly registry: Pick<Registry, "open" | "update">;
  readonly ops: Pick<LaneOps, "adopt" | "connected">;
  /** Journals a line under a stable id. */
  readonly emit: (id: string, line: string) => void;
  readonly log?: (line: string) => void;
};

const migration = (deps: AdoptLegacyDeps, lane: Lane, why: string): void => {
  deps.emit(`lane-runner-migration:${lane.key}`, `LANE_RUNNER_MIGRATION ${lane.key} ${why}: dori close ${lane.key} --cancelled and launch it again, or leave it and finish it by hand`);
};

/** Adopts every open lane without a runner; returns the keys adopted in this pass. */
export const adoptLegacyLanes = async (deps: AdoptLegacyDeps): Promise<string[]> => {
  const adopted: string[] = [];
  const legacy = (await deps.registry.open()).filter((l) => !l.closedAt && !l.runner);
  for (const lane of legacy) {
    const runner = machineRunner(lane.machine);
    if (!lane.machine && lane.sandbox) {
      migration(deps, lane, "runs in the old lane sandbox that hides the runner socket, so it cannot report through its runner");
      continue;
    }
    if (lane.machine && !deps.ops.connected(lane.machine)) {
      migration(deps, lane, `runs on machine ${lane.machine} whose runner is not connected`);
      continue;
    }
    // A lane that never got a pane waits for nothing a runner can adopt.
    if (!lane.pane) continue;
    try {
      await deps.ops.adopt({
        key: lane.key, ...(lane.machine ? { machine: lane.machine } : {}), pane: lane.pane,
        ...((lane.machine ? lane.remoteCwd : lane.cwd) ? { cwd: (lane.machine ? lane.remoteCwd : lane.cwd) as string } : {}),
        mode: lane.mode ?? "ulw", model: lane.model ?? "",
      });
    } catch (e) {
      deps.log?.(`LANE_ADOPT_FAILED ${lane.key} runner=${runner} ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    await deps.registry.update(lane.key, (current) => (current && !current.runner ? { ...current, runner } : current ?? undefined));
    adopted.push(lane.key);
  }
  return adopted;
};
