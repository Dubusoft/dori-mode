import { EXEMPT_POLICY_VERSION, REVIEW_EXEMPT_FILE, ReviewExemptions } from "./review-exempt.ts";
import { REVIEW_JOBS_FILE, type ReviewExecutionState, type ReviewJobRecord, ReviewJobs } from "./review-jobs.ts";
import { snapshotKey, type ReviewErrorCode } from "./review-receipt.ts";
import { REVIEW_STATUS_FILE, type ReviewMerge, ReviewStatusStore } from "./review-status.ts";

/**
 * Read-only audit of the review gate's stored history: proves from the durable stores alone that no merge the supervisor
 * recorded skipped review, and measures the gate from stored timestamps. It never writes, locks or calls GitHub.
 *
 * Inputs (all under `stateDir`, read through their store classes):
 * - review-jobs.json   every job record; the receipt of a completed job is stored on its record (there is no other
 *                      receipt store)
 * - review-exempt.json docs-only exemption decisions with their exempt receipts
 * - review-status.json the merges the supervisor recorded (`merges`)
 */

export const REVIEW_AUDIT_FILES = [REVIEW_JOBS_FILE, REVIEW_EXEMPT_FILE, REVIEW_STATUS_FILE] as const;

export type ReviewViolationKind =
  /** A merge whose PR head has neither a reviewer pass bound to its snapshot nor an exempt receipt. */
  | "merge_without_approval"
  /** A merge whose only pass at that head had gone stale (head/base changed) before the merge. */
  | "merge_on_stale"
  /** A merge recorded while the newest job of that PR head was not an approving pass (findings, error, stale, escalated, queued, running). */
  | "merge_while_blocked"
  /** A pass receipt whose source is not the gate reviewer, or a receipt of an unknown source. */
  | "non_reviewer_receipt"
  /** A receipt whose job id or snapshot identity differs from the job record that holds it. */
  | "receipt_mismatch"
  /** More than one running job for one snapshot key. */
  | "duplicate_running";

export type ReviewViolation = {
  readonly kind: ReviewViolationKind;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly jobIds: readonly string[];
  readonly mergeSha?: string;
  readonly detail: string;
};

/** Distribution of one latency in ms; null as a whole when there is no sample. */
export type LatencySummary = {
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly meanMs: number;
  readonly maxMs: number;
};

/** Per-job latencies; a leg with no stored timestamps is null. */
export type JobLatency = {
  readonly jobId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly state: ReviewExecutionState;
  /** job.createdAt -> start (running.startedAt, else the receipt's startedAt). */
  readonly requestToStartMs: number | null;
  /** receipt startedAt -> completedAt. */
  readonly startToCompleteMs: number | null;
};

export type PrRounds = { readonly repo: string; readonly prNumber: number; readonly findingsRounds: number; readonly passed: boolean };

export type ReviewAuditStats = {
  readonly jobs: number | null;
  readonly merges: number | null;
  readonly perJob: readonly JobLatency[] | null;
  readonly requestToStart: LatencySummary | null;
  readonly startToComplete: LatencySummary | null;
  readonly executionStates: Readonly<Partial<Record<ReviewExecutionState, number>>> | null;
  readonly verdicts: { readonly pass: number; readonly findings: number } | null;
  /** Completed findings receipts per PR (PRs with at least one job). */
  readonly findingsRoundsPerPr: readonly PrRounds[] | null;
  /** Findings receipts later followed by a reviewer pass on the same PR, out of all findings receipts. */
  readonly findingsResolvedByPass: { readonly resolved: number; readonly total: number } | null;
  /** Escalated jobs and reached review limits (owner decision caps). */
  readonly escalations: { readonly escalatedJobs: number; readonly capsReached: number } | null;
  readonly errorCodes: Readonly<Partial<Record<ReviewErrorCode, number>>> | null;
  /** D10 merges onto a base other than the approved one (recorded, not a gate violation). */
  readonly baseRaces: number | null;
  readonly exemptions: number | null;
};

export type ReviewAudit = {
  readonly stateDir: string;
  readonly filesRead: readonly string[];
  readonly violations: readonly ReviewViolation[];
  readonly stats: ReviewAuditStats;
};

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const short = (sha: string): string => sha.slice(0, 7);
const isoMs = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Whether `r`'s receipt carries its own job id and exactly its job's snapshot. */
const receiptBound = (r: ReviewJobRecord): boolean => {
  const x = r.receipt;
  if (!x) return false;
  return x.jobId === r.job.jobId && snapshotKey({
    repo: x.repo, prNumber: x.prNumber, headSha: x.headSha, baseRef: x.baseRef, baseSha: x.baseSha, mergeBaseSha: x.mergeBaseSha,
    policyVersion: x.policyVersion, criteriaSha256: x.criteriaSha256,
  }) === r.key;
};

const isReviewerPass = (r: ReviewJobRecord): boolean =>
  r.receipt?.result.verdict === "pass" && r.receipt.source === "reviewer" && receiptBound(r);

/**
 * A pass that approved the merge: completed, or marked stale only after the merge was recorded (a later observation of
 * the merged PR must not turn a valid approval into a violation).
 */
const approvedAt = (r: ReviewJobRecord, m: ReviewMerge): boolean =>
  isReviewerPass(r) && (r.execution.state === "completed" || (r.execution.state === "stale" && r.updatedAt > m.at));

/** The state of `r` as it stood at merge time, for the blocked check; a record changed after the merge counts as its pass. */
const blockedState = (r: ReviewJobRecord, m: ReviewMerge): string | undefined => {
  if (approvedAt(r, m)) return undefined;
  const e = r.execution;
  if (e.state === "completed") return r.receipt?.result.verdict === "findings" ? "findings" : `completed without an approving receipt`;
  if (e.state === "error") return `error ${e.code}`;
  return e.state;
};

const summarize = (xs: readonly number[]): LatencySummary | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    count: s.length, minMs: s[0]!, maxMs: s.at(-1)!, meanMs: Math.round(s.reduce((n, x) => n + x, 0) / s.length),
    medianMs: s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2),
  };
};

const count = <K extends string>(keys: readonly K[]): Partial<Record<K, number>> => {
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
};

const auditMerge = (m: ReviewMerge, records: readonly ReviewJobRecord[], exempt: ReviewExemptions): ReviewViolation[] => {
  const atHead = records.filter((r) => sameRepo(r.job.snapshot.repo, m.repo) && r.job.snapshot.prNumber === m.prNumber
    && r.job.snapshot.headSha === m.headSha && r.job.createdAt <= m.at);
  const v = (kind: ReviewViolationKind, jobIds: string[], detail: string): ReviewViolation =>
    ({ kind, repo: m.repo, prNumber: m.prNumber, headSha: m.headSha, mergeSha: m.mergeSha, jobIds, detail });
  const out: ReviewViolation[] = [];
  const pass = atHead.filter((r) => approvedAt(r, m));
  const exempted = exempt.list().some((d) => d.kind === "exempt" && sameRepo(d.receipt.repo, m.repo) && d.receipt.prNumber === m.prNumber
    && d.receipt.headSha === m.headSha && d.receipt.exemptPolicyVersion === EXEMPT_POLICY_VERSION);
  if (pass.length === 0 && !exempted) {
    const stale = atHead.filter((r) => isReviewerPass(r) && r.execution.state === "stale");
    out.push(stale.length > 0
      ? v("merge_on_stale", stale.map((r) => r.job.jobId), `merged at head ${short(m.headSha)} whose pass went stale before the merge`)
      : v("merge_without_approval", atHead.map((r) => r.job.jobId), `merged at head ${short(m.headSha)} with no reviewer pass and no exempt receipt`));
  }
  const newest = atHead.at(-1);
  const blocked = newest && blockedState(newest, m);
  if (newest && blocked) out.push(v("merge_while_blocked", [newest.job.jobId], `merged while job ${newest.job.jobId} was ${blocked}`));
  return out;
};

/** Audits the review history stored in `stateDir`; reads only, never writes. */
export const auditReviewHistory = (stateDir: string): ReviewAudit => {
  const jobsStore = new ReviewJobs(stateDir);
  const exempt = new ReviewExemptions(stateDir);
  const status = new ReviewStatusStore(stateDir);
  const records = jobsStore.list();
  const merges = status.merges();
  const exemptions = exempt.list();
  const violations: ReviewViolation[] = [];

  for (const m of merges) violations.push(...auditMerge(m, records, exempt));
  for (const r of records) {
    const x = r.receipt;
    if (!x) continue;
    const s = r.job.snapshot;
    const base = { repo: s.repo, prNumber: s.prNumber, headSha: s.headSha, jobIds: [r.job.jobId] };
    if ((x.source !== "reviewer" && x.result.verdict === "pass") || (x.source !== "reviewer" && x.source !== "qa")) {
      violations.push({ ...base, kind: "non_reviewer_receipt", detail: `receipt ${x.receiptId} has source ${String(x.source)} and verdict ${x.result.verdict}` });
    }
    if (!receiptBound(r)) violations.push({ ...base, kind: "receipt_mismatch", detail: `receipt ${x.receiptId} is not bound to job ${r.job.jobId}'s snapshot` });
  }
  const running = new Map<string, ReviewJobRecord[]>();
  for (const r of records) if (r.execution.state === "running") running.set(r.key, [...(running.get(r.key) ?? []), r]);
  for (const [key, rs] of running) {
    if (rs.length < 2) continue;
    const s = rs[0]!.job.snapshot;
    violations.push({ kind: "duplicate_running", repo: s.repo, prNumber: s.prNumber, headSha: s.headSha, jobIds: rs.map((r) => r.job.jobId), detail: `${rs.length} running jobs for ${key}` });
  }

  const has = records.length > 0;
  const perJob: JobLatency[] = records.map((r) => {
    const e = r.execution;
    const started = e.state === "running" ? e.startedAt : isoMs(r.receipt?.startedAt);
    const completed = isoMs(r.receipt?.completedAt);
    const recStart = isoMs(r.receipt?.startedAt);
    return {
      jobId: r.job.jobId, repo: r.job.snapshot.repo, prNumber: r.job.snapshot.prNumber, state: e.state,
      requestToStartMs: started === undefined ? null : started - r.job.createdAt,
      startToCompleteMs: recStart === undefined || completed === undefined ? null : completed - recStart,
    };
  });
  const receipts = records.filter((r) => r.receipt);
  const prs = new Map<string, ReviewJobRecord[]>();
  for (const r of records) {
    const k = `${r.job.snapshot.repo.toLowerCase()}#${r.job.snapshot.prNumber}`;
    prs.set(k, [...(prs.get(k) ?? []), r]);
  }
  const findings = records.filter((r) => r.receipt?.result.verdict === "findings");
  const resolved = findings.filter((f) => (prs.get(`${f.job.snapshot.repo.toLowerCase()}#${f.job.snapshot.prNumber}`) ?? [])
    .some((p) => p.job.createdAt > f.job.createdAt && isReviewerPass(p))).length;
  const errors = records.flatMap((r) => (r.execution.state === "error" ? [r.execution.code] : []));

  const stats: ReviewAuditStats = {
    jobs: has ? records.length : null,
    merges: merges.length > 0 ? merges.length : null,
    perJob: has ? perJob : null,
    requestToStart: summarize(perJob.flatMap((j) => (j.requestToStartMs === null ? [] : [j.requestToStartMs]))),
    startToComplete: summarize(perJob.flatMap((j) => (j.startToCompleteMs === null ? [] : [j.startToCompleteMs]))),
    executionStates: has ? count(records.map((r) => r.execution.state)) : null,
    verdicts: receipts.length > 0
      ? { pass: receipts.filter((r) => r.receipt!.result.verdict === "pass").length, findings: findings.length }
      : null,
    findingsRoundsPerPr: has
      ? [...prs.values()].map((rs) => ({
          repo: rs[0]!.job.snapshot.repo, prNumber: rs[0]!.job.snapshot.prNumber,
          findingsRounds: rs.filter((r) => r.receipt?.result.verdict === "findings").length, passed: rs.some(isReviewerPass),
        }))
      : null,
    findingsResolvedByPass: findings.length > 0 ? { resolved, total: findings.length } : null,
    escalations: has
      ? { escalatedJobs: records.filter((r) => r.execution.state === "escalated").length, capsReached: records.filter((r) => r.capReached).length }
      : null,
    errorCodes: has ? count(errors) : null,
    baseRaces: has ? records.filter((r) => r.baseRace).length : null,
    exemptions: exemptions.length > 0 ? exemptions.filter((d) => d.kind === "exempt").length : null,
  };
  return { stateDir, filesRead: REVIEW_AUDIT_FILES.map((f) => `${stateDir}/${f}`), violations, stats };
};

const n = (x: number | null): string => (x === null ? "n/a" : String(x));
const ms = (x: number | null): string => (x === null ? "n/a" : `${(x / 1000).toFixed(1)}s`);
const lat = (s: LatencySummary | null): string =>
  s === null ? "n/a" : `n=${s.count} min=${ms(s.minMs)} median=${ms(s.medianMs)} mean=${ms(s.meanMs)} max=${ms(s.maxMs)}`;
const counts = (c: Readonly<Record<string, number | undefined>> | null): string => {
  if (c === null) return "n/a";
  const e = Object.entries(c).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return e.length === 0 ? "none" : e.map(([k, v]) => `${k}=${v}`).join(" ");
};

/** A plain-text report of {@link auditReviewHistory}; "n/a" marks a stat with no stored data. */
export const formatReviewAudit = (a: ReviewAudit): string => {
  const s = a.stats;
  const lines = [
    `Review audit of ${a.stateDir}`,
    `Files: ${a.filesRead.join(", ")}`,
    "",
    a.violations.length === 0 ? "Violations: none" : `Violations: ${a.violations.length}`,
    ...a.violations.map((v) => `  - ${v.kind} ${v.repo}#${v.prNumber} head ${short(v.headSha)}${v.mergeSha ? ` merge ${short(v.mergeSha)}` : ""}`
      + `${v.jobIds.length ? ` jobs ${v.jobIds.join(",")}` : ""}: ${v.detail}`),
    "",
    "Stats:",
    `  jobs: ${n(s.jobs)}  merges: ${n(s.merges)}  exemptions: ${n(s.exemptions)}`,
    `  request->start: ${lat(s.requestToStart)}`,
    `  start->complete: ${lat(s.startToComplete)}`,
    `  states: ${counts(s.executionStates)}`,
    `  verdicts: ${s.verdicts === null ? "n/a" : `pass=${s.verdicts.pass} findings=${s.verdicts.findings}`}`,
    `  findings resolved by a later pass: ${s.findingsResolvedByPass === null ? "n/a" : `${s.findingsResolvedByPass.resolved}/${s.findingsResolvedByPass.total}`}`,
    `  escalations: ${s.escalations === null ? "n/a" : `escalated jobs=${s.escalations.escalatedJobs} caps reached=${s.escalations.capsReached}`}`,
    `  error codes: ${counts(s.errorCodes)}`,
    `  base races: ${n(s.baseRaces)}`,
    `  findings rounds per PR: ${s.findingsRoundsPerPr === null ? "n/a" : s.findingsRoundsPerPr.map((p) => `${p.repo}#${p.prNumber}=${p.findingsRounds}${p.passed ? " (passed)" : ""}`).join(", ")}`,
  ];
  return lines.join("\n");
};
