import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  answeredLine,
  answerOutcomeLines,
  closeOwnerDecision,
  openLaneDecision,
  openOwnerDecision,
  openOwnerDecisions,
  ownerDecisionTick,
  queueDecisionAnswer,
  readDecisions,
  reconcileDecisionDeliveries,
  reconcileDecisionsAtStart,
  recordAnswerRevision,
  decisionTargetOf,
  decisionDeliveryTick,
  recordChannelAnswer,
  recordOwnerAnswer,
  type DecisionContext,
  type DecisionReceipts,
  type DecisionTransport,
} from "../src/owner-decisions.ts";
import {
  decisionChoicesProblem,
  inputRequestProblem,
  parseDecisionText,
  parseRequestText,
  serializeDecisionText,
  serializeRequestText,
  type DecisionChoices,
} from "../src/runner/decision-text.ts";
import { ackLaneMessage, JsonLaneMessages, updateLaneMessage } from "../src/lane-messages.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "owner-decisions-"));
  dirs.push(dir);
  return dir;
};

const choices: DecisionChoices = {
  question: "Which path should we take?",
  options: ["Use the existing API", "Build a replacement"],
  recommend: 1,
  reason: "It is smaller and already supported.",
  waiting: "The implementation choice",
  blocking: true,
};

const fakeTransport = () => {
  let sequence = 0;
  const calls: { method: string; args: unknown[] }[] = [];
  const archived = new Map<string, boolean>();
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  const transport: DecisionTransport = {
    send: async (channel, content, stableId) => {
      record("send", channel, content, stableId);
      sequence += 1;
      return `m${sequence}`;
    },
    edit: async (...args) => { record("edit", ...args); },
    content: async (...args) => { record("content", ...args); return ""; },
    deleteMessage: async (...args) => { record("deleteMessage", ...args); },
    // Like Discord: the "started a thread" notice for the thread the fake starts carries the thread's own id, and `after`
    // returns only messages with a greater id.
    messagesAfter: async (...args) => {
      record("messagesAfter", ...args);
      return [{ id: "999", type: 0 }, { id: "1000", type: 18, reference: "1000" }, { id: "1001", type: 0 }]
        .filter((m) => BigInt(m.id) > BigInt(args[1]));
    },
    startThread: async (channel, messageId, name, memberId, autoArchiveMin) => {
      record("startThread", channel, messageId, name, memberId, autoArchiveMin);
      return { id: messageId ?? "1000" };
    },
    // Like Discord: a rename posts a "changed the channel name" message into the thread, which reopens it, even when the
    // same PATCH archives it.
    setThread: async (threadId, patch) => {
      record("setThread", threadId, patch);
      if (patch.archived !== undefined) archived.set(threadId, patch.archived);
      if (patch.name !== undefined) archived.set(threadId, false);
    },
    threadState: async (threadId) => { record("threadState", threadId); return { archived: false, parent: "111" }; },
    threadArchived: async (threadId) => { record("threadArchived", threadId); return archived.get(threadId) ?? false; },
  };
  return { transport, calls, archived };
};

const context = (
  dir: string,
  transport: DecisionTransport,
  overrides: Partial<DecisionContext["config"]> = {},
  now = 1_800_000_000_000,
): DecisionContext => ({
  config: {
    stateDir: dir,
    discordChannels: ["999"],
    decisionsChannel: "555",
    alertsChannel: undefined,
    displayTimeZone: "UTC",
    ...overrides,
  },
  transport,
  now: () => now,
  home: "/home/test",
});

const open = (ctx: DecisionContext, extra: Partial<Parameters<typeof openOwnerDecision>[1]> = {}) =>
  openOwnerDecision(ctx, { ...choices, source: "lead", ...extra });

test("decision text serializes and parses, rejecting free text and one option", () => {
  expect(parseDecisionText(serializeDecisionText(choices))).toEqual(choices);
  expect(parseDecisionText("Which path should we take?")).toBeUndefined();
  const oneOption = serializeDecisionText({ ...choices, options: ["Only one"] });
  expect(parseDecisionText(oneOption)).toBeUndefined();
  expect(decisionChoicesProblem({ ...choices, recommend: 3 })).toBe("--recommend must be 1-2");
});

test("opens in decisionsChannel, starts a thread, records open, and links the origin", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const result = await open(context(dir, fake.transport), { origin: "discord:111/222" });
  expect(result.channel.channel).toBe("555");
  expect(result.decision.state).toBe("open");
  expect(result.link).toMatchObject({ kind: "linked", origin: "222" });
  // A thread without a starter message, its channel notice deleted, then the question as the thread's first message.
  expect(fake.calls.map((call) => call.method).filter((method) => method !== "threadState" && method !== "messagesAfter"))
    .toEqual(["startThread", "deleteMessage", "send", "send"]);
  expect(fake.calls.find((call) => call.method === "startThread")?.args.slice(0, 2)).toEqual(["555", undefined]);
  expect(fake.calls.find((call) => call.method === "deleteMessage")?.args).toEqual(["555", "1000"]);
  expect(fake.calls.filter((call) => call.method === "send").map((call) => call.args[0])).toEqual(["1000", "222"]);
  expect(String(fake.calls.find((call) => call.method === "send")?.args[1])).toContain(choices.question);
  // The origin thread gets one link line, not the question.
  const link = String(fake.calls.find((call) => call.method === "send" && call.args[0] === "222")?.args[1]);
  expect(link).toBe("[System] 오너 결정 d1: <#1000>");
  expect(result.noticeKept).toBeUndefined();
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "open", linkMessage: result.link.kind === "linked" ? result.link.message : undefined });
});

test("uses the requesting channel and reports unset decisionsChannel", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const result = await open(context(dir, fake.transport, { decisionsChannel: undefined }), { origin: "discord:111/222" });
  expect(result.channel).toEqual({ channel: "111", unset: "requesting" });
  expect(result.decision.channel).toBe("111");
});

test("drops the reservation when starting its thread fails", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  fake.transport.startThread = async () => { throw new Error("thread creation failed"); };
  await expect(open(context(dir, fake.transport))).rejects.toMatchObject({ code: "DECISION_NOT_POSTED" });
  expect(fake.calls.some((call) => call.method === "send")).toBe(false);
  expect(readDecisions(dir).decisions).toEqual([]);
});

test("archives the thread and drops the reservation when the question cannot be posted in it", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  fake.transport.send = async () => { throw new Error("send failed"); };
  await expect(open(context(dir, fake.transport))).rejects.toMatchObject({ code: "DECISION_NOT_POSTED" });
  expect(fake.calls.find((call) => call.method === "setThread")?.args).toEqual(["1000", { archived: true }]);
  expect(readDecisions(dir).decisions).toEqual([]);
});

test("a notice that cannot be deleted is reported and recorded, and the decision still opens", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  fake.transport.deleteMessage = async () => { throw new Error("missing access"); };
  const result = await open(context(dir, fake.transport));
  expect(result.decision.state).toBe("open");
  expect(result.noticeKept).toBe("missing access");
  expect(readDecisions(dir).decisions[0]?.noticeKept).toBe("missing access");
});

test("a notice that is not found is reported and recorded, and nothing is deleted", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  fake.transport.messagesAfter = async () => [{ id: "1001", type: 0 }];
  const result = await open(context(dir, fake.transport));
  expect(result.decision.state).toBe("open");
  expect(result.noticeKept).toContain("no \"started a thread\" notice for 1000");
  expect(readDecisions(dir).decisions[0]?.noticeKept).toBe(result.noticeKept);
  expect(fake.calls.some((call) => call.method === "deleteMessage")).toBe(false);
});

test("thread names stay within 40 characters, and closing keeps the name", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const question = "이 결정 스레드의 제목이 너무 길어서 오너가 헷갈려 하므로 짧게 줄여야 하는데 어떤 규칙을 쓸까요?";
  const { decision } = await open(ctx, { question, task: 904 });
  await closeOwnerDecision(ctx, decision.id, { text: "Done.", choice: 1 });
  const opened = String(fake.calls.find((call) => call.method === "startThread")?.args[2]);
  expect(opened).toStartWith("[결정] d1 · #904 · 이 결정");
  expect(Array.from(opened).length).toBeLessThanOrEqual(40);
  expect(fake.calls.filter((call) => call.method === "setThread").some((call) => "name" in (call.args[1] as object))).toBe(false);
});

test("an owner message in the channel body answers the only waiting decision there, and nothing when two wait", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const { decision } = await open(ctx);
  const answer = recordChannelAnswer(dir, "555", "body-1", 1_800_000_000_100);
  expect(answer?.first).toBe(true);
  expect(answer?.decision).toMatchObject({ id: decision.id, state: "answered", answers: [{ channel: "555", message: "body-1" }] });
  expect(recordChannelAnswer(dir, "999", "elsewhere", 1_800_000_000_150)).toBeUndefined();
  await open(ctx, { question: "A second question?" });
  expect(recordChannelAnswer(dir, "555", "body-2", 1_800_000_000_200)).toBeUndefined();
  expect(readDecisions(dir).decisions.find((d) => d.id === decision.id)?.answers).toHaveLength(1);
});

test("a repeated lane sourceRef returns its original decision without posting", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const first = await open(ctx, { source: "lane", sourceRef: "report-1", lane: "ap-42-1" });
  const postCount = fake.calls.filter((call) => call.method === "send").length;
  const second = await open(ctx, { source: "lane", sourceRef: "report-1", lane: "ap-42-1" });
  expect(second.decision.id).toBe(first.decision.id);
  expect(fake.calls.filter((call) => call.method === "send")).toHaveLength(postCount);
});

test("records the first answer event once per message id", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const { decision } = await open(context(dir, fake.transport));
  const first = recordOwnerAnswer(dir, decision.thread as string, "answer-1", 1_800_000_000_100);
  const repeated = recordOwnerAnswer(dir, decision.thread as string, "answer-1", 1_800_000_000_200);
  expect(first?.first).toBe(true);
  expect(first?.decision).toMatchObject({ state: "answered", answerEvent: `owner-decision-answered:${decision.id}` });
  expect(repeated?.first).toBe(false);
  expect(repeated?.decision.answers).toHaveLength(1);
});

test("closing an answered decision posts confirmation, archives, resolves, and rejects a second close", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const { decision } = await open(ctx);
  const answer = recordOwnerAnswer(dir, decision.thread as string, "answer-1", 1_800_000_000_100);
  const closed = await closeOwnerDecision(ctx, decision.id, { text: "Proceed with option one.", choice: 1 });
  expect(fake.calls.some((call) => call.method === "send" && call.args[0] === decision.thread)).toBe(true);
  const patches = fake.calls.filter((call) => call.method === "setThread").map((call) => call.args[1] as { name?: string; archived?: boolean });
  expect(patches).toEqual([{ archived: true }]);
  expect(fake.archived.get(decision.thread as string)).toBe(true);
  expect(closed.archivePending).toBeUndefined();
  expect(closed.decision.state).toBe("closed");
  expect(closed.resolved).toBe(answer?.decision.answerEvent);
  expect(readdirSync(join(dir, "resolved")).length).toBeGreaterThan(0);
  expect(JSON.parse(readFileSync(join(dir, "resolved", readdirSync(join(dir, "resolved"))[0] as string), "utf8"))).toMatchObject({ id: answer?.decision.answerEvent });
  await expect(closeOwnerDecision(ctx, decision.id, { text: "Again" })).rejects.toMatchObject({ code: "DECISION_ALREADY_CLOSED" });
});

test("a thread that stays open after archiving is recorded as a pending archive, and the tick archives it", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const { decision } = await open(ctx);
  const setThread = fake.transport.setThread;
  fake.transport.setThread = async (threadId, patch) => { await setThread(threadId, patch.archived ? { ...patch, archived: false } : patch); };
  const closed = await closeOwnerDecision(ctx, decision.id, { text: "Done.", choice: 1 });
  expect(closed.archivePending).toContain("still open");
  expect(readDecisions(dir).decisions[0]?.archivePending).toBe(true);
  fake.transport.setThread = setThread;
  await ownerDecisionTick({ ...ctx, enqueue: () => {}, log: () => {} });
  expect(fake.archived.get(decision.thread as string)).toBe(true);
  expect(readDecisions(dir).decisions[0]?.archivePending).toBeUndefined();
});

test("tick sends one daily digest and enqueues a posting-stuck event once", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport, {}, Date.UTC(2026, 10, 12, 9, 30));
  const opened = await open(ctx);
  const enqueue: string[] = [];
  await ownerDecisionTick({
    ...ctx,
    enqueue: (id) => { enqueue.push(id); },
  });
  const digests = fake.calls.filter((call) => call.method === "send" && call.args[0] === "555" && String(call.args[2]).startsWith("decision-digest:"));
  expect(digests).toHaveLength(1);
  expect(digests[0]?.args[1]).toContain(opened.decision.id);
  await ownerDecisionTick({ ...ctx, enqueue: (id) => { enqueue.push(id); } });
  expect(fake.calls.filter((call) => call.method === "send" && String(call.args[2]).startsWith("decision-digest:"))).toHaveLength(1);

  const stuckDir = stateDir();
  const stuckFake = fakeTransport();
  const stuckCtx = context(stuckDir, stuckFake.transport, {}, Date.UTC(2026, 10, 12, 10));
  await open(stuckCtx);
  const stored = readDecisions(stuckDir);
  // Simulate a writer that reserved its decision but stopped before posting.
  const { updateDecisions } = await import("../src/owner-decisions.ts");
  updateDecisions(stuckDir, (file) => ({
    file: { ...file, decisions: file.decisions.map((item) => ({ ...item, state: "posting" as const, openedAt: stuckCtx.now() - 11 * 60_000, thread: undefined })) },
    result: undefined,
  }));
  expect(stored.decisions).toHaveLength(1);
  const stuckEvents: string[] = [];
  await ownerDecisionTick({ ...stuckCtx, enqueue: (id, line) => { if (line.startsWith("OWNER_DECISION_STUCK")) stuckEvents.push(id); } });
  await ownerDecisionTick({ ...stuckCtx, enqueue: (id, line) => { if (line.startsWith("OWNER_DECISION_STUCK")) stuckEvents.push(id); } });
  expect(stuckEvents).toEqual(["owner-decision-stuck:d1"]);
});

test("request text round-trips, and a long-lived secret is refused unless a file path is named", () => {
  const code = { need: "Device code for gh auth login", reason: "To push the branch", waiting: "Push of the PR", blocking: true };
  expect(parseRequestText(serializeRequestText(code))).toEqual(code);
  const file = { ...code, need: "The npm API token", file: "~/.config/dori/npm-token" };
  expect(parseRequestText(serializeRequestText(file))).toEqual(file);
  expect(parseDecisionText(serializeRequestText(code))).toBeUndefined();
  expect(parseRequestText(serializeDecisionText(choices))).toBeUndefined();
  expect(inputRequestProblem({ ...code, need: "The npm API token" })).toMatch(/^a long-lived secret/);
  expect(inputRequestProblem({ ...code, need: "스토어 계정 비밀번호" })).toMatch(/^a long-lived secret/);
  expect(inputRequestProblem({ ...code, file: "relative/path" })).toMatch(/^--file must be an absolute/);
});

test("a lane request opens a [요청] thread saying what, why, where and which lane waits; its answer is relayed and it closes", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const text = serializeRequestText({ need: "2FA code for the App Store login", reason: "Upload the build", waiting: "The upload step", blocking: true });
  const opened = await openLaneDecision(ctx, { key: "ap-923-1", thread: "discord:111/222" }, { id: "row-1", text });
  expect(opened?.decision).toMatchObject({ kind: "request", options: [], task: 923, lane: "ap-923-1", state: "open" });
  const name = String(fake.calls.find((call) => call.method === "startThread")?.args[2]);
  expect(name).toStartWith("[요청] d1 · #923 · 2FA code");
  const start = String(fake.calls.find((call) => call.method === "send" && call.args[0] === "1000")?.args[1]);
  expect(start).toContain("2FA code for the App Store login");
  expect(start).toContain("Upload the build");
  expect(start).toContain("이 스레드에 답으로");
  expect(start).toContain("레인 ap-923-1");
  expect(String(fake.calls.find((call) => call.method === "send" && call.args[0] === "222")?.args[1])).toBe("[System] 오너 요청 d1: <#1000>");
  const answer = recordOwnerAnswer(dir, "1000", "code-msg", 1_800_000_000_100);
  expect(answer?.first).toBe(true);
  const line = answeredLine(answer?.decision as NonNullable<typeof answer>["decision"]);
  expect(line).toStartWith("OWNER_DECISION_ANSWERED ap-923-1 d1 blocking discord:555/1000: [request] ");
  expect(line).toContain("message 1000/code-msg");
  expect(line).toContain("lane ap-923-1");
  await expect(closeOwnerDecision(ctx, "d1", { text: "x", choice: 1 })).rejects.toMatchObject({ code: "DECISION_BAD_CHOICE" });
  const closed = await closeOwnerDecision(ctx, "d1", { text: "Relayed to the lane" });
  expect(closed.decision.state).toBe("closed");
  expect(closed.resolved).toBe("owner-decision-answered:d1");
  expect(String(fake.calls.filter((call) => call.method === "send" && call.args[0] === "1000").at(-1)?.args[1])).toStartWith("[System] d1 요청 처리.");
});

test("a request with a file tells the owner to write it there with chmod 600 and not to paste it", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const text = serializeRequestText({ need: "The npm API token", reason: "Publish", file: "~/.config/dori/npm-token", waiting: "Publish", blocking: false });
  await openLaneDecision(context(dir, fake.transport), { key: "lane-x", thread: "none" }, { id: "row-1", text });
  const start = String(fake.calls.find((call) => call.method === "send" && call.args[0] === "1000")?.args[1]);
  expect(start).toContain("chmod 600 ~/.config/dori/npm-token");
  expect(start).toContain("붙여넣지 마시고");
});

test("a lane question whose lane thread sits in decisionsChannel is asked in that thread, answered there, and closed without archiving it", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const opened = await openLaneDecision(ctx, { key: "ap-925-1", thread: "discord:555/777" }, { id: "row-1", text: serializeDecisionText(choices) });
  expect(opened?.decision).toMatchObject({ state: "open", channel: "555", thread: "777", inLaneThread: true, lane: "ap-925-1" });
  expect(opened?.link).toEqual({ kind: "none" });
  // No thread of its own, no notice to delete, no link line: the question is the only post, in the lane thread.
  expect(fake.calls.filter((call) => !["threadState", "messagesAfter"].includes(call.method)).map((call) => [call.method, call.args[0]]))
    .toEqual([["send", "777"]]);
  const start = String(fake.calls.find((call) => call.method === "send")?.args[1]);
  expect(start).toContain(choices.question);
  expect(start).not.toContain("원래 스레드");
  await ownerDecisionTick({ ...ctx, enqueue: () => undefined, log: () => undefined });
  expect(fake.calls.filter((call) => call.method === "send")).toHaveLength(1);
  const answer = recordOwnerAnswer(dir, "777", "owner-1", 1_800_000_000_100);
  expect(answer?.first).toBe(true);
  expect(answeredLine(answer?.decision as NonNullable<typeof answer>["decision"])).toStartWith("OWNER_DECISION_ANSWERED ap-925-1 d1 blocking discord:555/777: ");
  const closed = await closeOwnerDecision(ctx, "d1", { text: "Going with option 1", choice: 1 });
  expect(closed).toMatchObject({ decision: { state: "closed" }, resolved: "owner-decision-answered:d1" });
  expect(closed.archivePending).toBeUndefined();
  expect(fake.calls.some((call) => call.method === "setThread" || call.method === "startThread")).toBe(false);
  expect(String(fake.calls.filter((call) => call.method === "send").at(-1)?.args[1])).not.toContain("스레드를 닫습니다");
  // Once closed, the lane thread is a lane thread again: later owner messages there answer nothing.
  expect(recordOwnerAnswer(dir, "777", "owner-2", 1_800_000_000_200)).toBeUndefined();
});

test("a second question in the same lane thread takes the next answer, and a lane thread outside decisionsChannel still gets its own thread", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  await openLaneDecision(ctx, { key: "ap-925-1", thread: "discord:555/777" }, { id: "row-1", text: serializeDecisionText(choices) });
  recordOwnerAnswer(dir, "777", "owner-1", 1_800_000_000_100);
  await openLaneDecision(ctx, { key: "ap-925-1", thread: "discord:555/777" }, { id: "row-2", text: serializeDecisionText({ ...choices, question: "And the follow-up?" }) });
  const second = recordOwnerAnswer(dir, "777", "owner-2", 1_800_000_000_200);
  expect(second).toMatchObject({ first: true, decision: { id: "d2", state: "answered" } });
  const other = await openLaneDecision(ctx, { key: "ap-926-1", thread: "discord:111/888" }, { id: "row-3", text: serializeDecisionText(choices) });
  expect(other?.decision).toMatchObject({ channel: "555", thread: "1000" });
  expect(other?.decision.inLaneThread).toBeUndefined();
  expect(fake.calls.filter((call) => call.method === "startThread")).toHaveLength(1);
});

/** Receipts that log each call into `calls` (beside the transport's), with the unseen counts and failures a case sets. */
const fakeReceipts = (calls: { method: string; args: unknown[] }[], unseen: Record<string, string[]> = {}, failHandled = new Set<string>()) => {
  const acked = new Set<string>();
  const receipts: DecisionReceipts = {
    unseen: (channel) => { const lines = unseen[channel] ?? []; delete unseen[channel]; return { count: lines.length, lines }; },
    acked: (channel, message) => acked.has(`${channel}/${message}`),
    ack: async (channel, message) => { calls.push({ method: "ack", args: [channel, message] }); acked.add(`${channel}/${message}`); },
    handled: async (channel, message, tasks) => {
      if (failHandled.delete(`${channel}/${message}`)) throw new Error("disk full");
      calls.push({ method: "handled", args: [channel, message, tasks] });
    },
  };
  return receipts;
};

test("close acks every answer before the archive, records each handled --reply after it with --tasks, and a re-close adds nothing", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx: DecisionContext = { ...context(dir, fake.transport), receipts: fakeReceipts(fake.calls) };
  const { decision } = await open(ctx, { origin: "discord:111/222" });
  recordOwnerAnswer(dir, "1000", "41", 1_800_000_000_100);
  recordOwnerAnswer(dir, "1000", "42", 1_800_000_000_200);
  const closed = await closeOwnerDecision(ctx, decision.id, { text: "Option one.", choice: 1, from: "333/43", tasks: 2 });
  const order = fake.calls.map((call) => call.method).filter((m) => ["ack", "send", "setThread", "handled"].includes(m)).slice(2);
  expect(order).toEqual(["ack", "ack", "ack", "send", "setThread", "handled", "handled", "handled"]);
  expect(fake.calls.filter((call) => call.method === "handled").map((call) => call.args)).toEqual([["1000", "41", 2], ["1000", "42", 2], ["333", "43", 2]]);
  expect(closed.answers).toMatchObject({ tasks: 2, left: [], handledFailed: [], ackFailed: [] });
  expect(answerOutcomeLines(closed.answers as NonNullable<typeof closed.answers>)).toContain("DECISION_HANDLED 1000 41 coverage=1/2");
  expect(closed.decision).toMatchObject({ coveredAnswers: ["1000/41", "1000/42", "333/43"], closeTasks: 2, handledAnswers: ["1000/41", "1000/42", "333/43"] });
  const again = await closeOwnerDecision(ctx, decision.id, { text: "Again" }).catch((e: unknown) => e);
  expect(again).toMatchObject({ code: "DECISION_ALREADY_CLOSED", lines: [] });
  expect(fake.calls.filter((call) => call.method === "handled")).toHaveLength(3);
});

test("a handled receipt that fails is reported, and closing the closed decision again records only the missing one", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx: DecisionContext = { ...context(dir, fake.transport), receipts: fakeReceipts(fake.calls, {}, new Set(["1000/42"])) };
  const { decision } = await open(ctx);
  recordOwnerAnswer(dir, "1000", "41", 1_800_000_000_100);
  recordOwnerAnswer(dir, "1000", "42", 1_800_000_000_200);
  const closed = await closeOwnerDecision(ctx, decision.id, { text: "Done.", choice: 1 });
  expect(closed.decision.state).toBe("closed");
  expect(answerOutcomeLines(closed.answers as NonNullable<typeof closed.answers>).find((l) => l.startsWith("DECISION_HANDLED_FAILED")))
    .toBe("DECISION_HANDLED_FAILED 1000 42: disk full; run the close again, or dori handled 1000 42 --reply");
  const again = await closeOwnerDecision(ctx, decision.id, { text: "Done." }).catch((e: unknown) => e);
  expect(again).toMatchObject({ code: "DECISION_ALREADY_CLOSED", lines: ["DECISION_HANDLED 1000 42 coverage=1/1"] });
  expect(fake.calls.filter((call) => call.method === "handled").map((call) => call.args[1])).toEqual(["41", "42"]);
});

test("close refuses with DECISION_STALE when the lead has not seen an owner message in the thread, posting nothing; --force closes", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const unread = "UNREAD 1000 INBOUND discord:1000:44 and one more thing";
  const ctx: DecisionContext = { ...context(dir, fake.transport), receipts: fakeReceipts(fake.calls, { "1000": [unread] }) };
  const { decision } = await open(ctx);
  recordOwnerAnswer(dir, "1000", "41", 1_800_000_000_100);
  const sends = fake.calls.filter((call) => call.method === "send").length;
  const stale = await closeOwnerDecision(ctx, decision.id, { text: "Done.", choice: 1 }).catch((e: unknown) => e);
  expect(stale).toMatchObject({ code: "DECISION_STALE", message: "DECISION_STALE 1", lines: [unread] });
  expect(fake.calls.filter((call) => call.method === "send")).toHaveLength(sends);
  expect(fake.calls.some((call) => call.method === "ack")).toBe(false);
  expect(readDecisions(dir).decisions[0]?.state).toBe("answered");
  const forced = fakeReceipts(fake.calls, { "1000": ["UNREAD 1000 INBOUND discord:1000:45 still unseen"] });
  const closed = await closeOwnerDecision({ ...ctx, receipts: forced }, decision.id, { text: "Done.", choice: 1, force: true });
  expect(closed.decision.state).toBe("closed");
});

test("a decision in a lane's own thread covers only its first answer; the rest are acked and left to the lead", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx: DecisionContext = { ...context(dir, fake.transport), receipts: fakeReceipts(fake.calls) };
  await openLaneDecision(ctx, { key: "ap-925-1", thread: "discord:555/777" }, { id: "row-1", text: serializeDecisionText(choices) });
  recordOwnerAnswer(dir, "777", "51", 1_800_000_000_100);
  recordOwnerAnswer(dir, "777", "52", 1_800_000_000_200);
  const closed = await closeOwnerDecision(ctx, "d1", { text: "Option one.", choice: 1 });
  expect(fake.calls.filter((call) => call.method === "ack").map((call) => call.args)).toEqual([["777", "51"], ["777", "52"]]);
  expect(fake.calls.filter((call) => call.method === "handled").map((call) => call.args)).toEqual([["777", "51", 1]]);
  expect(answerOutcomeLines(closed.answers as NonNullable<typeof closed.answers>)).toContain(
    "DECISION_ANSWER_LEFT 777 52: acked, not covered by the close; cover it with dori handled 777 52 --reply|--lane KEY");
  expect(answeredLine(readDecisions(dir).decisions[0] as NonNullable<ReturnType<typeof readDecisions>["decisions"][0]>))
    .toContain("run dori decision close d1 --text \"...\" first");
});

const laneOf = (key: string, extra: { runner?: string; lastRecoveryAt?: number; openedAt?: string } = {}) =>
  ({ key, thread: "discord:111/222", runner: "mini", lastRecoveryAt: 5, openedAt: "2026-11-13T00:00:00.000Z", ...extra });

const openLane = async (ctx: DecisionContext, key: string) =>
  (await openLaneDecision(ctx, laneOf(key), { id: `row-${key}`, text: serializeDecisionText(choices) }))?.decision.id as string;

const answer = (key: string, choice: number | undefined, edit = 0, message = "m1", extra: { lastRecoveryAt?: number } = {}) => ({
  channel: "1000", message, edit, content: choice === undefined ? "" : String(choice), ...(choice !== undefined ? { choice } : {}),
  target: decisionTargetOf(laneOf(key, extra)),
});

test("a lane decision pins its target; answer revisions count from r1, drop a repeat, and refuse what is no direct answer", async () => {
  const dir = stateDir();
  const ctx = context(dir, fakeTransport().transport);
  const id = await openLane(ctx, "ap-955-1");
  expect(readDecisions(dir).decisions[0]?.target).toEqual({ lane: "ap-955-1", runner: "mini", generation: 5, openedAt: "2026-11-13T00:00:00.000Z" });
  const r1 = recordAnswerRevision(dir, id, answer("ap-955-1", 1), 10);
  expect(r1).toMatchObject({ kind: "recorded", revision: { rev: 1, choice: 1, delivery: { id: "decision-d1-r1", state: "intended" } } });
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", 1), 11).kind).toBe("duplicate");
  expect(recordAnswerRevision(dir, id, { ...answer("ap-955-1", 1, 1), content: " 1 " }, 11).kind).toBe("duplicate");
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", 3, 2), 12)).toEqual({ kind: "refused", reason: "choice must be 1-2" });
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", 2, 2, "m1", { lastRecoveryAt: 6 }), 12)).toEqual({ kind: "refused", reason: "target changed since the question was asked" });
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", undefined, 0, "m9"), 12).kind).toBe("refused");
  const lead = (await open(ctx, { lane: "ap-955-1", origin: "discord:111/222" })).decision.id;
  expect(recordAnswerRevision(dir, lead, answer("ap-955-1", 1), 12)).toEqual({ kind: "refused", reason: "not a lane decision" });
  const r2 = recordAnswerRevision(dir, id, answer("ap-955-1", 2, 2), 13);
  expect(r2).toMatchObject({ kind: "recorded", revision: { rev: 2, choice: 2 }, replaced: { rev: 1 } });
  expect(readDecisions(dir).decisions[0]?.revisions?.map((r) => r.delivery.state)).toEqual(["superseded", "intended"]);
});

test("queueing an answer writes decision-d<ID>-r<n> once, replaces a queued older one, and corrects or withdraws one the lane may have", async () => {
  const dir = stateDir();
  const store = new JsonLaneMessages(dir);
  const id = await openLane(context(dir, fakeTransport().transport), "ap-955-1");
  recordAnswerRevision(dir, id, answer("ap-955-1", 1), 10);
  const q1 = queueDecisionAnswer(dir, store, id, 20);
  expect(q1).toMatchObject({ kind: "queued", message: { id: "decision-d1-r1", lane: "ap-955-1", state: "queued" } });
  expect(q1.kind === "queued" && q1.message.text).toBe("[dori] Owner answered d1 (Which path should we take?): 1. Use the existing API. Revision r1. Confirm with: dori report ack decision-d1-r1");
  expect(queueDecisionAnswer(dir, store, id, 21).kind).toBe("none");
  recordAnswerRevision(dir, id, answer("ap-955-1", 2, 1), 30);
  const q2 = queueDecisionAnswer(dir, store, id, 31);
  expect(store.get("decision-d1-r1")?.state).toBe("superseded");
  expect(q2.kind === "queued" && q2.message.text).toStartWith("[dori] Owner answered d1 (Which path should we take?): 2. Build a replacement. Revision r2.");
  updateLaneMessage(store, store.get("decision-d1-r2")!, { state: "delivered", deliveredAt: 32 }, 32);
  recordAnswerRevision(dir, id, answer("ap-955-1", 1, 2), 40);
  const q3 = queueDecisionAnswer(dir, store, id, 41);
  expect(q3).toMatchObject({ kind: "queued", replaces: 2 });
  expect(q3.kind === "queued" && q3.message.text).toContain("1. Use the existing API. Revision r3 replaces r2; follow r3. Confirm with: dori report ack decision-d1-r3");
  expect(store.get("decision-d1-r2")?.state).toBe("delivered");
  recordAnswerRevision(dir, id, answer("ap-955-1", undefined, 3), 50);
  const q4 = queueDecisionAnswer(dir, store, id, 51);
  expect(q4.kind === "queued" && q4.message.text).toStartWith("[dori] Owner withdrew the answer to d1 (Which path should we take?). Revision r4 replaces r2:");
  expect(store.get("decision-d1-r3")?.state).toBe("superseded");
});

test("a withdrawal before anything reached the lane cancels the queued answer and sends nothing", async () => {
  const dir = stateDir();
  const store = new JsonLaneMessages(dir);
  const id = await openLane(context(dir, fakeTransport().transport), "ap-955-1");
  recordAnswerRevision(dir, id, answer("ap-955-1", 2), 10);
  queueDecisionAnswer(dir, store, id, 11);
  recordAnswerRevision(dir, id, answer("ap-955-1", undefined, 1), 12);
  expect(queueDecisionAnswer(dir, store, id, 13)).toEqual({ kind: "cancelled", reason: "withdrawn before anything reached the lane" });
  expect(store.list().map((m) => [m.id, m.state])).toEqual([["decision-d1-r1", "superseded"]]);
  expect(readDecisions(dir).decisions[0]?.revisions?.map((r) => r.delivery.state)).toEqual(["superseded", "cancelled"]);
});

test("after a restart the intents are reconciled with the queue: queued once, acked, closed, and undelivered when the lane session is gone", async () => {
  const dir = stateDir();
  const store = new JsonLaneMessages(dir);
  const ctx = context(dir, fakeTransport().transport);
  const [a, b, c, d, e] = [await openLane(ctx, "ap-1-1"), await openLane(ctx, "ap-2-1"), await openLane(ctx, "ap-3-1"), await openLane(ctx, "ap-4-1"), await openLane(ctx, "ap-5-1")];
  // A crash after the intent, before the queue write (a, b, d); c and e got their message queued.
  for (const [id, key] of [[a, "ap-1-1"], [b, "ap-2-1"], [c, "ap-3-1"], [d, "ap-4-1"], [e, "ap-5-1"]] as const) recordAnswerRevision(dir, id, answer(key, 1), 10);
  queueDecisionAnswer(dir, store, c, 11);
  queueDecisionAnswer(dir, store, e, 11);
  await closeOwnerDecision(ctx, c, { text: "Closed by the lead", choice: 1 });
  // The queue lost e's message (a damaged or switched store): it is never queued again.
  writeFileSync(join(dir, "lane-messages.json"), JSON.stringify({ messages: { "decision-d3-r1": store.get("decision-d3-r1") } }));
  const lanes = new Map([
    ["ap-1-1", decisionTargetOf(laneOf("ap-1-1"))],
    ["ap-3-1", decisionTargetOf(laneOf("ap-3-1"))],
    ["ap-4-1", decisionTargetOf(laneOf("ap-4-1", { lastRecoveryAt: 9 }))],
    ["ap-5-1", decisionTargetOf(laneOf("ap-5-1"))],
  ]);
  const first = reconcileDecisionDeliveries(dir, store, lanes, 100);
  expect(first.map((x) => [x.decision, x.action, x.reason])).toEqual([
    [a, "queued", undefined],
    [b, "undelivered", "lane ap-2-1 is closed"],
    [c, "closed", "decision closed"],
    [d, "undelivered", "lane ap-4-1 was relaunched, replaced or moved"],
    [e, "undelivered", "its lane message is missing from the queue"],
  ]);
  expect(store.list().map((m) => [m.id, m.state])).toEqual([["decision-d3-r1", "superseded"], ["decision-d1-r1", "queued"]]);
  expect(reconcileDecisionDeliveries(dir, store, lanes, 101)).toEqual([]);
  expect(store.list()).toHaveLength(2);
  ackLaneMessage(store, "ap-1-1", "decision-d1-r1", 102);
  expect(reconcileDecisionDeliveries(dir, store, lanes, 103).map((x) => [x.decision, x.action])).toEqual([[a, "acked"]]);
  expect(readDecisions(dir).decisions.map((x) => x.revisions?.[0]?.delivery.state)).toEqual(["acked", "undelivered", "superseded", "undelivered", "undelivered"]);
  const events: [string, string][] = [];
  await reconcileDecisionsAtStart(dir, store, [laneOf("ap-1-1")], 104, (id, line) => { events.push([id, line]); }, () => {});
  expect(events.map(([id]) => id)).toEqual(["decision-undelivered:d2:r1", "decision-undelivered:d4:r1", "decision-undelivered:d5:r1"]);
  expect(events[0]?.[1]).toBe("DECISION_ANSWER_UNDELIVERED ap-2-1 d2 r1 decision-d2-r1: lane ap-2-1 is closed; take the answer over with dori decision close d2");
});

const tickOf = (dir: string, transport: DecisionTransport) => {
  const events: [string, string][] = [];
  return { events, deps: { ...context(dir, transport), enqueue: (id: string, line: string) => { events.push([id, line]); }, log: () => {} } };
};

const posts = (calls: { method: string; args: unknown[] }[]) => calls.filter((c) => c.method === "send" || c.method === "edit").map((c) => c.args);

test("a direct answer waits queued for its lane with the owner told so; the lane's ack closes the decision once", async () => {
  const dir = stateDir();
  const store = new JsonLaneMessages(dir);
  const fake = fakeTransport();
  const { events, deps } = tickOf(dir, fake.transport);
  const lanes = async () => [laneOf("ap-957-1")];
  const id = await openLane(deps, "ap-957-1");
  recordAnswerRevision(dir, id, answer("ap-957-1", 2), 10);
  queueDecisionAnswer(dir, store, id, 11);
  const before = posts(fake.calls).length;
  await decisionDeliveryTick(deps, store, lanes);
  await decisionDeliveryTick(deps, store, lanes);
  expect(posts(fake.calls).slice(before)).toEqual([["1000", "[System] d1: 2번으로 기록했습니다. 레인 ap-957-1에 전달하는 중입니다.", "decision-notice:d1"]]);
  expect(store.get("decision-d1-r1")?.state).toBe("queued");
  expect(readDecisions(dir).decisions[0]?.state).toBe("open");
  expect(events).toEqual([]);

  ackLaneMessage(store, "ap-957-1", "decision-d1-r1", 20);
  await decisionDeliveryTick(deps, store, lanes);
  const d = readDecisions(dir).decisions[0];
  expect(d).toMatchObject({ state: "closed", choice: 2, notice: { text: "[System] d1: 레인 ap-957-1이 2번을 받았습니다." } });
  expect(d?.revisions?.[0]?.delivery.state).toBe("acked");
  expect(posts(fake.calls).slice(before + 1, before + 3)).toEqual([
    ["1000", "m3", "[System] d1: 레인 ap-957-1이 2번을 받았습니다."],
    ["1000", "[System] d1 결정 반영: 2번(Build a replacement). 레인 ap-957-1이 2번을 받았습니다. 스레드를 닫습니다.", "decision-close:d1"],
  ]);
  expect(fake.archived.get("1000")).toBe(true);
  expect(events).toEqual([["decision-acked:d1:r1", "DECISION_ANSWER_ACKED ap-957-1 d1 r1 choice=2 decision-d1-r1: the lane confirmed it received the answer; the decision closes, nothing to do"]]);
  await decisionDeliveryTick(deps, store, lanes);
  expect(events).toHaveLength(1);
});

test("an acked answer whose close failed is closed by the next round, under the same lead event id", async () => {
  const dir = stateDir();
  const store = new JsonLaneMessages(dir);
  const fake = fakeTransport();
  let down = true;
  const transport: DecisionTransport = { ...fake.transport, send: async (channel, content, stableId) => {
    if (down && stableId?.startsWith("decision-close:")) throw new Error("discord unavailable");
    return fake.transport.send(channel, content, stableId);
  } };
  const { events, deps } = tickOf(dir, transport);
  const lanes = async () => [laneOf("ap-957-1")];
  const id = await openLane(deps, "ap-957-1");
  recordAnswerRevision(dir, id, answer("ap-957-1", 1), 10);
  queueDecisionAnswer(dir, store, id, 11);
  ackLaneMessage(store, "ap-957-1", "decision-d1-r1", 12);
  await decisionDeliveryTick(deps, store, lanes);
  expect(readDecisions(dir).decisions[0]?.state).toBe("open");
  expect(readDecisions(dir).decisions[0]?.revisions?.[0]?.delivery.state).toBe("acked");
  down = false;
  await decisionDeliveryTick(deps, store, lanes);
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "closed", choice: 1 });
  expect(events.map(([eventId]) => eventId)).toEqual(["decision-acked:d1:r1", "decision-acked:d1:r1"]);
});

test("an answer whose lane was relaunched is never delivered: the owner is told and the lead is woken once", async () => {
  const dir = stateDir();
  const store = new JsonLaneMessages(dir);
  const fake = fakeTransport();
  const { events, deps } = tickOf(dir, fake.transport);
  const id = await openLane(deps, "ap-957-1");
  recordAnswerRevision(dir, id, answer("ap-957-1", 2), 10);
  queueDecisionAnswer(dir, store, id, 11);
  const relaunched = async () => [laneOf("ap-957-1", { lastRecoveryAt: 9 })];
  await decisionDeliveryTick(deps, store, relaunched);
  await decisionDeliveryTick(deps, store, relaunched);
  expect(store.get("decision-d1-r1")?.state).toBe("superseded");
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "open", revisions: [{ delivery: { state: "undelivered" } }] });
  expect(events).toEqual([["decision-undelivered:d1:r1", "DECISION_ANSWER_UNDELIVERED ap-957-1 d1 r1 decision-d1-r1: lane ap-957-1 was relaunched, replaced or moved; take the answer over with dori decision close d1"]]);
  expect(readDecisions(dir).decisions[0]?.notice?.text).toBe("[System] d1: 레인 ap-957-1이 종료되거나 바뀌어 전달하지 못했습니다. 리드가 이어받습니다.");
});
