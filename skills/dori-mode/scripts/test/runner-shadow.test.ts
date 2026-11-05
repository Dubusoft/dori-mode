import { describe, expect, test } from "bun:test";
import { reportLines } from "../src/freshness.ts";
import { diffUnits, isShadowFailure, settleCycle, shadowDiffLine, shadowUnit, unitKey, valueHash } from "../src/runner/shadow.ts";

const state = (key: string, v: string, gen = 0) => shadowUnit("lane.state", key, gen, "status", v);

describe("shadow units", () => {
  test("hash is stable, 16 hex chars, and key is kind|lane|gen|field", () => {
    expect(valueHash("working")).toBe(valueHash("working"));
    expect(valueHash("working")).toMatch(/^[0-9a-f]{16}$/);
    expect(valueHash("a")).not.toBe(valueHash("b"));
    expect(unitKey(state("L1", "x", 2))).toBe("lane.state|L1|2|status");
  });

  test("report line hash uses the parsed [REPORT] line, not the surrounding screen", () => {
    const line = (screen: string) => reportLines(screen, "L1").at(-1) ?? "";
    const a = line("noise\n[REPORT] L1 | milestone | built it\n");
    const b = line("other noise\n  [REPORT] L1 | milestone | built it\nmore");
    expect(shadowUnit("lane.report", "L1", 0, "latest", a)).toEqual(shadowUnit("lane.report", "L1", 0, "latest", b));
  });
});

describe("diffUnits", () => {
  test("classifies the three raw classes, sorted, and ignores equal units", () => {
    const legacy = [state("B", "idle"), state("A", "working"), state("C", "same")];
    const runner = [state("A", "idle"), state("C", "same"), state("D", "x")];
    const diffs = diffUnits(legacy, runner);
    expect(diffs.map((d) => [d.laneKey, d.class])).toEqual([
      ["A", "value-differs"],
      ["B", "missing-in-runner"],
      ["D", "missing-in-legacy"],
    ]);
    expect(diffs[0]!.runnerHash).toBe(valueHash("idle"));
    expect(diffs[0]!.legacyHash).toBe(valueHash("working"));
    expect(diffs[1]!.runnerHash).toBeUndefined();
    expect(diffs[2]!.legacyHash).toBeUndefined();
  });

  test("different generations are different units; guard and pane kinds compare too", () => {
    const g = (v: string) => shadowUnit("guard.verdict", "m1", 0, "level", v);
    const p = (v: string) => shadowUnit("inventory.pane", "L1", 0, "paneId", v);
    expect(diffUnits([state("A", "x", 1)], [state("A", "x", 2)]).map((d) => d.class)).toEqual(["missing-in-runner", "missing-in-legacy"]);
    expect(diffUnits([g("alert"), p("w1:p1")], [g("critical"), p("w1:p1")]).map((d) => d.kind)).toEqual(["guard.verdict"]);
  });

  test("does not mutate its inputs", () => {
    const legacy = [state("B", "1"), state("A", "2")];
    const copy = structuredClone(legacy);
    diffUnits(legacy, []);
    expect(legacy).toEqual(copy);
  });
});

describe("settleCycle", () => {
  test("a new difference waits one cycle, then is reported with its class", () => {
    const d = diffUnits([state("A", "x")], [state("A", "y")]);
    const first = settleCycle([], d);
    expect(first.report).toEqual([]);
    expect(first.pending).toEqual(d);
    const second = settleCycle(first.pending, d);
    expect(second.report.map((x) => x.class)).toEqual(["value-differs"]);
    expect(second.pending).toEqual([]);
  });

  test("a difference gone on the next cycle is timing and not a failure", () => {
    const d = diffUnits([state("A", "x")], [state("A", "y")]);
    const first = settleCycle([], d);
    const second = settleCycle(first.pending, []);
    expect(second.report.map((x) => x.class)).toEqual(["timing"]);
    expect(second.report.some(isShadowFailure)).toBe(false);
    expect(second.pending).toEqual([]);
  });

  test("mixed: persisting reported, vanished timing, fresh pending", () => {
    const a = diffUnits([state("A", "x")], [state("A", "y")])[0]!;
    const b = diffUnits([state("B", "x")], [])[0]!;
    const c = diffUnits([], [state("C", "x")])[0]!;
    const out = settleCycle([a, b], [a, c]);
    expect(out.report.map((x) => [x.laneKey, x.class])).toEqual([["A", "value-differs"], ["B", "timing"]]);
    expect(out.pending.map((x) => x.laneKey)).toEqual(["C"]);
    expect(out.report.filter(isShadowFailure).map((x) => x.laneKey)).toEqual(["A"]);
  });
});

describe("shadowDiffLine", () => {
  test("formats all fields, dashes for absent hashes", () => {
    const [d] = diffUnits([state("A", "x", 3)], []);
    expect(shadowDiffLine("r1", d!)).toBe(
      `RUNNER_SHADOW_DIFF runner=r1 class=missing-in-runner kind=lane.state lane=A gen=3 field=status runnerHash=- legacyHash=${valueHash("x")}`,
    );
  });
});
