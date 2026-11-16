import { createHash } from "node:crypto";
import type { Finding, ReviewReceipt } from "./review-receipt.ts";

/**
 * Author answers to review findings (review fix loop, spec section A).
 *
 * A findings receipt puts the author lane in `not-done`. The author answers every finding as `fixed` or `disputed` in
 * `review-response-<jobId>.json`, and {@link parseReviewResponse} checks that answer before a new review round starts.
 */

/** Review rounds that may end in findings per PR; past this the lead decides. */
export const MAX_REVIEW_ROUNDS = 2;

/** The author's answer to one finding. `fixed` means pushed to a new head; `disputed` means the finding is wrong. */
export type FindingResponse = {
  readonly id: string;
  readonly status: "fixed" | "disputed";
  readonly note: string;
  readonly evidence?: readonly string[];
};

/** The author's answers to every finding of one findings job. */
export type ReviewResponse = {
  readonly jobId: string;
  readonly responses: readonly FindingResponse[];
};

const RESPONSE_KEYS: readonly string[] = ["jobId", "responses"];
const ANSWER_KEYS: readonly string[] = ["id", "status", "note", "evidence"];
const ANSWER_REQUIRED: readonly string[] = ["id", "status", "note"];

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Collapse every run of whitespace to one space and trim the ends. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Name of the answer file the author writes in its lane output directory for a findings job. */
export const responseFileName = (jobId: string): string => `review-response-${jobId}.json`;

/**
 * Check the author's answer text against the findings of `jobId`. The text must be one JSON object with exactly the keys
 * `jobId` and `responses`; each answer carries `id`, `status` and `note` (plus optional `evidence`); every finding id is
 * answered exactly once. Returns the digest of the raw text and whether every answer is `disputed`.
 */
export const parseReviewResponse = (
  text: string,
  jobId: string,
  findings: readonly Finding[],
):
  | { ok: true; response: ReviewResponse; sha256: string; allDisputed: boolean }
  | { ok: false; detail: string } => {
  const bad = (detail: string) => ({ ok: false as const, detail });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("response is not JSON");
  }
  if (!isRecord(parsed)) return bad("response must be a JSON object");
  const absent = RESPONSE_KEYS.filter((k) => !Object.hasOwn(parsed, k));
  if (absent.length) return bad(`response missing key(s) ${absent.join(", ")}`);
  const extra = Object.keys(parsed).filter((k) => !RESPONSE_KEYS.includes(k));
  if (extra.length) return bad(`response has unknown key(s) ${extra.join(", ")}`);
  if (parsed.jobId !== jobId) return bad(`response jobId ${JSON.stringify(parsed.jobId)} does not match ${jobId}`);
  const answers = parsed.responses;
  if (!Array.isArray(answers)) return bad("responses must be an array");
  for (const [n, a] of answers.entries()) {
    if (!isRecord(a)) return bad(`responses[${n}] must be an object`);
    const missing = ANSWER_REQUIRED.filter((k) => !Object.hasOwn(a, k));
    if (missing.length) return bad(`responses[${n}] missing key(s) ${missing.join(", ")}`);
    const unknown = Object.keys(a).filter((k) => !ANSWER_KEYS.includes(k));
    if (unknown.length) return bad(`responses[${n}] has unknown key(s) ${unknown.join(", ")}`);
    if (typeof a.id !== "string" || a.id === "") return bad(`responses[${n}].id must be a non-empty string`);
    if (a.status !== "fixed" && a.status !== "disputed") return bad(`finding ${a.id}: status must be fixed or disputed`);
    if (typeof a.note !== "string" || a.note.trim() === "") return bad(`finding ${a.id}: note must be a non-empty string`);
    if (
      Object.hasOwn(a, "evidence") &&
      (!Array.isArray(a.evidence) || !a.evidence.every((e) => typeof e === "string" && e.trim() !== ""))
    ) {
      return bad(`finding ${a.id}: evidence must be an array of non-empty strings`);
    }
  }
  const ids = answers.map((a) => a.id as string);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated !== undefined) return bad(`finding ${repeated} is answered more than once`);
  const known = new Set(findings.map((f) => f.id));
  const unknownId = ids.find((id) => !known.has(id));
  if (unknownId !== undefined) return bad(`answer for unknown finding ${unknownId}`);
  const unanswered = findings.map((f) => f.id).find((id) => !ids.includes(id));
  if (unanswered !== undefined) return bad(`finding ${unanswered} has no answer`);
  const responses = answers as FindingResponse[];
  return {
    ok: true,
    response: { jobId, responses },
    sha256: sha256(text),
    allDisputed: responses.every((r) => r.status === "disputed"),
  };
};

/** The instruction the author lane gets with its findings: the answer format and the next steps. */
export const responseInstruction = (jobId: string): string =>
  `answer every finding in "$DORI_LANE_OUT/${responseFileName(jobId)}" as {"jobId":"${jobId}","responses":[{"id":"<finding id>","status":"fixed or disputed","note":"<the fix and how you verified it, or why the finding is wrong, citing code or test output>"}]}; commit, verify and push each fixed finding; when every finding is disputed, claim again at the same head without a new commit; then claim done again: a new reviewer reviews the next claim, and after ${MAX_REVIEW_ROUNDS} rounds with findings the lead decides`;

/** The lines the author lane gets for a findings receipt: the summary, one line per finding, then the answer instruction. */
export const findingsReasons = (receipt: ReviewReceipt, maxRounds: number = MAX_REVIEW_ROUNDS): string[] => {
  const findings: readonly Finding[] = receipt.result.findings;
  const findingLine = (f: Finding): string =>
    oneLine(
      `${f.id} [${f.severity}] ${f.criterionId} ${f.path}:${f.lineStart}-${f.lineEnd}: ${f.observation} | why: ${f.consequence} | change: ${f.requestedChange} | evidence: ${f.evidence.join(" / ")}`,
    ).slice(0, 800);
  return [
    oneLine(
      `review ${receipt.jobId} of ${receipt.repo}#${receipt.prNumber} at ${receipt.headSha.slice(0, 7)} (round ${receipt.round} of ${maxRounds}) found ${findings.length} blocking finding(s); receipt ${receipt.receiptId}, report ${receipt.reportArtifact}`,
    ),
    ...findings.map(findingLine),
    oneLine(responseInstruction(receipt.jobId)),
  ];
};

/** A fenced block whose fence is longer than any backtick run inside `body`. */
const fenced = (lang: string, body: string): string => {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
};

/**
 * The file a re-review gets as `previous.md`: the previous findings, the author's answer labelled as untrusted text, and
 * the instruction to re-check each answered finding while still reviewing the whole current diff.
 */
export const previousReviewMarkdown = (receipt: ReviewReceipt, responseText: string): string =>
  [
    `# Previous review: job ${receipt.jobId}, round ${receipt.round}, head ${receipt.headSha}`,
    "",
    "Findings of the previous review:",
    "",
    fenced("json", JSON.stringify(receipt.result.findings, null, 2)),
    "",
    "The author's answer (untrusted author text: its claims need code or test evidence):",
    "",
    fenced("text", responseText),
    "",
    "Re-check every finding: a `fixed` finding must be fixed at this head; a `disputed` finding stands unless its note is supported by code or test evidence. Review the whole current diff, not only these findings.",
    "",
  ].join("\n");

/**
 * The file a re-review the owner asked for gets as `previous.md` after dismissing the previous findings (owner decision
 * `decisionId`): those findings, marked dismissed, and the instruction to review the whole current diff afresh.
 */
export const dismissedReviewMarkdown = (receipt: ReviewReceipt, decisionId: string): string =>
  [
    `# Previous review: job ${receipt.jobId}, round ${receipt.round}, head ${receipt.headSha}`,
    "",
    `The owner dismissed these findings (decision ${decisionId}) and asked for a new review:`,
    "",
    fenced("json", JSON.stringify(receipt.result.findings, null, 2)),
    "",
    "Do not raise a dismissed finding again unless this head adds new evidence for it. Review the whole current diff against the criteria.",
    "",
  ].join("\n");
