import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventClass } from "../src/event-policy.ts";
import { Supervisor } from "../src/supervise.ts";
import { readToodoCursor, ToodoEvents } from "../src/toodo-events.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState } from "./fakes.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

type Sent = { readonly id: string; readonly event: string; readonly data: string };
const frame = (e: Sent): string => `id: ${e.id}\nevent: ${e.event}\ndata: ${e.data}\n\n`;

/** A toodo-server event stream: replays from Last-Event-ID (the event itself included, as a crash would) and pushes live. */
const fakeToodo = (port = 0) => {
  const history: Sent[] = [];
  const streams = new Set<ReadableStreamDefaultController<string>>();
  const requests: { auth: string | null; lastEventId: string | null }[] = [];
  let status = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 0,
    fetch: (request) => {
      requests.push({ auth: request.headers.get("authorization"), lastEventId: request.headers.get("last-event-id") });
      if (status !== 200) return new Response("no\n", { status });
      const after = request.headers.get("last-event-id");
      const from = after ? history.findIndex((e) => e.id === after) : -1;
      return new Response(new ReadableStream<string>({
        start: (controller) => {
          streams.add(controller);
          if (!after) controller.enqueue(frame({ id: history.at(-1)?.id ?? "ep-0", event: "ready", data: "{}" }));
          else for (const e of history.slice(Math.max(from, 0))) controller.enqueue(frame(e));
        },
        cancel: () => { for (const c of streams) streams.delete(c); },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanups.push(() => { void server.stop(true); });
  return {
    url: `http://127.0.0.1:${server.port}`, port: server.port, requests,
    refuse: (code: number) => { status = code; },
    push: (e: Sent) => { history.push(e); for (const c of streams) c.enqueue(frame(e)); },
    stop: () => server.stop(true),
  };
};

/** Resolves once `ready()` holds after a change signalled through `poke`; fails after 5 s. */
const waiter = () => {
  const pending = new Set<{ ready: () => boolean; resolve: () => void }>();
  const poke = () => { for (const p of pending) if (p.ready()) { pending.delete(p); p.resolve(); } };
  const until = (ready: () => boolean, what: string): Promise<void> => {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(entry); reject(new Error(`timed out waiting for ${what}`)); }, 5_000);
      const entry = { ready, resolve: () => { clearTimeout(timer); resolve(); } };
      pending.add(entry);
    });
  };
  return { poke, until };
};

const fixture = (url: string) => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(1_800_000_000_000), state.dir);
  const supervisor = new Supervisor(deps);
  cleanups.push(() => { supervisor.close(); });
  const tokenFile = join(state.dir, "web-token");
  writeFileSync(tokenFile, "secret-token\n");
  const logs: string[] = [];
  const status: string[] = [];
  const w = waiter();
  const start = (extra: Partial<ConstructorParameters<typeof ToodoEvents>[0]> = {}) => {
    const stop = new AbortController();
    const events = new ToodoEvents({
      config: { url, tokenFile, enabled: true }, stateDir: state.dir,
      enqueue: (id, line) => { const added = supervisor.enqueue(id, line); w.poke(); return added; },
      fail: () => { status.push("fail"); }, ok: () => { status.push("ok"); },
      log: (line) => { logs.push(line); w.poke(); },
      fetch: (async (input: string, init?: RequestInit) => { try { return await fetch(input, init); } finally { w.poke(); } }) as typeof fetch,
      retryMinMs: 10, retryMaxMs: 40, ...extra,
    });
    const running = events.run(stop.signal);
    const halt = async () => { stop.abort(); await running; };
    cleanups.push(halt);
    return halt;
  };
  const toodo = (): { id: string; line: string }[] => readJournal(state.dir).events.filter((e: { id: string }) => e.id.startsWith("toodo:"));
  return { dir: state.dir, deps, logs, status, start, toodo, until: w.until };
};

test("task events are journaled by class and resume after a restart from the saved id without a duplicate", async () => {
  const server = fakeToodo();
  const f = fixture(server.url);
  const halt = f.start();
  await f.until(() => f.logs.some((line) => line.startsWith("TOODO_EVENTS_CONNECTED")), "the first connection");
  server.push({ id: "ep-1", event: "tasks-changed", data: "{}" });
  server.push({ id: "ep-2", event: "task-status-changed", data: JSON.stringify({ taskId: 12, workspaceId: 2, from: "in_review", to: "done", at: 1 }) });
  server.push({ id: "ep-3", event: "task-ready", data: JSON.stringify({ taskId: 13, workspaceId: 2, unblockedBy: 12, at: 1 }) });
  await f.until(() => f.toodo().length === 2, "two task events");
  expect(readToodoCursor(f.dir)).toBe("ep-3");
  await halt();

  // The restarted supervisor sends the saved id; the server replays ep-3 again, which the journal drops.
  f.start();
  server.push({ id: "ep-4", event: "task-status-changed", data: JSON.stringify({ taskId: 14, workspaceId: 2, from: null, to: "planned", at: 2 }) });
  await f.until(() => f.toodo().length === 3, "the event after the restart");
  expect(server.requests.map((r) => r.lastEventId)).toEqual([null, "ep-3"]);
  expect(server.requests.every((r) => r.auth === "Bearer secret-token")).toBe(true);
  expect(f.toodo()).toEqual([
    expect.objectContaining({ id: "toodo:ep-2", line: "TOODO_TASK_STATUS #12 in_review->done workspace=2" }),
    expect.objectContaining({ id: "toodo:ep-3", line: "TOODO_TASK_READY #13 workspace=2 unblocked-by=#12" }),
    expect.objectContaining({ id: "toodo:ep-4", line: "TOODO_TASK_STATUS #14 new->planned workspace=2" }),
  ]);
  expect(f.toodo().map((e) => eventClass(e.line, f.deps.config.eventPolicy))).toEqual(["lead-digest", "lead-urgent", "lead-digest"]);
  expect(f.logs.join("\n")).not.toContain("secret-token");
});

test("a toodo-server that is down is retried with backoff, reported once, and followed once it is up", async () => {
  const probe = fakeToodo();
  const port = probe.port;
  await probe.stop();
  const f = fixture(`http://127.0.0.1:${port}`);
  f.start();
  await f.until(() => f.logs.some((line) => line.startsWith("TOODO_EVENTS_DOWN")), "the down report");
  const server = fakeToodo(port);
  await f.until(() => f.logs.some((line) => line.startsWith("TOODO_EVENTS_CONNECTED")), "the reconnection");
  expect(f.logs.filter((line) => line.startsWith("TOODO_EVENTS_DOWN"))).toHaveLength(1);
  expect(f.status).toEqual(["fail", "ok"]);
  server.push({ id: "ep-1", event: "task-ready", data: JSON.stringify({ taskId: 5, workspaceId: 1, unblockedBy: 4, at: 1 }) });
  await f.until(() => f.toodo().length === 1, "the event after the reconnection");
});

test("a refused token and a silent stream are failures that are retried, never a hang", async () => {
  const refused = fakeToodo();
  refused.refuse(401);
  const a = fixture(refused.url);
  a.start();
  await a.until(() => refused.requests.length >= 2, "a retry after the 401");
  expect(a.logs.find((line) => line.startsWith("TOODO_EVENTS_DOWN"))).toContain("answered 401");

  const silent = fakeToodo();
  const b = fixture(silent.url);
  // Opens with the saved id, so the server sends nothing at all.
  writeFileSync(join(b.dir, "toodo-events.json"), JSON.stringify({ lastEventId: "ep-9" }));
  b.start({ idleMs: 50 });
  await b.until(() => silent.requests.length >= 2, "a reconnection after the silence");
  expect(b.logs.find((line) => line.startsWith("TOODO_EVENTS_DOWN"))).toContain("no data from toodo-server");
});
