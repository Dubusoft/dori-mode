import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The monitor filters exactly as setup.md tells the lead to arm them, keyed by the table's Monitor column. */
const filters = (): Map<string, RegExp> => {
  const md = readFileSync(join(import.meta.dir, "../../references/setup.md"), "utf8");
  const out = new Map<string, RegExp>();
  for (const line of md.split("\n")) {
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const filter = cells[3]?.match(/^`(.+)`$/)?.[1];
    if (cells[1] && filter) out.set(cells[1], new RegExp(filter.replaceAll("\\|", "|")));
  }
  return out;
};

const wakes = (name: string, lines: string[]): string[] => {
  const re = filters().get(name);
  if (!re) throw new Error(`setup.md has no "${name}" monitor`);
  return lines.filter((l) => re.test(l));
};

test("the done-flow filter wakes on every lane event, never on the ready line", () => {
  const events = ["LANE_DONE_CLAIMED a w:p1 merged", "LANE_NOT_DONE a dirty", "LANE_CLOSED a {}", "LANE_AUTO_CLOSED a", "LANE_REPORT a", "LANE_WATCH_WARN Error: herdr down"];
  expect(wakes("done flow", ["LANE_WATCH_READY", ...events])).toEqual(events);
});

test("the host-guard filter wakes on alerts and clears, never on the ready line", () => {
  const lines = ["HOST_GUARD_READY", "HOST_GUARD ALERT disk free 12 GB", "HOST_GUARD CLEAR load 40"];
  expect(wakes("host guard", lines)).toEqual(["HOST_GUARD ALERT disk free 12 GB", "HOST_GUARD CLEAR load 40"]);
});

test("the freshness filter wakes only on a paused lane that is working; the rest goes to the log", () => {
  const kinds = ["nudged", "posted", "no-report", "pending-report", "stale-report", "working-while-paused"];
  expect(wakes("freshness", kinds.map((k) => `${k.toUpperCase()} lane-a detail`))).toEqual(["WORKING-WHILE-PAUSED lane-a detail"]);
});

