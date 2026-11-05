import { lastReportLine } from "../freshness.ts";
import { procLanes, sampleProcs, type Proc } from "../lane-memory.ts";
import { listPanes, readScreen, type Pane } from "../panes.ts";
import type { Runner } from "../run.ts";
import type { LaneStatus } from "./protocol.ts";
import type { ObservedLane } from "./serve.ts";
import { valueHash } from "./shadow.ts";

/**
 * What a runner on a worker machine sees of the lanes on its host, without the supervisor's registry. A pane is a
 * lane's when one of its foreground processes (from `herdr pane process-info`) carries `DORI_LANE_KEY` in its own
 * environment or inherits it from an ancestor, the same attribution `lane-memory.ts` uses for memory. For each such
 * pane the status follows `observeLanes` (no agent: dead; agent working: working; else idle), and `reportHash` is the
 * shadow hash of the newest `[REPORT]` line in the pane's last 200 lines, so the supervisor can compare it with the
 * line its own screen scraping recorded (`Lane.lastRemoteReport`). Linux only, like `sampleProcs`.
 */

export const SCREEN_LINES = 200;

type ProcessInfo = {
  readonly shell_pid?: number;
  readonly foreground_processes?: readonly { readonly pid?: number }[];
};

export type ObserveHostDeps = {
  readonly run: Runner;
  readonly procs?: () => Promise<readonly Proc[]>;
};

const processInfo = async (run: Runner, pane: string): Promise<ProcessInfo | undefined> => {
  const r = await run(["herdr", "pane", "process-info", "--pane", pane]);
  if (r.code !== 0) return undefined;
  try { return (JSON.parse(r.out) as { result?: { process_info?: ProcessInfo } }).result?.process_info; }
  catch { return undefined; }
};

const statusOf = (pane: Pane): LaneStatus => (!pane.agent ? "dead" : pane.agent_status === "working" ? "working" : "idle");

export const observeHost = async (deps: ObserveHostDeps): Promise<ObservedLane[]> => {
  const [panes, procs] = await Promise.all([listPanes(deps.run), (deps.procs ?? (() => sampleProcs(deps.run)))()]);
  const owner = procLanes(procs);
  const seen = new Set<string>();
  const out: ObservedLane[] = [];
  for (const pane of panes) {
    const info = await processInfo(deps.run, pane.pane_id);
    const pids = [...(info?.foreground_processes ?? []).map((p) => p.pid), info?.shell_pid].filter((pid): pid is number => typeof pid === "number");
    const key = pids.map((pid) => owner.get(pid)).find((k): k is string => typeof k === "string");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const line = lastReportLine(await readScreen(deps.run, pane.pane_id, SCREEN_LINES).catch(() => ""), key);
    out.push({ key, pane: pane.pane_id, tab: pane.tab_id ?? "", status: statusOf(pane), ...(line ? { reportHash: valueHash(line) } : {}) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
};
