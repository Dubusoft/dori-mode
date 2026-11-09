import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES } from "../src/runner/protocol.ts";
import { memoryPair, type Transport } from "../src/runner/transport.ts";
import { acceptWs, backoff, connectWs, dialWs, isPrivateListen, listenWs } from "../src/runner/ws-transport.ts";

const nextLine = (transport: Transport): Promise<string> =>
  new Promise((resolve) => {
    const off = transport.onLine((line) => { off(); resolve(line); });
  });

const closed = (transport: Transport): Promise<string> =>
  new Promise((resolve) => { transport.onClose(resolve); });

describe("isPrivateListen", () => {
  const table: Array<[string, boolean]> = [
    ["0.0.0.0:7411", false],
    ["8.8.8.8:7411", false],
    ["100.101.1.2:7411", true],
    ["192.168.1.5:7411", true],
    ["127.0.0.1:0", true],
    ["10.1.2.3:7411", true],
    ["172.16.0.1:7411", true],
    ["172.32.0.1:7411", false],
    ["100.128.0.1:7411", false],
    ["[::1]:7411", true],
    ["[fd12:3456::1]:7411", true],
    ["[::]:7411", false],
    ["[2001:db8::1]:7411", false],
    [":7411", false],
    ["localhost:7411", false],
    ["127.0.0.1", false],
  ];
  for (const [input, expected] of table) test(`${input} -> ${expected}`, () => expect(isPrivateListen(input)).toBe(expected));

  test("listenWs refuses a wildcard or public address", () => {
    expect(() => listenWs("0.0.0.0:0")).toThrow("RUNNER_LISTEN_REFUSED");
    expect(() => listenWs("[::]:0")).toThrow("RUNNER_LISTEN_REFUSED");
    expect(() => listenWs("8.8.8.8:0")).toThrow("RUNNER_LISTEN_REFUSED");
  });
});

describe("backoff", () => {
  test("doubles from 1s to the 60s cap with a fixed midpoint random", () => {
    const sequence = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoff(attempt, () => 0.5));
    expect(sequence).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  test("jitter spans plus or minus 20 percent", () => {
    expect(backoff(0, () => 0)).toBe(800);
    expect(backoff(0, () => 0.999999)).toBe(1200);
    expect(backoff(10, () => 0)).toBe(48000);
    expect(backoff(1000, () => 0.5)).toBe(60000);
  });
});

describe("ws transport over loopback", () => {
  test("frames flow both ways and the link closes cleanly", async () => {
    const listener = listenWs("127.0.0.1:0");
    try {
      const accepted = new Promise<Transport>((resolve) => { listener.onConnection(resolve); });
      const client = await connectWs(`ws://127.0.0.1:${listener.port}`)();
      const server = await accepted;

      const atServer = nextLine(server);
      client.send('{"t":"ping"}\n');
      expect(await atServer).toBe('{"t":"ping"}');

      const atClient = nextLine(client);
      server.send('{"t":"pong"}\n');
      expect(await atClient).toBe('{"t":"pong"}');

      const serverClosed = closed(server);
      const clientClosed = closed(client);
      client.close("done");
      await clientClosed;
      await serverClosed;
      expect(client.open).toBe(false);
      expect(server.open).toBe(false);
      expect(() => client.send("x")).toThrow("transport closed");
    } finally {
      listener.close();
    }
  });

  test("an oversize frame closes the link", async () => {
    const listener = listenWs("127.0.0.1:0");
    try {
      const accepted = new Promise<Transport>((resolve) => { listener.onConnection(resolve); });
      const raw = new WebSocket(`ws://127.0.0.1:${listener.port}`);
      await new Promise((resolve) => raw.addEventListener("open", resolve, { once: true }));
      const server = await accepted;
      const serverClosed = closed(server);
      raw.send("x".repeat(MAX_FRAME_BYTES + 1));
      await serverClosed;
      expect(server.open).toBe(false);
    } finally {
      listener.close();
    }
  });

  test("listener close ends open connections and connect to a dead port rejects", async () => {
    const listener = listenWs("127.0.0.1:0");
    const port = listener.port;
    const accepted = new Promise<Transport>((resolve) => { listener.onConnection(resolve); });
    const client = await connectWs(`ws://127.0.0.1:${port}`)();
    await accepted;
    const clientClosed = closed(client);
    listener.close();
    await clientClosed;
    await expect(connectWs(`ws://127.0.0.1:${port}`)()).rejects.toThrow("RUNNER_CONNECT_FAILED");
  });
});

test("the accepting connector holds an early connection, rejects a competing link and cancels a pending accept on close", async () => {
  const worker = acceptWs("127.0.0.1:0");
  try {
    const supervisor = await connectWs(`ws://127.0.0.1:${worker.port}`)();
    const runner = await worker.connect();
    const got = nextLine(runner);
    supervisor.send("held");
    expect(await got).toBe("held");
    const competing = await connectWs(`ws://127.0.0.1:${worker.port}`)();
    if (competing.open) await closed(competing);
    expect(runner.open).toBe(true);
    const ended = closed(runner);
    supervisor.close("drop");
    await ended;
    const pending = worker.connect().catch((error: Error) => error.message);
    worker.close();
    expect(await pending).toBe("runner listener closed");
  } finally { worker.close(); }
});

test("the dialing listener backs off failed dials, discovers replacements and discards a late dial after close", async () => {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const attempts: { url: string; resolve: (transport: Transport) => void; reject: (error: Error) => void }[] = [];
  let endpoints: Record<string, string> = { worker: "127.0.0.1:7411" };
  const accepted: Transport[] = [];
  const listener = dialWs({
    endpoints: () => endpoints, random: () => 0.5, refreshMs: 99_000,
    timers: {
      set(fn, ms) { scheduled.set(++nextTimer, { fn, ms }); return nextTimer; },
      clear(handle) { scheduled.delete(handle as number); },
    },
    dial: (url) => new Promise((resolve, reject) => { attempts.push({ url, resolve, reject }); }),
  });
  const fire = (ms: number) => {
    const entry = [...scheduled].find(([, timer]) => timer.ms === ms);
    expect(entry).toBeDefined();
    const [id, timer] = entry!;
    scheduled.delete(id);
    timer.fn();
  };
  listener.onConnection((transport) => accepted.push(transport));
  expect(attempts[0]?.url).toBe("ws://127.0.0.1:7411");
  attempts[0]!.reject(new Error("offline"));
  await Promise.resolve();
  fire(1000);
  attempts[1]!.reject(new Error("offline"));
  await Promise.resolve();
  fire(2000);
  const first = memoryPair();
  attempts[2]!.resolve(first.supervisor);
  await Promise.resolve();
  expect(accepted).toEqual([first.supervisor]);
  first.sever();
  fire(1000);
  const late = memoryPair();
  endpoints = { worker: "127.0.0.1:7412", new: "10.1.2.3:7411" };
  fire(99_000);
  expect(attempts.slice(-2).map((a) => a.url)).toEqual(["ws://127.0.0.1:7412", "ws://10.1.2.3:7411"]);
  attempts[3]!.resolve(late.supervisor);
  await Promise.resolve();
  expect(late.runner.open).toBe(false);
  listener.close();
  const afterClose = memoryPair();
  attempts[4]!.resolve(afterClose.supervisor);
  await Promise.resolve();
  expect(afterClose.runner.open).toBe(false);
  expect(scheduled.size).toBe(0);
  expect(accepted).toHaveLength(1);
});
