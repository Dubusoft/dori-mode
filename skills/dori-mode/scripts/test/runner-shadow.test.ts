import { describe, expect, test } from "bun:test";
import { reportLines } from "../src/freshness.ts";
import type { Pane } from "../src/panes.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import type { Lane } from "../src/registry.ts";
import { observeLanes, SHADOW_SETTLE_MS, ShadowObserver } from "../src/runner/serve.ts";
import { diffUnits, isShadowFailure, settleCycle, shadowDiffLine, shadowUnit, unitKey, valueHash } from "../src/runner/shadow.ts";

const state = (key: string, v: string, gen = 0) => shadowUnit("lane.state", key, gen, "status", v);
const S = SHADOW_SETTLE_MS;

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
  test("a difference is reported with its class only after SHADOW_SETTLE_MS, then re-armed", () => {
    const d = diffUnits([state("A", "x")], [state("A", "y")]);
    const first = settleCycle([], d, 0, S);
    expect(first.report).toEqual([]);
    expect(first.pending.map((x) => [x.laneKey, x.since, x.reported])).toEqual([["A", 0, false]]);
    const early = settleCycle(first.pending, d, S - 1, S);
    expect(early.report).toEqual([]);
    const settled = settleCycle(early.pending, d, S, S);
    expect(settled.report.map((x) => x.class)).toEqual(["value-differs"]);
    expect(settled.report[0]).not.toHaveProperty("since");
    expect(settleCycle(settled.pending, d, 2 * S - 1, S).report).toEqual([]);
    expect(settleCycle(settled.pending, d, 2 * S, S).report.map((x) => x.class)).toEqual(["value-differs"]);
    // Gone after it was reported: nothing more, not even timing.
    expect(settleCycle(settled.pending, [], S + 1, S)).toEqual({ report: [], pending: [] });
  });

  test("a difference gone before SHADOW_SETTLE_MS is timing once and not a failure", () => {
    const d = diffUnits([state("A", "x")], [state("A", "y")]);
    const first = settleCycle([], d, 0, S);
    const still = settleCycle(first.pending, d, 5_000, S);
    expect(still.report).toEqual([]);
    const gone = settleCycle(still.pending, [], 25_000, S);
    expect(gone.report.map((x) => x.class)).toEqual(["timing"]);
    expect(gone.report.some(isShadowFailure)).toBe(false);
    expect(gone.pending).toEqual([]);
  });

  test("mixed: settled reported, vanished timing, fresh pending", () => {
    const at = (d: ReturnType<typeof diffUnits>[number], since: number) => ({ ...d, since, reported: false });
    const a = diffUnits([state("A", "x")], [state("A", "y")])[0]!;
    const b = diffUnits([state("B", "x")], [])[0]!;
    const c = diffUnits([], [state("C", "x")])[0]!;
    const out = settleCycle([at(a, 0), at(b, 0)], [a, c], S, S);
    expect(out.report.map((x) => [x.laneKey, x.class])).toEqual([["A", "value-differs"], ["B", "timing"]]);
    expect(out.pending.map((x) => [x.laneKey, x.reported])).toEqual([["A", true], ["C", false]]);
    expect(out.report.filter(isShadowFailure).map((x) => x.laneKey)).toEqual(["A"]);
  });
});

describe("ShadowObserver against the legacy pane list", () => {
  const lane = (key: string, pane: string, extra: object = {}): Lane =>
    ({ key, title: key, thread: "none", brief: "b", done: [], openedAt: "2026-11-05T00:00:00Z", pane, ...extra }) as unknown as Lane;
  const pane = (id: string, agent_status?: string): Pane => ({ pane_id: id, workspace_id: "w", tab_id: "t", agent: "omo", ...(agent_status ? { agent_status } : {}) });
  let seq = 0;
  const event = (type: string, body: object): AnyRunnerEvent => ({ v: 1, runner: "local", gen: 1, epoch: 1, seq: ++seq, type, body }) as unknown as AnyRunnerEvent;
  /** Feeds what a local runner publishes for `open` and `panes`: hello inventory and one lane.state each. */
  const runnerSees = (observer: ShadowObserver, open: Lane[], panes: Pane[], hello = true): void => {
    const observed = observeLanes("local", open, panes);
    if (hello) observer.hello("local", observed.map(({ key, pane: p, tab }) => ({ key, pane: p, tab })));
    for (const l of observed) observer.event("local", event("lane.state", { key: l.key, status: l.status, pane: l.pane }));
  };
  const none = new Set<string>();
  const twoCycles = (observer: ShadowObserver, open: Lane[], panes: Pane[] | undefined, archived = none): string[] =>
    [0, S].flatMap((now) => observer.cycle("local", open, now, { panes, archived }));

  test("a paused lane whose pane is gone: both sides say not alive, no difference", () => {
    const open = [lane("paused-lane", "w1:p9", { pausedAt: "2026-11-05T00:00:00Z" })];
    const observer = new ShadowObserver();
    runnerSees(observer, open, []);
    expect(observeLanes("local", open, [])[0]?.status).toBe("missing");
    expect(twoCycles(observer, open, [])).toEqual([]);
  });

  test("agent_status unknown: the runner says dead and the legacy side says not alive, no difference", () => {
    const open = [lane("L", "w1:p1")];
    const panes = [pane("w1:p1", "unknown")];
    expect(observeLanes("local", open, panes)[0]?.status).toBe("dead");
    const observer = new ShadowObserver();
    runnerSees(observer, open, panes);
    expect(twoCycles(observer, open, panes)).toEqual([]);
  });

  test("a lane opened after hello: the pane in lane.state stands in for the hello inventory", () => {
    const observer = new ShadowObserver();
    observer.hello("local", []);
    const open = [lane("late", "w1:p2")];
    const panes = [pane("w1:p2", "working")];
    runnerSees(observer, open, panes, false);
    expect(twoCycles(observer, open, panes)).toEqual([]);
  });

  test("a closed (archived) lane is not missing-in-legacy; a key neither open nor archived still is", () => {
    const observer = new ShadowObserver();
    const panes = [pane("w1:p1", "idle"), pane("w1:p2", "idle")];
    runnerSees(observer, [lane("closed", "w1:p1"), lane("stray", "w1:p2")], panes);
    observer.event("local", event("lane.progress", { key: "closed", reportHash: "h" }));
    const lines = twoCycles(observer, [], panes, new Set(["closed"]));
    expect(lines.filter((l) => l.includes("lane=closed "))).toEqual([]);
    expect(lines.map((l) => l.split(" ").slice(2, 5).join(" "))).toEqual([
      "class=missing-in-legacy kind=inventory.pane lane=stray",
      "class=missing-in-legacy kind=lane.state lane=stray",
    ]);
  });

  test("a transition shorter than SHADOW_SETTLE_MS is reported only as timing", () => {
    const observer = new ShadowObserver();
    const open = [lane("L", "w1:p1")];
    runnerSees(observer, open, [pane("w1:p1", "working")]);
    // The pane died; the supervisor sees it at once, the runner on its next observation 25 s later.
    expect(observer.cycle("local", open, 0, { panes: [], archived: none })).toEqual([]);
    expect(observer.cycle("local", open, 5_000, { panes: [], archived: none })).toEqual([]);
    runnerSees(observer, open, [], false);
    const lines = observer.cycle("local", open, 25_000, { panes: [], archived: none });
    expect(lines.map((l) => l.split(" ").slice(2, 5).join(" "))).toEqual(["class=timing kind=lane.state lane=L"]);
    expect(observer.cycle("local", open, 25_000 + S, { panes: [], archived: none })).toEqual([]);
  });

  test("an unreadable legacy pane list compares no lane.state units that pass", () => {
    const observer = new ShadowObserver();
    const open = [lane("L", "w1:p1")];
    runnerSees(observer, open, [pane("w1:p1", "working")]);
    expect(twoCycles(observer, open, undefined)).toEqual([]);
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
