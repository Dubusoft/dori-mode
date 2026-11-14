import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { claimGate } from "./ci-follow.ts";
import { closeLane, type FlowDeps } from "./done-flow.ts";
import type { OpenPull } from "./github-events.ts";
import { briefBody } from "./lane-files.ts";
import { machineRunner } from "./lane-ops.ts";
import { type Lane, LANE_KEY, statusOf } from "./registry.ts";
import {
  annotate, complete, enqueue, escalate, fail, markRunning, markStale, recoverAfterRestart, requeue, ReviewJobError, type ReviewJobRecord,
  ReviewJobs,
} from "./review-jobs.ts";
import {
  installedOutDir, launchReviewLane, REVIEW_REPORT_FILE, REVIEW_RESULT_FILE, reviewBrief, type ReviewLaunchRequest, type ReviewLaunchResult,
} from "./review-lane.ts";
import {
  acceptReviewSubmission, isApproval, type ReceiptRejectCode, REVIEWER_CHANNEL, type ReviewErrorCode, type ReviewJob, type ReviewReceipt,
  type ReviewSnapshot, type ReviewSource, snapshotKey,
} from "./review-receipt.ts";
import {
  checkReviewScope, prepareReviewSnapshot, releaseReviewSnapshot, reviewSnapshotPath, type ReleaseResult, type ScopeInput, type ScopeResult,
  type SnapshotInput, type SnapshotResult,
} from "./review-snapshot.ts";
import {
  classifyExemption, EXEMPT_POLICY_VERSION, type ExemptDecision, exemptKey, exemptReceipt, type ExemptReceipt, isExemptFor, ReviewExemptions,
} from "./review-exempt.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";

/**
 * The supervisor's review gate (T4 design D2-D11): observes a PR's review snapshot, starts at most one review job per
 * snapshot through a review lane, takes the review lane's result in, and answers whether a PR is approved for merge and
 * whether an author lane must be held open. Every job lives in the durable ReviewJobs store; nothing here approves
 * without a reviewer `pass` receipt for the exact observed snapshot.
 */

export const REVIEW_POLICY_VERSION = "t4-1";
/** D8: a job queued this long without a start, or running this long without a result, fails with `timeout`. */
export const REVIEW_TIMEOUT_MS = 20 * 60_000;

/** Common review criteria; with the author lane's brief (criterion G1) they make the canonical criteria text (D2). */
export const REVIEW_CRITERIA = [
  "# Review criteria",
  "",
  "- C1 Correctness: the change does what its goal states, handles its edge cases and breaks no existing behavior.",
  "- C2 Verification: typecheck and tests pass on the snapshot; changed behavior is covered by tests that would fail without it.",
  "- C3 Scope: the diff contains only changes the goal needs; no unrelated refactors, debug leftovers or generated noise.",
  "- C4 Safety: no secrets, no injection or unsafe command construction, no weakened permission or sandbox checks, no data loss.",
  "- C5 Consistency: types, docs, config and callers match the changed code; no dead or contradictory paths are left behind.",
].join("\n");

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const short = (sha: string): string => sha.slice(0, 7);
const repoName = (repo: string): string => (repo.split("/")[1] ?? repo).toLowerCase().replace(/[^a-z0-9.-]/g, "-");
const prUrl = (repo: string, n: number): string => `https://github.com/${repo}/pull/${n}`;
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The canonical criteria text: the common criteria, then the author lane's brief when it is readable. */
export const criteriaText = (brief: string | undefined): string =>
  brief === undefined ? REVIEW_CRITERIA : `${REVIEW_CRITERIA}\n- G1 Goal: the change fulfils the author lane's brief below.\n\n## Author brief (G1)\n\n${briefBody(brief).trim()}\n`;

/** The PR as GitHub shows it now; `checks` is its check rollup (`red` once any check failed; absent: not read). */
export type PrInfo = {
  readonly state: string; readonly baseRef: string; readonly headSha: string; readonly title: string; readonly body: string;
  readonly checks?: "green" | "pending" | "red";
};

type Rollup = readonly { readonly __typename?: string; readonly status?: string; readonly conclusion?: string; readonly state?: string }[];
const CHECK_FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
/** A check rollup as green, pending (something still runs) or red (any check failed). */
const rollupOf = (checks: Rollup): "green" | "pending" | "red" => {
  if (checks.some((c) => (c.__typename === "StatusContext" ? c.state === "FAILURE" || c.state === "ERROR" : c.status === "COMPLETED" && CHECK_FAILED.has(c.conclusion ?? "")))) return "red";
  return checks.every((c) => (c.__typename === "StatusContext" ? c.state === "SUCCESS" : c.status === "COMPLETED")) ? "green" : "pending";
};

/** A PR the gate looks at; `sha` is the polled head (absent: the head GitHub shows now). */
export type ReviewPull = Pick<OpenPull, "repo" | "number"> & { readonly sha?: string; readonly url?: string };

/** What {@link ReviewGate.observeSnapshot} read: the snapshot identity and the inputs a job for it is built from. */
export type ObservedReview = {
  readonly snapshot: ReviewSnapshot;
  readonly criteria: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
};

/** GitHub reads, launching and local effects, injectable so tests use fakes. Defaults: {@link defaultReviewGateIo}. */
export type ReviewGateIo = {
  readonly prInfo: (repo: string, n: number) => Promise<PrInfo>;
  /** The current tip of `ref` in `repo`. */
  readonly branchSha: (repo: string, ref: string) => Promise<string>;
  readonly mergeBase: (repo: string, base: string, head: string) => Promise<string>;
  /** The `mergeBase...head` diff text. */
  readonly diff: (repo: string, mergeBase: string, head: string) => Promise<string>;
  /** The text of `path` in `repo` at commit `sha` (throws when it cannot be read). */
  readonly fileAt: (repo: string, sha: string, path: string) => Promise<string>;
  /** The first parent of a merge commit. */
  readonly mergeParent: (repo: string, mergeSha: string) => Promise<string>;
  /** Makes `sha` present in the local checkout `repoDir` (git fetch origin <sha>). */
  readonly fetchHead: (repoDir: string, sha: string) => Promise<void>;
  readonly prepareSnapshot: (input: SnapshotInput) => Promise<SnapshotResult>;
  readonly checkScope: (input: ScopeInput) => Promise<ScopeResult>;
  readonly releaseSnapshot: (input: { readonly repoDir: string; readonly path: string }) => Promise<ReleaseResult>;
  readonly launch: (request: ReviewLaunchRequest) => Promise<ReviewLaunchResult>;
  /** Closes a reviewer lane; `ok` true when its result was taken in (force), false for an abandoned review (cancelled). */
  readonly closeLane: (lane: Lane, note: string, ok: boolean) => Promise<{ readonly closed: boolean; readonly lines: readonly string[] }>;
  readonly readText: (path: string) => string | undefined;
  /** Where a lane's DORI_LANE_OUT files are installed after its claim. */
  readonly outDir: (laneKey: string) => string;
  /** The local runner's worktree root (as launchMergeLane finds it). */
  readonly worktreeRoot: () => string | undefined;
  /** The local repo checkout a review snapshot of the author lane's PR is made from. */
  readonly repoDir: (author: Lane) => string | undefined;
  /** Home whose `.omo/agent/projects` holds the trusted senpi-task records. */
  readonly home: string;
  readonly randomHex: (bytes: number) => string;
};

const ghJson = async (deps: FlowDeps, argv: readonly string[]): Promise<string> => {
  const r = await deps.run(["gh", ...argv], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`gh ${argv.slice(0, 3).join(" ")} exit ${r.code}: ${oneLine(r.err || r.out, 160)}`);
  return r.out;
};

const readTextFile = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

/** The production io: gh api reads through deps.run, the review-snapshot helpers, launchReviewLane and closeLane. */
export const defaultReviewGateIo = (deps: FlowDeps): ReviewGateIo => ({
  prInfo: async (repo, n) => {
    const v = JSON.parse(await ghJson(deps, ["pr", "view", String(n), "-R", repo, "--json", "state,baseRefName,headRefOid,title,body,statusCheckRollup"])) as {
      state?: string; baseRefName?: string; headRefOid?: string; title?: string; body?: string; statusCheckRollup?: Rollup | null;
    };
    return {
      state: v.state ?? "UNKNOWN", baseRef: v.baseRefName ?? "", headSha: v.headRefOid ?? "", title: v.title ?? "", body: v.body ?? "",
      checks: rollupOf(v.statusCheckRollup ?? []),
    };
  },
  branchSha: async (repo, ref) => (await ghJson(deps, ["api", `repos/${repo}/branches/${ref}`, "--jq", ".commit.sha"])).trim(),
  mergeBase: async (repo, base, head) => (await ghJson(deps, ["api", `repos/${repo}/compare/${base}...${head}`, "--jq", ".merge_base_commit.sha"])).trim(),
  diff: (repo, mergeBase, head) => ghJson(deps, ["api", "-H", "Accept: application/vnd.github.diff", `repos/${repo}/compare/${mergeBase}...${head}`]),
  fileAt: (repo, sha, path) =>
    ghJson(deps, ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`]),
  mergeParent: async (repo, mergeSha) => (await ghJson(deps, ["api", `repos/${repo}/commits/${mergeSha}`, "--jq", ".parents[0].sha"])).trim(),
  fetchHead: async (repoDir, sha) => {
    const r = await deps.run(["git", "-C", repoDir, "fetch", "--quiet", "origin", sha], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`git fetch origin ${short(sha)} exit ${r.code}: ${oneLine(r.err || r.out, 160)}`);
  },
  prepareSnapshot: (input) => prepareReviewSnapshot(deps.run, input),
  checkScope: (input) => checkReviewScope(deps.run, input),
  releaseSnapshot: (input) => releaseReviewSnapshot(deps.run, input),
  launch: (request) => launchReviewLane(deps, request),
  closeLane: (lane, note, ok) => closeLane(deps, lane, note, ok ? { force: true } : { force: true, cancelled: { reason: note } }),
  readText: readTextFile,
  outDir: (laneKey) => installedOutDir(deps.config.stateDir, laneKey),
  worktreeRoot: () => (deps.runnerWorktreeRoot ?? ((label) => runnerWorktreeRoot(deps.config.stateDir, label)))(machineRunner(undefined)) || deps.config.worktreeRoot,
  repoDir: (author) => (author.machine ? undefined : author.cwd),
  home: homedir(),
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
});

export type ReviewEmit = (id: string, line: string) => void;

export type ApprovalResult =
  | { readonly approved: true; readonly jobId: string; readonly receipt: ReviewReceipt }
  /** T6: the snapshot is a non-code edit the exemption policy admits; no reviewer ran. */
  | { readonly approved: true; readonly exempt: ExemptReceipt }
  | { readonly approved: false; readonly reason: string };

export type EnsureResult =
  /** claimGate refused: no job. */
  | { readonly kind: "refused"; readonly why: string }
  /** D4: a lower-numbered PR of the same claim and base goes first. */
  | { readonly kind: "waiting"; readonly why: string }
  | { readonly kind: "queued"; readonly jobId: string; readonly reason: string }
  | { readonly kind: "started"; readonly jobId: string }
  | { readonly kind: "running"; readonly jobId: string }
  | { readonly kind: "completed"; readonly jobId: string; readonly verdict: "pass" | "findings" }
  | { readonly kind: "failed"; readonly jobId: string; readonly code: ReviewErrorCode; readonly detail: string }
  | { readonly kind: "escalated"; readonly jobId: string; readonly reason: string };

export type BaseRaceResult =
  | { readonly raced: false; readonly why: string }
  | { readonly raced: true; readonly approvedBaseSha: string; readonly mergedOntoSha: string };

const LIVE = new Set(["queued", "running", "completed"]);

/** D4: the claimed PRs of `lane` in `pull`'s repo with a lower number, lowest first (candidates that go before `pull`). */
export const reviewPredecessors = (lane: Lane, pull: Pick<OpenPull, "repo" | "number">): { readonly repo: string; readonly number: number }[] =>
  (lane.claim?.pulls ?? []).filter((p) => sameRepo(p.repo, pull.repo) && p.number < pull.number).sort((a, b) => a.number - b.number)
    .map((p) => ({ repo: p.repo, number: p.number }));

/** A reject code of acceptReviewSubmission as the job's execution error. */
const errorCode = (code: ReceiptRejectCode): ReviewErrorCode =>
  code === "model_unavailable" || code === "input_unavailable" ? code : "invalid_output";

const line = (kind: string, r: ReviewJobRecord, rest: string): string =>
  `${kind} ${r.job.snapshot.repo}#${r.job.snapshot.prNumber} lane=${r.job.authorLaneKey} job=${r.job.jobId} ${rest}`.trimEnd();

type ResultFile = {
  readonly jobId?: unknown; readonly jobToken?: unknown; readonly source?: unknown; readonly body?: unknown;
  readonly taskRecord?: unknown; readonly startedAt?: unknown; readonly completedAt?: unknown;
};

/** One gate per supervisor. Construction reconciles the job store after a restart (D8); every method waits for that. */
export class ReviewGate {
  readonly jobs: ReviewJobs;
  readonly exemptions: ReviewExemptions;
  /** Settles once recoverAfterRestart ran. */
  readonly ready: Promise<void>;
  private readonly io: ReviewGateIo;
  /** Records recovery failed, announced by the first tick. */
  private recovered: ReviewJobRecord[] = [];

  constructor(private readonly deps: FlowDeps, io: Partial<ReviewGateIo> = {}) {
    this.jobs = new ReviewJobs(deps.config.stateDir);
    this.exemptions = new ReviewExemptions(deps.config.stateDir);
    this.io = { ...defaultReviewGateIo(deps), ...io };
    this.ready = this.recover();
  }

  private now(): number { return this.deps.clock.now(); }

  private async recover(): Promise<void> {
    const keys = this.jobs.list({ states: ["running"] }).map((r) => (r.execution.state === "running" ? r.execution.reviewerLaneKey : ""));
    const alive = new Map<string, boolean>();
    for (const key of keys) {
      const lane = await this.deps.registry.read(key);
      alive.set(key, Boolean(lane) && statusOf(lane!) !== "closed");
    }
    this.recovered = recoverAfterRestart(this.jobs, this.now(), (key) => alive.get(key) ?? "unknown");
  }

  /**
   * D2: the snapshot of `pull` as GitHub shows it now; `author` supplies the brief for the criteria. `criteria`, when
   * given, is used as the criteria text instead (intake of a job whose author lane is no longer in the registry).
   */
  async observeSnapshot(pull: ReviewPull, author?: Lane, criteriaOverride?: string): Promise<ObservedReview> {
    const io = this.io;
    const info = await io.prInfo(pull.repo, pull.number);
    const headSha = pull.sha ?? info.headSha;
    const baseSha = await io.branchSha(pull.repo, info.baseRef);
    const mergeBaseSha = await io.mergeBase(pull.repo, baseSha, headSha);
    const criteria = criteriaOverride ?? criteriaText(author ? io.readText(author.brief) : undefined);
    return {
      snapshot: {
        repo: pull.repo, prNumber: pull.number, headSha, baseRef: info.baseRef, baseSha, mergeBaseSha,
        policyVersion: REVIEW_POLICY_VERSION, criteriaSha256: sha256(criteria),
      },
      criteria, title: info.title, body: info.body, url: pull.url ?? prUrl(pull.repo, pull.number),
    };
  }

  /**
   * T6: the stored exemption decision of the observed snapshot, classified once per snapshot key (head, base, policy and
   * exemption policy). A diff or file that cannot be read is a `review` decision: nothing unclassifiable is exempt.
   */
  async exemption(observed: ObservedReview): Promise<ExemptDecision> {
    const s = observed.snapshot, key = exemptKey(s);
    const known = this.exemptions.get(key);
    if (known) return known;
    const at = this.now();
    let decision: ExemptDecision;
    try {
      const diff = await this.io.diff(s.repo, s.mergeBaseSha, s.headSha);
      const c = await classifyExemption(diff, (side, path) => this.io.fileAt(s.repo, side === "base" ? s.mergeBaseSha : s.headSha, path));
      decision = c.exempt
        ? { kind: "exempt", key, receipt: exemptReceipt(s, c, sha256(diff), at) }
        : { kind: "review", key, reason: c.reason, classifiedAt: new Date(at).toISOString() };
    } catch (e) {
      decision = { kind: "review", key, reason: `diff unreadable: ${oneLine(e instanceof Error ? e.message : String(e))}`, classifiedAt: new Date(at).toISOString() };
    }
    return this.exemptions.record(decision);
  }

  /**
   * D9 step 3: a completed reviewer `pass` receipt for exactly the observed snapshot, else (T6) an exemption of exactly
   * that snapshot, else why not.
   */
  async approval(lane: Lane, pull: ReviewPull, observed: ObservedReview): Promise<ApprovalResult> {
    await this.ready;
    const records = this.recordsOf(pull.repo, pull.number);
    const ok = records.filter((r) => r.execution.state === "completed" && r.receipt && isApproval(r.receipt, observed.snapshot)).at(-1);
    if (ok?.receipt) return { approved: true, jobId: ok.job.jobId, receipt: ok.receipt };
    const ex = await this.exemption(observed);
    if (ex.kind === "exempt" && isExemptFor(ex.receipt, observed.snapshot)) return { approved: true, exempt: ex.receipt };
    const cur = records.filter((r) => r.key === snapshotKey(observed.snapshot)).at(-1);
    const where = `${pull.repo}#${pull.number}@${short(observed.snapshot.headSha)} (lane ${lane.key})`;
    if (!cur) return { approved: false, reason: `no review of ${where} at base ${short(observed.snapshot.baseSha)} yet` };
    const e = cur.execution;
    const state = e.state === "queued" ? `queued: ${e.reason}`
      : e.state === "running" ? `running in ${e.reviewerLaneKey}`
      : e.state === "completed" ? `completed with ${cur.receipt?.result.verdict ?? "no"} verdict (source ${cur.receipt?.source ?? "?"})`
      : e.state === "error" ? `failed ${e.code}: ${e.detail}`
      : e.state === "escalated" ? `escalated: ${e.reason}`
      : `stale: ${e.reason}`;
    return { approved: false, reason: `review ${cur.job.jobId} of ${where} ${state}` };
  }

  /**
   * D4: whether `pull` may be reviewed now. A lower-numbered PR of the same claim that is still open into the same base
   * goes first: `waiting for <repo>#<n>`.
   */
  async reviewTurn(lane: Lane, pull: ReviewPull, baseRef: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string }> {
    for (const p of reviewPredecessors(lane, pull)) {
      const info = await this.io.prInfo(p.repo, p.number);
      if (info.state === "OPEN" && info.baseRef === baseRef) return { ok: false, why: `waiting for ${p.repo}#${p.number}` };
    }
    return { ok: true };
  }

  /**
   * D3-D5: makes sure a review job runs for the observed snapshot. The caller has checked green and mergeGate "merge";
   * claimGate is re-checked here. Marks older snapshots stale, respects the D4 order, never adds a second job for a key
   * (a queued one is launched again: the HOLD retry), retries once after an error and escalates a second error.
   */
  async ensureJob(lane: Lane, pull: ReviewPull & { readonly sha: string }, observed: ObservedReview, emit: ReviewEmit): Promise<EnsureResult> {
    await this.ready;
    const claim = claimGate(lane, pull);
    if (!claim.ok) return { kind: "refused", why: claim.why };
    this.emitStale(markStale(this.jobs, this.now(), observed.snapshot), emit);
    const turn = await this.reviewTurn(lane, pull, observed.snapshot.baseRef);
    if (!turn.ok) return { kind: "waiting", why: turn.why };
    const key = snapshotKey(observed.snapshot);
    const records = this.jobs.byKey(key);
    const live = records.find((r) => LIVE.has(r.execution.state));
    if (live) return this.continueLive(live, lane, emit);
    const blocked = this.escalation(records, emit);
    if (blocked) return blocked;
    return this.startJob(lane, pull, observed, records.length + 1, emit);
  }

  private continueLive(r: ReviewJobRecord, author: Lane, emit: ReviewEmit): Promise<EnsureResult> | EnsureResult {
    const e = r.execution;
    if (e.state === "queued") return this.launchQueued(r, author, emit);
    if (e.state === "running") return { kind: "running", jobId: r.job.jobId };
    return { kind: "completed", jobId: r.job.jobId, verdict: r.receipt?.result.verdict ?? "findings" };
  }

  /**
   * D8 retry rule for one snapshot key: an escalated record blocks; an error with model_unavailable, or a second error,
   * is escalated (once); a single other error lets one new job start.
   */
  private escalation(records: readonly ReviewJobRecord[], emit: ReviewEmit): EnsureResult | undefined {
    const esc = records.find((r) => r.execution.state === "escalated");
    if (esc && esc.execution.state === "escalated") return { kind: "escalated", jobId: esc.job.jobId, reason: esc.execution.reason };
    const errors = records.filter((r) => r.execution.state === "error");
    const last = errors.at(-1);
    if (!last || last.execution.state !== "error") return undefined;
    const atOnce = last.execution.code === "model_unavailable";
    if (!atOnce && errors.length < 2) return undefined;
    const reason = atOnce ? `model unavailable: ${oneLine(last.execution.detail)}` : `${errors.length} review runs failed (last ${last.execution.code}: ${oneLine(last.execution.detail)})`;
    const next = escalate(this.jobs, this.now(), last.job.jobId, reason);
    emit(`review-escalated:${next.job.jobId}`, line("REVIEW_ESCALATED", next, `head=${short(next.job.snapshot.headSha)} ${reason}; the lead decides ${prUrl(next.job.snapshot.repo, next.job.snapshot.prNumber)}`));
    return { kind: "escalated", jobId: next.job.jobId, reason };
  }

  /** A free reviewer lane key `review-<repo>-<n>-<head7>` (LANE_KEY length), suffixed `-2`, `-3` while one is registered. */
  private async reviewerKey(repo: string, n: number, head: string): Promise<string> {
    for (let i = 1; ; i++) {
      const tail = `-${n}-${short(head)}${i > 1 ? `-${i}` : ""}`;
      const key = `review-${repoName(repo)}`.slice(0, 61 - tail.length) + tail;
      if (!(await this.deps.registry.read(key))) return key;
    }
  }

  private async startJob(lane: Lane, pull: ReviewPull & { readonly sha: string }, observed: ObservedReview, attempt: number, emit: ReviewEmit): Promise<EnsureResult> {
    const io = this.io, s = observed.snapshot, now = this.now();
    const token = io.randomHex(32);
    const reviewerLaneKey = await this.reviewerKey(s.repo, s.prNumber, s.headSha);
    if (!LANE_KEY.test(reviewerLaneKey)) return { kind: "refused", why: `reviewer lane key ${reviewerLaneKey} is not a valid lane key` };
    const job: ReviewJob = {
      jobId: `rv-${repoName(s.repo)}-${s.prNumber}-${short(s.headSha)}-${io.randomHex(3)}`,
      snapshot: s, authorLaneKey: lane.key, reviewerLaneKey, round: 1, diffSha256: sha256(""),
      authorModel: { id: lane.model || this.deps.config.defaultModel }, tokenHash: sha256(token), createdAt: now,
    };
    // The diff is read before the job is recorded, so its digest is part of the job.
    const repoDir = io.repoDir(lane);
    let diff: string;
    try { diff = await io.diff(s.repo, s.mergeBaseSha, s.headSha); } catch (e) {
      return { kind: "waiting", why: `diff unreadable: ${oneLine(e instanceof Error ? e.message : String(e))}` };
    }
    const { record, created } = enqueue(this.jobs, now, { ...job, diffSha256: sha256(diff) }, attempt > 1 ? `attempt ${attempt}` : "queued");
    if (!created) return this.continueLive(record, lane, emit);
    const id = record.job.jobId;
    const broken = (detail: string): EnsureResult => {
      const failed = fail(this.jobs, this.now(), id, "input_unavailable", detail);
      emit(`review-failed:${id}`, line("REVIEW_FAILED", failed, `code=input_unavailable attempt=${attempt}: ${oneLine(detail)}`));
      return this.escalation(this.jobs.byKey(record.key), emit) ?? { kind: "failed", jobId: id, code: "input_unavailable", detail };
    };
    const root = io.worktreeRoot();
    if (!root) return broken("worktreeRoot is not set");
    if (!repoDir) return broken(`author lane ${lane.key} has no local checkout to snapshot (remote lanes are not reviewed on this host yet)`);
    // A failed fetch is not fatal (the head may already be local); it is named when the snapshot then fails.
    let fetchError = "";
    try { await io.fetchHead(repoDir, s.headSha); } catch (e) { fetchError = oneLine(e instanceof Error ? e.message : String(e)); }
    const snap = await io.prepareSnapshot({ repoDir, path: reviewSnapshotPath(root, repoName(s.repo), id), headSha: s.headSha, jobId: id });
    if (!snap.ok) return broken(`snapshot: ${snap.detail}${fetchError ? `; fetching ${short(s.headSha)} failed first: ${fetchError}` : ""}`);
    annotate(this.jobs, this.now(), id, { snapshotPath: snap.path, snapshotStartedAt: snap.startedAt, repoDir });
    const stateDir = this.deps.config.stateDir;
    const inputDir = join(stateDir, "review-inputs", id);
    mkdirSync(inputDir, { recursive: true });
    const diffPath = join(inputDir, "diff.patch"), criteriaPath = join(inputDir, "criteria.md"), prPath = join(inputDir, "pr.md");
    writeFileSync(diffPath, diff);
    writeFileSync(criteriaPath, observed.criteria);
    writeFileSync(prPath, `# ${observed.title}\n\n${observed.body}\n`);
    mkdirSync(join(stateDir, "briefs"), { recursive: true });
    writeFileSync(this.briefPath(reviewerLaneKey), reviewBrief(record.job, token, {
      url: observed.url, title: observed.title, snapshotPath: snap.path, inputDir, diffPath, criteriaPath, prPath,
    }));
    return this.launchQueued(this.jobs.get(id) ?? record, lane, emit);
  }

  private briefPath(reviewerLaneKey: string): string { return join(this.deps.config.stateDir, "briefs", `${reviewerLaneKey}.md`); }

  /** D5: launches a queued job's review lane. STARTUP -> running; HOLD stays queued with the reason; a refusal fails it. */
  private async launchQueued(r: ReviewJobRecord, author: Lane, emit: ReviewEmit): Promise<EnsureResult> {
    const id = r.job.jobId, s = r.job.snapshot;
    // A lane registered under the reviewer key already (a launch whose markRunning was interrupted) is adopted.
    const existing = await this.deps.registry.read(r.job.reviewerLaneKey);
    if (existing && statusOf(existing) !== "closed") return this.started(r, emit);
    if (!r.snapshotPath || !existsSync(this.briefPath(r.job.reviewerLaneKey))) {
      const failed = fail(this.jobs, this.now(), id, "input_unavailable", "review inputs missing (interrupted start)");
      emit(`review-failed:${id}`, line("REVIEW_FAILED", failed, "code=input_unavailable: review inputs missing (interrupted start)"));
      return { kind: "failed", jobId: id, code: "input_unavailable", detail: "review inputs missing" };
    }
    let result: ReviewLaunchResult;
    try {
      result = await this.io.launch({
        key: r.job.reviewerLaneKey, title: `review ${s.repo}#${s.prNumber}@${short(s.headSha)}`, brief: this.briefPath(r.job.reviewerLaneKey),
        cwd: r.snapshotPath, ...(author.thread ? { thread: author.thread } : {}),
      });
    } catch (e) {
      const reason = `launch error: ${oneLine(e instanceof Error ? e.message : String(e))}`;
      requeue(this.jobs, this.now(), id, reason);
      return { kind: "queued", jobId: id, reason };
    }
    if (result.kind === "started") return this.started(r, emit);
    if (result.kind === "held") {
      const before = r.execution.state === "queued" ? r.execution.reason : "";
      const next = requeue(this.jobs, this.now(), id, result.reason);
      if (before !== result.reason) emit(`review-queued:${id}`, line("REVIEW_QUEUED", next, `head=${short(s.headSha)} held: ${oneLine(result.reason)}`));
      return { kind: "queued", jobId: id, reason: result.reason };
    }
    const failed = fail(this.jobs, this.now(), id, "input_unavailable", `launch refused: ${result.detail}`);
    emit(`review-failed:${id}`, line("REVIEW_FAILED", failed, `code=input_unavailable: launch refused: ${oneLine(result.detail)}`));
    await this.release(failed);
    return this.escalation(this.jobs.byKey(r.key), emit) ?? { kind: "failed", jobId: id, code: "input_unavailable", detail: result.detail };
  }

  private started(r: ReviewJobRecord, emit: ReviewEmit): EnsureResult {
    const next = markRunning(this.jobs, this.now(), r.job.jobId, r.job.reviewerLaneKey);
    const s = next.job.snapshot;
    emit(`review-started:${next.job.jobId}`, line("REVIEW_STARTED", next, `reviewer=${next.job.reviewerLaneKey} head=${short(s.headSha)} base=${s.baseRef}@${short(s.baseSha)} ${prUrl(s.repo, s.prNumber)}`));
    return { kind: "started", jobId: next.job.jobId };
  }

  private emitStale(records: readonly ReviewJobRecord[], emit: ReviewEmit): void {
    for (const r of records) {
      const reason = r.execution.state === "stale" ? r.execution.reason : "stale";
      emit(`review-stale:${r.job.jobId}`, line("REVIEW_STALE", r, `head=${short(r.job.snapshot.headSha)} ${reason}`));
    }
  }

  /**
   * One gate pass per supervisor poll: announces jobs recovery failed, times out queued and running jobs (D8), marks
   * jobs whose reviewer lane is gone `runner_lost`, takes in claimed review lanes (D7), closes reviewer lanes whose job
   * is no longer running and releases snapshots of finished jobs. Errors per job are logged, never thrown.
   */
  async tick(emit: ReviewEmit): Promise<void> {
    await this.ready;
    for (const r of this.recovered.splice(0)) this.failed(r, emit);
    for (const r of this.jobs.list({ states: ["queued", "running"] })) {
      try { await this.tickJob(r, emit); } catch (e) {
        console.error(`REVIEW_GATE_ERROR ${r.job.jobId} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const lane of (await this.deps.registry.open()).filter((l) => l.review && statusOf(l) !== "closed")) {
      const r = this.jobs.list().filter((j) => j.job.reviewerLaneKey === lane.key).at(-1);
      if (r?.execution.state === "running" || r?.execution.state === "queued") continue;
      try { await this.closeReviewer(lane, r, `review job ${r?.job.jobId ?? "unknown"} is ${r?.execution.state ?? "gone"}`, false); } catch (e) {
        console.error(`REVIEW_GATE_ERROR ${lane.key} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const r of this.jobs.list({ states: ["completed", "stale", "error", "escalated"] })) {
      if (r.snapshotPath && !r.snapshotReleased) {
        const lane = await this.deps.registry.read(r.job.reviewerLaneKey);
        if (!lane || statusOf(lane) === "closed" || this.jobs.list().filter((j) => j.job.reviewerLaneKey === lane.key).at(-1)?.job.jobId !== r.job.jobId) await this.release(r);
      }
    }
  }

  private async tickJob(r: ReviewJobRecord, emit: ReviewEmit): Promise<void> {
    const now = this.now(), e = r.execution;
    if (e.state === "queued") {
      if (now - r.job.createdAt < REVIEW_TIMEOUT_MS) return;
      const next = fail(this.jobs, now, r.job.jobId, "timeout", `queued ${REVIEW_TIMEOUT_MS / 60_000} min without a start (${e.reason})`);
      this.failed(next, emit);
      await this.release(next);
      return;
    }
    if (e.state !== "running") return;
    const lane = await this.deps.registry.read(e.reviewerLaneKey);
    const status = lane ? statusOf(lane) : "closed";
    if (lane && (status === "done-claimed" || status === "verified-done")) return this.intake(r, lane, emit);
    if (!lane || status === "closed") {
      const next = fail(this.jobs, now, r.job.jobId, "runner_lost", `reviewer lane ${e.reviewerLaneKey} ${lane ? "closed" : "is gone"} without a result`);
      this.failed(next, emit);
      await this.release(next);
      return;
    }
    if (now - e.startedAt < REVIEW_TIMEOUT_MS) return;
    const next = fail(this.jobs, now, r.job.jobId, "timeout", `running ${REVIEW_TIMEOUT_MS / 60_000} min without a result`);
    this.failed(next, emit);
    await this.closeReviewer(lane, next, `review ${r.job.jobId} timed out`, false);
  }

  /** REVIEW_FAILED for an error record, then the D8 escalation check of its key. */
  private failed(r: ReviewJobRecord, emit: ReviewEmit): void {
    if (r.execution.state !== "error") return;
    const attempt = this.jobs.byKey(r.key).filter((j) => j.job.createdAt <= r.job.createdAt).length;
    emit(`review-failed:${r.job.jobId}`, line("REVIEW_FAILED", r, `code=${r.execution.code} attempt=${attempt}: ${oneLine(r.execution.detail)}`));
    this.escalation(this.jobs.byKey(r.key), emit);
  }

  /** D7: takes a claimed review lane's result in. Always ends with the reviewer closed and the snapshot released. */
  private async intake(r: ReviewJobRecord, lane: Lane, emit: ReviewEmit): Promise<void> {
    const io = this.io, job = r.job, id = job.jobId, dir = io.outDir(lane.key);
    const author = (await this.deps.registry.read(job.authorLaneKey)) ?? undefined;
    let observed: ObservedReview;
    // Unreadable GitHub: left running; the next tick tries again and the timeout bounds it. The criteria the job was
    // started with are reused (a merge lane's job takes them from the original owner's brief, not the merge lane's).
    const criteria = io.readText(join(this.deps.config.stateDir, "review-inputs", id, "criteria.md"));
    try { observed = await this.observeSnapshot({ repo: job.snapshot.repo, number: job.snapshot.prNumber }, author, criteria); } catch (e) {
      console.error(`REVIEW_GATE_ERROR ${id} snapshot unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const refuse = async (code: ReviewErrorCode, detail: string): Promise<void> => {
      const next = fail(this.jobs, this.now(), id, code, detail);
      this.failed(next, emit);
      await this.closeReviewer(lane, next, `review ${id} rejected: ${code}`, false);
    };
    const resultText = io.readText(join(dir, REVIEW_RESULT_FILE));
    if (resultText === undefined) return refuse("input_unavailable", `${REVIEW_RESULT_FILE} missing from the lane's reports`);
    let result: ResultFile;
    try { result = JSON.parse(resultText) as ResultFile; } catch { return refuse("invalid_output", `${REVIEW_RESULT_FILE} is not JSON`); }
    if (typeof result !== "object" || result === null) return refuse("invalid_output", `${REVIEW_RESULT_FILE} is not an object`);
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const bodyName = str(result.body) || "review-body.json";
    if (basename(bodyName) !== bodyName) return refuse("invalid_output", "body must name a file in the lane's reports");
    const bodyText = io.readText(join(dir, bodyName));
    if (bodyText === undefined) return refuse("input_unavailable", `${bodyName} missing from the lane's reports`);
    const source: ReviewSource = result.source === "qa" ? "qa" : "reviewer";
    if (result.source !== "qa" && result.source !== "reviewer") return refuse("invalid_output", "source must be reviewer or qa");
    const recordPath = str(result.taskRecord);
    const recordText = recordPath ? io.readText(recordPath) : undefined;
    if (r.snapshotPath) {
      const scope = await io.checkScope({ path: r.snapshotPath, headSha: job.snapshot.headSha, since: r.snapshotStartedAt ?? job.createdAt });
      if (!scope.ok) return refuse("scope_violation", scope.detail);
    }
    const untrustedRoots = [...(author?.worktrees ?? []), ...(author?.cwd ? [author.cwd] : []), ...(r.snapshotPath ? [r.snapshotPath] : []), ...(r.repoDir ? [r.repoDir] : [])];
    const accepted = acceptReviewSubmission({
      job, observed: observed.snapshot,
      submission: {
        via: REVIEWER_CHANNEL, laneKey: lane.key, jobId: str(result.jobId), jobToken: str(result.jobToken), bodyText,
        ...(recordPath && recordText !== undefined ? { taskRecord: { path: recordPath, text: recordText } } : {}),
        reportArtifact: resolve(join(dir, REVIEW_REPORT_FILE)), startedAt: str(result.startedAt), completedAt: str(result.completedAt), source,
      },
      trustedTaskRoots: [join(io.home, ".omo", "agent", "projects")], untrustedRoots,
    });
    if (!accepted.ok) {
      if (accepted.code === "stale_snapshot") {
        this.emitStale(markStale(this.jobs, this.now(), observed.snapshot), emit);
        await this.closeReviewer(lane, this.jobs.get(id), `review ${id} is stale`, false);
        return;
      }
      return refuse(errorCode(accepted.code), `${accepted.code}: ${accepted.detail}`);
    }
    let done: ReviewJobRecord;
    try { done = complete(this.jobs, this.now(), id, accepted.receipt); } catch (e) {
      // The job went stale (or otherwise left running) while the reviewer worked: recorded nowhere as approval.
      if (!(e instanceof ReviewJobError)) throw e;
      await this.closeReviewer(lane, this.jobs.get(id), `review ${id} no longer running: ${e.code}`, true);
      return;
    }
    const receipt = accepted.receipt, url = prUrl(job.snapshot.repo, job.snapshot.prNumber);
    if (receipt.result.verdict === "pass") {
      emit(`review-passed:${id}`, line("REVIEW_PASSED", done, `reviewer=${lane.key} receipt=${receipt.receiptId} head=${short(receipt.headSha)} base=${receipt.baseRef}@${short(receipt.baseSha)} ${url}`));
    } else {
      emit(`review-findings:${id}`, line("REVIEW_FINDINGS", done, `findings=${receipt.result.findings.length} source=${receipt.source} receipt=${receipt.receiptId} head=${short(receipt.headSha)} report=${receipt.reportArtifact} ${url}`));
    }
    await this.closeReviewer(lane, done, `review ${id} ${receipt.result.verdict}`, true);
  }

  /** Closes a reviewer lane (once per job) and releases the job's snapshot. A failed close is retried by the next tick. */
  private async closeReviewer(lane: Lane, r: ReviewJobRecord | undefined, note: string, ok: boolean): Promise<void> {
    const res = await this.io.closeLane(lane, note, ok);
    if (!res.closed) console.error(`REVIEW_GATE_CLOSE_REFUSED ${lane.key}: ${oneLine(res.lines.at(-1) ?? "refused")}`);
    if (!r) return;
    if (res.closed) annotate(this.jobs, this.now(), r.job.jobId, { reviewerClosed: true });
    await this.release(this.jobs.get(r.job.jobId) ?? r);
  }

  private async release(r: ReviewJobRecord): Promise<void> {
    if (!r.snapshotPath || !r.repoDir || r.snapshotReleased) return;
    const res = await this.io.releaseSnapshot({ repoDir: r.repoDir, path: r.snapshotPath });
    if (res.ok) annotate(this.jobs, this.now(), r.job.jobId, { snapshotReleased: true });
    else console.error(`REVIEW_SNAPSHOT_RELEASE_FAILED ${r.job.jobId}: ${oneLine(res.detail)}`);
  }

  private recordsOf(repo: string, n: number): ReviewJobRecord[] {
    return this.jobs.list().filter((r) => sameRepo(r.job.snapshot.repo, repo) && r.job.snapshot.prNumber === n);
  }

  /**
   * D11: whether the done watcher must keep `lane` open, from durable state only (the job store and GitHub), so it holds
   * across a restart. For each PR its claim binds, at the claimed head:
   * - the newest non-stale job is a completed reviewer `pass`, or (T6) the claimed head has an exemption under the
   *   current exemption policy: this PR releases;
   * - else the PR is read (a failed read holds): MERGED or CLOSED releases, and so does an open PR whose head moved off
   *   the claimed one, whose base is not `ciMergeBase` (the supervisor never reviews it) or whose checks failed (the
   *   watcher's red-check objection runs; no review job starts on red);
   * - else (open at the claimed head into `ciMergeBase`, green or pending) it holds, whatever the job store says: no job
   *   yet (waiting for its first), queued, running, findings, failed (the retry or escalation still runs on the next
   *   green poll) or escalated (the lead decides). An `error` or `escalated` record therefore never holds a PR that was
   *   closed, merged, moved or turned red.
   * The lane is held while any bound PR holds.
   */
  async holdsLane(lane: Lane): Promise<boolean> {
    await this.ready;
    for (const bound of lane.claim?.pulls ?? []) {
      const records = this.recordsOf(bound.repo, bound.number).filter((r) => r.job.snapshot.headSha === bound.sha);
      const last = records.filter((r) => r.execution.state !== "stale").at(-1);
      if (last?.execution.state === "completed" && last.receipt?.result.verdict === "pass" && last.receipt.source === "reviewer") continue;
      if (this.exemptions.list().some((d) => d.kind === "exempt" && sameRepo(d.receipt.repo, bound.repo) && d.receipt.prNumber === bound.number
        && d.receipt.headSha === bound.sha && d.receipt.exemptPolicyVersion === EXEMPT_POLICY_VERSION)) continue;
      let info: PrInfo;
      try { info = await this.io.prInfo(bound.repo, bound.number); } catch { return true; }
      if (info.state !== "OPEN" || info.headSha !== bound.sha || info.baseRef !== this.deps.config.ciMergeBase || info.checks === "red") continue;
      return true;
    }
    return false;
  }

  /**
   * D10: after a merge the supervisor made, compares the merge commit's first parent with the approved base. A difference
   * is recorded on the approving job (`baseRace`) and emitted once as urgent REVIEW_BASE_RACE; nothing is reverted.
   */
  async recordBaseRace(lane: Lane, pull: ReviewPull & { readonly sha: string }, mergeSha: string, emit: ReviewEmit): Promise<BaseRaceResult> {
    await this.ready;
    const r = this.recordsOf(pull.repo, pull.number)
      .filter((j) => j.execution.state === "completed" && j.receipt?.result.verdict === "pass" && j.receipt.source === "reviewer" && j.job.snapshot.headSha === pull.sha).at(-1);
    if (!r?.receipt) return { raced: false, why: "no approved review at this head" };
    if (r.baseRace) return { raced: true, approvedBaseSha: r.baseRace.approvedBaseSha, mergedOntoSha: r.baseRace.mergedOntoSha };
    const parent = await this.io.mergeParent(pull.repo, mergeSha);
    const approved = r.receipt.baseSha;
    if (parent === approved) return { raced: false, why: "merged onto the approved base" };
    const next = annotate(this.jobs, this.now(), r.job.jobId, { baseRace: { approvedBaseSha: approved, mergedOntoSha: parent, mergeSha, at: this.now() } });
    emit(`review-base-race:${pull.repo}#${pull.number}@${pull.sha}`,
      `REVIEW_BASE_RACE ${pull.repo}#${pull.number} lane=${lane.key} job=${next.job.jobId} approved-base=${short(approved)} merged-onto=${short(parent)} merge=${mergeSha} ${pull.url ?? prUrl(pull.repo, pull.number)}`);
    return { raced: true, approvedBaseSha: approved, mergedOntoSha: parent };
  }
}
