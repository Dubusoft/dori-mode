import { expect, test } from "bun:test";

import { latestChecks, type RollupCheck } from "../src/check-rollup.ts";

const run = (conclusion: string, startedAt: string, patch: Partial<RollupCheck> = {}): RollupCheck =>
  ({ __typename: "CheckRun", name: "preview", workflowName: "Deploy", status: "COMPLETED", conclusion, startedAt, completedAt: startedAt, ...patch });

test("a run a newer run of the same check replaced is dropped, so a superseded CANCELLED run no longer counts", () => {
  const cancelled = run("CANCELLED", "2026-11-20T01:00:00Z");
  const success = run("SUCCESS", "2026-11-20T01:00:05Z");
  expect(latestChecks([cancelled, success])).toEqual([success]);
  expect(latestChecks([success, cancelled])).toEqual([success]);
});

test("the newest run decides even when it is the CANCELLED or FAILURE one", () => {
  for (const bad of ["CANCELLED", "FAILURE"]) {
    const newest = run(bad, "2026-11-20T02:00:00Z");
    expect(latestChecks([run("SUCCESS", "2026-11-20T01:00:00Z"), newest])).toEqual([newest]);
  }
});

test("a run still going replaces a finished one, and different checks, status contexts and unnamed runs all stay", () => {
  const queued = run("", "", { status: "QUEUED", conclusion: undefined });
  expect(latestChecks([run("CANCELLED", "2026-11-20T01:00:00Z"), queued])).toEqual([queued]);
  const other = [run("FAILURE", "2026-11-20T01:00:00Z", { workflowName: "CI" }), run("FAILURE", "2026-11-20T01:00:00Z", { name: "build" })];
  const context: RollupCheck = { __typename: "StatusContext", state: "FAILURE" };
  const unnamed: RollupCheck = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
  const rollup = [run("SUCCESS", "2026-11-20T03:00:00Z"), ...other, context, unnamed, { ...unnamed }];
  expect(latestChecks(rollup)).toEqual(rollup);
});
