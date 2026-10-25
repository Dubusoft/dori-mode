import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ackToodo, pendingAcks } from "../src/ack.ts";
import { eventClass } from "../src/event-policy.ts";
import { BUILTIN_SOURCES, EventSources } from "../src/event-sources.ts";
import type { Http } from "../src/messenger/http.ts";
import { resolveTarget } from "../src/messenger/target.ts";
import { Toodo, toodoConfigError, ToodoError } from "../src/messenger/toodo.ts";
import { supervisorToodo, toodoView } from "../src/messenger/toodo-supervisor.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState } from "./fakes.ts";
import { fakeToodoState, fileToodo } from "./fixtures/toodo-fake.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const WORKER = join(import.meta.dir, "fixtures", "toodo-kill-worker.ts");

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(1_800_000_000_000);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "idle" });
  const deps = depsFor(world, clock, state.dir);
  const toodoFile = join(state.dir, "toodo-fake.json");
  const seed = (messages: { id: number; author: string; body: string }[], events: { id: number; taskId: number; title: string; status: string }[] = []) =>
    writeFileSync(toodoFile, JSON.stringify({ messages: messages.map((m) => ({ ...m, at: 0 })), events, typing: false, calls: [] }));
  const journal = (): {
    events: { id: string; line: string }[];
    awaitingAck?: { id: string; ackedAt?: number; handledAt?: number }[];
  } => readJournal(state.dir);
  const source = (supervisor: Supervisor, toodo = fileToodo(toodoFile)) =>
    supervisorToodo({ toodo: () => toodo, enqueue: (id, line) => supervisor.enqueue(id, line), stateDir: state.dir, now: clock.now, pollMs: 60_000 });
  return { state, clock, deps, toodoFile, seed, journal, source };
};

test("a pass journals each person's message as an owner INBOUND, and takes it only after the journal write", async () => {
  const f = fixture();
  f.seed([{ id: 7, author: "user", body: "Plan\n the  release" }, { id: 8, author: "lead", body: "On it." }]);
  const supervisor = new Supervisor(f.deps);
  const order: string[] = [];
  const toodo = fileToodo(f.toodoFile, { beforeTake: () => { order.push(`take after ${f.journal().events.map((e) => e.id).join(",")}`); } });
  await supervisorToodo({
    toodo: () => toodo, enqueue: (id, line) => { order.push(`journal ${id}`); return supervisor.enqueue(id, line); },
    stateDir: f.state.dir, now: f.clock.now, pollMs: 60_000,
  }).pass();
  expect(order).toEqual(["journal toodo:chat:7", "take after toodo:chat:7"]);
  expect(f.journal().events.map((e) => e.line)).toEqual(["INBOUND toodo 7 user Plan the release"]);
  expect(f.journal().awaitingAck).toEqual([{ id: "toodo:chat:7" }]);
  expect(eventClass("INBOUND toodo 7 user Plan the release")).toBe("lead-urgent");
  expect(fakeToodoState(f.toodoFile).messages[0]?.taken).toBe(true);
});

test("killed between peek and take: after a supervisor and Toodo restart the message reaches the lead once and is taken", async () => {
  const f = fixture();
  f.seed([{ id: 3, author: "user", body: "deploy it" }]);
  const killed = Bun.spawn(["bun", WORKER, f.state.dir, f.toodoFile], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  expect(await killed.exited).not.toBe(0);
  expect(killed.signalCode).toBe("SIGKILL");
  // Journaled before the kill, still pending in Toodo.
  expect(f.journal().events.filter((e) => e.id === "toodo:chat:3")).toHaveLength(1);
  expect(fakeToodoState(f.toodoFile).messages[0]?.taken).toBeUndefined();
  // A new supervisor and a new Toodo instance over the same state.
  const supervisor = new Supervisor(f.deps);
  const sources = new EventSources({ stateDir: f.state.dir, enqueue: (id, line) => supervisor.enqueue(id, line), now: f.clock.now, run: f.deps.run });
  const toodo = fileToodo(f.toodoFile);
  await supervisorToodo({ toodo: () => toodo, enqueue: sources.enqueueFor("toodo"), stateDir: f.state.dir, now: f.clock.now, pollMs: 60_000 }).pass();
  sources.save();
  expect(f.journal().events.filter((e) => e.line.startsWith("INBOUND toodo 3 "))).toHaveLength(1);
  expect(fakeToodoState(f.toodoFile).messages[0]?.taken).toBe(true);
  expect(JSON.parse(await Bun.file(join(f.state.dir, "sources-status.json")).text()).sources.toodo).toMatchObject({ events: 0, duplicates: 1 });
});

test("more than one page of pending items is read in rounds, and task events are informational", async () => {
  const f = fixture();
  f.seed(Array.from({ length: 60 }, (_, i) => ({ id: i + 1, author: "user", body: `m${i + 1}` })), [{ id: 4, taskId: 9, title: "Ship it", status: "done" }]);
  const supervisor = new Supervisor(f.deps);
  await f.source(supervisor).pass();
  const lines = f.journal().events.map((e) => e.line);
  expect(lines.filter((l) => l.startsWith("INBOUND toodo "))).toHaveLength(60);
  expect(lines).toContain("TOODO_TASK event-4 task 9 done: Ship it");
  expect(eventClass("TOODO_TASK event-4 task 9 done: Ship it")).toBe("lead-digest");
  expect(fakeToodoState(f.toodoFile).calls.filter((c) => c.startsWith("take "))).toHaveLength(2);
  expect(f.journal().awaitingAck?.some((a) => a.id.startsWith("toodo:event"))).toBe(false);
});

test("finish reports: the first pass only sets the cursor, later ones reach the lead as digest events with no ack", async () => {
  const f = fixture();
  f.seed([{ id: 1, author: "system", body: "Task 3 merged" }]);
  const supervisor = new Supervisor(f.deps);
  const inbound = f.source(supervisor);
  await inbound.pass();
  expect(f.journal().events).toEqual([]);
  const s = fakeToodoState(f.toodoFile);
  s.messages.push({ id: 2, author: "system", body: "Task 4 merged: PR 12", at: 0 }, { id: 3, author: "system", body: "imported", at: 0, origin: "matrix" });
  writeFileSync(f.toodoFile, JSON.stringify(s));
  await inbound.pass();
  await inbound.pass();
  expect(f.journal().events.map((e) => [e.id, e.line])).toEqual([["toodo:system:2", "TOODO_FINISH 2 Task 4 merged: PR 12"]]);
  expect(eventClass("TOODO_FINISH 2 Task 4 merged: PR 12")).toBe("lead-digest");
  expect(f.journal().awaitingAck ?? []).toEqual([]);
});

test("a chat-changed wake from the event stream runs a pass, and a broken stream reconnects", async () => {
  const f = fixture();
  f.seed([{ id: 5, author: "user", body: "hello" }]);
  const supervisor = new Supervisor(f.deps);
  const toodo = fileToodo(f.toodoFile);
  let opens = 0;
  let woke!: () => void;
  const passed = new Promise<void>((resolve) => { woke = resolve; });
  const inbound = supervisorToodo({
    toodo: () => toodo, enqueue: (id, line) => { const added = supervisor.enqueue(id, line); woke(); return added; },
    stateDir: f.state.dir, now: f.clock.now, pollMs: 60_000_000, backoff: async () => {},
    listen: async (wake, signal, onOpen) => {
      opens++;
      if (opens === 1) throw new Error("connection refused");
      onOpen();
      wake();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  await passed;
  expect(opens).toBe(2);
  expect(inbound.state()).toEqual({ connected: true });
  await inbound.close();
  expect(inbound.state()).toEqual({ connected: false });
  expect(f.journal().events.map((e) => e.id)).toEqual(["toodo:chat:5"]);
});

test("dori ack toodo: ack_chat and typing in Toodo, then a receipt the supervisor matches to toodo:chat:<n>", async () => {
  const f = fixture();
  f.seed([{ id: 12, author: "user", body: "x" }]);
  const toodo = fileToodo(f.toodoFile);
  await ackToodo(f.state.dir, toodo, "12", f.clock.now());
  expect(fakeToodoState(f.toodoFile)).toMatchObject({ typing: true, messages: [{ id: 12, acked: true }] });
  expect(pendingAcks(f.state.dir).map((a) => a.id)).toEqual(["toodo:chat:12"]);
  await expect(ackToodo(f.state.dir, toodo, "chat-12", f.clock.now())).rejects.toThrow("toodo");
});

test("the toodo client parses JSON and event-stream answers, and turns tool errors into ToodoError", async () => {
  const bodies: string[] = [];
  const answers = [
    { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ items: [{ id: "chat-1", at: 1, kind: "chat", body: "hi" }] }) }] } }) },
    { status: 200, body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "{\"id\":9,\"author\":\"lead\",\"body\":\"ok\",\"at\":1}" }] } })}\n\n` },
    { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 3, result: { isError: true, content: [{ type: "text", text: "TOODO_LEAD is not external" }] } }) },
    { status: 401, body: "" },
  ];
  const http: Http = async (req) => { bodies.push(`${req.headers?.authorization} ${String(req.body)}`); return { headers: {}, ...answers.shift()! }; };
  const toodo = new Toodo(http, "http://127.0.0.1:1/", () => "tok");
  expect((await toodo.peek()).items[0]?.id).toBe("chat-1");
  expect((await toodo.reply("ok", ["chat-1"])).id).toBe(9);
  expect(bodies[1]).toContain("\"handles\":[\"chat-1\"]");
  expect(bodies[0]).toStartWith("Bearer tok ");
  await expect(toodo.typing(true)).rejects.toThrow(new ToodoError("Toodo set_typing: TOODO_LEAD is not external"));
  await expect(toodo.peek()).rejects.toThrow("wrong lead token");
});

test("config, targets and the source list know the toodo channel", () => {
  expect(BUILTIN_SOURCES).toContain("toodo");
  expect(toodoConfigError(undefined)).toBeUndefined();
  expect(toodoConfigError({ url: "http://127.0.0.1:47617", leadTokenFile: "~/t" })).toBeUndefined();
  expect(toodoConfigError({ url: "127.0.0.1", leadTokenFile: "~/t" })).toContain("toodo.url");
  expect(toodoConfigError({ url: "http://x", leadTokenFile: "~/t", pollSeconds: 1 })).toContain("pollSeconds");
  expect(resolveTarget("toodo", "toodo")).toEqual({ to: "toodo" });
  expect(resolveTarget("toodo", "12")).toEqual({ to: "toodo", thread: "12" });
  expect(resolveTarget("toodo", "chat-12")).toEqual({ to: "toodo", thread: "12" });
  expect(() => resolveTarget("toodo", "general")).toThrow("Toodo target");
  expect(toodoView(undefined, 0).state).toBe("missing");
  expect(toodoView({ pid: 1, at: 0, connected: true, url: "u" }, 1_000).state).toBe("live");
  expect(toodoView({ pid: 1, at: 0, connected: false, url: "u" }, 1_000).state).toBe("disconnected");
});
