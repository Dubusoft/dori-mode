import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeOwnerDecision,
  openOwnerDecision,
  openOwnerDecisions,
  ownerDecisionTick,
  readDecisions,
  recordChannelAnswer,
  recordOwnerAnswer,
  type DecisionContext,
  type DecisionTransport,
} from "../src/owner-decisions.ts";
import {
  decisionChoicesProblem,
  parseDecisionText,
  serializeDecisionText,
  type DecisionChoices,
} from "../src/runner/decision-text.ts";

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
    // Discord's "started a thread" notice for the thread the fake starts, after an unrelated message.
    messagesAfter: async (...args) => {
      record("messagesAfter", ...args);
      return [{ id: "other", type: 0 }, { id: "notice", type: 18, reference: "thread" }];
    },
    startThread: async (channel, messageId, name, memberId, autoArchiveMin) => {
      record("startThread", channel, messageId, name, memberId, autoArchiveMin);
      return { id: messageId ?? "thread" };
    },
    setThread: async (...args) => { record("setThread", ...args); },
    threadState: async (threadId) => { record("threadState", threadId); return { archived: false, parent: "111" }; },
    threadArchived: async (threadId) => { record("threadArchived", threadId); return false; },
  };
  return { transport, calls };
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
  expect(fake.calls.find((call) => call.method === "deleteMessage")?.args).toEqual(["555", "notice"]);
  expect(fake.calls.filter((call) => call.method === "send").map((call) => call.args[0])).toEqual(["thread", "222"]);
  expect(String(fake.calls.find((call) => call.method === "send")?.args[1])).toContain(choices.question);
  // The origin thread gets one link line, not the question.
  const link = String(fake.calls.find((call) => call.method === "send" && call.args[0] === "222")?.args[1]);
  expect(link).toBe("[System] 오너 결정 d1: <#thread>");
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
  expect(fake.calls.find((call) => call.method === "setThread")?.args).toEqual(["thread", { archived: true }]);
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

test("thread names stay within 40 characters, open and closed", async () => {
  const dir = stateDir();
  const fake = fakeTransport();
  const ctx = context(dir, fake.transport);
  const question = "이 결정 스레드의 제목이 너무 길어서 오너가 헷갈려 하므로 짧게 줄여야 하는데 어떤 규칙을 쓸까요?";
  const { decision } = await open(ctx, { question, task: 904 });
  await closeOwnerDecision(ctx, decision.id, { text: "Done.", choice: 1 });
  const opened = String(fake.calls.find((call) => call.method === "startThread")?.args[2]);
  const closed = String((fake.calls.find((call) => call.method === "setThread")?.args[1] as { name?: string }).name);
  expect(opened).toStartWith("결정 d1 · #904 · 이 결정");
  expect(closed).toStartWith("결정됨 d1 · #904 · 이 결정");
  expect(Array.from(opened).length).toBeLessThanOrEqual(40);
  expect(Array.from(closed).length).toBeLessThanOrEqual(40);
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
  expect(fake.calls.some((call) => call.method === "setThread" && call.args[1] && (call.args[1] as { archived?: boolean }).archived === true && String((call.args[1] as { name?: string }).name).startsWith("결정됨 d1"))).toBe(true);
  expect(closed.decision.state).toBe("closed");
  expect(closed.resolved).toBe(answer?.decision.answerEvent);
  expect(readdirSync(join(dir, "resolved")).length).toBeGreaterThan(0);
  expect(JSON.parse(readFileSync(join(dir, "resolved", readdirSync(join(dir, "resolved"))[0] as string), "utf8"))).toMatchObject({ id: answer?.decision.answerEvent });
  await expect(closeOwnerDecision(ctx, decision.id, { text: "Again" })).rejects.toMatchObject({ code: "DECISION_ALREADY_CLOSED" });
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
