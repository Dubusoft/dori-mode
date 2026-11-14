import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { displayTime } from "./display-time.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaneReportStore, type LaneStatusTransport, laneStatusText, statusChannel, writeLaneStatus } from "./lane-reports.ts";
import { type DecisionContext, type DecisionSpec, openedLine, openOwnerDecision, refIds, taskOfLane } from "./owner-decisions.ts";
import { type Lane, statusOf } from "./registry.ts";
import { EXEMPT_POLICY_VERSION, type ExemptDecision, type ExemptReceipt, type ReviewExemptions } from "./review-exempt.ts";
import {
  dismissalOf, noteCapDecision, openCap, type ReviewCap, type ReviewJobRecord, type ReviewJobs, sinceOwner,
} from "./review-jobs.ts";
import { MAX_REVIEW_ROUNDS } from "./review-response.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";
import { ownerClosedRecorded } from "./thread-followup.ts";

/**
 * The owner's view of review progress (design 5.8): one line per PR in the author lane's own `[System]` status message
 * (lane-reports.ts laneStatusText), computed from the durable review state only (review-jobs.json, review-exempt.json and
 * the merges recorded here), so it is the same after a restart and a failed thread write never changes what the gate
 * decides. The supervisor's tick also opens the one owner decision a reached review limit needs.
 */

export const REVIEW_STATUS_FILE = "review-status.json";
const REVIEW_STATUS_LOCK = "review-status.lock.sqlite";
export const REVIEW_LINE_MAX = 300;
export const REVIEW_LINES_MAX = 6;

/** A merge the supervisor made of a PR an owner lane claimed. */
export type ReviewMerge = {
  readonly lane: string; readonly repo: string; readonly prNumber: number; readonly headSha: string; readonly mergeSha: string; readonly at: number;
};

type StatusFile = { readonly merges: readonly ReviewMerge[]; readonly shown: Readonly<Record<string, string>> };

/**
 * `review-status.json`: the merges the supervisor made (for the `머지 완료` line) and, per lane, the review lines last
 * written to its status message, so an unchanged state is not written again and a failed write is retried next pass.
 */
export class ReviewStatusStore {
  readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, REVIEW_STATUS_FILE);
    this.lock = join(stateDir, REVIEW_STATUS_LOCK);
  }
  private read(): StatusFile {
    if (!existsSync(this.path)) return { merges: [], shown: {} };
    const v = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StatusFile>;
    return { merges: v.merges ?? [], shown: v.shown ?? {} };
  }
  private update(act: (f: StatusFile) => StatusFile): void {
    withStateLockSync(this.lock, () => { saveJsonFile(this.path, act(this.read())); });
  }
  merges(): readonly ReviewMerge[] { return this.read().merges; }
  recordMerge(m: ReviewMerge): void {
    this.update((f) => (f.merges.some((x) => x.repo === m.repo && x.prNumber === m.prNumber && x.mergeSha === m.mergeSha) ? f : { ...f, merges: [...f.merges, m] }));
  }
  shown(lane: string): string | undefined { return this.read().shown[lane]; }
  setShown(lane: string, text: string): void { this.update((f) => ({ ...f, shown: { ...f.shown, [lane]: text } })); }
}

export type ReviewStores = { readonly jobs: ReviewJobs; readonly exemptions: ReviewExemptions; readonly merges: ReviewStatusStore };

/** What {@link reviewStatusLines} reads: every job record, exemption and merge, and the reviewer lanes by key. */
export type ReviewStatusInput = {
  readonly records: readonly ReviewJobRecord[];
  readonly exemptions: readonly ExemptDecision[];
  readonly merges: readonly ReviewMerge[];
  readonly reviewers: ReadonlyMap<string, Lane>;
  readonly defaultModel: string;
  readonly now: number;
  readonly timeZone?: string | undefined;
};

const short = (sha: string): string => sha.slice(0, 7);
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 3)}...`);
const minutes = (ms: number): string => `${Math.max(0, Math.floor(ms / 60_000))}분`;

/** The PRs a lane's review lines cover: those its claim binds, those it authored jobs for, and those merged for it. */
const prsOf = (lane: Lane, input: ReviewStatusInput): { readonly repo: string; readonly number: number; readonly sha?: string }[] => {
  const out: { repo: string; number: number; sha?: string }[] = [];
  const add = (repo: string, number: number, sha?: string): void => {
    if (!out.some((p) => sameRepo(p.repo, repo) && p.number === number)) out.push({ repo, number, ...(sha ? { sha } : {}) });
  };
  for (const p of lane.claim?.pulls ?? []) add(p.repo, p.number, p.sha);
  for (const r of input.records) if (r.job.authorLaneKey === lane.key) add(r.job.snapshot.repo, r.job.snapshot.prNumber);
  for (const m of input.merges) if (m.lane === lane.key) add(m.repo, m.prNumber);
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
};

const findingsText = (r: ReviewJobRecord): string =>
  (r.receipt?.result.findings ?? []).map((f) => `${f.id} ${f.path}:${f.lineStart} ${cut(flat(f.observation), 60)}`).join("; ");

/** The one status line of PR `repo#number` (design 5.8 table), or undefined when nothing is known about it yet. */
const prLine = (pull: { readonly repo: string; readonly number: number; readonly sha?: string }, input: ReviewStatusInput): string | undefined => {
  const stamp = (at: number): string => displayTime(at, input.timeZone, "short");
  const pr = input.records.filter((r) => sameRepo(r.job.snapshot.repo, pull.repo) && r.job.snapshot.prNumber === pull.number);
  const head = pull.sha ?? pr.at(-1)?.job.snapshot.headSha;
  const name = `리뷰 ${pull.repo}#${pull.number}`;
  const at = head ? ` head ${short(head)}` : "";
  const merged = input.merges.filter((m) => sameRepo(m.repo, pull.repo) && m.prNumber === pull.number).at(-1);
  const pass = (h: string | undefined): ReviewJobRecord | undefined =>
    pr.filter((r) => r.job.snapshot.headSha === h && r.execution.state !== "stale" && r.receipt?.result.verdict === "pass" && r.receipt.source === "reviewer").at(-1);
  const exempt = (h: string | undefined): ExemptReceipt | undefined =>
    input.exemptions.map((d) => (d.kind === "exempt" ? d.receipt : undefined))
      .filter((x): x is ExemptReceipt => !!x && sameRepo(x.repo, pull.repo) && x.prNumber === pull.number && x.headSha === h && x.exemptPolicyVersion === EXEMPT_POLICY_VERSION).at(-1);
  if (merged) {
    const ok = pass(merged.headSha), ex = exempt(merged.headSha);
    const basis = ok?.receipt ? `리뷰 receipt ${ok.receipt.receiptId}` : ex ? `비코드 면제 ${ex.receiptId}` : "근거 기록 없음";
    return `${name}: 머지 완료 - merge ${short(merged.mergeSha)}, 최종 head ${short(merged.headSha)}, ${basis}`;
  }
  const cap = openCap(pr);
  if (cap) return capLine(name, cap.capReached, pr, cap);
  const cur = pr.filter((r) => r.job.snapshot.headSha === head && r.execution.state !== "stale").at(-1);
  const ex = exempt(head);
  if (!cur && ex) return `${name}: 비코드 면제 -${at}, 규칙 ${ex.ruleIds.join(",")}, 정책 ${ex.exemptPolicyVersion}, 파일 ${ex.files.length}개 (${ex.receiptId})`;
  if (!cur) return pull.sha ? `${name}: 리뷰 대기 -${at}, 아직 시작 전 (CI 통과와 머지 조건 확인 후 시작)` : undefined;
  const job = cur.job, e = cur.execution, again = job.round > 1 || job.responseSha256 !== undefined;
  const left = Math.max(0, MAX_REVIEW_ROUNDS - sinceOwner(pr).filter((r) => r.receipt?.result.verdict === "findings").length);
  switch (e.state) {
    case "queued":
      return `${name}: ${again ? "재리뷰 대기" : "리뷰 대기"} -${at}, 라운드 ${job.round}, 사유 ${cut(flat(e.reason), 80)}, 대기 ${minutes(input.now - job.createdAt)} (job ${job.jobId})`;
    case "running": {
      const reviewer = input.reviewers.get(e.reviewerLaneKey);
      return `${name}: ${again ? "재리뷰 중" : "리뷰 중"} -${at}, 라운드 ${job.round}, 리뷰 레인 ${e.reviewerLaneKey} (모델 ${reviewer?.model || input.defaultModel}, 머신 ${reviewer?.machine ?? "local"}), 시작 ${stamp(e.startedAt)} (job ${job.jobId})`;
    }
    case "completed": {
      const receipt = cur.receipt;
      if (receipt?.result.verdict === "pass") {
        return `${name}: 리뷰 통과 -${at}, base ${receipt.baseRef}@${short(receipt.baseSha)}, receipt ${receipt.receiptId} (리뷰 레인 ${job.reviewerLaneKey}); CI와 머지 조건 확인 후 머지`;
      }
      const dismissed = dismissalOf(pr, cur);
      if (dismissed) return `${name}: 재리뷰 대기 -${at}, 오너 결정 ${dismissed}로 지적 ${receipt?.result.findings.length ?? 0}건 기각, 새 리뷰어 대기 (job ${job.jobId})`;
      const sent = cur.authorNotified ? `작성 레인 전달 ${stamp(cur.authorNotified.at)}` : "작성 레인 전달 대기";
      return `${name}: 수정 중 -${at}, 지적 ${receipt?.result.findings.length ?? 0}건 (${findingsText(cur)}), ${sent}, 남은 자동 라운드 ${left}, receipt ${receipt?.receiptId ?? "-"}, 보고서 ${receipt?.reportArtifact ?? "-"}`;
    }
    case "error":
      return `${name}: 리뷰 재시도 대기 -${at}, 실행 실패 ${e.code}: ${cut(flat(e.detail), 80)} (job ${job.jobId})`;
    case "escalated":
      return `${name}: 결정 필요 -${at}, 리뷰 실행 장애: ${cut(flat(e.reason), 100)}; 리드가 확인 중 (job ${job.jobId})`;
    case "stale":
      return undefined;
  }
};

/** The line of a PR stopped by its review limit: undecided (결정 필요) or held by the owner (보류). */
const capLine = (name: string, cap: ReviewCap, pr: readonly ReviewJobRecord[], r: ReviewJobRecord): string => {
  const at = ` head ${short(r.job.snapshot.headSha)}`;
  if (cap.ownerDecision?.outcome === "hold") return `${name}: 보류 -${at}, 오너 결정 ${cap.ownerDecision.decisionId}로 자동 리뷰를 멈춤 (${cut(flat(cap.reason), 100)})`;
  const tries = `리뷰 ${pr.length}회, 지적 ${pr.filter((x) => x.receipt?.result.verdict === "findings").length}회`;
  const ask = cap.decisionId ? `오너 결정 ${cap.decisionId} 대기 (수정 계속 / 기각 후 재검토 / 보류)` : "오너 결정 요청 준비 중";
  return `${name}: 결정 필요 -${at}, 자동 한도 도달: ${cut(flat(cap.reason), 100)}; ${tries}; ${ask}`;
};

/** The review lines of `lane`'s status message, one per PR (design 5.8), each at most REVIEW_LINE_MAX characters. */
export const reviewStatusLines = (lane: Lane, input: ReviewStatusInput): string[] =>
  prsOf(lane, input).map((p) => prLine(p, input)).filter((l): l is string => l !== undefined).slice(0, REVIEW_LINES_MAX).map((l) => cut(l, REVIEW_LINE_MAX));

/** Reads the review status input from the stores and the registry (reviewer lanes of running jobs). */
export const readReviewStatus = async (deps: FlowDeps, stores: ReviewStores): Promise<ReviewStatusInput> => {
  const records = stores.jobs.list();
  const reviewers = new Map<string, Lane>();
  for (const r of records) {
    if (r.execution.state !== "running" || reviewers.has(r.execution.reviewerLaneKey)) continue;
    const lane = await deps.registry.read(r.execution.reviewerLaneKey);
    if (lane) reviewers.set(lane.key, lane);
  }
  return {
    records, exemptions: stores.exemptions.list(), merges: stores.merges.merges(), reviewers, defaultModel: deps.config.defaultModel,
    now: deps.clock.now(), timeZone: deps.config.displayTimeZone,
  };
};

/** The review section of a lane's status message as a report updates it (lane-reports.ts routeReports). */
export const reviewSectionOf = (deps: FlowDeps, stores: ReviewStores) => async (lane: Lane): Promise<readonly string[]> =>
  (lane.review ? [] : reviewStatusLines(lane, await readReviewStatus(deps, stores)));

/** The three owner choices of a reached review limit, in REVIEW_DECISION_OUTCOMES order; none merges without a review. */
export const REVIEW_CAP_OPTIONS = [
  "수정 계속: 작성 레인이 남은 지적을 계속 고치고, 자동 리뷰 한도를 새로 시작",
  "지적 기각 후 재검토: 이 지적들을 기각하고 새 리뷰어가 현재 head를 다시 리뷰",
  "보류: 머지하지 않고 자동 리뷰를 멈춘 채 둠",
] as const;

/** The owner decision a reached review limit opens: one per cap (`sourceRef` names the capped job and the cap time). */
export const reviewCapSpec = (r: ReviewJobRecord, cap: ReviewCap, pr: readonly ReviewJobRecord[], author: Lane | undefined): DecisionSpec => {
  const s = r.job.snapshot;
  const findings = pr.filter((x) => x.receipt?.result.verdict === "findings").length;
  const last = pr.filter((x) => x.receipt).at(-1)?.receipt;
  const task = taskOfLane(r.job.authorLaneKey);
  const origin = author && author.thread !== "none" && refIds(author.thread) ? author.thread : undefined;
  return {
    question: `${s.repo}#${s.prNumber} 자동 리뷰 한도 도달 (${flat(cap.reason)}). 어떻게 할까요?`,
    options: [...REVIEW_CAP_OPTIONS],
    recommend: findings >= MAX_REVIEW_ROUNDS ? 1 : 2,
    reason: `리뷰 ${pr.length}회, 지적으로 끝난 라운드 ${findings}회${last ? `, 마지막 receipt ${last.receiptId} (${last.result.verdict})` : ""}, head ${short(s.headSha)}. 리뷰 없이 머지하는 선택지는 없습니다.`,
    waiting: `${s.repo}#${s.prNumber} 머지 (레인 ${r.job.authorLaneKey}는 열린 채 대기)`,
    blocking: true,
    source: "lead",
    sourceRef: `review-cap:${r.job.jobId}:${cap.at}`,
    lane: r.job.authorLaneKey,
    reviewCap: { jobId: r.job.jobId, repo: s.repo, prNumber: s.prNumber },
    ...(task !== undefined ? { task } : {}),
    ...(origin ? { origin } : {}),
  };
};

export type ReviewStatusTickDeps = {
  readonly flow: FlowDeps;
  readonly stores: ReviewStores;
  readonly reports: LaneReportStore;
  readonly transport: LaneStatusTransport;
  readonly decisions: DecisionContext;
  readonly home: string;
  readonly emit: (id: string, line: string) => void;
};

/**
 * One pass, run after lane reports are routed:
 * 1. every reached review limit with no owner decision yet opens exactly one (openOwnerDecision dedupes by `sourceRef`,
 *    so a crash before the decision id is recorded finds the same decision); the id is recorded on the capped job and a
 *    digest OWNER_DECISION_OPENED goes to the lead. A failed open is retried next pass and raised once as urgent
 *    REVIEW_DECISION_FAILED.
 * 2. every open author lane whose review lines changed since they were last written gets its status message rewritten
 *    with them, silently (no notification). The lines are stored only after the write succeeds, so a failed write is
 *    retried next pass; it never touches the job store or the gate. A thread the owner closed is not written to.
 * Returns one line per effect; errors are logged, never thrown.
 */
export const reviewStatusTick = async (d: ReviewStatusTickDeps): Promise<string[]> => {
  const out: string[] = [];
  const { flow, stores } = d;
  const err = (e: unknown): string => flat(e instanceof Error ? e.message : String(e)).slice(0, 200);
  for (const r of stores.jobs.list()) {
    const cap = r.capReached;
    if (!cap || cap.decisionId || cap.ownerDecision) continue;
    const s = r.job.snapshot;
    try {
      const author = await flow.registry.read(r.job.authorLaneKey);
      const pr = stores.jobs.list().filter((x) => sameRepo(x.job.snapshot.repo, s.repo) && x.job.snapshot.prNumber === s.prNumber);
      const opened = await openOwnerDecision(d.decisions, reviewCapSpec(r, cap, pr, author ?? undefined));
      noteCapDecision(stores.jobs, flow.clock.now(), r.job.jobId, opened.decision.id);
      d.emit(`owner-decision-opened:${opened.decision.id}`, openedLine(opened.decision, opened.duplicateOf));
      out.push(`REVIEW_DECISION_OPENED ${s.repo}#${s.prNumber} job=${r.job.jobId} decision=${opened.decision.id}`);
    } catch (e) {
      console.error(`REVIEW_DECISION_ERROR ${r.job.jobId} ${err(e)}; retried next pass`);
      d.emit(`review-decision-failed:${r.job.jobId}`,
        `REVIEW_DECISION_FAILED ${s.repo}#${s.prNumber} lane=${r.job.authorLaneKey} job=${r.job.jobId} the owner decision for the reached review limit could not be opened: ${err(e)}; retried every pass, the PR stays held`);
    }
  }
  let input: ReviewStatusInput | undefined;
  for (const lane of await flow.registry.open()) {
    if (lane.review || statusOf(lane) === "closed") continue;
    const channel = statusChannel(lane);
    if (!channel) continue;
    try {
      input ??= await readReviewStatus(flow, stores);
      const lines = reviewStatusLines(lane, input);
      const shown = stores.merges.shown(lane.key);
      const now = lines.join("\n");
      if (now === (shown ?? "")) continue;
      if (ownerClosedRecorded(flow.config.stateDir, lane.thread)) continue;
      const text = laneStatusText(lane, d.reports.list({ lane: lane.key }), undefined, flow.clock.now(), d.home, flow.config.displayTimeZone, lines);
      const nonce = createHash("sha256").update(text).digest("hex").slice(0, 16);
      await writeLaneStatus(flow, d.transport, channel, lane, text, `review-status:${lane.key}:${nonce}`, true);
      stores.merges.setShown(lane.key, now);
      out.push(`REVIEW_STATUS_UPDATED ${lane.key} lines=${lines.length}`);
    } catch (e) {
      console.error(`REVIEW_STATUS_FAILED ${lane.key} ${err(e)}; retried next pass`);
    }
  }
  return out;
};
