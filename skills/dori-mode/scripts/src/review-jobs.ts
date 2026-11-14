import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { receiptSnapshot, snapshotKey, type ReviewErrorCode, type ReviewJob, type ReviewReceipt, type ReviewSnapshot } from "./review-receipt.ts";
import { saveJsonFile } from "./store.ts";
import { withStateLockSync } from "./state-lock.ts";

/**
 * Durable review job store (design 5.4 with the T1 changes). One record per issued {@link ReviewJob}, keyed by job id and
 * carrying the snapshot key, so the CLI and the supervisor share one view that survives restarts and a snapshot is never
 * reviewed twice at once.
 *
 * Refusals are typed: {@link markRunning}, {@link complete}, {@link fail} and {@link escalate} throw a
 * {@link ReviewJobError}; nothing is written in that case.
 */

/** Where a job is in its life. `completed` holds the receipt; `stale`, `error` and `escalated` are dead ends for that job. */
export type ReviewExecution =
  | { readonly state: "queued"; readonly reason: string }
  | { readonly state: "running"; readonly startedAt: number; readonly reviewerLaneKey: string }
  | { readonly state: "completed"; readonly receiptId: string }
  | { readonly state: "stale"; readonly reason: string }
  | { readonly state: "error"; readonly code: ReviewErrorCode; readonly detail: string }
  | { readonly state: "escalated"; readonly decisionId?: string; readonly reason: string };

export type ReviewExecutionState = ReviewExecution["state"];

/** One stored job with its execution state. `key` is {@link snapshotKey} of `job.snapshot`. */
export type ReviewJobRecord = {
  readonly job: ReviewJob;
  readonly key: string;
  readonly execution: ReviewExecution;
  /** Times the job was started (markRunning). */
  readonly attempts: number;
  readonly updatedAt: number;
  readonly receipt?: ReviewReceipt;
  /** The review snapshot worktree the gate prepared for this job, and the ms stamp taken after its checkout. */
  readonly snapshotPath?: string;
  readonly snapshotStartedAt?: number;
  /** The repo checkout the snapshot is a worktree of (for its release). */
  readonly repoDir?: string;
  /** Set once the snapshot worktree was released. */
  readonly snapshotReleased?: boolean;
  /** Set once the gate closed this job's reviewer lane. */
  readonly reviewerClosed?: boolean;
  /** D10: the approved base differed from the merge commit's first parent. */
  readonly baseRace?: ReviewBaseRace;
};

/** A merge whose first parent was not the base the approval covered (another PR merged in between). */
export type ReviewBaseRace = {
  readonly approvedBaseSha: string;
  readonly mergedOntoSha: string;
  readonly mergeSha: string;
  readonly at: number;
};

/** The fields {@link annotate} may set; identity, execution and receipt are never patched. */
export type ReviewJobAnnotation = Partial<Pick<ReviewJobRecord, "snapshotPath" | "snapshotStartedAt" | "repoDir" | "snapshotReleased" | "reviewerClosed" | "baseRace">>;

export type ReviewJobErrorCode = "unknown_job" | "duplicate_job_id" | "bad_state" | "key_running" | "receipt_mismatch";

/** A refused review job operation. */
export class ReviewJobError extends Error {
  readonly code: ReviewJobErrorCode;
  constructor(code: ReviewJobErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export const REVIEW_JOBS_FILE = "review-jobs.json";
const REVIEW_JOBS_LOCK = "review-jobs.lock.sqlite";

/** States in which a job holds its snapshot: a new job for the same key is not started. */
const LIVE_STATES: ReadonlySet<ReviewExecutionState> = new Set(["queued", "running", "completed"]);

export type ReviewJobFilter = {
  readonly repo?: string;
  readonly prNumber?: number;
  readonly states?: readonly ReviewExecutionState[];
};

const matches = (r: ReviewJobRecord, f: ReviewJobFilter): boolean =>
  (f.repo === undefined || r.job.snapshot.repo === f.repo) &&
  (f.prNumber === undefined || r.job.snapshot.prNumber === f.prNumber) &&
  (f.states === undefined || f.states.includes(r.execution.state));

/** Oldest first, then by job id. */
const byCreated = (a: ReviewJobRecord, b: ReviewJobRecord): number =>
  a.job.createdAt - b.job.createdAt || (a.job.jobId < b.job.jobId ? -1 : a.job.jobId > b.job.jobId ? 1 : 0);

/** `review-jobs.json`: rewritten whole under its own state lock; every mutation is one locked read-modify-write. */
export class ReviewJobs {
  readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, REVIEW_JOBS_FILE);
    this.lock = join(stateDir, REVIEW_JOBS_LOCK);
  }
  private read(): Record<string, ReviewJobRecord> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { jobs: Record<string, ReviewJobRecord> }).jobs : {};
  }
  get(jobId: string): ReviewJobRecord | undefined { return this.read()[jobId]; }
  /** Every record of one snapshot key, oldest first. */
  byKey(key: string): ReviewJobRecord[] { return this.list().filter((r) => r.key === key); }
  list(filter: ReviewJobFilter = {}): ReviewJobRecord[] {
    return Object.values(this.read()).filter((r) => matches(r, filter)).sort(byCreated);
  }
  /**
   * Runs `act` with the current records under the lock. `act` calls `put` for each record it changes; the file is
   * rewritten once, only when something changed. A throw in `act` writes nothing.
   */
  transact<T>(act: (records: Readonly<Record<string, ReviewJobRecord>>, put: (r: ReviewJobRecord) => void) => T): T {
    return withStateLockSync(this.lock, () => {
      const jobs = this.read();
      let dirty = false;
      const result = act(jobs, (r) => { jobs[r.job.jobId] = r; dirty = true; });
      if (dirty) saveJsonFile(this.path, { jobs });
      return result;
    });
  }
}

const require_ = (records: Readonly<Record<string, ReviewJobRecord>>, jobId: string): ReviewJobRecord => {
  const r = records[jobId];
  if (!r) throw new ReviewJobError("unknown_job", jobId);
  return r;
};

const need = (r: ReviewJobRecord, state: ReviewExecutionState, to: string): void => {
  if (r.execution.state !== state) throw new ReviewJobError("bad_state", `${r.job.jobId} is ${r.execution.state}, cannot ${to}`);
};

/**
 * Records a new queued job. When a record with the same snapshot key is queued, running or completed, that record is
 * returned with `created: false` and nothing is written: a snapshot is never started twice. A key with only stale, error
 * or escalated records gets the new job. A reused job id for another key throws `duplicate_job_id`.
 */
export const enqueue = (
  store: ReviewJobs, now: number, job: ReviewJob, reason = "queued",
): { readonly record: ReviewJobRecord; readonly created: boolean } =>
  store.transact((records, put) => {
    const key = snapshotKey(job.snapshot);
    const live = Object.values(records).filter((r) => r.key === key && LIVE_STATES.has(r.execution.state)).sort(byCreated)[0];
    if (live) return { record: live, created: false };
    if (records[job.jobId]) throw new ReviewJobError("duplicate_job_id", job.jobId);
    const record: ReviewJobRecord = { job, key, execution: { state: "queued", reason }, attempts: 0, updatedAt: now };
    put(record);
    return { record, created: true };
  });

/**
 * queued -> running. Throws `bad_state` from any other state and `key_running` when another record of the same key is
 * already running.
 */
export const markRunning = (store: ReviewJobs, now: number, jobId: string, reviewerLaneKey: string): ReviewJobRecord =>
  store.transact((records, put) => {
    const r = require_(records, jobId);
    need(r, "queued", "start");
    const other = Object.values(records).find((o) => o.key === r.key && o.job.jobId !== jobId && o.execution.state === "running");
    if (other) throw new ReviewJobError("key_running", `${other.job.jobId} already runs ${r.key}`);
    const next: ReviewJobRecord = {
      ...r, execution: { state: "running", startedAt: now, reviewerLaneKey }, attempts: r.attempts + 1, updatedAt: now,
    };
    put(next);
    return next;
  });

/**
 * running -> completed with `receipt`. The receipt must carry this job id and the record's snapshot identity, else
 * `receipt_mismatch`. A job that went stale (or anything but running) throws `bad_state` and stays as it is.
 */
export const complete = (store: ReviewJobs, now: number, jobId: string, receipt: ReviewReceipt): ReviewJobRecord =>
  store.transact((records, put) => {
    const r = require_(records, jobId);
    need(r, "running", "complete");
    if (receipt.jobId !== jobId) throw new ReviewJobError("receipt_mismatch", `receipt is for job ${receipt.jobId}`);
    if (snapshotKey(receiptSnapshot(receipt)) !== r.key) throw new ReviewJobError("receipt_mismatch", "receipt snapshot differs from the job's");
    const next: ReviewJobRecord = { ...r, execution: { state: "completed", receiptId: receipt.receiptId }, receipt, updatedAt: now };
    put(next);
    return next;
  });

/** queued or running -> error. */
export const fail = (store: ReviewJobs, now: number, jobId: string, code: ReviewErrorCode, detail: string): ReviewJobRecord =>
  store.transact((records, put) => {
    const r = require_(records, jobId);
    if (r.execution.state !== "queued" && r.execution.state !== "running") need(r, "running", "fail");
    const next: ReviewJobRecord = { ...r, execution: { state: "error", code, detail }, updatedAt: now };
    put(next);
    return next;
  });

/** queued, running or error -> escalated (the lead decides; no automatic retry). */
export const escalate = (store: ReviewJobs, now: number, jobId: string, reason: string, decisionId?: string): ReviewJobRecord =>
  store.transact((records, put) => {
    const r = require_(records, jobId);
    if (!["queued", "running", "error"].includes(r.execution.state)) need(r, "running", "escalate");
    const next: ReviewJobRecord = {
      ...r, execution: { state: "escalated", reason, ...(decisionId !== undefined ? { decisionId } : {}) }, updatedAt: now,
    };
    put(next);
    return next;
  });

const SNAPSHOT_FIELDS = [
  "repo", "prNumber", "headSha", "baseRef", "baseSha", "mergeBaseSha", "policyVersion", "criteriaSha256",
] as const satisfies readonly (keyof ReviewSnapshot)[];

/**
 * Marks stale every queued, running or completed record of the observed PR whose key differs from the observed
 * snapshot's, with a reason naming the changed fields. Returns the records changed. A later {@link complete} for such a
 * job is refused (design 5.6).
 */
export const markStale = (store: ReviewJobs, now: number, observed: ReviewSnapshot): ReviewJobRecord[] =>
  store.transact((records, put) => {
    const key = snapshotKey(observed);
    const changed: ReviewJobRecord[] = [];
    for (const r of Object.values(records).sort(byCreated)) {
      const s = r.job.snapshot;
      if (s.repo !== observed.repo || s.prNumber !== observed.prNumber || r.key === key || !LIVE_STATES.has(r.execution.state)) continue;
      const fields = SNAPSHOT_FIELDS.filter((f) => s[f] !== observed[f]);
      const next: ReviewJobRecord = { ...r, execution: { state: "stale", reason: `snapshot changed: ${fields.join(", ")}` }, updatedAt: now };
      put(next);
      changed.push(next);
    }
    return changed;
  });

/** Sets bookkeeping fields of one record (snapshot path, release, reviewer close, base race); never its state. */
export const annotate = (store: ReviewJobs, now: number, jobId: string, patch: ReviewJobAnnotation): ReviewJobRecord =>
  store.transact((records, put) => {
    const next: ReviewJobRecord = { ...require_(records, jobId), ...patch, updatedAt: now };
    put(next);
    return next;
  });

/** queued -> queued with a new reason (a held launch); unchanged reason writes nothing. Throws `bad_state` otherwise. */
export const requeue = (store: ReviewJobs, now: number, jobId: string, reason: string): ReviewJobRecord =>
  store.transact((records, put) => {
    const r = require_(records, jobId);
    need(r, "queued", "requeue");
    if (r.execution.state === "queued" && r.execution.reason === reason) return r;
    const next: ReviewJobRecord = { ...r, execution: { state: "queued", reason }, updatedAt: now };
    put(next);
    return next;
  });

/**
 * Reconciles the store after a supervisor restart. Queued, completed and stale records are untouched; a running record
 * whose reviewer lane is not alive becomes error `runner_lost`; alive or unknown stays running. Never creates a job.
 * Returns the records changed.
 */
export const recoverAfterRestart = (
  store: ReviewJobs, now: number, isLaneAlive: (laneKey: string) => boolean | "unknown",
): ReviewJobRecord[] =>
  store.transact((records, put) => {
    const changed: ReviewJobRecord[] = [];
    for (const r of Object.values(records).sort(byCreated)) {
      if (r.execution.state !== "running" || isLaneAlive(r.execution.reviewerLaneKey) !== false) continue;
      const next: ReviewJobRecord = {
        ...r, execution: { state: "error", code: "runner_lost", detail: `reviewer lane ${r.execution.reviewerLaneKey} is gone after restart` }, updatedAt: now,
      };
      put(next);
      changed.push(next);
    }
    return changed;
  });
