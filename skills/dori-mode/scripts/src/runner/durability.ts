import type { CommandOutcome, CommandStatusState, RunnerEventBodies } from "./protocol.ts";
import type { RunnerState } from "./state.ts";

/**
 * Command durability (design 5.6). The runner commits a command's intent before its effect and its result after
 * (serve.ts `commandDispatcher`). This module covers the two crash windows:
 *
 * - Runner side, at start: a command still at `intent` is never run again. Its outcome is read back from the host
 *   instead: for `lane.start`, a herdr pane whose process carries `DORI_LANE_KEY=<key>` means the effect happened
 *   (`verified`), no such pane means it did not (`failed`, so the supervisor may start it again), and herdr not answering
 *   leaves it `ambiguous`. Other lane commands have no effect left to observe and are `ambiguous`.
 * - Supervisor side, after its own restart: an `attempted` command is read back with `cmd.status`. A runner that holds
 *   no record of it (`unknown`) is never sent the same command again: the supervisor asks `lane.observe` and decides
 *   from that observation with the same three outcomes. `ambiguous` becomes `OPERATION_AMBIGUOUS` for the lead.
 */

export type Observation = "present" | "absent" | "unknown";

/**
 * How long a final command record is kept (design 5.6): longer than the supervisor's longest outage plus its recovery
 * window, so a supervisor back from a restart still gets an answer to `cmd.status`. A record still at `intent` is
 * never pruned.
 */
export const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Deletes final command records older than `COMMAND_RETENTION_MS`; returns how many went. */
export const pruneCommandRecords = (state: Pick<RunnerState, "pruneCommands">, now: number): number =>
  state.pruneCommands(now - COMMAND_RETENTION_MS);

const fromObservation = (seen: Observation): CommandOutcome => (seen === "present" ? "verified" : seen === "absent" ? "failed" : "ambiguous");

export type ResolveDeps = {
  readonly state: Pick<RunnerState, "pendingIntents" | "recordResult">;
  /** Whether lane `key`'s agent runs on this host now (herdr panes and `DORI_LANE_KEY`); `unknown` when herdr fails. */
  readonly observeLane: (key: string) => Promise<Observation>;
  readonly publish: (body: RunnerEventBodies["cmd.result"]) => void;
};

export const resolveInterrupted = async (deps: ResolveDeps): Promise<string[]> => {
  const lines: string[] = [];
  for (const row of deps.state.pendingIntents()) {
    let outcome: CommandOutcome = "ambiguous";
    let detail = `interrupted ${row.type}; nothing to observe`;
    if (row.type === "lane.start" && row.key) {
      const seen = await deps.observeLane(row.key).catch((): Observation => "unknown");
      outcome = fromObservation(seen);
      detail = `interrupted lane.start; observed ${seen}`;
    }
    deps.state.recordResult(row.cmdId, outcome, detail);
    deps.publish({ cmdId: row.cmdId, cmdSeq: row.cmdSeq, state: outcome, detail });
    lines.push(`RUNNER_CMD_RECOVERED cmdId=${row.cmdId} ${outcome} ${detail}`);
  }
  return lines;
};

export type SupervisorReadback = "verified" | "retry" | "ambiguous" | "pending";

export type ReadbackDeps = {
  readonly status: (cmdId: string) => Promise<CommandStatusState>;
  readonly observe: (key: string) => Promise<Observation>;
};

/**
 * The supervisor's read-back of one `attempted` command. `pending` means the runner still runs it; `retry` means its
 * absence is proven, so the command may be sent again; `ambiguous` is never retried.
 */
export const readBackCommand = async (deps: ReadbackDeps, command: { readonly cmdId: string; readonly key?: string }): Promise<SupervisorReadback> => {
  const status = await deps.status(command.cmdId).catch((): CommandStatusState => "unknown");
  if (status === "verified") return "verified";
  if (status === "failed") return "retry";
  if (status === "ambiguous") return "ambiguous";
  if (status === "intent" || status === "running") return "pending";
  if (!command.key) return "ambiguous";
  const seen = await deps.observe(command.key).catch((): Observation => "unknown");
  return seen === "present" ? "verified" : seen === "absent" ? "retry" : "ambiguous";
};

/** Acts on the read-back: sends the command again only when its absence is proven; `ambiguous` goes to the lead once. */
export const settleAttempted = async (
  deps: ReadbackDeps & { readonly resend: () => void; readonly emit: (line: string) => void },
  command: { readonly cmdId: string; readonly key?: string; readonly type: string },
): Promise<SupervisorReadback> => {
  const outcome = await readBackCommand(deps, command);
  if (outcome === "retry") deps.resend();
  if (outcome === "ambiguous") deps.emit(`OPERATION_AMBIGUOUS ${command.cmdId} ${command.type}${command.key ? ` ${command.key}` : ""}: the runner has no record and herdr could not tell whether it happened; not sent again`);
  return outcome;
};
