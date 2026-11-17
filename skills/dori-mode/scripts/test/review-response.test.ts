import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  findingsReasons,
  MAX_REVIEW_ROUNDS,
  parseReviewResponse,
  previousReviewMarkdown,
  responseFileName,
  responseInstruction,
} from "../src/review-response.ts";
import type { Finding, ReviewReceipt } from "../src/review-receipt.ts";

const JOB = "rj_0001";
const HEAD = "a".repeat(40);
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const finding = (id: string, observation = "obs"): Finding => ({
  id,
  severity: "high",
  criterionId: "C1",
  path: "src/a.ts",
  lineStart: 3,
  lineEnd: 5,
  observation,
  consequence: "cons",
  evidence: ["e1", "e2"],
  requestedChange: "fix it",
});

const F1 = finding("F1");
const F2 = finding("F2");
const FINDINGS: readonly Finding[] = [F1, F2];

const receipt = (findings: readonly [Finding, ...Finding[]]): ReviewReceipt => ({
  schemaVersion: 1,
  receiptId: "rr_1",
  jobId: JOB,
  source: "reviewer",
  authorLaneKey: "author",
  reviewerLaneKey: "reviewer",
  repo: "o/r",
  prNumber: 7,
  headSha: HEAD,
  baseRef: "main",
  baseSha: "b".repeat(40),
  mergeBaseSha: "c".repeat(40),
  diffSha256: sha("diff"),
  policyVersion: "v1",
  criteriaSha256: sha("criteria"),
  round: 1,
  authorModel: { id: "model" },
  reviewerModel: null,
  startedAt: "2026-11-14T10:00:00Z",
  completedAt: "2026-11-14T10:05:00Z",
  reportArtifact: "/r/report.md",
  resultSha256: sha("result"),
  result: { schemaVersion: 1, jobId: JOB, verdict: "findings", summary: "s", findings, notes: [] },
});

const answers = (list: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ jobId: JOB, responses: list, ...extra });

const FIXED_F1 = { id: "F1", status: "fixed", note: "pushed fix", evidence: ["bun test ok"] };
const DISPUTED_F2 = { id: "F2", status: "disputed", note: "the branch is unreachable" };

const refusal = (text: string, jobId = JOB, list: readonly Finding[] = FINDINGS): string => {
  const r = parseReviewResponse(text, jobId, list);
  if (r.ok) throw new Error("expected a refusal");
  return r.detail;
};

describe("parseReviewResponse", () => {
  test("accepts a full answer and digests the raw text", () => {
    const text = answers([FIXED_F1, DISPUTED_F2]);
    const r = parseReviewResponse(text, JOB, FINDINGS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sha256).toBe(sha(text));
    expect(r.allDisputed).toBe(false);
    expect(r.response.jobId).toBe(JOB);
    expect(r.response.responses.map((x) => x.id)).toEqual(["F1", "F2"]);
  });

  test("reports allDisputed when every answer is disputed", () => {
    const r = parseReviewResponse(answers([{ ...FIXED_F1, status: "disputed" }, DISPUTED_F2]), JOB, FINDINGS);
    expect(r.ok && r.allDisputed).toBe(true);
  });

  test("refuses a wrong jobId", () => {
    expect(refusal(answers([FIXED_F1, DISPUTED_F2]), "rj_0002")).toContain("does not match");
  });

  test("refuses extra and missing top-level keys", () => {
    expect(refusal(answers([FIXED_F1, DISPUTED_F2], { extra: 1 }))).toContain("extra");
    expect(refusal(JSON.stringify({ jobId: JOB }))).toContain("responses");
  });

  test("refuses an answer with an unknown key or missing required key", () => {
    expect(refusal(answers([{ ...FIXED_F1, extra: "x" }, DISPUTED_F2]))).toContain("unknown key");
    expect(refusal(answers([{ id: "F1", status: "fixed" }, DISPUTED_F2]))).toContain("note");
  });

  test("refuses a missing finding answer and names its id", () => {
    expect(refusal(answers([FIXED_F1]))).toContain("F2");
  });

  test("refuses an unknown finding id and names it", () => {
    expect(refusal(answers([FIXED_F1, DISPUTED_F2, { ...DISPUTED_F2, id: "F9" }]))).toContain("F9");
  });

  test("refuses a duplicate finding id and names it", () => {
    expect(refusal(answers([FIXED_F1, { ...FIXED_F1 }, DISPUTED_F2]))).toContain("F1");
  });

  test("refuses a bad status", () => {
    expect(refusal(answers([{ ...FIXED_F1, status: "accepted" }, DISPUTED_F2]))).toContain("fixed or disputed");
  });

  test("refuses an empty note", () => {
    expect(refusal(answers([{ ...FIXED_F1, note: "   " }, DISPUTED_F2]))).toContain("note");
  });

  test("refuses evidence that is not an array of non-empty strings", () => {
    expect(refusal(answers([{ ...FIXED_F1, evidence: [""] }, DISPUTED_F2]))).toContain("evidence");
  });

  test("refuses text that is not JSON or not an object", () => {
    expect(refusal("not json")).toContain("not JSON");
    expect(refusal("[]")).toContain("JSON object");
  });
});

describe("findingsReasons", () => {
  test("starts with the summary line, then one line per finding, then the instruction", () => {
    const lines = findingsReasons(receipt([F1, F2]));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      `review ${JOB} of o/r#7 at ${HEAD.slice(0, 7)} (round 1 of ${MAX_REVIEW_ROUNDS}) found 2 blocking finding(s); receipt rr_1, report /r/report.md`,
    );
    expect(lines[1]).toBe("F1 [high] C1 src/a.ts:3-5: obs | why: cons | change: fix it | evidence: e1 / e2");
    expect(lines[2]).toContain("F2 [high]");
    expect(lines[3]).toBe(responseInstruction(JOB));
  });

  test("collapses whitespace and cuts a finding line to 800 characters", () => {
    const long = finding("F1", `a\n  b ${"x".repeat(1000)}`);
    const lines = findingsReasons(receipt([long]));
    expect(lines[1]?.startsWith("F1 [high] C1 src/a.ts:3-5: a b xxx")).toBe(true);
    expect(lines[1]?.length).toBe(800);
    expect(lines.every((l) => !/\s{2}|\n/.test(l))).toBe(true);
  });

  test("names the answer file in the instruction", () => {
    expect(responseInstruction(JOB)).toContain(`$DORI_LANE_OUT/${responseFileName(JOB)}`);
    expect(responseFileName(JOB)).toBe(`review-response-${JOB}.json`);
  });
});

describe("previousReviewMarkdown", () => {
  test("holds the heading, the findings, the untrusted answer and the re-check instruction", () => {
    const text = answers([FIXED_F1, DISPUTED_F2]);
    const md = previousReviewMarkdown(receipt([F1, F2]), text);
    expect(md.startsWith(`# Previous review: job ${JOB}, round 1, head ${HEAD}`)).toBe(true);
    expect(md).toContain('"id": "F1"');
    expect(md).toContain("untrusted author text");
    expect(md).toContain(text);
    expect(md).toContain("Review the whole current diff");
  });
});
