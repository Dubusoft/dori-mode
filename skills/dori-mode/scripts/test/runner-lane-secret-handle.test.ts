import { expect, test } from "bun:test";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { type LaneSocketLanes, serveLaneSocket } from "../src/runner/lane-socket.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";

const HANDLE = `dsh_${"A".repeat(43)}`;
const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-a" };

/** Sends one raw request line and waits for its reply line. */
const raw = async (connect: Connector, body: object): Promise<void> => {
  const link = await connect();
  const got = new Promise<void>((resolve) => { link.onLine(() => { resolve(); }); });
  link.send(`${JSON.stringify(body)}\n`);
  await got;
};

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } };
};

const socket = (secretHandle?: LaneSocketLanes["secretHandle"]) => {
  const net = memoryNetwork();
  const logs: string[] = [];
  const lanes: LaneSocketLanes = { tokenFor: (key, token) => (key === "lane-a" && token === "tok-a") || (key === "lane-b" && token === "tok-b"), ...(secretHandle ? { secretHandle } : {}) };
  serveLaneSocket(net.listener, lanes, () => {}, (l) => { logs.push(l); });
  const replies: string[] = [];
  const connect: Connector = async () => {
    const link = await net.connect();
    const pair = net.pairs.at(-1) as (typeof net.pairs)[number];
    return {
      send: (line) => { link.send(line); pair.pump(); void (async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); pair.pump(); } })(); },
      onLine: (h) => link.onLine((line) => { replies.push(line); h(line); }), onClose: (h) => link.onClose(h), close: (reason) => { link.close(reason); },
      get open() { return link.open; },
    } satisfies Transport;
  };
  return { connect, logs, replies };
};

test("secret handle prints exactly the handle and passes the lane key and name", async () => {
  const calls: string[][] = [];
  const sock = socket(async (key, name) => { calls.push([key, name]); return { ok: true, handle: HANDLE, expiresAt: 1 }; });
  const r = io();
  const writes: string[] = [];
  const code = await laneCliMain(["secret", "handle", "WEB_PW"], { env, connect: sock.connect, ...r.deps, write: (_s, t) => { writes.push(t); } });
  expect(code).toBe(0);
  expect(calls).toEqual([["lane-a", "WEB_PW"]]);
  expect(writes).toEqual([`${HANDLE}\n`]);
  expect(r.err).toEqual([]);
});

test("a refusal prints code and detail on stderr and exits 1", async () => {
  const sock = socket(async () => ({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "no origins" }));
  const r = io();
  const code = await laneCliMain(["secret", "handle", "WEB_PW"], { env, connect: sock.connect, ...r.deps, write: () => {} });
  expect(code).toBe(1);
  expect(r.err).toEqual(["RUNNER_SECRET_DENIED no origins"]);
});

test("wrong usage exits 2 with the usage line", async () => {
  const sock = socket();
  for (const args of [["secret", "handle"], ["secret", "handle", "a", "b"], ["secret", "handle", "bad name"]]) {
    const r = io();
    expect(await laneCliMain(args, { env, connect: sock.connect, ...r.deps })).toBe(2);
    expect(r.err).toEqual(["usage: dori secret handle NAME"]);
  }
});

test("another lane's token is refused before secretHandle runs", async () => {
  let called = 0;
  const sock = socket(async () => { called++; return { ok: true, handle: HANDLE, expiresAt: 1 }; });
  const r = io();
  const code = await laneCliMain(["secret", "handle", "WEB_PW"], { env: { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-b" }, connect: sock.connect, ...r.deps, write: () => {} });
  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(r.err.join("\n")).toContain("RUNNER_LANE_AUTH_FAILED");
});

test("an absent dep answers RUNNER_SECRET_UNSUPPORTED", async () => {
  const sock = socket();
  const r = io();
  const code = await laneCliMain(["secret", "handle", "WEB_PW"], { env, connect: sock.connect, ...r.deps, write: () => {} });
  expect(code).toBe(1);
  expect(r.err[0]).toStartWith("RUNNER_SECRET_UNSUPPORTED");
});

test("an invalid name on the wire is RUNNER_LANE_BAD_REQUEST", async () => {
  const sock = socket(async () => ({ ok: true, handle: HANDLE, expiresAt: 1 }));
  await raw(sock.connect, { kind: "secret.handle", key: "lane-a", token: "tok-a", name: "no good" });
  expect(JSON.parse(sock.replies[0] as string).code).toBe("RUNNER_LANE_BAD_REQUEST");
});

test("the lane socket has no exchange verb: secret.exchange and unknown verbs are refused without a value", async () => {
  let issued = 0;
  const sock = socket(async () => { issued++; return { ok: true, handle: HANDLE, expiresAt: 1 }; });
  for (const kind of ["secret.exchange", "exchange", "secret.handle.exchange"]) {
    await raw(sock.connect, { kind, key: "lane-a", token: "tok-a", handle: HANDLE, origin: "https://x.test", name: "WEB_PW" });
  }
  expect(sock.replies).toHaveLength(3);
  for (const line of sock.replies) {
    const reply = JSON.parse(line);
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("RUNNER_LANE_BAD_REQUEST");
    expect(reply.value).toBeUndefined();
    expect(reply.values).toBeUndefined();
    expect(line).not.toContain(HANDLE);
  }
  expect(issued).toBe(0);
});
