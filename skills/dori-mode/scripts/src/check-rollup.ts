// A PR's check rollup as `gh pr view|list --json statusCheckRollup` gives it, reduced to the runs that still count.
// GitHub keeps every check run of the head commit in the rollup, so a check that ran twice at the same head (a duplicate
// trigger whose older run the workflow's concurrency cancelled, or a rerun) shows up twice. Only the newest run of a
// check decides it: an older CANCELLED or FAILURE run that a newer run replaced is not a failure, and a newest run that
// is itself CANCELLED or FAILURE still is.

/** One rollup entry: a CheckRun (`status`, `conclusion`) or a StatusContext (`state`). */
export type RollupCheck = {
  readonly __typename?: string;
  readonly name?: string;
  readonly workflowName?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
};

/** The check a run belongs to: its workflow and name; undefined for a status context or an unnamed run. */
const checkKey = (c: RollupCheck): string | undefined =>
  c.__typename === "StatusContext" || !c.name ? undefined : `${c.workflowName ?? ""}\u0000${c.name}`;

/** Whether run `a` replaces run `b` of the same check: a run still going is newer than a finished one, then the later start. */
const newer = (a: RollupCheck, b: RollupCheck): boolean => {
  const aDone = a.status === "COMPLETED";
  const bDone = b.status === "COMPLETED";
  if (aDone !== bDone) return !aDone;
  const at = (c: RollupCheck) => `${c.startedAt ?? ""}\u0000${c.completedAt ?? ""}`;
  return at(a) >= at(b);
};

/**
 * The rollup with each check's superseded runs dropped: of the runs sharing a workflow and name, only the newest is
 * kept, in its original position. Status contexts (GitHub already reports only the latest per context) and runs with no
 * name are kept as they are.
 */
export const latestChecks = <T extends RollupCheck>(rollup: readonly T[]): T[] => {
  const latest = new Map<string, T>();
  for (const c of rollup) {
    const key = checkKey(c);
    if (key === undefined) continue;
    const seen = latest.get(key);
    if (!seen || newer(c, seen)) latest.set(key, c);
  }
  return rollup.filter((c) => {
    const key = checkKey(c);
    return key === undefined || latest.get(key) === c;
  });
};
