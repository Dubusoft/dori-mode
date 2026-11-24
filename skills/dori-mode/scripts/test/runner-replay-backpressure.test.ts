import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connect as connectTcp } from "node:net";
import { RunnerClient, REPLAY_PAGE_ROWS } from "../src/runner/client.ts";
import { OUTBOX_FILE, Outbox } from "../src/runner/outbox.ts";
import { encodeFrame, supervisorControl } from "../src/runner/protocol.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Transport } from "../src/runner/transport.ts";
import { acceptWs, connectWs, listenWs } from "../src/runner/ws-transport.ts";
import { memoryPair } from "./support/memory-transport.ts";
import { fakeClock, withState } from "./fakes.ts";

let dir: string;
let done: () => void;
beforeEach(() => { ({ dir, done } = withState()); });
afterEach(() => { done(); });

const HELLO_OK = encodeFrame(supervisorControl({ runner: "r1", gen: 1, epoch: 1 }, "hello.ok", { proto: 5, epoch: 1, eventAck: 0 }));

/** Writes `count` unacked `lane.asking` rows (seq 1..count) in one transaction; appending them one by one fsyncs each. */
const seedOutbox = (count: number, text: string): void => {
  new Outbox(dir, { now: () => 1 }).close();
  const db = new Database(join(dir, OUTBOX_FILE));
  const insert = db.query("INSERT INTO events (seq, type, body, at) VALUES (?, 'lane.asking', ?, 1)");
  db.transaction(() => {
    for (let seq = 1; seq <= count; seq++) insert.run(seq, JSON.stringify({ key: "lane-a", text }));
    db.query("UPDATE meta SET v = ? WHERE k = 'next_seq'").run(count + 1);
  })();
  db.close();
};

test("a websocket send under backpressure waits for drain, and a dropped send closes the link", async () => {
  const listener = listenWs("127.0.0.1:0");
  // A raw client that stops reading after the upgrade, so the server's queue fills like a slow peer's.
  const socket = connectTcp(listener.port, "127.0.0.1");
  try {
    const accepted = new Promise<Transport>((resolve) => { listener.onConnection(resolve); });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await new Promise((resolve) => socket.once("data", resolve));
    socket.pause();
    const server = await accepted;
    const closed = new Promise<string>((resolve) => { server.onClose(resolve); });
    const chunk = "x".repeat(512 * 1024);

    let drained: Promise<void> | undefined;
    for (let i = 0; i < 64 && !drained; i++) {
      server.send(chunk);
      drained = server.drained?.();
    }
    expect(drained).toBeInstanceOf(Promise);
    socket.resume();
    await drained;
    expect(server.drained?.()).toBeUndefined();
    expect(server.open).toBe(true);

    socket.pause();
    for (let i = 0; i < 400 && server.open; i++) server.send(chunk);
    expect(await closed).toStartWith("RUNNER_SEND_DROPPED");
  } finally {
    socket.destroy();
    listener.close();
  }
});

test("a 10k-row outbox replays over a websocket page by page and every row arrives in order", async () => {
  const ROWS = 10_000;
  // 4 KiB rows make a 40 MiB backlog, past Bun's 16 MiB send queue: a replay that ignored backpressure would be dropped.
  seedOutbox(ROWS, "q".repeat(4096));
  const outbox = new Outbox(dir, { now: () => 1 });
  const state = new RunnerState(dir, { now: () => 1 });
  state.boot();
  const limits: (number | undefined)[] = [];
  const unacked = outbox.unacked.bind(outbox);
  outbox.unacked = (since, limit) => { limits.push(limit); return unacked(since, limit); };
  const worker = acceptWs("127.0.0.1:0");
  let supervisor: Transport | undefined;
  try {
    supervisor = await connectWs(`ws://127.0.0.1:${worker.port}`)();
    const seqs: number[] = [];
    const all = new Promise<void>((resolve) => {
      supervisor!.onLine((line) => {
        const frame = JSON.parse(line) as { type: string; seq?: number };
        if (frame.type === "hello") supervisor!.send(HELLO_OK);
        else if (frame.seq !== undefined && seqs.push(frame.seq) === ROWS) resolve();
      });
    });
    const client = new RunnerClient({ label: "r1", hostId: "host" }, { outbox, state, clock: fakeClock(1), connect: worker.connect });
    expect(await client.connectOnce()).toEqual({ ok: true, eventAck: 0, replayed: ROWS });
    await all;
    expect(seqs).toEqual(Array.from({ length: ROWS }, (_, i) => i + 1));
    expect(limits).toHaveLength(Math.ceil(ROWS / REPLAY_PAGE_ROWS) + 1);
    expect(limits.every((limit) => limit === REPLAY_PAGE_ROWS)).toBe(true);
  } finally {
    supervisor?.close();
    worker.close();
    outbox.close();
    state.close();
  }
});

test("rows published while the replay waits for drain are replayed in order before the connection is ready", async () => {
  const outbox = new Outbox(dir, { now: () => 1 });
  const state = new RunnerState(dir, { now: () => 1 });
  state.boot();
  for (let i = 1; i <= 3; i++) outbox.append("lane.asking", { key: "lane-a", text: String(i) });
  const pair = memoryPair();
  let release: () => void = () => {};
  let gate: Promise<void> | undefined = new Promise<void>((resolve) => { release = resolve; });
  const seqs: number[] = [];
  pair.supervisor.onLine((line) => {
    const frame = JSON.parse(line) as { type: string; seq?: number };
    if (frame.type === "hello") pair.supervisor.send(HELLO_OK);
    else if (frame.seq !== undefined) seqs.push(frame.seq);
  });
  // The first replayed row leaves the link backlogged until the test releases it.
  const runner: Transport = { ...pair.runner, drained: () => { const wait = gate; gate = undefined; return wait; } };
  const client = new RunnerClient({ label: "r1", hostId: "host" }, { outbox, state, clock: fakeClock(1), connect: async () => runner });
  try {
    const outcome = client.connectOnce();
    await Promise.resolve();
    pair.pump();
    expect(seqs).toEqual([1]);
    expect(client.connected).toBe(false);
    expect(client.publish("lane.asking", { key: "lane-a", text: "4" })).toBe(4);
    pair.pump();
    expect(seqs).toEqual([1]);
    release();
    expect(await outcome).toEqual({ ok: true, eventAck: 0, replayed: 4 });
    pair.pump();
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(client.connected).toBe(true);
  } finally {
    pair.sever();
    outbox.close();
    state.close();
  }
});
