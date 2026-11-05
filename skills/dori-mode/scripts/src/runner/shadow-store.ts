import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lockDownDatabase } from "./fs-safety.ts";
import { HUB_FILE } from "./hub.ts";
import type { ShadowDiffClass } from "./shadow.ts";

/**
 * Keeps every reported shadow difference in the hub's `<stateDir>/runners.sqlite` (table `shadow_diffs`), so
 * `dori runner shadow-report` can say, per runner, how many differences of each class it had and how many count as
 * failures (every class but `timing`). It stores what the `RUNNER_SHADOW_DIFF` lines say and nothing else.
 */

export const SHADOW_CLASSES: readonly ShadowDiffClass[] = ["missing-in-runner", "missing-in-legacy", "value-differs", "timing"];

export type StoredDiff = {
  readonly runner: string;
  readonly class: ShadowDiffClass;
  readonly kind: string;
  readonly lane: string;
  readonly gen: number;
  readonly field: string;
  readonly runnerHash?: string;
  readonly legacyHash?: string;
};

const LINE = /^RUNNER_SHADOW_DIFF runner=(\S+) class=(\S+) kind=(\S+) lane=(\S+) gen=(\d+) field=(\S+) runnerHash=(\S+) legacyHash=(\S+)$/;

export const parseDiffLine = (line: string): StoredDiff | undefined => {
  const m = LINE.exec(line.trim());
  if (!m || !(SHADOW_CLASSES as readonly string[]).includes(m[2]!)) return undefined;
  return {
    runner: m[1]!, class: m[2] as ShadowDiffClass, kind: m[3]!, lane: m[4]!, gen: Number(m[5]), field: m[6]!,
    ...(m[7] !== "-" ? { runnerHash: m[7]! } : {}), ...(m[8] !== "-" ? { legacyHash: m[8]! } : {}),
  };
};

const open = (stateDir: string): Database => {
  const path = join(stateDir, HUB_FILE);
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS shadow_diffs (id INTEGER PRIMARY KEY, runner TEXT NOT NULL, class TEXT NOT NULL, kind TEXT NOT NULL, lane TEXT NOT NULL, gen INTEGER NOT NULL, field TEXT NOT NULL, runnerHash TEXT, legacyHash TEXT, at INTEGER NOT NULL)");
  lockDownDatabase(path);
  return db;
};

/** Stores each `RUNNER_SHADOW_DIFF` line of `lines` at `at`; other lines are ignored. Returns how many it stored. */
export const recordDiffLines = (stateDir: string, lines: readonly string[], at: number): number => {
  const diffs = lines.map(parseDiffLine).filter((d): d is StoredDiff => d !== undefined);
  if (!diffs.length) return 0;
  const db = open(stateDir);
  try {
    const insert = db.query("INSERT INTO shadow_diffs (runner, class, kind, lane, gen, field, runnerHash, legacyHash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    db.transaction(() => { for (const d of diffs) insert.run(d.runner, d.class, d.kind, d.lane, d.gen, d.field, d.runnerHash ?? null, d.legacyHash ?? null, at); })();
    return diffs.length;
  } finally {
    db.close();
  }
};

/** Whether the hub's `runners` table has `label` (the table is absent before the hub first opened). */
const knownRunner = (db: Database, label: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runners'").get() !== null
  && db.query("SELECT 1 FROM runners WHERE label = ?").get(label) !== null;

export type ShadowReportRow = { readonly runner: string; readonly failures: number; readonly counts: Readonly<Record<ShadowDiffClass, number>> };

export const shadowReport = (stateDir: string, filter: { readonly runner?: string; readonly sinceMs?: number } = {}): ShadowReportRow[] => {
  if (!existsSync(join(stateDir, HUB_FILE))) return [];
  const db = open(stateDir);
  try {
    const rows = db.query("SELECT runner, class, COUNT(*) AS n FROM shadow_diffs WHERE (?1 IS NULL OR runner = ?1) AND at >= ?2 GROUP BY runner, class ORDER BY runner")
      .all(filter.runner ?? null, filter.sinceMs ?? 0) as { runner: string; class: ShadowDiffClass; n: number }[];
    const byRunner = new Map<string, Record<ShadowDiffClass, number>>();
    for (const row of rows) {
      const counts = byRunner.get(row.runner) ?? Object.fromEntries(SHADOW_CLASSES.map((c) => [c, 0])) as Record<ShadowDiffClass, number>;
      counts[row.class] = row.n;
      byRunner.set(row.runner, counts);
    }
    // A runner the hub knows that has no stored difference gets a row of zeros, so a clean count reads failures=0.
    if (filter.runner !== undefined && !byRunner.has(filter.runner) && knownRunner(db, filter.runner)) {
      byRunner.set(filter.runner, Object.fromEntries(SHADOW_CLASSES.map((c) => [c, 0])) as Record<ShadowDiffClass, number>);
    }
    return [...byRunner].map(([runner, counts]) => ({ runner, counts, failures: SHADOW_CLASSES.filter((c) => c !== "timing").reduce((sum, c) => sum + counts[c], 0) }));
  } finally {
    db.close();
  }
};

export const renderShadowReport = (rows: readonly ShadowReportRow[]): string =>
  rows.map((r) => `RUNNER_SHADOW_REPORT runner=${r.runner} failures=${r.failures} ${SHADOW_CLASSES.map((c) => `${c}=${r.counts[c]}`).join(" ")}`).join("\n");
