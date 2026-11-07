import { procLanes, sampleProcs, type Proc } from "../lane-memory.ts";
import { listPanes, type Pane } from "../panes.ts";
import { LANE_KEY } from "../registry.ts";
import type { Runner } from "../run.ts";
import type { TurnEvidence, TurnHold, TurnStopCause } from "./protocol.ts";
import { laneStatus, type ObservedLane } from "./serve.ts";

/**
 * What a runner on a worker machine sees of the lanes on its host, without the supervisor's registry. A pane the runner
 * started a lane on (`owned`: its lane records, each pane checked by `RunnerLanes.currentPane`) is that lane's whatever
 * runs in it, so a lane whose agent exited and left only its shell is still observed (as dead), and a host with no
 * readable process environment (macOS) still sees every lane it owns. Any other pane is a lane's when one of its foreground processes (from `herdr pane process-info`) carries `DORI_LANE_KEY` in its own
 * environment or inherits it from an ancestor, the same attribution `lane-memory.ts` uses for memory (Linux, where
 * `/proc` is readable). When no process environment is readable (macOS) the attribution falls back to the agent's
 * argv: the launch prompt names the lane brief (`briefs/<key>.md` in the runner directory, or an older launch's
 * `dori-brief-<key>.md`), and a foreground process whose argv carries that path belongs to `<key>`. The owned record
 * wins, then the environment attribution, then the argv. For each such
 * pane the status follows `laneStatus` (agent not alive: dead; alive and working: working; else idle). A pane's text is
 * never read here: a lane's reports reach the supervisor only as `lane.report` events.
 */

type ProcessInfo = {
  readonly shell_pid?: number;
  readonly foreground_processes?: readonly { readonly pid?: number; readonly argv?: readonly string[] }[];
};

const BRIEF_TOKEN = /[/\\](?:dori-brief-|briefs[/\\])([a-z0-9._-]+)\.md(?=\s|$)/g;

/** The lane key named by a `briefs/<key>.md` or `dori-brief-<key>.md` path (either separator style) in an argv, if any. */
export const briefLane = (argv: readonly string[] | undefined): string | undefined => {
  for (const arg of argv ?? []) {
    for (const m of arg.matchAll(BRIEF_TOKEN)) {
      const key = m[1];
      if (key && LANE_KEY.test(key)) return key;
    }
  }
  return undefined;
};

export type TurnStop = Pick<TurnEvidence, "cause" | "hold" | "continuation">;

const STOP_LABELS: readonly (readonly [RegExp, TurnStopCause])[] = [
  [/^Operation aborted$|^Interrupted by the user's Stop before it finished\./, "aborted"],
  [/^System operation aborted$/, "system-aborted"],
  [/^Provider (?:request failed(?::.*)?|retry failed after \d+ attempts?)$/, "provider-failed"],
];
/** The last turn's end sits right above the input box and the footer: an older turn's label is further up. */
const TURN_END_LINES = 10;
/** omo's lifecycle segment in the footer names the last run's stop (`paused · stalled · aborted: user`); it wins. */
const FOOTER_STOP = /(?:^|\s)aborted: (user|system|provider)\b/;
const FOOTER_CAUSE: Readonly<Record<string, TurnStopCause>> = { user: "aborted", system: "system-aborted", provider: "provider-failed" };
const FOOTER_LINES = 3;

/**
 * Reads a stopped lane's screen (the caller reads the pane; nothing here does): the label of an aborted turn among
 * the last non-empty lines (whole lines only, so output that quotes one does not count) or omo's footer lifecycle
 * segment; the goal or session pause and any pending continuation (goal wait countdown, monitor watch) from the
 * footer; and `asking` from the question prompt.
 */
export const turnStop = (screen: string, asking: boolean): TurnStop => {
  const lines = screen.split("\n").map((line) => line.trim()).filter(Boolean);
  let cause: TurnStopCause = "finished";
  for (const line of lines.slice(-TURN_END_LINES)) {
    const hit = STOP_LABELS.find(([label]) => label.test(line));
    if (hit) cause = hit[1];
  }
  const footer = lines.slice(-FOOTER_LINES).join("\n");
  const source = FOOTER_STOP.exec(footer)?.[1];
  if (source) cause = FOOTER_CAUSE[source] ?? cause;
  const continuation = /goal (?:continues|retries|resumes) in |[◉◎] watching /.test(footer);
  const hold: TurnHold = asking ? "question"
    : /Goal paused \(\/goal resume\)/.test(footer) ? "goal-paused"
    // omo's own session pause after a stopped run: `Paused · 0 updates held · type to continue`.
    : /(?:^|\s)(?:Paused|Run paused|Interrupted) · /.test(footer) ? "session-paused"
    : /Goal stopped: no progress/.test(footer) ? "goal-stopped"
    : /Goal blocked/.test(footer) ? "goal-blocked"
    : /Goal achieved/.test(footer) ? "goal-complete"
    : /Pursuing goal/.test(footer) ? "none" : "no-goal";
  return { cause, hold, continuation };
};

export type ObserveHostDeps = {
  readonly run: Runner;
  readonly procs?: () => Promise<readonly Proc[]>;
  /** The lanes this runner owns, as pane id to lane key, for the panes listed (only panes whose identity checked out). */
  readonly owned?: (panes: readonly Pane[]) => Promise<ReadonlyMap<string, string>>;
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
  const owned = (await deps.owned?.(panes)) ?? new Map<string, string>();
  const seen = new Set<string>();
  const out: ObservedLane[] = [];
  for (const pane of panes) {
    const ownedKey = owned.get(pane.pane_id);
    const info = ownedKey ? undefined : await processInfo(deps.run, pane.pane_id);
    const pids = [...(info?.foreground_processes ?? []).map((p) => p.pid), info?.shell_pid].filter((pid): pid is number => typeof pid === "number");
    const key = ownedKey
      ?? pids.map((pid) => owner.get(pid)).find((k): k is string => typeof k === "string")
      ?? (info?.foreground_processes ?? []).map((p) => briefLane(p.argv)).find((k): k is string => k !== undefined);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, pane: pane.pane_id, tab: pane.tab_id ?? "", status: laneStatus(pane) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
};
