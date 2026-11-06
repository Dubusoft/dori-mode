import { createHash } from "node:crypto";
import { lastReportLine } from "../freshness.ts";
import { procLanes, sampleProcs, type Proc } from "../lane-memory.ts";
import { listPanes, readScreen } from "../panes.ts";
import { LANE_KEY } from "../registry.ts";
import type { Runner } from "../run.ts";
import { laneStatus, type ObservedLane } from "./serve.ts";

/**
 * What a runner on a worker machine sees of the lanes on its host, without the supervisor's registry. A pane is a
 * lane's when one of its foreground processes (from `herdr pane process-info`) carries `DORI_LANE_KEY` in its own
 * environment or inherits it from an ancestor, the same attribution `lane-memory.ts` uses for memory (Linux, where
 * `/proc` is readable). When no process environment is readable (macOS) the attribution falls back to the agent's
 * argv: the launch prompt names the lane brief `dori-brief-<key>.md`, and a foreground process whose argv carries that
 * path belongs to `<key>`. The environment attribution wins when both name a lane. For each such
 * pane the status follows `laneStatus` (agent not alive: dead; alive and working: working; else idle), and `reportHash` is the
 * `valueHash` of the newest `[REPORT]` line in the pane's last 200 lines, so the supervisor can compare it with the
 * line its own screen scraping recorded (`Lane.lastRemoteReport`).
 */

export const SCREEN_LINES = 200;

/** A short stable hash of a value (the first 16 hex digits of its SHA-256), as `lane.progress` carries a report line. */
export const valueHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

type ProcessInfo = {
  readonly shell_pid?: number;
  readonly foreground_processes?: readonly { readonly pid?: number; readonly argv?: readonly string[] }[];
};

const BRIEF_TOKEN = /[/\\]dori-brief-([a-z0-9._-]+)\.md(?=\s|$)/g;

/** The lane key named by a `dori-brief-<key>.md` path (either separator style) in an argv, if any. */
export const briefLane = (argv: readonly string[] | undefined): string | undefined => {
  for (const arg of argv ?? []) {
    for (const m of arg.matchAll(BRIEF_TOKEN)) {
      const key = m[1];
      if (key && LANE_KEY.test(key)) return key;
    }
  }
  return undefined;
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

export const observeHost = async (deps: ObserveHostDeps): Promise<ObservedLane[]> => {
  const [panes, procs] = await Promise.all([listPanes(deps.run), (deps.procs ?? (() => sampleProcs(deps.run)))()]);
  const owner = procLanes(procs);
  const seen = new Set<string>();
  const out: ObservedLane[] = [];
  for (const pane of panes) {
    const info = await processInfo(deps.run, pane.pane_id);
    const pids = [...(info?.foreground_processes ?? []).map((p) => p.pid), info?.shell_pid].filter((pid): pid is number => typeof pid === "number");
    const key = pids.map((pid) => owner.get(pid)).find((k): k is string => typeof k === "string")
      ?? (info?.foreground_processes ?? []).map((p) => briefLane(p.argv)).find((k): k is string => k !== undefined);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const line = lastReportLine(await readScreen(deps.run, pane.pane_id, SCREEN_LINES).catch(() => ""), key);
    out.push({ key, pane: pane.pane_id, tab: pane.tab_id ?? "", status: laneStatus(pane), ...(line ? { reportHash: valueHash(line) } : {}) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
};
