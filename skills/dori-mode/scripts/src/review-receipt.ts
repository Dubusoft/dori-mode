import { createHash, timingSafeEqual } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Review receipt contract (design 5.4, adjusted by the T1 report section 6).
 *
 * The reviewer model emits a {@link ReviewBody}; the supervisor alone turns it into a {@link ReviewReceipt} through
 * {@link acceptReviewSubmission}, copying identity only from its own {@link ReviewJob}. The model family is recorded
 * through the reviewer task record, never enforced: there is no different-family condition and no
 * `independence_unverified` code.
 */

/** One blocking defect tied to a review criterion and a line range of the review checkout. */
export type Finding = {
  readonly id: string;
  readonly severity: "critical" | "high" | "medium";
  readonly criterionId: string;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly observation: string;
  readonly consequence: string;
  readonly evidence: readonly string[];
  readonly requestedChange: string;
};

/** A non-blocking remark (style preference, future hardening); `path` is null when it names no file. */
export type Note = {
  readonly path: string | null;
  readonly text: string;
};

/** The machine verdict a reviewer emits: exactly one JSON object, `pass` with no findings or `findings` with at least one. */
export type ReviewBody =
  | {
      readonly schemaVersion: 1;
      readonly jobId: string;
      readonly verdict: "pass";
      readonly summary: string;
      readonly findings: readonly [];
      readonly notes: readonly Note[];
    }
  | {
      readonly schemaVersion: 1;
      readonly jobId: string;
      readonly verdict: "findings";
      readonly summary: string;
      readonly findings: readonly [Finding, ...Finding[]];
      readonly notes: readonly Note[];
    };

/** The reviewer model as the senpi-task child record reports it; recorded, not enforced. */
export type ReviewModel = {
  readonly category: string | null;
  readonly agentType: string | null;
  readonly requested: string | null;
  readonly resolved: string;
  readonly effective: string | null;
  readonly taskId: string;
  readonly recordSha256: string;
};

/** The exact PR state a review covers; any field change invalidates an earlier result (design 5.1). */
export type ReviewSnapshot = {
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly policyVersion: string;
  readonly criteriaSha256: string;
};

/** Supervisor-issued trusted metadata of one review run. `tokenHash` is the sha256 hex of the secret job token. */
export type ReviewJob = {
  readonly jobId: string;
  readonly snapshot: ReviewSnapshot;
  readonly authorLaneKey: string;
  readonly reviewerLaneKey: string;
  readonly round: number;
  readonly diffSha256: string;
  readonly authorModel: { readonly id: string };
  readonly tokenHash: string;
  readonly createdAt: number;
};

/** Where a result came from: the gate reviewer, or the review lane's own failing QA (no reviewer ran). */
export type ReviewSource = "reviewer" | "qa";

/** The supervisor-owned record of an accepted review result. Identity fields come from the job, never from the body. */
export type ReviewReceipt = {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly jobId: string;
  readonly source: ReviewSource;
  readonly authorLaneKey: string;
  readonly reviewerLaneKey: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly diffSha256: string;
  readonly policyVersion: string;
  readonly criteriaSha256: string;
  readonly round: number;
  readonly authorModel: { readonly id: string };
  /** Null only for source "qa". */
  readonly reviewerModel: ReviewModel | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reportArtifact: string;
  readonly resultSha256: string;
  readonly result: ReviewBody;
};

/** Execution error codes of a review run (design 5.4 without `independence_unverified`). */
export type ReviewErrorCode =
  | "timeout"
  | "invalid_output"
  | "model_unavailable"
  | "runner_lost"
  | "input_unavailable"
  | "scope_violation";

/** Why {@link acceptReviewSubmission} refused to create a receipt. */
export type ReceiptRejectCode =
  | "invalid_job"
  | "job_mismatch"
  | "untrusted_channel"
  | "author_submission"
  | "unknown_reviewer"
  | "bad_token"
  | "stale_snapshot"
  | "invalid_timestamp"
  | "forged_record"
  | "wrong_reviewer"
  | "invalid_output"
  | "model_unavailable"
  | "input_unavailable";

/** The only submission channel that may carry a reviewer result: the authenticated review-lane result path. */
export const REVIEWER_CHANNEL = "reviewer-lane";
/** The senpi-task agent type that alone may render the verdict. */
export const GATE_REVIEWER_AGENT = "omo-native-gate-reviewer";

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TASK_FILE = /^([A-Za-z0-9_-]+)\.json$/;
const MAX_JSON_DEPTH = 64;

/** Lowercase sha256 hex of a UTF-8 string. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Stable identity key of a snapshot: `<repo>#<pr>@<head>..<baseRef>@<baseSha>/<mergeBaseSha>/<policyVersion>/<criteriaSha256>`. */
export const snapshotKey = (s: ReviewSnapshot): string =>
  `${s.repo}#${s.prNumber}@${s.headSha}..${s.baseRef}@${s.baseSha}/${s.mergeBaseSha}/${s.policyVersion}/${s.criteriaSha256}`;

// ---------------------------------------------------------------------------------------------------------------------
// Strict JSON: one value, no trailing data, duplicate keys rejected at any depth.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

class JsonSyntaxError extends Error {}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Recursive-descent JSON parser that, unlike `JSON.parse`, refuses duplicate object keys instead of keeping the last. */
const parseStrictJson = (text: string): { ok: true; value: Json } | { ok: false; detail: string } => {
  let i = 0;
  const fail = (what: string): never => { throw new JsonSyntaxError(`${what} at offset ${i}`); };
  const ws = (): void => { while (i < text.length && " \t\r\n".includes(text[i] ?? "")) i++; };
  const str = (): string => {
    const start = i++;
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail("control character in string");
      i += c === 0x5c ? 2 : 1;
    }
    i++;
    try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail("invalid string escape"); }
  };
  const value = (depth: number): Json => {
    if (depth > MAX_JSON_DEPTH) fail("nesting too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: JsonObject = Object.create(null) as JsonObject;
      ws();
      if (text[i] === "}") { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== "\"") fail("expected object key");
        const keyAt = i;
        const key = str();
        if (Object.hasOwn(obj, key)) { i = keyAt; fail(`duplicate key ${JSON.stringify(key)}`); }
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return obj; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: Json[] = [];
      ws();
      if (text[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return arr; }
        fail("expected ',' or ']'");
      }
    }
    if (c === "\"") return str();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m) { i += m[0].length; return Number(m[0]); }
    return fail("unexpected token");
  };
  try {
    const v = value(0);
    ws();
    if (i !== text.length) fail("trailing data");
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof JsonSyntaxError) return { ok: false, detail: e.message };
    throw e;
  }
};

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problem text when `obj` lacks a key of `keys` or carries one outside it; undefined when the key set is exact. */
const keyProblem = (obj: JsonObject, keys: readonly string[], where: string): string | undefined => {
  const missing = keys.filter((k) => !Object.hasOwn(obj, k));
  if (missing.length) return `${where}: missing key(s) ${missing.join(", ")}`;
  const unknown = Object.keys(obj).filter((k) => !keys.includes(k));
  if (unknown.length) return `${where}: unknown key(s) ${unknown.join(", ")}`;
  return undefined;
};

const nonEmpty = (v: Json | undefined): v is string => typeof v === "string" && v.trim() !== "";
const positiveInt = (v: Json | undefined): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** True for a normalized repo-relative path: no leading `/` or drive, no backslash, no empty, `.` or `..` segment. */
export const isRepoRelativePath = (p: string): boolean =>
  p !== "" &&
  !p.includes("\\") &&
  !p.includes("\0") &&
  !p.startsWith("/") &&
  !/^[A-Za-z]:/.test(p) &&
  p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

const FINDING_KEYS = [
  "id", "severity", "criterionId", "path", "lineStart", "lineEnd",
  "observation", "consequence", "evidence", "requestedChange",
] as const;
const SEVERITIES: readonly string[] = ["critical", "high", "medium"];

const checkFinding = (v: Json | undefined, where: string): string | undefined => {
  if (!isObject(v)) return `${where}: not an object`;
  const keys = keyProblem(v, FINDING_KEYS, where);
  if (keys) return keys;
  for (const k of ["id", "criterionId", "observation", "consequence", "requestedChange"] as const) {
    if (!nonEmpty(v[k])) return `${where}.${k}: must be a non-empty string`;
  }
  if (typeof v.severity !== "string" || !SEVERITIES.includes(v.severity)) return `${where}.severity: must be critical, high or medium`;
  if (typeof v.path !== "string" || !isRepoRelativePath(v.path)) return `${where}.path: must be a normalized repo-relative path`;
  if (!positiveInt(v.lineStart)) return `${where}.lineStart: must be a positive integer`;
  if (!positiveInt(v.lineEnd)) return `${where}.lineEnd: must be a positive integer`;
  if (v.lineEnd < v.lineStart) return `${where}.lineEnd: must be >= lineStart`;
  const ev = v.evidence;
  if (!Array.isArray(ev) || ev.length === 0 || !ev.every(nonEmpty)) return `${where}.evidence: must be a non-empty array of non-empty strings`;
  return undefined;
};

const checkNote = (v: Json | undefined, where: string): string | undefined => {
  if (!isObject(v)) return `${where}: not an object`;
  const keys = keyProblem(v, ["path", "text"], where);
  if (keys) return keys;
  if (v.path !== null && (typeof v.path !== "string" || !isRepoRelativePath(v.path))) {
    return `${where}.path: must be null or a normalized repo-relative path`;
  }
  if (!nonEmpty(v.text)) return `${where}.text: must be a non-empty string`;
  return undefined;
};

/**
 * Strictly parse a reviewer body. The text, after trimming surrounding whitespace only, must be exactly one JSON object
 * matching {@link ReviewBody} for `expectedJobId`: fences, prose, trailing data, duplicate keys at any depth, unknown or
 * missing keys, wrong types and verdict/findings inconsistency are all `invalid_output`.
 */
export const parseReviewBody = (
  text: string,
  expectedJobId: string,
): { ok: true; body: ReviewBody } | { ok: false; code: "invalid_output"; detail: string } => {
  const bad = (detail: string) => ({ ok: false as const, code: "invalid_output" as const, detail });
  const trimmed = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!trimmed.startsWith("{")) return bad("body must be a single JSON object (no fence or prose)");
  const parsed = parseStrictJson(trimmed);
  if (!parsed.ok) return bad(`json: ${parsed.detail}`);
  const v = parsed.value;
  if (!isObject(v)) return bad("body must be a JSON object");
  const keys = keyProblem(v, ["schemaVersion", "jobId", "verdict", "summary", "findings", "notes"], "body");
  if (keys) return bad(keys);
  if (v.schemaVersion !== 1) return bad("schemaVersion must be 1");
  if (!nonEmpty(v.jobId)) return bad("jobId must be a non-empty string");
  if (v.jobId !== expectedJobId) return bad(`jobId ${JSON.stringify(v.jobId)} does not match the issued job`);
  if (v.verdict !== "pass" && v.verdict !== "findings") return bad("verdict must be pass or findings");
  if (!nonEmpty(v.summary)) return bad("summary must be a non-empty string");
  if (!Array.isArray(v.findings)) return bad("findings must be an array");
  if (!Array.isArray(v.notes)) return bad("notes must be an array");
  if (v.verdict === "pass" && v.findings.length !== 0) return bad("verdict pass requires findings []");
  if (v.verdict === "findings" && v.findings.length === 0) return bad("verdict findings requires at least one finding");
  const ids = new Set<string>();
  for (const [n, f] of v.findings.entries()) {
    const problem = checkFinding(f, `findings[${n}]`);
    if (problem) return bad(problem);
    const id = (f as JsonObject).id as string;
    if (ids.has(id)) return bad(`findings[${n}].id: duplicate id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  for (const [n, note] of v.notes.entries()) {
    const problem = checkNote(note, `notes[${n}]`);
    if (problem) return bad(problem);
  }
  // Rebuild with plain prototypes so callers get ordinary objects, not the parser's null-prototype ones.
  return { ok: true, body: JSON.parse(JSON.stringify(v)) as ReviewBody };
};

// ---------------------------------------------------------------------------------------------------------------------
// senpi-task child record (`~/.omo/agent/projects/<project>/senpi-task/tasks/<taskId>.json`).

/** `provider/model_id` of a senpi-task model object (`requested_model`, `resolved_model`, `effective_model`), else null. */
const modelRef = (v: Json | undefined): string | null =>
  isObject(v) && nonEmpty(v.provider) && nonEmpty(v.model_id) ? `${v.provider}/${v.model_id}` : null;

const optString = (v: Json | undefined): string | null => (nonEmpty(v) ? v : null);

/** Failure kinds a senpi-task record carries when the child never had a usable model. */
const MODEL_FAILURE_KINDS: readonly string[] = ["model_unavailable", "model_chain_exhausted"];

/**
 * Read the reviewer model from a senpi-task child record. Field names follow the real records: `task_id`, `status`,
 * `agent_type`, `category`, `requested_model` / `resolved_model` / `effective_model` (objects with `provider` and
 * `model_id`), and on failure `failure_kind`, `failure_reason`, `error_message`.
 *
 * Mapping (T1 report 6.6): only `status: "completed"` with a resolved model yields a model. A record whose failure fields
 * mention `plan_unresolved` (an unknown category, agent or model pin; fails before start, not retried), a model failure
 * kind (`model_unavailable`, `model_chain_exhausted`), or a completed record without a resolved model is
 * `model_unavailable`. An unreadable record or any other non-completed status (running, cancelled, lost, other errors)
 * is `input_unavailable`: no reviewer output exists to accept.
 */
export const parseTaskRecord = (
  text: string,
):
  | { ok: true; model: Omit<ReviewModel, "recordSha256"> }
  | { ok: false; code: "model_unavailable" | "input_unavailable"; detail: string } => {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, code: "input_unavailable", detail: "task record is not JSON" }; }
  if (!isObject(v as Json)) return { ok: false, code: "input_unavailable", detail: "task record is not an object" };
  const rec = v as JsonObject;
  if (!nonEmpty(rec.task_id)) return { ok: false, code: "input_unavailable", detail: "task record has no task_id" };
  const status = typeof rec.status === "string" ? rec.status : "";
  if (status !== "completed") {
    const failure = [rec.failure_kind, rec.failure_reason, rec.error_message].filter((x) => typeof x === "string").join(" ");
    const kind = typeof rec.failure_kind === "string" ? rec.failure_kind : "";
    const detail = `task ${rec.task_id} status ${status || "unknown"}${failure ? `: ${failure}` : ""}`;
    if (failure.includes("plan_unresolved") || MODEL_FAILURE_KINDS.includes(kind)) return { ok: false, code: "model_unavailable", detail };
    return { ok: false, code: "input_unavailable", detail };
  }
  const resolved = modelRef(rec.resolved_model);
  if (!resolved) return { ok: false, code: "model_unavailable", detail: `task ${rec.task_id} has no resolved model` };
  return {
    ok: true,
    model: {
      category: optString(rec.category),
      agentType: optString(rec.agent_type),
      requested: modelRef(rec.requested_model),
      resolved,
      effective: modelRef(rec.effective_model),
      taskId: rec.task_id,
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Acceptance.

/** A result as it reaches the supervisor, with the channel it arrived on. */
export type ReviewSubmission = {
  readonly via: string;
  readonly laneKey: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly bodyText: string;
  readonly taskRecord?: { readonly path: string; readonly text: string };
  readonly reportArtifact: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly source: ReviewSource;
};

/**
 * Input of {@link acceptReviewSubmission}. Paths are compared lexically after `resolve`; callers pass realpaths when
 * symlinks may be involved.
 */
export type AcceptReviewInput = {
  readonly job: ReviewJob;
  /** What the supervisor reads from GitHub now. */
  readonly observed: ReviewSnapshot;
  readonly submission: ReviewSubmission;
  /** Directories under which genuine senpi-task records live, e.g. `<reviewerHome>/.omo/agent/projects`. */
  readonly trustedTaskRoots: readonly string[];
  /** Author worktree, review snapshot worktree, repo roots: nothing under them is trusted evidence. */
  readonly untrustedRoots: readonly string[];
};

export type AcceptReviewResult =
  | { ok: true; receipt: ReviewReceipt }
  | { ok: false; code: ReceiptRejectCode; detail: string };

const SNAPSHOT_FIELDS = [
  "repo", "prNumber", "headSha", "baseRef", "baseSha", "mergeBaseSha", "policyVersion", "criteriaSha256",
] as const satisfies readonly (keyof ReviewSnapshot)[];

const snapshotProblem = (s: ReviewSnapshot, where: string): string | undefined => {
  if (!s.repo) return `${where}.repo empty`;
  if (!Number.isSafeInteger(s.prNumber) || s.prNumber <= 0) return `${where}.prNumber not a positive integer`;
  for (const k of ["headSha", "baseSha", "mergeBaseSha"] as const) if (!GIT_SHA.test(s[k])) return `${where}.${k} not a 40-hex git SHA`;
  if (!s.baseRef) return `${where}.baseRef empty`;
  if (!s.policyVersion) return `${where}.policyVersion empty`;
  if (!SHA256.test(s.criteriaSha256)) return `${where}.criteriaSha256 not a 64-hex sha256`;
  return undefined;
};

const jobProblem = (job: ReviewJob): string | undefined => {
  if (!job.jobId) return "jobId empty";
  if (!job.authorLaneKey || !job.reviewerLaneKey) return "lane key empty";
  if (job.authorLaneKey === job.reviewerLaneKey) return "reviewer lane equals author lane";
  if (!Number.isSafeInteger(job.round) || job.round <= 0) return "round not a positive integer";
  if (!SHA256.test(job.diffSha256)) return "diffSha256 not a 64-hex sha256";
  if (!SHA256.test(job.tokenHash)) return "tokenHash not a 64-hex sha256";
  if (!job.authorModel.id) return "authorModel.id empty";
  if (!Number.isFinite(job.createdAt)) return "createdAt not a number";
  return snapshotProblem(job.snapshot, "snapshot");
};

/** Strict UTC ISO timestamp (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) naming a real calendar instant; its epoch ms, else undefined. */
const isoMs = (s: string): number | undefined => {
  if (!ISO_UTC.test(s)) return undefined;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19)) return undefined;
  return ms;
};

/** True when `p` lies strictly below `root`, honoring the path separator boundary (`/a/bc` is not under `/a/b`). */
const isInside = (root: string, p: string): boolean => {
  const rel = relative(resolve(root), resolve(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const isInsideOrAt = (root: string, p: string): boolean => resolve(root) === resolve(p) || isInside(root, p);

/** Timing-safe comparison of sha256(token) with the issued 64-hex hash. */
const tokenMatches = (token: string, tokenHash: string): boolean =>
  timingSafeEqual(Buffer.from(sha256(token), "hex"), Buffer.from(tokenHash, "hex"));

/**
 * The only way a {@link ReviewReceipt} is created. Checks, in order: trusted job shape (`invalid_job`), job id
 * (`job_mismatch`), arrival channel (`untrusted_channel`), submitting lane (`author_submission`, `unknown_reviewer`),
 * job token (`bad_token`), snapshot identity against what GitHub shows now (`stale_snapshot`), timestamps
 * (`invalid_timestamp`), artifact and task-record placement (`forged_record`, `input_unavailable`), the task record
 * (`model_unavailable`, `input_unavailable`, `wrong_reviewer`) and the body (`invalid_output`). The receipt id is
 * derived from the job and result digests, so replaying the same submission yields the same receipt.
 */
export const acceptReviewSubmission = (input: AcceptReviewInput): AcceptReviewResult => {
  const { job, observed, submission: sub } = input;
  const reject = (code: ReceiptRejectCode, detail: string): AcceptReviewResult => ({ ok: false, code, detail });

  const invalid = jobProblem(job);
  if (invalid) return reject("invalid_job", invalid);
  if (sub.jobId !== job.jobId) return reject("job_mismatch", `submission job ${sub.jobId} is not ${job.jobId}`);
  if (sub.via !== REVIEWER_CHANNEL) return reject("untrusted_channel", `result arrived via ${JSON.stringify(sub.via)}`);
  if (sub.laneKey === job.authorLaneKey) return reject("author_submission", "the author lane cannot submit its own review");
  if (sub.laneKey !== job.reviewerLaneKey) return reject("unknown_reviewer", `lane ${sub.laneKey} is not the job's reviewer`);
  if (!tokenMatches(sub.jobToken, job.tokenHash)) return reject("bad_token", "job token does not match");

  for (const k of SNAPSHOT_FIELDS) {
    if (job.snapshot[k] !== observed[k]) {
      return reject("stale_snapshot", `${k} changed: job ${String(job.snapshot[k])}, now ${String(observed[k])}`);
    }
  }

  const startedMs = isoMs(sub.startedAt);
  const completedMs = isoMs(sub.completedAt);
  if (startedMs === undefined || completedMs === undefined) return reject("invalid_timestamp", "startedAt/completedAt must be UTC ISO");
  if (completedMs < startedMs) return reject("invalid_timestamp", "completedAt precedes startedAt");

  if (!sub.reportArtifact || !isAbsolute(sub.reportArtifact)) return reject("forged_record", "reportArtifact must be an absolute path");
  if (input.untrustedRoots.some((root) => isInsideOrAt(root, sub.reportArtifact))) {
    return reject("forged_record", "reportArtifact lies inside an untrusted tree");
  }

  let reviewerModel: ReviewModel | null = null;
  if (sub.source === "reviewer") {
    const rec = sub.taskRecord;
    if (!rec) return reject("input_unavailable", "reviewer submission has no senpi-task record");
    if (!isAbsolute(rec.path)) return reject("forged_record", "task record path must be absolute");
    const file = TASK_FILE.exec(basename(rec.path));
    const tasksDir = dirname(resolve(rec.path));
    if (!file || basename(tasksDir) !== "tasks" || basename(dirname(tasksDir)) !== "senpi-task") {
      return reject("forged_record", "task record path is not */senpi-task/tasks/<id>.json");
    }
    if (!input.trustedTaskRoots.some((root) => isInside(root, rec.path))) return reject("forged_record", "task record lies outside the trusted task roots");
    if (input.untrustedRoots.some((root) => isInsideOrAt(root, rec.path))) return reject("forged_record", "task record lies inside an untrusted tree");
    const parsed = parseTaskRecord(rec.text);
    if (!parsed.ok) return reject(parsed.code, parsed.detail);
    if (parsed.model.taskId !== file[1]) return reject("forged_record", `record task_id ${parsed.model.taskId} does not match its file name`);
    if (parsed.model.agentType !== GATE_REVIEWER_AGENT) {
      return reject("wrong_reviewer", `agent_type ${String(parsed.model.agentType)} is not ${GATE_REVIEWER_AGENT}`);
    }
    reviewerModel = { ...parsed.model, recordSha256: sha256(rec.text) };
  }

  const body = parseReviewBody(sub.bodyText, job.jobId);
  if (!body.ok) return reject("invalid_output", body.detail);
  if (sub.source === "qa" && body.body.verdict !== "findings") return reject("invalid_output", "a QA result must be verdict findings");

  const resultSha256 = sha256(sub.bodyText);
  const receiptId = `rr_${sha256([job.jobId, sub.source, resultSha256, reviewerModel?.recordSha256 ?? ""].join("\n")).slice(0, 32)}`;
  const s = job.snapshot;
  return {
    ok: true,
    receipt: {
      schemaVersion: 1,
      receiptId,
      jobId: job.jobId,
      source: sub.source,
      authorLaneKey: job.authorLaneKey,
      reviewerLaneKey: job.reviewerLaneKey,
      repo: s.repo,
      prNumber: s.prNumber,
      headSha: s.headSha,
      baseRef: s.baseRef,
      baseSha: s.baseSha,
      mergeBaseSha: s.mergeBaseSha,
      diffSha256: job.diffSha256,
      policyVersion: s.policyVersion,
      criteriaSha256: s.criteriaSha256,
      round: job.round,
      authorModel: { id: job.authorModel.id },
      reviewerModel,
      startedAt: sub.startedAt,
      completedAt: sub.completedAt,
      reportArtifact: sub.reportArtifact,
      resultSha256,
      result: body.body,
    },
  };
};

/** The snapshot identity a receipt was issued for. */
export const receiptSnapshot = (r: ReviewReceipt): ReviewSnapshot => ({
  repo: r.repo,
  prNumber: r.prNumber,
  headSha: r.headSha,
  baseRef: r.baseRef,
  baseSha: r.baseSha,
  mergeBaseSha: r.mergeBaseSha,
  policyVersion: r.policyVersion,
  criteriaSha256: r.criteriaSha256,
});

/** True only for a reviewer `pass` whose snapshot is exactly the one observed now; QA results and findings never approve. */
export const isApproval = (receipt: ReviewReceipt, observed: ReviewSnapshot): boolean =>
  receipt.source === "reviewer" &&
  receipt.result.verdict === "pass" &&
  snapshotKey(receiptSnapshot(receipt)) === snapshotKey(observed);
