import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditReviewHistory, formatReviewAudit } from "../src/review-audit.ts";
import { exemptKey, exemptReceipt, ReviewExemptions } from "../src/review-exempt.ts";
import { complete, enqueue, escalate, fail, markRunning, markStale, ReviewJobs } from "../src/review-jobs.ts";
import type { Finding, ReviewJob, ReviewReceipt, ReviewSnapshot } from "../src/review-receipt.ts";
import { ReviewStatusStore } from "../src/review-status.ts";

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const sha = (c: string): string => c.repeat(40);
const iso = (ms: number): string => new Date(ms).toISOString();

const snapshot = (over: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  repo: "Dubusoft/dori-mode", prNumber: 7, headSha: sha("a"), baseRef: "dev", baseSha: sha("b"),
  mergeBaseSha: sha("c"), policyVersion: "p1", criteriaSha256: "d".repeat(64), ...over,
});

const job = (jobId: string, createdAt: number, over: Partial<ReviewSnapshot> = {}, extra: Partial<ReviewJob> = {}): ReviewJob => ({
  jobId, snapshot: snapshot(over), authorLaneKey: "author", reviewerLaneKey: `reviewer-${jobId}`, round: 1,
  diffSha256: "e".repeat(64), authorModel: { id: "m/author" }, tokenHash: "f".repeat(64), createdAt, ...extra,
});

const finding: Finding = {
  id: "F1", severity: "high", criterionId: "C1", path: "src/x.ts", lineStart: 1, lineEnd: 2,
  observation: "bug", consequence: "breaks", evidence: ["e"], requestedChange: "fix",
};

const receiptFor = (j: ReviewJob, startedAt: number, completedAt: number, verdict: "pass" | "findings", over: Partial<ReviewReceipt> = {}): ReviewReceipt => ({
  schemaVersion: 1, receiptId: `rr_${j.jobId}`, jobId: j.jobId, source: "reviewer", authorLaneKey: j.authorLaneKey,
  reviewerLaneKey: j.reviewerLaneKey, repo: j.snapshot.repo, prNumber: j.snapshot.prNumber, headSha: j.snapshot.headSha,
  baseRef: j.snapshot.baseRef, baseSha: j.snapshot.baseSha, mergeBaseSha: j.snapshot.mergeBaseSha, diffSha256: j.diffSha256,
  policyVersion: j.snapshot.policyVersion, criteriaSha256: j.snapshot.criteriaSha256, round: j.round, authorModel: j.authorModel,
  reviewerModel: null, startedAt: iso(startedAt), completedAt: iso(completedAt), reportArtifact: "/tmp/r.md", resultSha256: "0".repeat(64),
  result: verdict === "pass"
    ? { schemaVersion: 1, jobId: j.jobId, verdict: "pass", summary: "ok", findings: [], notes: [] }
    : { schemaVersion: 1, jobId: j.jobId, verdict: "findings", summary: "no", findings: [finding], notes: [] },
  ...over,
});

let dir: string;
let jobs: ReviewJobs;
let merges: ReviewStatusStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-audit-"));
  jobs = new ReviewJobs(dir);
  merges = new ReviewStatusStore(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Runs one job through the real store: enqueue at `at`, start at `at+1s`, complete after `took` ms with `verdict`. */
const review = (j: ReviewJob, verdict: "pass" | "findings", took = 60_000): void => {
  enqueue(jobs, j.createdAt, j);
  markRunning(jobs, j.createdAt + 1_000, j.jobId, j.reviewerLaneKey);
  complete(jobs, j.createdAt + 1_000 + took, j.jobId, receiptFor(j, j.createdAt + 1_000, j.createdAt + 1_000 + took, verdict));
};

const merge = (headSha: string, at: number, prNumber = 7): void =>
  merges.recordMerge({ lane: "author", repo: "Dubusoft/dori-mode", prNumber, headSha, mergeSha: sha("9"), at });

const kinds = (stateDir: string): string[] => auditReviewHistory(stateDir).violations.map((v) => v.kind).sort();

describe("auditReviewHistory", () => {
  test("empty state has no violations and every stat is null", () => {
    const a = auditReviewHistory(dir);
    expect(a.violations).toEqual([]);
    for (const v of Object.values(a.stats)) expect(v).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    expect(formatReviewAudit(a)).toContain("Violations: none");
  });

  test("a clean findings -> fix -> pass -> merge history has no violations and measured stats", () => {
    review(job("j1", T0), "findings", 120_000);
    review(job("j2", T0 + 600_000, { headSha: sha("1") }, { round: 2, previousJobId: "j1" }), "pass", 60_000);
    merge(sha("1"), T0 + 900_000);
    const a = auditReviewHistory(dir);
    expect(a.violations).toEqual([]);
    expect(a.stats.jobs).toBe(2);
    expect(a.stats.merges).toBe(1);
    expect(a.stats.verdicts).toEqual({ pass: 1, findings: 1 });
    expect(a.stats.requestToStart).toEqual({ count: 2, minMs: 1_000, medianMs: 1_000, meanMs: 1_000, maxMs: 1_000 });
    expect(a.stats.startToComplete).toEqual({ count: 2, minMs: 60_000, medianMs: 90_000, meanMs: 90_000, maxMs: 120_000 });
    expect(a.stats.findingsRoundsPerPr).toEqual([{ repo: "Dubusoft/dori-mode", prNumber: 7, findingsRounds: 1, passed: true }]);
    expect(a.stats.findingsResolvedByPass).toEqual({ resolved: 1, total: 1 });
    expect(a.stats.escalations).toEqual({ escalatedJobs: 0, capsReached: 0 });
    expect(a.stats.errorCodes).toEqual({});
    expect(a.stats.exemptions).toBeNull();
  });

  test("a docs-only merge backed by an exempt receipt is not a violation", () => {
    const s = snapshot({ prNumber: 8 });
    const exemptions = new ReviewExemptions(dir);
    exemptions.record({ kind: "exempt", key: exemptKey(s), receipt: exemptReceipt(s, { exempt: true, ruleIds: ["path:docs"], files: ["docs/a.md"], additions: 1, deletions: 1 }, "1".repeat(64), T0) });
    merge(sha("a"), T0 + 1_000, 8);
    const a = auditReviewHistory(dir);
    expect(a.violations).toEqual([]);
    expect(a.stats.exemptions).toBe(1);
    expect(a.stats.jobs).toBeNull();
  });

  test("a merge with no receipt is reported", () => {
    merge(sha("a"), T0);
    const a = auditReviewHistory(dir);
    expect(a.violations.map((v) => v.kind)).toEqual(["merge_without_approval"]);
    expect(a.violations[0]).toMatchObject({ repo: "Dubusoft/dori-mode", prNumber: 7, headSha: sha("a"), mergeSha: sha("9") });
    expect(formatReviewAudit(a)).toContain("merge_without_approval Dubusoft/dori-mode#7");
  });

  test("a merge whose head's pass went stale before the merge is reported", () => {
    review(job("j1", T0), "pass");
    markStale(jobs, T0 + 200_000, snapshot({ baseSha: sha("5") }));
    merge(sha("a"), T0 + 300_000);
    expect(kinds(dir)).toEqual(["merge_on_stale", "merge_while_blocked"]);
  });

  test("a pass marked stale only after the merge still approves it", () => {
    review(job("j1", T0), "pass");
    merge(sha("a"), T0 + 100_000);
    markStale(jobs, T0 + 200_000, snapshot({ baseSha: sha("5") }));
    expect(kinds(dir)).toEqual([]);
  });

  test("a merge while the head's job had findings, an error or an escalation is reported", () => {
    review(job("j1", T0), "findings");
    merge(sha("a"), T0 + 100_000);
    const j2 = job("j2", T0, { prNumber: 9 });
    enqueue(jobs, T0, j2);
    markRunning(jobs, T0 + 1, "j2", j2.reviewerLaneKey);
    fail(jobs, T0 + 2, "j2", "timeout", "no result");
    merge(sha("a"), T0 + 100_000, 9);
    const j3 = job("j3", T0, { prNumber: 10 });
    enqueue(jobs, T0, j3);
    escalate(jobs, T0 + 2, "j3", "runner down");
    merge(sha("a"), T0 + 100_000, 10);
    const a = auditReviewHistory(dir);
    expect(a.violations.filter((v) => v.kind === "merge_while_blocked").map((v) => [v.prNumber, v.detail])).toEqual([
      [7, "merged while job j1 was findings"], [9, "merged while job j2 was error timeout"], [10, "merged while job j3 was escalated"],
    ]);
    expect(a.violations.filter((v) => v.kind === "merge_without_approval").map((v) => v.prNumber)).toEqual([7, 9, 10]);
    expect(a.stats.errorCodes).toEqual({ timeout: 1 });
    expect(a.stats.escalations).toEqual({ escalatedJobs: 1, capsReached: 0 });
    expect(a.stats.findingsResolvedByPass).toEqual({ resolved: 0, total: 1 });
  });

  test("a duplicate running job for one snapshot key is reported", () => {
    const j1 = job("j1", T0);
    enqueue(jobs, T0, j1);
    markRunning(jobs, T0 + 1_000, "j1", j1.reviewerLaneKey);
    // The store refuses a second running job for a key; write it raw to model a corrupted history.
    const first = jobs.get("j1")!;
    jobs.transact((_records, put) => put({ ...first, job: { ...first.job, jobId: "j1b", responseSha256: "1".repeat(64) } }));
    const a = auditReviewHistory(dir);
    expect(a.violations.map((v) => [v.kind, v.jobIds])).toEqual([["duplicate_running", ["j1", "j1b"]]]);
    expect(a.stats.requestToStart?.count).toBe(2);
    expect(a.stats.startToComplete).toBeNull();
    expect(a.stats.verdicts).toBeNull();
  });

  test("a pass receipt from a non-reviewer source is reported and does not approve a merge", () => {
    const j1 = job("j1", T0);
    enqueue(jobs, T0, j1);
    markRunning(jobs, T0 + 1_000, "j1", j1.reviewerLaneKey);
    complete(jobs, T0 + 2_000, "j1", receiptFor(j1, T0 + 1_000, T0 + 2_000, "pass", { source: "qa" }));
    merge(sha("a"), T0 + 3_000);
    expect(kinds(dir)).toEqual(["merge_while_blocked", "merge_without_approval", "non_reviewer_receipt"]);
  });

  test("the audit never writes to the state dir", () => {
    review(job("j1", T0), "pass");
    merge(sha("a"), T0 + 100_000);
    const before = readdirSync(dir).sort();
    auditReviewHistory(dir);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(existsSync(join(dir, "review-exempt.json"))).toBe(false);
  });
});
