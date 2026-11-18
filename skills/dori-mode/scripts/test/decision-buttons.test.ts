import { afterEach, expect, test } from "bun:test";

import { decisionTargetOf, readDecisions, type TargetLane } from "../src/decision-store.ts";
import { reconcileDecisionDeliveries } from "../src/decision-delivery.ts";
import { routeDecisionClick, type DirectRouting } from "../src/decision-inbound.ts";
import { ackLaneMessage, SqliteLaneMessages } from "../src/lane-messages.ts";
import { decisionButtonRows, decideInteraction } from "../src/messenger/decision-buttons.ts";
import { DiscordCommands } from "../src/messenger/discord-commands.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { DEFAULT_RESOLVE_KINDS, isDecision } from "../src/decision-obligations.ts";
import { eventClass } from "../src/event-policy.ts";
import {
  answeredEventId, closeOwnerDecision, type DecisionContext, type DecisionReceipts, type DecisionTransport, openLaneDecision, openOwnerDecision, recordOwnerAnswer,
} from "../src/owner-decisions.ts";
import { serializeDecisionText, serializeRequestText } from "../src/runner/decision-text.ts";
import { storePath, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const choices = { question: "Which path?", options: ["Keep", "Replace", "Drop"], recommend: 2, reason: "smaller", waiting: "the choice", blocking: true };

type Button = { label: string; style: number; custom_id: string; disabled?: boolean };
/** Each button as the owner sees it: its label, then ` off` when disabled. */
const shown = (rows: unknown): string[] => (rows as { components: Button[] }[]).flatMap((row) => row.components.map((b) => `${b.label}${b.disabled ? " off" : ""}`));

test("answer buttons: one row up to 5 options, two rows for 6-9, the recommended one primary, labels cut to 80; none for a request", () => {
  const lane = { id: "d7", options: choices.options, recommend: 2 };
  expect(decisionButtonRows(lane)).toEqual([{ type: 1, components: [
    { type: 2, style: 2, label: "1. Keep", custom_id: "dori:decide:d7:1" },
    { type: 2, style: 1, label: "2. Replace", custom_id: "dori:decide:d7:2" },
    { type: 2, style: 2, label: "3. Drop", custom_id: "dori:decide:d7:3" },
  ] }]);
  const nine = decisionButtonRows({ ...lane, options: ["a", "b", "c", "d", "e", "f", "g", "h", "x".repeat(200)], recommend: 9 }) as { components: Button[] }[];
  expect(nine.map((row) => row.components.map((b) => b.custom_id.split(":").at(-1)))).toEqual([["1", "2", "3", "4", "5"], ["6", "7", "8", "9"]]);
  expect(Array.from(nine[1]!.components[3]!.label)).toHaveLength(80);
  expect(nine[1]!.components[3]!.style).toBe(1);
  expect(decisionButtonRows({ ...lane, kind: "request" })).toBeUndefined();
});

test("answer buttons show the newest answer green and marked, all disabled once it is acked or undelivered or the decision closes; a withdrawal shows none", () => {
  const lane = { id: "d7", options: choices.options, recommend: 2, state: "answered" as const };
  const revision = (choice: number | undefined, state: "queued" | "acked" | "undelivered") =>
    ({ rev: 1, channel: "t", message: "m", edit: 0, hash: "h", ...(choice ? { choice } : {}), target: { lane: "ap-1-1", runner: "mini", generation: 0 }, at: 1, delivery: { id: "x", state, updatedAt: 1 } });
  const queued = decisionButtonRows({ ...lane, revisions: [revision(3, "queued")] }) as { components: Button[] }[];
  expect(shown(queued)).toEqual(["1. Keep", "2. Replace", "✓ 3. Drop"]);
  expect(queued[0]!.components.map((b) => b.style)).toEqual([2, 1, 3]);
  expect(shown(decisionButtonRows({ ...lane, revisions: [revision(3, "acked")] }))).toEqual(["1. Keep off", "2. Replace off", "✓ 3. Drop off"]);
  expect(shown(decisionButtonRows({ ...lane, revisions: [revision(1, "undelivered")] }))).toEqual(["✓ 1. Keep off", "2. Replace off", "3. Drop off"]);
  expect(shown(decisionButtonRows({ ...lane, revisions: [revision(undefined, "acked")] }))).toEqual(["1. Keep", "2. Replace", "3. Drop"]);
  expect(shown(decisionButtonRows({ ...lane, state: "closed", choice: 2, revisions: [revision(3, "queued")] }))).toEqual(["1. Keep off", "✓ 2. Replace off", "3. Drop off"]);
  expect(shown(decisionButtonRows({ ...lane, state: "closed" }))).toEqual(["1. Keep off", "2. Replace off", "3. Drop off"]);
});

test("a decide click parses only dori:decide:d<ID>:<1-9> from a guild member", () => {
  const value = (customId: string) => ({
    type: 3, id: "1", token: "t", application_id: "100", guild_id: "200", channel_id: "700", data: { component_type: 2, custom_id: customId }, member: { user: { id: "300" } },
  });
  expect(decideInteraction(value("dori:decide:d12:3"))).toMatchObject({ decision: "d12", choice: 3, channel: "700", userId: "300" });
  expect(decideInteraction({ ...value("dori:decide:d12:3"), message: { id: "q1" } })?.message).toBe("q1");
  for (const bad of ["dori:decide:d12:0", "dori:decide:d12:10", "dori:decide:12:1", "dori:hook:decide:d12"]) expect(decideInteraction(value(bad))).toBeUndefined();
  expect(decideInteraction({ ...value("dori:decide:d12:3"), member: undefined })).toBeUndefined();
});

const config = { applicationId: "100", guildId: "200", ownerId: "300" };

type Sent = { readonly method: string; readonly url: string; readonly body: { type?: number; flags?: number; content?: string; components?: unknown[] }; readonly bot: boolean };

/** Lane decisions opened as the supervisor opens them, and the real dispatcher routing clicks into the real stores. */
const world = () => {
  const state = withState();
  cleanups.push(state.done);
  let threads = 0;
  let posts = 0;
  const sent: { channel: string; content: string; components?: readonly unknown[] }[] = [];
  const edited: { channel: string; message: string; shown: string[] }[] = [];
  const transport: DecisionTransport = {
    send: async (channel, content, _stableId, components) => { sent.push({ channel, content, ...(components ? { components } : {}) }); return `q${++posts}`; },
    edit: async () => {}, content: async () => "", deleteMessage: async () => {}, messagesAfter: async () => [],
    editComponents: async (channel, message, components) => { edited.push({ channel, message, shown: shown(components) }); },
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
  const ids: string[] = [];
  const routing: DirectRouting = { stateDir: state.dir, store: () => store, lanes: async () => lanes, now: () => 2_000, emit: async (id, line) => { ids.push(id); emitted.push(line); }, log: () => {} };
  const requests: HttpRequest[] = [];
  // Off: the supervisor was restarting, so Discord's answer window for the interaction has passed.
  let window = true;
  const http: Http = async (req) => { requests.push(req); return { status: !window && req.url.endsWith("/callback") ? 404 : 204, headers: {}, body: "" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => "", undefined, [], undefined, undefined, { decide: (click) => routeDecisionClick(routing, click) });
  /** The requests one click made, paths relative to the API. */
  const click = async (decision: string, choice: number, channel: string, interaction: string, userId = "300"): Promise<Sent[]> => {
    const before = requests.length;
    await commands.handle({
      type: 3, id: interaction, token: "secret", application_id: "100", guild_id: "200", channel_id: channel,
      data: { component_type: 2, custom_id: `dori:decide:${decision}:${choice}` }, member: { user: { id: userId } }, message: { id: "q1", components: [] },
    });
    return requests.slice(before).map((r) => ({
      method: r.method, url: r.url.replace("https://discord.com/api/v10", ""), body: JSON.parse(String(r.body)) as Sent["body"], bot: r.headers?.Authorization !== undefined,
    }));
  };
  /** An owner click in Discord's window: acknowledged deferred, its buttons updated, then an ephemeral reply. */
  const answer = async (decision: string, choice: number, channel: string, interaction: string): Promise<{ content: string; shown?: string[] }> => {
    const out = await click(decision, choice, channel, interaction);
    expect(out[0]).toEqual({ method: "POST", url: `/interactions/${interaction}/secret/callback`, body: { type: 6 }, bot: false });
    const reply = out.at(-1);
    expect(reply).toMatchObject({ method: "POST", url: "/webhooks/100/secret", body: { flags: 64 }, bot: false });
    const update = out.slice(1, -1);
    expect(update.map((r) => `${r.method} ${r.url}`)).toEqual(update.length ? ["PATCH /webhooks/100/secret/messages/@original"] : []);
    return { content: reply?.body.content ?? "", ...(update[0] ? { shown: shown(update[0].body.components) } : {}) };
  };
  const revisions = (id: string) => readDecisions(state.dir).decisions.find((d) => d.id === id)?.revisions?.map((r) => `r${r.rev}:${r.choice}:${r.message}`) ?? [];
  const queue = () => store.list().map((m) => `${m.id}:${m.state}`);
  const relaunch = (key: string) => { lanes = lanes.map((l) => (l.key === key ? laneOf(key, 9) : l)); };
  const reconcile = () => reconcileDecisionDeliveries(state.dir, store, new Map(lanes.map((l) => [l.key, decisionTargetOf(l)] as const)), 3_000);
  return { ctx, sent, edited, ask, click, answer, revisions, queue, store, emitted, ids, relaunch, reconcile, restarting: () => { window = false; } };
};

test("a lane question's starter message carries its buttons and says so; a request's carries none", async () => {
  const w = world();
  await w.ask("ap-1-1");
  await w.ask("ap-2-1", serializeRequestText({ need: "the 2FA code", reason: "login", waiting: "deploy", blocking: true }));
  const [question, request] = w.sent;
  expect(question?.components).toEqual(decisionButtonRows({ id: "d1", options: choices.options, recommend: 2 }));
  expect(question?.content.split("\n").at(-1)).toBe("버튼을 누르거나, 이 스레드에 번호나 문장으로 답해 주세요.");
  expect(request?.components).toBeUndefined();
});

test("the owner's click answers like d<ID>=<N> and shows the choice; another button before the ack corrects it; a redelivered click adds nothing", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  // The first answer's one visible confirmation is the thread's [System] notice: the click shows nothing of its own.
  const first = await w.click(d.id, 2, d.thread!, "900");
  expect(first.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /interactions/900/secret/callback", "PATCH /webhooks/100/secret/messages/@original"]);
  expect(first[0]?.body).toEqual({ type: 6 });
  expect(shown(first[1]?.body.components)).toEqual(["1. Keep", "✓ 2. Replace", "3. Drop"]);
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900"]);
  expect(w.queue()).toEqual(["decision-d1-r1:queued"]);
  expect(w.store.get("decision-d1-r1")?.text).toBe("[dori] Owner answered d1 (Which path?): 2. Replace. Revision r1. Confirm with: ~/.dori/runner/bin/dori report ack decision-d1-r1");
  expect(w.emitted).toEqual([`DECISION_ANSWER_DIRECT ap-1-1 d1 r1 choice=2 "Replace" decision-d1-r1 from ${d.thread}/click:900 via button: queued for the lane, nothing to do`]);
  await w.answer(d.id, 2, d.thread!, "900");
  expect((await w.answer(d.id, 2, d.thread!, "901")).content).toBe("d1에 이미 2번으로 답했습니다.");
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900"]);
  expect(w.queue()).toEqual(["decision-d1-r1:queued"]);
  expect(await w.answer(d.id, 3, d.thread!, "902")).toEqual({ content: "d1의 답을 3번으로 바꾸었습니다. 레인에 정정을 전달합니다.", shown: ["1. Keep", "2. Replace", "✓ 3. Drop"] });
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900", "r2:3:click:902"]);
  expect(w.queue()).toEqual(["decision-d1-r1:superseded", "decision-d1-r2:queued"]);
  expect(w.emitted).toHaveLength(2);
  expect(w.emitted[1]).toStartWith('DECISION_ANSWER_DIRECT ap-1-1 d1 r2 choice=3 "Drop" decision-d1-r2');
});

test("once the lane acked the answer a click changes nothing and the buttons go off; the close disables them before the archive", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  await w.click(d.id, 2, d.thread!, "900");
  ackLaneMessage(w.store, "ap-1-1", "decision-d1-r1", 2_500);
  w.reconcile();
  expect(await w.answer(d.id, 3, d.thread!, "901")).toEqual({ content: "레인이 이미 d1의 2번을 받았습니다. 다른 답은 스레드에 적어 주세요.", shown: ["1. Keep off", "✓ 2. Replace off", "3. Drop off"] });
  expect(w.revisions(d.id)).toEqual(["r1:2:click:900"]);
  await closeOwnerDecision(w.ctx, d.id, { text: "레인 ap-1-1이 2번을 받았습니다", choice: 2, force: true });
  expect(w.edited).toEqual([{ channel: d.thread!, message: d.message!, shown: ["1. Keep off", "✓ 2. Replace off", "3. Drop off"] }]);
  expect(readDecisions(w.ctx.config.stateDir).decisions[0]?.buttons).toBe("2:off");
});

test("a non-owner, a click from another channel and a closed decision get a reply and record nothing", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  const refused = await w.click(d.id, 1, d.thread!, "910", "999");
  expect(refused).toEqual([{ method: "POST", url: "/interactions/910/secret/callback", body: { type: 4, data: { flags: 64, content: "이 버튼은 오너만 누를 수 있습니다." } } as Sent["body"], bot: false }]);
  expect(await w.answer(d.id, 1, "100", "911")).toEqual({ content: "이 스레드의 질문 버튼이 아닙니다." });
  expect(await w.answer("d99", 1, d.thread!, "912")).toEqual({ content: "이 스레드의 질문 버튼이 아닙니다." });
  await closeOwnerDecision(w.ctx, d.id, { text: "done", choice: 1, force: true });
  expect(w.edited).toEqual([{ channel: d.thread!, message: d.message!, shown: ["✓ 1. Keep off", "2. Replace off", "3. Drop off"] }]);
  expect(await w.answer(d.id, 1, d.thread!, "915")).toEqual({ content: "d1은 이미 닫힌 질문입니다.", shown: ["✓ 1. Keep off", "2. Replace off", "3. Drop off"] });
  expect(w.revisions(d.id)).toEqual([]);
  expect(readDecisions(w.ctx.config.stateDir).decisions[0]?.answers).toBeUndefined();
  expect(w.queue()).toEqual([]);
  expect(w.emitted).toEqual([]);
});

test("a lead decision carries buttons; a click goes to the lead as urgent OWNER_DECISION_ANSWERED via button, another button as a correction, and close --choice settles it", async () => {
  const w = world();
  const lead = (await openOwnerDecision(w.ctx, { ...choices, source: "lead", lane: "ap-3-1" })).decision;
  expect(w.sent[0]?.components).toEqual(decisionButtonRows(lead));
  expect(w.sent[0]?.content.split("\n").at(-1)).toBe("버튼을 누르거나, 이 스레드에 번호나 문장으로 답해 주세요.");

  expect(await w.answer(lead.id, 2, lead.thread!, "930")).toEqual({
    content: "d1에 2번으로 답했습니다. 레인에 바로 전달할 수 없어 리드에게 넘겼습니다.", shown: ["1. Keep", "✓ 2. Replace", "3. Drop"],
  });
  const answered = w.emitted[0]!;
  expect(answered).toStartWith(`OWNER_DECISION_ANSWERED ap-3-1 d1 blocking discord:555/${lead.thread}: Which path? choice=2 "Replace" via button; run dori decision close d1 --choice 2 --text "..." first`);
  expect(eventClass(answered)).toBe("lead-urgent");
  expect(isDecision(answered, DEFAULT_RESOLVE_KINDS)).toBe(true);
  expect(w.ids[0]).toBe(answeredEventId("d1"));
  await w.answer(lead.id, 2, lead.thread!, "930");
  expect((await w.answer(lead.id, 2, lead.thread!, "931")).content).toBe("d1에 이미 2번으로 답했습니다.");
  expect(w.emitted).toHaveLength(1);

  expect(await w.answer(lead.id, 3, lead.thread!, "932")).toEqual({ content: "d1의 답을 3번으로 바꾸었습니다. 리드에게 정정을 넘겼습니다.", shown: ["1. Keep", "2. Replace", "✓ 3. Drop"] });
  expect(w.emitted[1]).toBe('DECISION_ANSWER_CORRECTED ap-3-1 d1 choice=3 "Drop" replaces choice=2 via button: the owner changed the answer the lead holds; settle it with dori decision close d1 --choice 3 --text "..."');
  expect(eventClass(w.emitted[1]!)).toBe("lead-urgent");
  expect(w.ids[1]).toBe("decision-button:d1:932");
  expect(w.revisions(lead.id)).toEqual([]);
  expect(w.queue()).toEqual([]);

  // The close acks and records handled only Discord messages: a click is none.
  const calls: string[] = [];
  const receipts: DecisionReceipts = {
    unseen: () => ({ count: 0, lines: [] }), acked: () => false,
    ack: async (channel, message) => { calls.push(`ack ${channel}/${message}`); },
    handled: async (channel, message) => { calls.push(`handled ${channel}/${message}`); },
  };
  const closed = await closeOwnerDecision({ ...w.ctx, receipts }, lead.id, { text: "3번으로 진행", choice: 3 });
  expect(closed.resolved).toBe(answeredEventId("d1"));
  expect(closed.decision).toMatchObject({ state: "closed", choice: 3, buttons: "3:off" });
  expect(closed.answers).toMatchObject({ acked: [], handled: [], left: [] });
  expect(calls).toEqual([]);
  expect(w.edited).toEqual([{ channel: lead.thread!, message: lead.message!, shown: ["1. Keep off", "2. Replace off", "✓ 3. Drop off"] }]);
  expect((await w.answer(lead.id, 1, lead.thread!, "933")).content).toBe("d1은 이미 닫힌 질문입니다.");
  expect(w.emitted).toHaveLength(2);
});

test("a click on a lane question the lane can no longer take, or whose answer the lead holds, goes to the lead; the lane's queue is untouched", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  w.relaunch("ap-1-1");
  expect((await w.answer(d.id, 1, d.thread!, "940")).content).toBe("d1에 1번으로 답했습니다. 레인에 바로 전달할 수 없어 리드에게 넘겼습니다.");
  expect(w.emitted).toEqual([expect.stringMatching(/^OWNER_DECISION_ANSWERED ap-1-1 d1 blocking .* choice=1 "Keep" via button; run dori decision close d1 --choice 1 /)]);
  expect(w.revisions(d.id)).toEqual([]);
  expect(w.queue()).toEqual([]);

  // Live lane, but the owner already typed an answer the lead holds: a click joins it as a correction.
  const other = await w.ask("ap-2-1");
  expect(recordOwnerAnswer(w.ctx.config.stateDir, other.thread!, "msg-1", 1_500)?.first).toBe(true);
  expect((await w.answer(other.id, 3, other.thread!, "941")).content).toBe("d2에 3번으로 답했습니다. 레인에 바로 전달할 수 없어 리드에게 넘겼습니다.");
  expect(w.emitted[1]).toStartWith('DECISION_ANSWER_CORRECTED ap-2-1 d2 choice=3 "Drop" via button:');
  expect(w.revisions(other.id)).toEqual([]);
  expect(w.queue()).toEqual([]);
});

test("a click made while the supervisor restarted is carried out: buttons updated and the reply posted in the thread; one the lane cannot take goes to the lead like any other", async () => {
  const w = world();
  const d = await w.ask("ap-1-1");
  const other = await w.ask("ap-2-1");
  w.restarting();
  const late = await w.click(d.id, 2, d.thread!, "920");
  expect(late.map((r) => `${r.method} ${r.url} ${r.bot ? "bot" : "interaction"}`)).toEqual([
    "POST /interactions/920/secret/callback interaction", `PATCH /channels/${d.thread}/messages/q1 bot`,
  ]);
  expect(shown(late[1]?.body.components)).toEqual(["1. Keep", "✓ 2. Replace", "3. Drop"]);
  expect(w.revisions(d.id)).toEqual(["r1:2:click:920"]);
  expect(w.queue()).toEqual(["decision-d1-r1:queued"]);

  w.relaunch("ap-2-1");
  const handed = await w.click(other.id, 3, other.thread!, "921");
  expect(handed.at(-1)?.body.content).toBe("[System] 재시작 중에 누른 버튼(d2 3번)입니다. d2에 3번으로 답했습니다. 레인에 바로 전달할 수 없어 리드에게 넘겼습니다.");
  expect(shown(handed[1]?.body.components)).toEqual(["1. Keep", "2. Replace", "✓ 3. Drop"]);
  expect(w.revisions(other.id)).toEqual([]);
  expect(w.emitted.at(-1)).toStartWith(`OWNER_DECISION_ANSWERED ap-2-1 d2 blocking discord:555/${other.thread}: Which path? choice=3 "Drop" via button; run dori decision close d2 --choice 3 `);
});
