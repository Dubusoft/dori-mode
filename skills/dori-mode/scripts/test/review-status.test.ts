import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { LaneStatusTransport } from "../src/lane-reports.ts";
import { closeOwnerDecision, type DecisionContext, type DecisionTransport, readDecisions } from "../src/owner-decisions.ts";
import type { Lane } from "../src/registry.ts";
import { type PrInfo, ReviewGate } from "../src/review-gate.ts";
import type { ExemptDecision } from "../src/review-exempt.ts";
import { type ReviewExecution, type ReviewJobRecord, ReviewJobs } from "../src/review-jobs.ts";
import type { ReviewReceipt } from "../src/review-receipt.ts";
import { reviewStatusLines, type ReviewStatusInput, reviewStatusTick, ReviewStatusStore, type ReviewStores } from "../src/review-status.ts";
import { ReviewExemptions } from "../src/review-exempt.ts";
import { openLaneReports } from "../src/lane-reports.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H = sha("a");

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

type RecordSpec = {
  readonly id: string; readonly execution: ReviewExecution; readonly pr?: number; readonly head?: string; readonly round?: number;
  readonly verdict?: "pass" | "findings"; readonly at?: number; readonly author?: string; readonly response?: string;
  readonly patch?: Partial<ReviewJobRecord>;
};

/** A stored job record shaped like the gate writes it (only the fields the status and the gate read are filled in). */
const record = (s: RecordSpec): ReviewJobRecord => {
  const head = s.head ?? H, n = s.pr ?? 7, at = s.at ?? T0;
  const snapshot = { repo: REPO, prNumber: n, headSha: head, baseRef: "dev", baseSha: sha("b"), mergeBaseSha: sha("c"), policyVersion: "t4-1", criteriaSha256: "x" };
  const receipt = s.verdict ? ({
    receiptId: `rr-${s.id}`, jobId: s.id, repo: REPO, prNumber: n, headSha: head, baseRef: "dev", baseSha: sha("b"), round: s.round ?? 1, source: "reviewer",
    reportArtifact: `/state/research/review-${s.id}/review-report.md`,
    result: s.verdict === "pass" ? { verdict: "pass", findings: [] } : {
      verdict: "findings",
      findings: [{ id: "F1", severity: "high", criterionId: "C1", path: "src/x.ts", lineStart: 3, lineEnd: 4, observation: "the edge case is unguarded", consequence: "c", evidence: ["e"], requestedChange: "r" }],
    },
  } as unknown as ReviewReceipt) : undefined;
  return {
    job: {
      jobId: s.id, snapshot, authorLaneKey: s.author ?? "author", reviewerLaneKey: `review-app-${n}-${head.slice(0, 7)}`, round: s.round ?? 1,
      diffSha256: "d", authorModel: { id: "m" }, tokenHash: "t", createdAt: at, ...(s.response ? { responseSha256: s.response } : {}),
    },
    key: `${REPO}#${n}@${head}`, execution: s.execution, attempts: 1, updatedAt: at, ...(receipt ? { receipt } : {}), ...s.patch,
  };
};

const lane = (patch: Partial<Lane> = {}): Lane => ({
  key: "author", title: "author", thread: "discord:111/222", brief: "/b.md", done: "x", openedAt: new Date(T0).toISOString(), status: "done-claimed",
  claim: { at: new Date(T0).toISOString(), evidence: "e", pulls: [{ repo: REPO, number: 7, sha: H }] }, ...patch,
});

const input = (records: ReviewJobRecord[], patch: Partial<ReviewStatusInput> = {}): ReviewStatusInput => ({
  records, exemptions: [], merges: [], reviewers: new Map(), defaultModel: "default-model", now: T0 + 5 * 60_000, timeZone: "UTC", ...patch,
});

describe("review status lines (design 5.8)", () => {
  test("each state names its label and the ids that trace it", () => {
    const one = (records: ReviewJobRecord[], patch: Partial<ReviewStatusInput> = {}, l = lane()): string => reviewStatusLines(l, input(records, patch)).join("\n");
    expect(one([])).toBe(`리뷰 ${REPO}#7: 리뷰 대기 - head aaaaaaa, 아직 시작 전 (CI 통과와 머지 조건 확인 후 시작)`);
    expect(one([record({ id: "j1", execution: { state: "queued", reason: "HOLD review reserve" } })]))
      .toBe(`리뷰 ${REPO}#7: 리뷰 대기 - head aaaaaaa, 라운드 1, 사유 HOLD review reserve, 대기 5분 (job j1)`);
    const reviewer: Lane = { ...lane({ key: "review-app-7-aaaaaaa", review: true, model: "gpt-x", machine: "mac" }) };
    expect(one([record({ id: "j1", execution: { state: "running", startedAt: T0, reviewerLaneKey: reviewer.key } })], { reviewers: new Map([[reviewer.key, reviewer]]) }))
      .toBe(`리뷰 ${REPO}#7: 리뷰 중 - head aaaaaaa, 라운드 1, 리뷰 레인 review-app-7-aaaaaaa (모델 gpt-x, 머신 mac), 시작 11-14 12:00 UTC (job j1)`);
    expect(one([record({ id: "j2", round: 2, response: "r", execution: { state: "running", startedAt: T0, reviewerLaneKey: "review-x" } })]))
      .toContain("재리뷰 중 - head aaaaaaa, 라운드 2, 리뷰 레인 review-x (모델 default-model, 머신 local)");
    const findings = one([record({ id: "j1", verdict: "findings", execution: { state: "completed", receiptId: "rr-j1" }, patch: { authorNotified: { at: T0, laneKey: "author" } } })]);
    expect(findings).toContain("수정 중 - head aaaaaaa, 지적 1건 (F1 src/x.ts:3 the edge case is unguarded), 작성 레인 전달 11-14 12:00 UTC, 남은 자동 라운드 1, receipt rr-j1");
    expect(one([record({ id: "j1", verdict: "pass", execution: { state: "completed", receiptId: "rr-j1" } })]))
      .toBe(`리뷰 ${REPO}#7: 리뷰 통과 - head aaaaaaa, base dev@bbbbbbb, receipt rr-j1 (리뷰 레인 review-app-7-aaaaaaa); CI와 머지 조건 확인 후 머지`);
    const exempt = { kind: "exempt", key: "k", receipt: { kind: "exempt", receiptId: "rx_1", repo: REPO, prNumber: 7, headSha: H, exemptPolicyVersion: "t6-1", ruleIds: ["docs-md"], files: ["README.md"] } } as unknown as ExemptDecision;
    expect(one([], { exemptions: [exempt] })).toBe(`리뷰 ${REPO}#7: 비코드 면제 - head aaaaaaa, 규칙 docs-md, 정책 t6-1, 파일 1개 (rx_1)`);
    const cap = { reason: "2 review rounds ended with findings (limit 2)", at: T0 };
    const capped = [record({ id: "j1", verdict: "findings", execution: { state: "stale", reason: "s" } }), record({ id: "j2", verdict: "findings", at: T0 + 1, execution: { state: "completed", receiptId: "rr-j2" }, patch: { capReached: cap } })];
    expect(one(capped)).toContain("결정 필요 - head aaaaaaa, 자동 한도 도달: 2 review rounds ended with findings (limit 2); 리뷰 2회, 지적 2회; 오너 결정 요청 준비 중");
    capped[1] = { ...capped[1]!, capReached: { ...cap, decisionId: "d4" } };
    expect(one(capped)).toContain("오너 결정 d4 대기 (수정 계속 / 기각 후 재검토 / 보류)");
    capped[1] = { ...capped[1]!, capReached: { ...cap, decisionId: "d4", ownerDecision: { decisionId: "d4", outcome: "hold", at: T0 } } };
    expect(one(capped)).toContain("보류 - head aaaaaaa, 오너 결정 d4로 자동 리뷰를 멈춤");
    capped[1] = { ...capped[1]!, capReached: { ...cap, decisionId: "d4", ownerDecision: { decisionId: "d4", outcome: "rereview", at: T0 + 3 } } };
    expect(one(capped)).toContain("재리뷰 대기 - head aaaaaaa, 오너 결정 d4로 지적 1건 기각, 새 리뷰어 대기 (job j2)");
    capped[1] = { ...capped[1]!, capReached: { ...cap, decisionId: "d4", ownerDecision: { decisionId: "d4", outcome: "continue", at: T0 + 3 } } };
    expect(one(capped)).toContain("수정 중 - head aaaaaaa, 지적 1건");
    expect(one(capped)).toContain("남은 자동 라운드 2");
    expect(one([record({ id: "j1", verdict: "pass", execution: { state: "completed", receiptId: "rr-j1" } })], { merges: [{ lane: "author", repo: REPO, prNumber: 7, headSha: H, mergeSha: sha("m"), at: T0 }] }))
      .toBe(`리뷰 ${REPO}#7: 머지 완료 - merge mmmmmmm, 최종 head aaaaaaa, 리뷰 receipt rr-j1`);
    expect(one([record({ id: "j1", execution: { state: "escalated", reason: "model unavailable: x" } })])).toContain("결정 필요 - head aaaaaaa, 리뷰 실행 장애: model unavailable: x; 리드가 확인 중 (job j1)");
  });

  test("a lane with no claim and no jobs has no review lines; another lane's jobs are not shown", () => {
    expect(reviewStatusLines(lane({ claim: undefined }), input([record({ id: "j1", author: "other", execution: { state: "queued", reason: "q" } })]))).toEqual([]);
  });
});

/** Supervisor-side pieces over a real state dir: registry, job store, decisions and lane reports, with fake transports. */
const world = async () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, state.dir, { displayTimeZone: "UTC" });
  await deps.registry.write(lane());
  const jobs = new ReviewJobs(state.dir);
  const statusCalls: { op: string; text?: string; silent?: boolean }[] = [];
  const fail = { status: false, decision: false };
  let n = 0;
  const status: LaneStatusTransport = {
    post: async (_channel, text, _id, silent) => { if (fail.status) throw new Error("discord down"); statusCalls.push({ op: "post", text, silent: silent ?? false }); return `s${++n}`; },
    edit: async (_channel, _id, text) => { if (fail.status) throw new Error("discord down"); statusCalls.push({ op: "edit", text }); },
    remove: async () => {},
    threadState: async () => ({ archived: false, parent: "111" }),
    laterMessages: async () => ({ messages: [], more: false }),
  };
  let m = 0;
  const decisionTransport: DecisionTransport = {
    send: async () => { if (fail.decision) throw new Error("decisions channel down"); return `m${++m}`; },
    edit: async () => {}, content: async () => "", deleteMessage: async () => {}, messagesAfter: async () => [],
    startThread: async () => { if (fail.decision) throw new Error("decisions channel down"); return { id: `900${++m}` }; },
    setThread: async () => {}, threadState: async () => ({ archived: false, parent: "555" }), threadArchived: async () => true,
  };
  const decisions: DecisionContext = {
    config: { stateDir: state.dir, discordChannels: ["999"], decisionsChannel: "555", alertsChannel: undefined, displayTimeZone: "UTC" },
    transport: decisionTransport, now: () => clock.now(), home: "/home/test",
  };
  const stores: ReviewStores = { jobs, exemptions: new ReviewExemptions(state.dir), merges: new ReviewStatusStore(state.dir) };
  const events: [string, string][] = [];
  const tick = () => reviewStatusTick({
    flow: deps, stores, reports: openLaneReports(deps.config), transport: status, decisions, home: "/home/test", emit: (id, line) => { events.push([id, line]); },
  });
  const put = (...records: ReviewJobRecord[]): void => { jobs.transact((_r, putOne) => { for (const r of records) putOne(r); }); };
  return { dir: state.dir, deps, clock, jobs, stores, statusCalls, fail, decisions, events, tick, put };
};

const cappedPair = (): ReviewJobRecord[] => [
  record({ id: "j1", verdict: "findings", execution: { state: "stale", reason: "s" }, patch: { authorNotified: { at: T0, laneKey: "author" } } }),
  record({ id: "j2", round: 2, verdict: "findings", at: T0 + 1, execution: { state: "completed", receiptId: "rr-j2" }, patch: { capReached: { reason: "2 review rounds ended with findings (limit 2)", at: T0 + 2 } } }),
];

describe("review status tick", () => {
  test("a reached limit opens exactly one owner decision across passes, recorded on the job; the status is written silently once", async () => {
    const w = await world();
    w.put(...cappedPair());
    await w.tick();
    await w.tick();
    const all = readDecisions(w.dir).decisions;
    expect(all).toHaveLength(1);
    const d = all[0]!;
    expect(d).toMatchObject({ lane: "author", source: "lead", sourceRef: `review-cap:j2:${T0 + 2}`, reviewCap: { jobId: "j2", repo: REPO, prNumber: 7 }, origin: "discord:111/222" });
    expect(d.options).toHaveLength(3);
    expect(w.jobs.get("j2")?.capReached?.decisionId).toBe(d.id);
    expect(w.events.filter(([id]) => id.startsWith("owner-decision-opened:"))).toEqual([[`owner-decision-opened:${d.id}`, expect.stringContaining("OWNER_DECISION_OPENED")]]);
    expect(w.statusCalls).toHaveLength(1);
    expect(w.statusCalls[0]).toMatchObject({ op: "post", silent: true });
    expect(w.statusCalls[0]!.text).toContain(`리뷰 ${REPO}#7: 결정 필요`);
    expect(w.statusCalls[0]!.text).toContain(`오너 결정 ${d.id} 대기`);
    expect(w.statusCalls[0]!.text).toStartWith("[System] 레인 author 상태, 진행");
  });

  test("a decision that cannot be opened is raised once and opened by a later pass", async () => {
    const w = await world();
    w.put(...cappedPair());
    w.fail.decision = true;
    await w.tick();
    await w.tick();
    expect(readDecisions(w.dir).decisions).toHaveLength(0);
    expect(w.jobs.get("j2")?.capReached?.decisionId).toBeUndefined();
    expect(new Set(w.events.filter(([id]) => id.startsWith("review-decision-failed:")).map(([id]) => id))).toEqual(new Set(["review-decision-failed:j2"]));
    w.fail.decision = false;
    await w.tick();
    const opened = readDecisions(w.dir).decisions;
    expect(opened).toHaveLength(1);
    expect(w.jobs.get("j2")?.capReached?.decisionId).toBe(opened[0]!.id);
  });

  test("a failed status write changes neither the job store nor the merge gate, and the next pass writes it", async () => {
    const w = await world();
    w.put(record({ id: "j1", verdict: "findings", execution: { state: "completed", receiptId: "rr-j1" }, patch: { authorNotified: { at: T0, laneKey: "author" } } }));
    const pr: PrInfo = { state: "OPEN", baseRef: "dev", headSha: H, title: "t", body: "", checks: "green" };
    const gate = new ReviewGate(w.deps, { prInfo: async () => pr });
    const author = (await w.deps.registry.read("author"))!;
    const before = readFileSync(w.jobs.path, "utf8");
    expect(await gate.holdsLane(author)).toBe(true);
    w.fail.status = true;
    await w.tick();
    expect(readFileSync(w.jobs.path, "utf8")).toBe(before);
    expect(await gate.holdsLane(author)).toBe(true);
    expect(new ReviewStatusStore(w.dir).shown("author")).toBeUndefined();
    expect(w.statusCalls).toHaveLength(0);
    w.fail.status = false;
    await w.tick();
    expect(w.statusCalls).toHaveLength(1);
    expect(w.statusCalls[0]!.text).toContain("수정 중");
    expect(readFileSync(w.jobs.path, "utf8")).toBe(before);
    await w.tick();
    expect(w.statusCalls).toHaveLength(1);
  });

  test("closing the decision records each choice as its own outcome; a close without a choice is refused", async () => {
    const outcomes: string[] = [];
    for (const choice of [1, 2, 3]) {
      const w = await world();
      w.put(...cappedPair());
      await w.tick();
      const id = readDecisions(w.dir).decisions[0]!.id;
      await expect(closeOwnerDecision(w.decisions, id, { text: "ok" })).rejects.toMatchObject({ code: "DECISION_BAD_CHOICE" });
      expect(w.jobs.get("j2")?.capReached?.ownerDecision).toBeUndefined();
      const closed = await closeOwnerDecision(w.decisions, id, { text: "ok", choice });
      expect(closed.review).toEqual({ jobId: "j2", outcome: w.jobs.get("j2")!.capReached!.ownerDecision!.outcome });
      expect(w.jobs.get("j2")?.capReached?.ownerDecision?.decisionId).toBe(id);
      outcomes.push(w.jobs.get("j2")!.capReached!.ownerDecision!.outcome);
    }
    expect(outcomes).toEqual(["continue", "rereview", "hold"]);
  });
});
