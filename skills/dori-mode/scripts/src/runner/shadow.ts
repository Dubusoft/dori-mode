/**
 * Shadow comparison: a runner in shadow mode reports what it sees, the supervisor changes nothing and compares it with
 * what the current paths found. Both sides are normalized into units `{kind, laneKey, generation, field, valueHash}`
 * and compared per unit key `kind|laneKey|generation|field`. A difference is one of `missing-in-runner`,
 * `missing-in-legacy`, `value-differs`; a difference that is gone at the next cycle is reclassified `timing`. Only
 * non-timing differences count as failures. Each reported difference is logged as one `RUNNER_SHADOW_DIFF` line.
 */

import { createHash } from "node:crypto";

/** What is compared: lane status, the latest `[REPORT]` line hash, the guard verdict (never raw figures), the pane id. */
export type ShadowKind = "lane.state" | "lane.report" | "guard.verdict" | "inventory.pane";

export type ShadowUnit = {
  readonly kind: ShadowKind;
  /** The lane key; guard verdicts use the machine label here. */
  readonly laneKey: string;
  /** The registry's lane generation (`lastRecoveryAt ?? 0`); 0 for guard verdicts. */
  readonly generation: number;
  readonly field: string;
  readonly valueHash: string;
};

export type ShadowDiffClass = "missing-in-runner" | "missing-in-legacy" | "value-differs" | "timing";

export type ShadowDiff = {
  readonly class: ShadowDiffClass;
  readonly kind: ShadowKind;
  readonly laneKey: string;
  readonly generation: number;
  readonly field: string;
  readonly runnerHash?: string;
  readonly legacyHash?: string;
};

/** The result of one cycle: `report` is logged now, `pending` waits one cycle to tell timing from a real difference. */
export type ShadowCycle = { readonly report: readonly ShadowDiff[]; readonly pending: readonly ShadowDiff[] };

/** A stable short hash of a normalized value (sha256 hex, first 16 characters). */
export const valueHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Builds a unit, hashing `value`. */
export const shadowUnit = (kind: ShadowKind, laneKey: string, generation: number, field: string, value: string): ShadowUnit => ({
  kind,
  laneKey,
  generation,
  field,
  valueHash: valueHash(value),
});

/** `kind|laneKey|generation|field` */
export const unitKey = (unit: Pick<ShadowUnit, "kind" | "laneKey" | "generation" | "field">): string =>
  `${unit.kind}|${unit.laneKey}|${unit.generation}|${unit.field}`;

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const indexUnits = (units: readonly ShadowUnit[]): Map<string, ShadowUnit> => new Map(units.map((u) => [unitKey(u), u]));

/** The raw differences between the two sides of one cycle (never `timing`), sorted by unit key. */
export const diffUnits = (legacy: readonly ShadowUnit[], runner: readonly ShadowUnit[]): ShadowDiff[] => {
  const l = indexUnits(legacy);
  const r = indexUnits(runner);
  const diffs: [string, ShadowDiff][] = [];
  for (const key of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(key);
    const b = r.get(key);
    const unit = (a ?? b)!;
    const base = { kind: unit.kind, laneKey: unit.laneKey, generation: unit.generation, field: unit.field };
    if (a && !b) diffs.push([key, { ...base, class: "missing-in-runner", legacyHash: a.valueHash }]);
    else if (!a && b) diffs.push([key, { ...base, class: "missing-in-legacy", runnerHash: b.valueHash }]);
    else if (a && b && a.valueHash !== b.valueHash)
      diffs.push([key, { ...base, class: "value-differs", runnerHash: b.valueHash, legacyHash: a.valueHash }]);
  }
  return diffs.sort(([x], [y]) => byKey(x, y)).map(([, d]) => d);
};

/**
 * Settles a cycle against the previous cycle's pending differences: one pending before and still present is reported
 * with its class; one pending before and gone now is reported as `timing`; one new now becomes pending.
 */
export const settleCycle = (previousPending: readonly ShadowDiff[], current: readonly ShadowDiff[]): ShadowCycle => {
  const before = new Set(previousPending.map(unitKey));
  const now = new Set(current.map(unitKey));
  const report: [string, ShadowDiff][] = [];
  const pending: [string, ShadowDiff][] = [];
  for (const diff of previousPending) {
    if (!now.has(unitKey(diff))) report.push([unitKey(diff), { ...diff, class: "timing" }]);
  }
  for (const diff of current) {
    (before.has(unitKey(diff)) ? report : pending).push([unitKey(diff), diff]);
  }
  const sorted = (list: [string, ShadowDiff][]): ShadowDiff[] => list.sort(([x], [y]) => byKey(x, y)).map(([, d]) => d);
  return { report: sorted(report), pending: sorted(pending) };
};

export const isShadowFailure = (diff: ShadowDiff): boolean => diff.class !== "timing";

/**
 * `RUNNER_SHADOW_DIFF runner=<label> class=<class> kind=<kind> lane=<key> gen=<n> field=<field> runnerHash=<h|-> legacyHash=<h|->`
 */
export const shadowDiffLine = (runner: string, diff: ShadowDiff): string =>
  `RUNNER_SHADOW_DIFF runner=${runner} class=${diff.class} kind=${diff.kind} lane=${diff.laneKey} gen=${diff.generation} field=${diff.field} runnerHash=${diff.runnerHash ?? "-"} legacyHash=${diff.legacyHash ?? "-"}`;
