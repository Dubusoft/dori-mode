import { afterEach, expect, test } from "bun:test";

import { routeDecisionClick, type DirectRouting } from "../src/decision-inbound.ts";
import { readDecisions, type TargetLane } from "../src/decision-store.ts";
import { SqliteLaneMessages } from "../src/lane-messages.ts";
import { decisionButtonRows, decideInteraction } from "../src/messenger/decision-buttons.ts";
import { DiscordCommands } from "../src/messenger/discord-commands.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { closeOwnerDecision, type DecisionContext, type DecisionTransport, openLaneDecision, openOwnerDecision } from "../src/owner-decisions.ts";
import { serializeDecisionText, serializeRequestText } from "../src/runner/decision-text.ts";
import { storePath, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const choices = { question: "Which path?", options: ["Keep", "Replace", "Drop"], recommend: 2, reason: "smaller", waiting: "the choice", blocking: true };

test("answer buttons: one row up to 5 options, two rows for 6-9, the recommended one primary, labels cut to 80; none for a request or a lead decision", () => {
  const lane = { id: "d7", source: "lane" as const, options: choices.options, recommend: 2 };
  expect(decisionButtonRows(lane)).toEqual([{ type: 1, components: [
    { type: 2, style: 2, label: "1. Keep", custom_id: "dori:decide:d7:1" },
    { type: 2, style: 1, label: "2. Replace", custom_id: "dori:decide:d7:2" },
    { type: 2, style: 2, label: "3. Drop", custom_id: "dori:decide:d7:3" },
  ] }]);
  const nine = decisionButtonRows({ ...lane, options: ["a", "b", "c", "d", "e", "f", "g", "h", "x".repeat(200)], recommend: 9 }) as { components: { label: string; style: number; custom_id: string }[] }[];
  expect(nine.map((row) => row.components.map((b) => b.custom_id.split(":").at(-1)))).toEqual([["1", "2", "3", "4", "5"], ["6", "7", "8", "9"]]);
  expect(Array.from(nine[1]!.components[3]!.label)).toHaveLength(80);
  expect(nine[1]!.components[3]!.style).toBe(1);
  expect(decisionButtonRows({ ...lane, kind: "request" })).toBeUndefined();
  expect(decisionButtonRows({ ...lane, source: "lead" })).toBeUndefined();
});

test("a decide click parses only dori:decide:d<ID>:<1-9> from a guild member", () => {
  const value = (customId: string) => ({
    type: 3, id: "1", token: "t", application_id: "100", guild_id: "200", channel_id: "700", data: { component_type: 2, custom_id: customId }, member: { user: { id: "300" } },
  });
  expect(decideInteraction(value("dori:decide:d12:3"))).toMatchObject({ decision: "d12", choice: 3, channel: "700", userId: "300" });
  for (const bad of ["dori:decide:d12:0", "dori:decide:d12:10", "dori:decide:12:1", "dori:hook:decide:d12"]) expect(decideInteraction(value(bad))).toBeUndefined();
  expect(decideInteraction({ ...value("dori:decide:d12:3"), member: undefined })).toBeUndefined();
});

const config = { applicationId: "100", guildId: "200", ownerId: "300" };

/** Lane decisions opened as the supervisor opens them, and the real dispatcher routing clicks into the real stores. */
const world = () => {
  const state = withState();
  cleanups.push(state.done);
  let threads = 0;
  let posts = 0;
  const sent: { channel: string; content: string; components?: readonly unknown[] }[] = [];
  const transport: DecisionTransport = {
    send: async (channel, content, _stableId, components) => { sent.push({ channel, content, ...(components ? { components } : {}) }); return `q${++posts}`; },
    edit: async () => {}, content: async () => "", deleteMessage: async () => {}, messagesAfter: async () => [],
    startThread: async () => ({ id: `t${++threads}` }), setThread: async () => {},
    threadState: async () => ({ archived: false, parent: "555" }), threadArchived: async () => false,
  };
  const ctx: DecisionContext = { config: { stateDir: state.dir, discordChannels: ["100"], decisionsChannel: "555", alertsChannel: undefined, displayTimeZone: "UTC" }, transport, now: () => 1_000, home: "/home/test" };
  let lanes: TargetLane[] = [];
  const laneOf = (key: string, lastRecoveryAt = 5): TargetLane & { thread: string } =>
    ({ key, thread: "discord:100/222", runner: "mini", lastRecoveryAt, openedAt: "2026-11-13T00:00:00.000Z" });
  const ask = async (key: string, text = serializeDecisionText(choices)) => {
    if (!lanes.some((l) => l.key === key)) lanes.push(laneOf(key));
    const opened = await openLaneDecision(ctx, laneOf(key), { id: `row-${key}-${threads}`, text });
    if (!opened) throw new Error("not a decision text");
    return opened.decision;
  };
  const store = new SqliteLaneMessages(storePath(state.dir));
  const emitted: string[] = [];
  const routing: DirectRouting = { stateDir: state.dir, store: () => store, lanes: async () => lanes, now: () => 2_000, emit: async (_id, line) => { emitted.push(line); }, log: () => {} };
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => { requests.push(req); return { status: 204, headers: {}, body: "" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => "", undefined, [], undefined, undefined, { decide: (click) => routeDecisionClick(routing, click) });
  const click = async (decision: string, choice: number, channel: string, interaction: string, userId = "300") => {
    const before = requests.length;
    await commands.handle({
      type: 3, id: interaction, token: "secret", application_id: "100", guild_id: "200", channel_id: channel,
      data: { component_type: 2, custom_id: `dori:decide:${decision}:${choice}` }, member: { user: { id: userId } }, message: { id: "q1", components: [] },
    });
    expect(requests).toHaveLength(before + 1);
    const body = JSON.parse(String(requests.at(-1)?.body)) as { type: number; data: { flags: number; content: string } };
    expect(requests.at(-1)?.url).toBe(`https://discord.com/api/v10/interactions/${interaction}/secret/callback`);
    expect(body).toMatchObject({ type: 4, data: { flags: 64 } });
    return body.data.content;
  };
  const revisions = (id: string) => readDecisions(state.dir).decisions.find((d) => d.id === id)?.revisions?.map((r) => `r${r.rev}:${r.choice}:${r.message}`) ?? [];
  const queue = () => store.list().map((m) => `${m.id}:${m.state}`);
  return { ctx, sent, ask, click, revisions, queue, store, emitted, relaunch: (key: string) => { lanes = lanes.map((l) => (l.key === key ? laneOf(key, 9) : l)); } };
};

test("a lane question's starter message carries its buttons and says so; a request's carries none", async () => {
  const w = world();
  await w.ask("ap-1-1");
  await w.ask("ap-2-1", serializeRequestText({ need: "the 2FA code", reason: "login", waiting: "deploy", blocking: true }));
  const [question, request] = w.sent;
  expect(question?.components).toEqual(decisionButtonRows({ id: "d1", source: "lane", options: choices.options, recommend: 2 }));
  expect(question?.content.split("\n").at(-1)).toBe("버튼을 누르거나, 이 스레드에 번호나 문장으로 답해 주세요.");
  expect(request?.components).toBeUndefined();
});

test("the owner's click in the decision's thread answers like d<ID>=<N>: one revision, one queued lane message, a digest line; a redelivered click adds nothing", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  expect(await w.click(d.id, 2, d.thread!, "900")).toBe("d1에 2번으로 답했습니다. 레인에 전달합니다.");
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900"]);
  expect(w.queue()).toEqual(["decision-d1-r1:queued"]);
  expect(w.store.get("decision-d1-r1")?.text).toBe("[dori] Owner answered d1 (Which path?): 2. Replace. Revision r1. Confirm with: ~/.dori/runner/bin/dori report ack decision-d1-r1");
  expect(w.emitted.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["DECISION_ANSWER_DIRECT ap-1-1"]);
  await w.click(d.id, 2, d.thread!, "900");
  expect(await w.click(d.id, 2, d.thread!, "901")).toBe("d1에 이미 2번으로 답했습니다.");
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900"]);
  expect(w.queue()).toEqual(["decision-d1-r1:queued"]);
  // Another button before the lane acks is a new revision of the same answer.
  await w.click(d.id, 3, d.thread!, "902");
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900", "r2:3:click:902"]);
  expect(w.queue()).toEqual(["decision-d1-r1:superseded", "decision-d1-r2:queued"]);
});

test("a non-owner, a click from another channel, a closed decision and one the lane cannot take get an ephemeral reply and record nothing", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  expect(await w.click(d.id, 1, d.thread!, "910", "999")).toBe("이 버튼은 오너만 누를 수 있습니다.");
  expect(await w.click(d.id, 1, "100", "911")).toBe("이 스레드의 질문 버튼이 아닙니다.");
  expect(await w.click("d99", 1, d.thread!, "912")).toBe("이 스레드의 질문 버튼이 아닙니다.");
  const lead = await openOwnerDecision(w.ctx, { ...choices, source: "lead", lane: "ap-3-1" });
  expect(await w.click(lead.decision.id, 1, lead.decision.thread!, "913")).toBe("이 질문은 버튼으로 바로 답할 수 없습니다. 번호를 스레드에 적어 주세요.");
  w.relaunch("ap-1-1");
  expect(await w.click(d.id, 1, d.thread!, "914")).toBe("이 질문은 버튼으로 바로 답할 수 없습니다. 번호를 스레드에 적어 주세요.");
  await closeOwnerDecision(w.ctx, d.id, { text: "done", choice: 1, force: true });
  expect(await w.click(d.id, 1, d.thread!, "915")).toBe("d1은 이미 닫힌 질문입니다.");
  expect(w.revisions(d.id)).toEqual([]);
  expect(w.revisions(lead.decision.id)).toEqual([]);
  expect(w.queue()).toEqual([]);
  expect(w.emitted).toEqual([]);
});
