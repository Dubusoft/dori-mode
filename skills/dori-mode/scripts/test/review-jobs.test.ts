import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  complete, enqueue, escalate, fail, markRunning, markStale, recoverAfterRestart, ReviewJobError, ReviewJobs, type ReviewJobErrorCode,
} from "../src/review-jobs.ts";
import { snapshotKey, type ReviewJob, type ReviewReceipt, type ReviewSnapshot } from "../src/review-receipt.ts";

const sha = (c: string): string => c.repeat(40);

const snapshot = (over: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  repo: "Dubusoft/dori-mode", prNumber: 7, headSha: sha("a"), baseRef: "main", baseSha: sha("b"),
  mergeBaseSha: sha("c"), policyVersion: "p1", criteriaSha256: "d".repeat(64), ...over,
});

const job = (jobId: string, over: Partial<ReviewSnapshot> = {}): ReviewJob => ({
  jobId, snapshot: snapshot(over), authorLaneKey: "author", reviewerLaneKey: `reviewer-${jobId}`, round: 1,
  diffSha256: "e".repeat(64), authorModel: { id: "m/author" }, tokenHash: "f".repeat(64), createdAt: 1,
});

const receiptFor = (j: ReviewJob, over: Partial<ReviewReceipt> = {}): ReviewReceipt => ({
  schemaVersion: 1, receiptId: `rr_${j.jobId}`, jobId: j.jobId, source: "reviewer", authorLaneKey: j.authorLaneKey,
  reviewerLaneKey: j.reviewerLaneKey, repo: j.snapshot.repo, prNumber: j.snapshot.prNumber, headSha: j.snapshot.headSha,
  baseRef: j.snapshot.baseRef, baseSha: j.snapshot.baseSha, mergeBaseSha: j.snapshot.mergeBaseSha, diffSha256: j.diffSha256,
  policyVersion: j.snapshot.policyVersion, criteriaSha256: j.snapshot.criteriaSha256, round: j.round, authorModel: j.authorModel,
  reviewerModel: null, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", reportArtifact: "/tmp/r.md",
  resultSha256: "0".repeat(64),
  result: { schemaVersion: 1, jobId: j.jobId, verdict: "pass", summary: "ok", findings: [], notes: [] },
  ...over,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "review-jobs-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const refused = (act: () => unknown, code: ReviewJobErrorCode): void => {
  try { act(); } catch (e) {
    expect(e).toBeInstanceOf(ReviewJobError);
    expect((e as ReviewJobError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("review jobs", () => {
  test("queued, running, completed and stale records survive a restart", () => {
    const store = new ReviewJobs(dir);
    const q = job("q", { prNumber: 1 });
    const r = job("r", { prNumber: 2 });
    const c = job("c", { prNumber: 3 });
    const s = job("s", { prNumber: 4 });
    for (const j of [q, r, c, s]) enqueue(store, 10, j);
    markRunning(store, 11, "r", "lane-r");
    markRunning(store, 11, "c", "lane-c");
    complete(store, 12, "c", receiptFor(c));
    markStale(store, 13, snapshot({ prNumber: 4, headSha: sha("9") }));

    const again = new ReviewJobs(dir);
    expect(again.get("q")?.execution).toEqual({ state: "queued", reason: "queued" });
    expect(again.get("r")?.execution).toEqual({ state: "running", startedAt: 11, reviewerLaneKey: "lane-r" });
    expect(again.get("c")?.execution).toEqual({ state: "completed", receiptId: "rr_c" });
    expect(again.get("c")?.receipt?.jobId).toBe("c");
    expect(again.get("s")?.execution.state).toBe("stale");
    expect(again.get("r")?.attempts).toBe(1);
    expect(again.byKey(snapshotKey(q.snapshot)).map((x) => x.job.jobId)).toEqual(["q"]);
    expect(again.list({ states: ["queued", "completed"] }).map((x) => x.job.jobId)).toEqual(["c", "q"]);
  });

  test("duplicate enqueue for the same snapshot returns the same job, also after a restart", () => {
    const first = enqueue(new ReviewJobs(dir), 1, job("j1"));
    expect(first.created).toBe(true);
    const second = enqueue(new ReviewJobs(dir), 2, job("j2"));
    expect(second.created).toBe(false);
    expect(second.record.job.jobId).toBe("j1");
    markRunning(new ReviewJobs(dir), 3, "j1", "lane");
    expect(enqueue(new ReviewJobs(dir), 4, job("j3")).record.job.jobId).toBe("j1");
    expect(new ReviewJobs(dir).list()).toHaveLength(1);
  });

  test("enqueue is allowed again after stale or error", () => {
    const store = new ReviewJobs(dir);
    enqueue(store, 1, job("j1"));
    markRunning(store, 2, "j1", "lane");
    fail(store, 3, "j1", "timeout", "too slow");
    const retry = enqueue(store, 4, job("j2"));
    expect(retry.created).toBe(true);
    markStale(store, 5, snapshot({ headSha: sha("9") }));
    expect(store.get("j2")?.execution.state).toBe("stale");
    expect(enqueue(store, 6, job("j3")).created).toBe(true);
    escalate(store, 7, "j3", "needs lead", "d1");
    expect(store.get("j3")?.execution).toEqual({ state: "escalated", reason: "needs lead", decisionId: "d1" });
    expect(enqueue(store, 8, job("j4")).created).toBe(true);
  });

  test("markStale on head change and on base sha change names the field", () => {
    const store = new ReviewJobs(dir);
    enqueue(store, 1, job("j1"));
    const byHead = markStale(store, 2, snapshot({ headSha: sha("9") }));
    expect(byHead.map((r) => r.job.jobId)).toEqual(["j1"]);
    expect(store.get("j1")?.execution).toEqual({ state: "stale", reason: "snapshot changed: headSha" });

    enqueue(store, 3, job("j2"));
    markStale(store, 4, snapshot({ baseSha: sha("8") }));
    expect(store.get("j2")?.execution).toEqual({ state: "stale", reason: "snapshot changed: baseSha" });
  });

  test("markStale leaves the matching key and other PRs alone", () => {
    const store = new ReviewJobs(dir);
    enqueue(store, 1, job("same"));
    enqueue(store, 1, job("other", { prNumber: 99 }));
    expect(markStale(store, 2, snapshot())).toEqual([]);
    expect(store.get("same")?.execution.state).toBe("queued");
    expect(store.get("other")?.execution.state).toBe("queued");
  });

  test("a late completion for a stale job is refused and the job stays stale", () => {
    const store = new ReviewJobs(dir);
    const j = job("j1");
    enqueue(store, 1, j);
    markRunning(store, 2, "j1", "lane");
    markStale(store, 3, snapshot({ headSha: sha("9") }));
    refused(() => complete(store, 4, "j1", receiptFor(j)), "bad_state");
    expect(new ReviewJobs(dir).get("j1")?.execution.state).toBe("stale");
    expect(new ReviewJobs(dir).get("j1")?.receipt).toBeUndefined();
  });

  test("complete refuses a receipt of another key or another job", () => {
    const store = new ReviewJobs(dir);
    const j = job("j1");
    enqueue(store, 1, j);
    markRunning(store, 2, "j1", "lane");
    refused(() => complete(store, 3, "j1", receiptFor(j, { headSha: sha("9") })), "receipt_mismatch");
    refused(() => complete(store, 3, "j1", receiptFor(j, { jobId: "other" })), "receipt_mismatch");
    expect(store.get("j1")?.execution.state).toBe("running");
    complete(store, 4, "j1", receiptFor(j));
    expect(store.get("j1")?.execution.state).toBe("completed");
  });

  test("markRunning only from queued and never twice for one key", () => {
    const store = new ReviewJobs(dir);
    const a = job("a");
    enqueue(store, 1, a);
    markRunning(store, 2, "a", "lane");
    refused(() => markRunning(store, 3, "a", "lane"), "bad_state");
    refused(() => markRunning(store, 3, "nope", "lane"), "unknown_job");
    // A second record of the same key can exist after the first errored; it may not start beside a running one.
    fail(store, 4, "a", "timeout", "t");
    enqueue(store, 5, job("b"));
    markRunning(store, 6, "b", "lane-b");
    store.transact((_records, put) => {
      put({ job: job("c"), key: snapshotKey(snapshot()), execution: { state: "queued", reason: "x" }, attempts: 0, updatedAt: 7 });
    });
    refused(() => markRunning(store, 8, "c", "lane-c"), "key_running");
  });

  test("a running job with a dead lane becomes runner_lost; alive or unknown stays running", () => {
    const store = new ReviewJobs(dir);
    for (const id of ["dead", "alive", "unknown"]) {
      enqueue(store, 1, job(id, { prNumber: id.length }));
      markRunning(store, 2, id, `lane-${id}`);
    }
    enqueue(store, 1, job("queued", { prNumber: 50 }));
    const changed = recoverAfterRestart(new ReviewJobs(dir), 9, (lane) => (lane === "lane-dead" ? false : lane === "lane-alive" ? true : "unknown"));
    expect(changed.map((r) => r.job.jobId)).toEqual(["dead"]);
    const again = new ReviewJobs(dir);
    expect(again.get("dead")?.execution).toMatchObject({ state: "error", code: "runner_lost" });
    expect(again.get("alive")?.execution.state).toBe("running");
    expect(again.get("unknown")?.execution.state).toBe("running");
    expect(again.get("queued")?.execution.state).toBe("queued");
    expect(again.list()).toHaveLength(4);
  });

  test("two concurrent enqueue calls for one snapshot produce one record", async () => {
    const store = new ReviewJobs(dir);
    const results = await Promise.all([
      Promise.resolve().then(() => enqueue(store, 1, job("j1"))),
      Promise.resolve().then(() => enqueue(new ReviewJobs(dir), 1, job("j2"))),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].record.job.jobId).toBe(results[1].record.job.jobId);
    expect(new ReviewJobs(dir).list()).toHaveLength(1);
  });
});
