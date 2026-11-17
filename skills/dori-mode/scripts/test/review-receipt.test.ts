import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acceptReviewSubmission,
  isApproval,
  parseReviewBody,
  parseTaskRecord,
  snapshotKey,
  type AcceptReviewInput,
  type ReviewJob,
  type ReviewSnapshot,
  type ReviewSubmission,
} from "../src/review-receipt.ts";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hex40 = (c: string): string => c.repeat(40);

const JOB_ID = "rj_0001";
const TOKEN = "job-token-" + "x".repeat(24);
const SNAP: ReviewSnapshot = {
  repo: "Example/demo",
  prNumber: 42,
  headSha: hex40("a"),
  baseRef: "main",
  baseSha: hex40("b"),
  mergeBaseSha: hex40("c"),
  policyVersion: "review-policy-1",
  criteriaSha256: sha256("criteria"),
};
const JOB: ReviewJob = {
  jobId: JOB_ID,
  snapshot: SNAP,
  authorLaneKey: "lane-author",
  reviewerLaneKey: "lane-reviewer",
  round: 1,
  diffSha256: sha256("diff"),
  authorModel: { id: "provider-a/model-a" },
  tokenHash: sha256(TOKEN),
  createdAt: 1_700_000_000_000,
};

const REVIEWER_HOME = "/home/rev";
const TASK_ROOT = `${REVIEWER_HOME}/.omo/agent/projects`;
const RECORD_PATH = `${TASK_ROOT}/demo-review-0000/senpi-task/tasks/st_0000aaaa.json`;
const AUTHOR_WT = "/data/repos/worktrees/demo-author";
const SNAPSHOT_WT = "/data/repos/worktrees/demo-review-snap";
const REPO_ROOT = "/data/repos/demo";
const ARTIFACT = "/home/rev/.dori/lane-out/rj_0001/report.md";

const finding = (over: Record<string, unknown> = {}) => ({
  id: "F1",
  severity: "high",
  criterionId: "C1",
  path: "src/app.ts",
  lineStart: 10,
  lineEnd: 12,
  observation: "Null is dereferenced.",
  consequence: "Crash on empty input.",
  evidence: ["src/app.ts:10 reads x.y without a check"],
  requestedChange: "Guard the empty case.",
  ...over,
});
const passBody = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, jobId: JOB_ID, verdict: "pass", summary: "No blocking defects.", findings: [], notes: [], ...over,
});
const findingsBody = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, jobId: JOB_ID, verdict: "findings", summary: "One defect.", findings: [finding()], notes: [], ...over,
});

/** A record shaped like a real senpi-task child record (fake values; run_stats/cost fields dropped). */
const taskRecord = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    task_id: "st_0000aaaa",
    status: "completed",
    residency_state: "persisted_only",
    parent_session_id: "00000000-0000-7000-8000-000000000001",
    root_session_id: "00000000-0000-7000-8000-000000000001",
    depth: 1,
    execution_mode: "in-process",
    model: "provider-b/model-b",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:05:00.000Z",
    started_at: "2026-01-01T00:00:01.000Z",
    terminal_at: "2026-01-01T00:04:00.000Z",
    name: "gate-review",
    task_summary: "Review PR",
    agent_type: "omo-native-gate-reviewer",
    category: null,
    requested_model: { provider: "provider-b", model_id: "model-b", display: "provider-b/model-b", variant: "high", source: "agent" },
    resolved_model: { provider: "provider-b", model_id: "model-b", display: "Model B", variant: "high", source: "agent" },
    effective_model: { provider: "provider-b", model_id: "model-b", display: "provider-b/model-b", source: "agent" },
    ...over,
  });

const submission = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  via: "reviewer-lane",
  laneKey: "lane-reviewer",
  jobId: JOB_ID,
  jobToken: TOKEN,
  bodyText: JSON.stringify(passBody()),
  taskRecord: { path: RECORD_PATH, text: taskRecord() },
  reportArtifact: ARTIFACT,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:04:00.000Z",
  source: "reviewer",
  ...over,
});

const input = (over: Partial<AcceptReviewInput> = {}, sub: Partial<ReviewSubmission> = {}): AcceptReviewInput => ({
  job: JOB,
  observed: SNAP,
  submission: submission(sub),
  trustedTaskRoots: [TASK_ROOT],
  untrustedRoots: [AUTHOR_WT, SNAPSHOT_WT, REPO_ROOT],
  ...over,
});

const code = (i: AcceptReviewInput): string => {
  const r = acceptReviewSubmission(i);
  return r.ok ? "ok" : r.code;
};

describe("snapshotKey", () => {
  test("stable format", () => {
    expect(snapshotKey(SNAP)).toBe(
      `Example/demo#42@${hex40("a")}..main@${hex40("b")}/${hex40("c")}/review-policy-1/${SNAP.criteriaSha256}`,
    );
  });
});

describe("parseReviewBody", () => {
  const ok = (v: unknown) => parseReviewBody(typeof v === "string" ? v : JSON.stringify(v), JOB_ID);
  const rejects = (v: unknown, detail?: RegExp) => {
    const r = ok(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_output");
      if (detail) expect(r.detail).toMatch(detail);
    }
  };

  test("pass, findings, surrounding whitespace", () => {
    expect(ok(passBody()).ok).toBe(true);
    const r = ok(`\n  ${JSON.stringify(findingsBody(), null, 2)}\n\t`);
    expect(r.ok && r.body.verdict).toBe("findings");
  });
  test("boundaries: lineStart == lineEnd, empty notes, note path null, large bodies", () => {
    expect(ok(findingsBody({ findings: [finding({ lineStart: 7, lineEnd: 7 })] })).ok).toBe(true);
    expect(ok(passBody({ notes: [{ path: null, text: "General remark." }, { path: "docs/a.md", text: "Typo." }] })).ok).toBe(true);
    const many = Array.from({ length: 500 }, (_, n) => finding({ id: `F${n}`, observation: "o".repeat(4000) }));
    expect(ok(findingsBody({ findings: many })).ok).toBe(true);
  });
  test("fence, prose, trailing data, non-object", () => {
    rejects("```json\n" + JSON.stringify(passBody()) + "\n```");
    rejects("Here is my review: " + JSON.stringify(passBody()));
    rejects(JSON.stringify(passBody()) + "\nLooks good to me.", /trailing/);
    rejects(JSON.stringify(passBody()) + JSON.stringify(passBody()), /trailing/);
    rejects(JSON.stringify([passBody()]));
    rejects("");
  });
  test("duplicate keys at any depth", () => {
    rejects(JSON.stringify(passBody()).replace('"verdict":"pass"', '"verdict":"findings","verdict":"pass"'), /duplicate key/);
    const nested = JSON.stringify(findingsBody()).replace('"severity":"high"', '"severity":"medium","severity":"high"');
    rejects(nested, /duplicate key "severity"/);
    rejects(JSON.stringify(passBody()).replace('"summary"', '"sum\\u006dary":"x","summary"'), /duplicate key/);
  });
  test("schema: unknown, missing, wrong types, version, job id", () => {
    rejects(passBody({ extra: true }), /unknown/);
    const { notes: _n, ...noNotes } = passBody();
    rejects(noNotes, /missing/);
    rejects(findingsBody({ findings: [{ ...finding(), extra: 1 }] }), /unknown/);
    rejects(passBody({ schemaVersion: 2 }));
    rejects(passBody({ schemaVersion: "1" }));
    rejects(passBody({ jobId: "rj_other" }), /does not match/);
    rejects(passBody({ summary: "" }));
    rejects(passBody({ summary: "   " }));
    rejects(passBody({ notes: [{ path: null, text: "" }] }));
    rejects(passBody({ notes: [{ path: null }] }));
  });
  test("verdict / findings consistency", () => {
    rejects(passBody({ findings: [finding()] }));
    rejects(findingsBody({ findings: [] }));
    rejects(passBody({ verdict: "PASS" }));
  });
  test("finding field rules", () => {
    for (const bad of [
      { severity: "low" },
      { lineStart: 0 },
      { lineStart: 1.5 },
      { lineEnd: 9 },
      { lineStart: "10" },
      { evidence: [] },
      { evidence: [""] },
      { evidence: "x" },
      { criterionId: "" },
      { requestedChange: "" },
    ]) rejects(findingsBody({ findings: [finding(bad)] }));
    for (const path of ["/etc/passwd", "../x.ts", "src/../x.ts", "src\\x.ts", "", "./src/x.ts", "src//x.ts", "src/", "C:/x.ts"]) {
      rejects(findingsBody({ findings: [finding({ path })] }));
      rejects(passBody({ notes: [{ path, text: "n" }] }));
    }
    rejects(findingsBody({ findings: [finding(), finding()] }), /duplicate id/);
  });
});

describe("parseTaskRecord", () => {
  test("completed gate reviewer record", () => {
    const r = parseTaskRecord(taskRecord());
    expect(r).toEqual({
      ok: true,
      model: {
        category: null,
        agentType: "omo-native-gate-reviewer",
        requested: "provider-b/model-b",
        resolved: "provider-b/model-b",
        effective: "provider-b/model-b",
        taskId: "st_0000aaaa",
      },
    });
  });
  test("category-routed record without agent_type or effective model", () => {
    const r = parseTaskRecord(taskRecord({ agent_type: undefined, category: "deep-low", effective_model: undefined }));
    expect(r.ok && r.model).toMatchObject({ category: "deep-low", agentType: null, effective: null });
  });
  test("failed record with plan_unresolved is model_unavailable", () => {
    const rec = taskRecord({
      status: "error", resolved_model: undefined, effective_model: undefined,
      failure_kind: "plan_unresolved", error_message: "plan_unresolved: unknown category review-x",
    });
    const r = parseTaskRecord(rec);
    expect(!r.ok && r.code).toBe("model_unavailable");
    const viaMessage = parseTaskRecord(taskRecord({ status: "error", error_message: "spawn failed: plan_unresolved (model pin)" }));
    expect(!viaMessage.ok && viaMessage.code).toBe("model_unavailable");
  });
  test("model failure kinds and missing resolved model are model_unavailable", () => {
    for (const kind of ["model_unavailable", "model_chain_exhausted"]) {
      const r = parseTaskRecord(taskRecord({ status: "error", failure_kind: kind }));
      expect(!r.ok && r.code).toBe("model_unavailable");
    }
    const r = parseTaskRecord(taskRecord({ resolved_model: undefined }));
    expect(!r.ok && r.code).toBe("model_unavailable");
  });
  test("other statuses and unreadable records are input_unavailable", () => {
    for (const rec of [
      taskRecord({ status: "running" }),
      taskRecord({ status: "cancelled" }),
      taskRecord({ status: "error", failure_kind: "child-prompt-failed", error_message: "Child prompt failed to start." }),
      "not json",
      "[]",
      taskRecord({ task_id: "" }),
    ]) {
      const r = parseTaskRecord(rec);
      expect(!r.ok && r.code).toBe("input_unavailable");
    }
  });
});

describe("acceptReviewSubmission", () => {
  test("reviewer pass creates a receipt with identity from the job only", () => {
    const r = acceptReviewSubmission(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.receipt;
    expect(rec).toMatchObject({
      schemaVersion: 1, jobId: JOB_ID, source: "reviewer", authorLaneKey: "lane-author", reviewerLaneKey: "lane-reviewer",
      ...SNAP, diffSha256: JOB.diffSha256, round: 1, authorModel: { id: "provider-a/model-a" }, reportArtifact: ARTIFACT,
    });
    expect(rec.reviewerModel).toMatchObject({ resolved: "provider-b/model-b", taskId: "st_0000aaaa", recordSha256: sha256(taskRecord()) });
    expect(rec.resultSha256).toBe(sha256(JSON.stringify(passBody())));
    expect(rec).not.toHaveProperty("family");
    expect(isApproval(rec, SNAP)).toBe(true);
  });
  test("replay is idempotent", () => {
    const a = acceptReviewSubmission(input());
    const b = acceptReviewSubmission(input());
    expect(a.ok && b.ok && a.receipt.receiptId === b.receipt.receiptId).toBe(true);
  });
  test("reviewer findings receipt is not an approval", () => {
    const r = acceptReviewSubmission(input({}, { bodyText: JSON.stringify(findingsBody()) }));
    expect(r.ok && r.receipt.result.verdict).toBe("findings");
    expect(r.ok && isApproval(r.receipt, SNAP)).toBe(false);
  });
  test("qa findings need no task record and never approve", () => {
    const qaFinding = finding({ criterionId: "C7", path: "qa/bun-test.log", evidence: ["bun test exit 1"] });
    const r = acceptReviewSubmission(input({}, {
      source: "qa", taskRecord: undefined, bodyText: JSON.stringify(findingsBody({ findings: [qaFinding] })),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.source).toBe("qa");
    expect(r.receipt.reviewerModel).toBeNull();
    expect(isApproval(r.receipt, SNAP)).toBe(false);
  });
  test("qa pass is invalid_output", () => {
    expect(code(input({}, { source: "qa", taskRecord: undefined }))).toBe("invalid_output");
  });

  test("every identity field mismatch is stale_snapshot and never a receipt", () => {
    const changed: Record<keyof ReviewSnapshot, unknown> = {
      repo: "Example/other", prNumber: 43, headSha: hex40("d"), baseRef: "dev", baseSha: hex40("e"),
      mergeBaseSha: hex40("f"), policyVersion: "review-policy-2", criteriaSha256: sha256("criteria-2"),
    };
    for (const [k, v] of Object.entries(changed)) {
      const r = acceptReviewSubmission(input({ observed: { ...SNAP, [k]: v } }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("stale_snapshot");
        expect(r.detail).toContain(k);
      }
      expect("receipt" in r).toBe(false);
    }
  });
  test("isApproval rejects a receipt once any identity field moves", () => {
    const r = acceptReviewSubmission(input());
    if (!r.ok) throw new Error(r.detail);
    expect(isApproval(r.receipt, { ...SNAP, baseSha: hex40("e") })).toBe(false);
    expect(isApproval(r.receipt, { ...SNAP, criteriaSha256: sha256("other") })).toBe(false);
  });

  test("channel, lane and token rejections", () => {
    expect(code(input({}, { jobId: "rj_other" }))).toBe("job_mismatch");
    expect(code(input({}, { via: "author-report" }))).toBe("untrusted_channel");
    expect(code(input({}, { via: "file" }))).toBe("untrusted_channel");
    expect(code(input({}, { laneKey: "lane-author" }))).toBe("author_submission");
    expect(code(input({}, { laneKey: "lane-someone" }))).toBe("unknown_reviewer");
    expect(code(input({}, { jobToken: "wrong-token" }))).toBe("bad_token");
    expect(code(input({}, { jobToken: "" }))).toBe("bad_token");
  });
  test("a valid body copied into an author report is untrusted", () => {
    expect(code(input({}, { via: "author-report", laneKey: "lane-author" }))).toBe("untrusted_channel");
  });
  test("invalid trusted job metadata", () => {
    expect(code(input({ job: { ...JOB, round: 0 } }))).toBe("invalid_job");
    expect(code(input({ job: { ...JOB, snapshot: { ...SNAP, headSha: "A".repeat(40) } }, observed: { ...SNAP, headSha: "A".repeat(40) } }))).toBe("invalid_job");
    expect(code(input({ job: { ...JOB, diffSha256: "abc" } }))).toBe("invalid_job");
  });
  test("timestamps", () => {
    expect(code(input({}, { startedAt: "2026-01-01 00:00:00" }))).toBe("invalid_timestamp");
    expect(code(input({}, { completedAt: "2026-02-30T00:00:00Z" }))).toBe("invalid_timestamp");
    expect(code(input({}, { completedAt: "2025-12-31T23:59:59.000Z" }))).toBe("invalid_timestamp");
    expect(code(input({}, { completedAt: "2026-01-01T00:00:00.000Z" }))).toBe("ok");
  });
  test("reviewer without task record is input_unavailable", () => {
    expect(code(input({}, { taskRecord: undefined }))).toBe("input_unavailable");
  });
  test("forged task record placements", () => {
    const at = (path: string) => code(input({}, { taskRecord: { path, text: taskRecord() } }));
    expect(at(`${AUTHOR_WT}/senpi-task/tasks/st_0000aaaa.json`)).toBe("forged_record");
    expect(at(`${REPO_ROOT}/.omo/agent/projects/p/senpi-task/tasks/st_0000aaaa.json`)).toBe("forged_record");
    expect(at(`${TASK_ROOT}-evil/p/senpi-task/tasks/st_0000aaaa.json`)).toBe("forged_record");
    expect(at(`${TASK_ROOT}/p/senpi-task/tasks/../../../../../../..${AUTHOR_WT}/senpi-task/tasks/st_0000aaaa.json`)).toBe("forged_record");
    expect(at(`${TASK_ROOT}/p/tasks/st_0000aaaa.json`)).toBe("forged_record");
    expect(at(`${TASK_ROOT}/p/senpi-task/tasks/st_0000aaaa.txt`)).toBe("forged_record");
    expect(at("demo/senpi-task/tasks/st_0000aaaa.json")).toBe("forged_record");
    expect(at(`${TASK_ROOT}/p/senpi-task/tasks/st_0000bbbb.json`)).toBe("forged_record");
    // A trusted root that contains an untrusted tree: the untrusted tree still wins.
    const nested = code(input({ trustedTaskRoots: ["/data/repos"] }, { taskRecord: { path: `${REPO_ROOT}/x/senpi-task/tasks/st_0000aaaa.json`, text: taskRecord() } }));
    expect(nested).toBe("forged_record");
  });
  test("report artifact inside an untrusted tree is forged", () => {
    expect(code(input({}, { reportArtifact: `${AUTHOR_WT}/evidence/report.md` }))).toBe("forged_record");
    expect(code(input({}, { reportArtifact: `${SNAPSHOT_WT}/report.md` }))).toBe("forged_record");
    expect(code(input({}, { reportArtifact: "report.md" }))).toBe("forged_record");
  });
  test("task record failures carry their codes", () => {
    const rec = (over: Record<string, unknown>) => ({ taskRecord: { path: RECORD_PATH, text: taskRecord(over) } });
    expect(code(input({}, rec({ status: "error", failure_kind: "plan_unresolved", resolved_model: undefined })))).toBe("model_unavailable");
    expect(code(input({}, rec({ status: "running" })))).toBe("input_unavailable");
    expect(code(input({}, rec({ agent_type: "omo-native-code-reviewer" })))).toBe("wrong_reviewer");
    expect(code(input({}, rec({ agent_type: undefined, category: "deep-low" })))).toBe("wrong_reviewer");
  });
  test("body failures are invalid_output", () => {
    expect(code(input({}, { bodyText: "```json\n" + JSON.stringify(passBody()) + "\n```" }))).toBe("invalid_output");
    expect(code(input({}, { bodyText: JSON.stringify(passBody()) + " thanks" }))).toBe("invalid_output");
    expect(code(input({}, { bodyText: JSON.stringify(passBody({ jobId: "rj_other" })) }))).toBe("invalid_output");
    expect(code(input({}, { bodyText: JSON.stringify(passBody({ extra: 1 })) }))).toBe("invalid_output");
  });
});
