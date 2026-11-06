import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DriftConfig } from "./config.ts";
import type { Emit } from "./done-flow.ts";
import { githubTargets, type OpenPull, sameRepoHead } from "./github-events.ts";
import type { LaneReport, LaneReportStore } from "./lane-reports.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Runner } from "./run.ts";

/**
 * Lane drift (urgent LANE_DRIFT): machine-detectable deviations of a working lane, raised by the supervisor itself. The
 * lead has no periodic obligation; it hears only when a lane drifts.
 * - milestone-overdue: no milestone report for `milestoneOverdueMin` since the last one (or the lane's open). Once per
 *   overdue stretch, once more at twice the interval, then quiet until a milestone arrives.
 * - ci-failing: the lane's PR failed its checks on `ciFailStreak` head SHAs in a row (no green between), once per streak.
 *   Read from the GitHub poll the supervisor already runs (GitHubEvents.openPulls); no extra GitHub call.
 */
/** Per lane: the stretch start (last milestone `at`, or openedAt) and how many alerts that stretch has had (0-2). */
type MilestoneState = { readonly since: number; readonly fired: number };
/** Per PR (`repo#n`, repo lowercased): failing head SHAs in a row, the last one counted, and whether this streak alerted. */
type CiState = { readonly lane: string; readonly streak: number; readonly sha: string; readonly fired: boolean };
export type DriftState = { readonly lanes: Readonly<Record<string, MilestoneState>>; readonly pulls: Readonly<Record<string, CiState>> };

export const DRIFT_STATE_FILE = "drift-state.json";
const EMPTY: DriftState = { lanes: {}, pulls: {} };

/** The saved drift state; a missing or unreadable file starts empty. */
export const loadDriftState = (stateDir: string): DriftState => {
  const path = join(stateDir, DRIFT_STATE_FILE);
  if (!existsSync(path)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DriftState>;
    return { lanes: raw.lanes ?? {}, pulls: raw.pulls ?? {} };
  } catch (e) {
    console.error(`DRIFT_STATE_UNREADABLE ${path}: ${e instanceof Error ? e.message : String(e)}; starting empty`);
    return EMPTY;
  }
};

export const saveDriftState = (stateDir: string, state: DriftState): void => {
  const path = join(stateDir, DRIFT_STATE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
};

type Out = { readonly id: string; readonly line: string };

/** Milestone drift over the working lanes; lanes no longer open drop out of the state, paused lanes keep theirs. */
export const milestoneDrift = (
  state: DriftState["lanes"], lanes: readonly Lane[], reports: readonly LaneReport[], overdueMin: number, now: number,
): { readonly lanes: Record<string, MilestoneState>; readonly out: Out[] } => {
  const lastMilestone = new Map<string, number>();
  for (const r of reports) if (r.kind === "milestone") lastMilestone.set(r.lane, Math.max(lastMilestone.get(r.lane) ?? -Infinity, r.at));
  const interval = overdueMin * 60_000;
  const next: Record<string, MilestoneState> = {};
  const out: Out[] = [];
  for (const lane of lanes) {
    const milestone = lastMilestone.get(lane.key);
    const since = milestone ?? Date.parse(lane.openedAt);
    if (!Number.isFinite(since)) continue;
    const prior = state[lane.key];
    let fired = prior && prior.since === since ? prior.fired : 0;
    if (statusOf(lane) === "working") {
      const elapsed = now - since;
      if ((fired === 0 && elapsed >= interval) || (fired === 1 && elapsed >= 2 * interval)) {
        fired += 1;
        out.push({
          id: `lane-drift:${lane.key}:milestone:${since}:${fired}`,
          line: `LANE_DRIFT ${lane.key} milestone-overdue ${Math.floor(elapsed / 60_000)}min since ${milestone === undefined ? "open" : "last milestone"}`,
        });
      }
    }
    next[lane.key] = { since, fired };
  }
  return { lanes: next, out };
};

/** PR key -> owning lane key, for the given open pulls. */
export type PullOwners = (lanes: readonly Lane[], pulls: readonly OpenPull[]) => Promise<Map<string, string>>;

const pullKey = (pull: Pick<OpenPull, "repo" | "number">): string => `${pull.repo.toLowerCase()}#${pull.number}`;

/** The same ownership rule as CI follow-up: oldest open lane whose Done signal or local worktree branch names the same-repo PR. */
export const pullOwners = (run: Runner): PullOwners => async (lanes, pulls) => {
  const owner = new Map<string, string>();
  const sorted = [...lanes].sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.key.localeCompare(b.key));
  for (const lane of sorted) {
    for (const [repo, targets] of await githubTargets([lane], run)) {
      for (const pull of pulls) {
        if (pull.repo.toLowerCase() !== repo || !sameRepoHead(pull) || !(targets.numbers.has(pull.number) || targets.branches.has(pull.branch))) continue;
        if (!owner.has(pullKey(pull))) owner.set(pullKey(pull), lane.key);
      }
    }
  }
  return owner;
};

/**
 * CI drift over the last poll's open pulls. A failing check at a head SHA not yet counted adds one to its PR's streak
 * (only when a working lane owns it); green ends the streak; pending or none leaves it. A PR no longer open drops out.
 * Owners are looked up only when a new failing SHA needs counting.
 */
export const ciDrift = async (
  state: DriftState["pulls"], lanes: readonly Lane[], pulls: readonly OpenPull[], streakAt: number, owners: PullOwners,
): Promise<{ readonly pulls: Record<string, CiState>; readonly out: Out[] }> => {
  const next: Record<string, CiState> = {};
  const out: Out[] = [];
  const fresh = pulls.filter((p) => p.checks === "failing" && state[pullKey(p)]?.sha !== p.sha);
  const working = lanes.filter((l) => statusOf(l) === "working");
  const owner = fresh.length ? await owners(working, fresh) : new Map<string, string>();
  for (const pull of pulls) {
    const key = pullKey(pull);
    const prior = state[key];
    if (pull.checks === "green") continue;
    if (pull.checks !== "failing" || prior?.sha === pull.sha) {
      if (prior) next[key] = prior;
      continue;
    }
    const lane = owner.get(key);
    if (!lane) { if (prior) next[key] = prior; continue; }
    const streak = prior && prior.lane === lane ? prior.streak + 1 : 1;
    let fired = prior && prior.lane === lane ? prior.fired : false;
    if (!fired && streak >= streakAt) {
      fired = true;
      out.push({ id: `lane-drift:${lane}:ci:${key}:${pull.sha}`, line: `LANE_DRIFT ${lane} ci-failing ${streak} consecutive failures ${pull.url}` });
    }
    next[key] = { lane, streak, sha: pull.sha, fired };
  }
  return { pulls: next, out };
};

export type DriftDeps = {
  readonly stateDir: string;
  readonly drift: DriftConfig;
  readonly now: () => number;
  readonly openLanes: () => Promise<readonly Lane[]>;
  readonly owners: PullOwners;
};

/**
 * One drift pass: emits each new LANE_DRIFT line (stable ids, so a crash between emit and save does not double it in the
 * journal), then saves the state, so a restarted supervisor does not fire the same stretch or streak again.
 */
export const driftTick = async (deps: DriftDeps, reports: LaneReportStore | undefined, pulls: readonly OpenPull[], emit: Emit): Promise<void> => {
  if (!deps.drift.enabled) return;
  const state = loadDriftState(deps.stateDir);
  const lanes = await deps.openLanes();
  const milestones = reports
    ? milestoneDrift(state.lanes, lanes, reports.list(), deps.drift.milestoneOverdueMin, deps.now())
    : { lanes: { ...state.lanes }, out: [] };
  const ci = await ciDrift(state.pulls, lanes, pulls, deps.drift.ciFailStreak, deps.owners);
  for (const { id, line } of [...milestones.out, ...ci.out]) await emit(line, id);
  saveDriftState(deps.stateDir, { lanes: milestones.lanes, pulls: ci.pulls });
};
