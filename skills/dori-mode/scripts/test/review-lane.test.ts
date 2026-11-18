import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { launchQueue } from "../src/routing.ts";
import { parseSignal } from "../src/signals.ts";
import { launchReviewLane, reviewBrief, reviewDone } from "../src/review-lane.ts";
import type { ReviewJob } from "../src/review-receipt.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-14T12:00:00Z");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const job: ReviewJob = {
  jobId: "rv-app-7-aaaaaaa-0a0b0c",
  snapshot: {
    repo: "acme/app", prNumber: 7, headSha: "a".repeat(40), baseRef: "dev", baseSha: "b".repeat(40), mergeBaseSha: "c".repeat(40),
    policyVersion: "t4-1", criteriaSha256: "d".repeat(64),
  },
  authorLaneKey: "author", reviewerLaneKey: "review-app-7-aaaaaaa", round: 1, diffSha256: "e".repeat(64),
  authorModel: { id: "m/author" }, tokenHash: "f".repeat(64), createdAt: T0,
};

test("the review brief names the job, the token, the one gate reviewer and the exact result shape", () => {
  const token = "1".repeat(64);
  const text = reviewBrief(job, token, {
    url: "https://github.com/acme/app/pull/7", title: "Add thing", snapshotPath: "/wt/app-review-x", inputDir: "/s/review-inputs/x",
    diffPath: "/s/review-inputs/x/diff.patch", criteriaPath: "/s/review-inputs/x/criteria.md", prPath: "/s/review-inputs/x/pr.md",
  });
  for (const part of [
    job.jobId, `"jobToken": "${token}"`, `subagent_type "omo-native-gate-reviewer"`, "exactly ONE", "NEVER edit code, commit, push, merge",
    "/wt/app-review-x", "/s/review-inputs/x/diff.patch", `"source": "reviewer"`, `"body": "review-body.json"`, `"taskRecord"`,
    `"startedAt"`, `"completedAt"`, "review-report.md", `source "qa"`, "dori report review-app-7-aaaaaaa done", "60 s", "ONE correction",
  ]) expect(text).toContain(part);
});

test("the review lane's Done line is its installed result file", () => {
  const signal = parseSignal(reviewDone("/home/u/.dori/state", "review-app-7-aaaaaaa"));
  expect(signal).toMatchObject({ kind: "file", path: "/home/u/.dori/research/review-app-7-aaaaaaa/review-result.json" });
});

const world = (panesMax = 20) => {
  const state = withState();
  cleanups.push(state.done);
  const w = newWorld();
  w.panes = [{ pane_id: "p0", workspace_id: "w" }];
  w.inspection = { git: undefined };
  const deps = depsFor(w, fakeClock(T0), state.dir, { guard: { ...defaultConfig("/home/test").guard, panesMax } });
  const request = (key: string) => {
    const brief = join(state.dir, "briefs", `${key}.md`);
    mkdirSync(dirname(brief), { recursive: true });
    writeFileSync(brief, "Review the snapshot.\n");
    return { key, title: key, brief, cwd: state.dir, thread: "t1" };
  };
  return { w, deps, request, stateDir: state.dir };
};

test("launchReviewLane goes through the shared admission as a local review on the default model", async () => {
  const h = world();
  const first = await launchReviewLane(h.deps, h.request("review-app-7-aaaaaaa"), () => {});
  expect(first.kind).toBe("started");
  if (first.kind !== "started") throw new Error("expected a start");
  expect(first.lane.review).toBe(true);
  expect(first.lane.model).toBe(h.deps.config.defaultModel);
  expect(h.w.ops.find((o) => o.op === "start" && o.key === "review-app-7-aaaaaaa")?.args).toMatchObject({ review: true });
  // No slot is reserved for reviews: a second review takes the next free lane slot.
  expect((await launchReviewLane(h.deps, h.request("review-app-8-bbbbbbb"), () => {})).kind).toBe("started");
});

test("a review waits like an author lane once the pane cap is full", async () => {
  // Cap 2 with one other pane: one free slot.
  const h = world(2);
  expect((await launchReviewLane(h.deps, h.request("review-app-7-aaaaaaa"), () => {})).kind).toBe("started");
  const second = await launchReviewLane(h.deps, h.request("review-app-8-bbbbbbb"), () => {});
  expect(second.kind).toBe("held");
  if (second.kind === "held") expect(second.reason).toStartWith("HOLD ");
  expect(launchQueue(h.stateDir).map((q) => [q.key, q.review])).toEqual([["review-app-8-bbbbbbb", true]]);
});

test("a runner that cannot run a review lane refuses it before any start or HOLD queue entry", async () => {
  for (const [patch, reason] of [
    [{ profiles: ["default", "sandboxed"] }, "has no agents.review"],
    [{ profiles: ["default", "sandboxed", "review"], os: "darwin" }, "macOS lane sandbox has no review profile"],
  ] as const) {
    const h = world();
    const deps = { ...h.deps, ops: { ...h.deps.ops, observeMachine: async (machine?: string) => ({ ...(await h.deps.ops.observeMachine(machine)), ...patch }) } };
    const refused = await launchReviewLane(deps, h.request("review-app-7-aaaaaaa"), () => {});
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") expect(refused.detail).toStartWith("REVIEW_UNSUPPORTED machine local");
    if (refused.kind === "refused") expect(refused.detail).toContain(reason);
    expect(h.w.ops.filter((o) => o.op === "start")).toEqual([]);
    expect(launchQueue(h.stateDir)).toEqual([]);
  }
  // A runner reporting the review profile on Linux starts it.
  const h = world();
  const deps = { ...h.deps, ops: { ...h.deps.ops, observeMachine: async (machine?: string) => ({ ...(await h.deps.ops.observeMachine(machine)), profiles: ["review"] }) } };
  expect((await launchReviewLane(deps, h.request("review-app-7-aaaaaaa"), () => {})).kind).toBe("started");
});
