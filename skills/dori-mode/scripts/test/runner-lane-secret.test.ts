import { expect, test } from "bun:test";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { type LaneSocketLanes, serveLaneSocket } from "../src/runner/lane-socket.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";

const VALUE = "dori-test-throwaway-123";
const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-a", PATH: "/bin" };

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } };
};

const socket = (secrets?: LaneSocketLanes["secrets"]) => {
  const net = memoryNetwork();
  const published: [RunnerEventType, unknown][] = [];
  const logs: string[] = [];
  const lanes: LaneSocketLanes = { tokenFor: (key, token) => (key === "lane-a" && token === "tok-a") || (key === "lane-b" && token === "tok-b"), ...(secrets ? { secrets } : {}) };
  serveLaneSocket(net.listener, lanes, (type, body) => { published.push([type, body]); }, (l) => { logs.push(l); });
  // The in-memory link delivers on pump(); the reply is async here, so the connector pumps again after the microtasks settle.
  const connect: Connector = async () => {
    const link = await net.connect();
    const pair = net.pairs.at(-1) as (typeof net.pairs)[number];
    return {
      send: (line) => { link.send(line); pair.pump(); void (async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); pair.pump(); } })(); },
      onLine: (h) => link.onLine(h), onClose: (h) => link.onClose(h), close: (reason) => { link.close(reason); },
      get open() { return link.open; },
    } satisfies Transport;
  };
  return { connect, published, logs };
};

test("exec hands values only to the child env and returns its exit code", async () => {
  const calls: string[][] = [];
  const sock = socket(async (key, names) => { calls.push([key, ...names]); return { ok: true, values: { NPM_TOKEN: VALUE } }; });
  const r = io();
  let seen: { argv: readonly string[]; env: Record<string, string> } | undefined;
  const code = await laneCliMain(["secret", "exec", "NPM_TOKEN", "--", "npm", "publish"], {
    env, connect: sock.connect, ...r.deps, spawnWithEnv: async (argv, e) => { seen = { argv, env: e }; return 7; },
  });
  expect(code).toBe(7);
  expect(calls).toEqual([["lane-a", "NPM_TOKEN"]]);
  expect(seen?.argv).toEqual(["npm", "publish"]);
  expect(seen?.env.NPM_TOKEN).toBe(VALUE);
  expect(seen?.env.PATH).toBe("/bin");
  expect(seen?.argv.join(" ")).not.toContain(VALUE);
  expect([...r.out, ...r.err].join("\n")).not.toContain(VALUE);
  expect(sock.published).toEqual([]);
  expect(sock.logs.join("\n")).not.toContain(VALUE);
});

test("a token that belongs to another lane is refused before secrets() runs", async () => {
  let called = 0;
  const sock = socket(async () => { called++; return { ok: true, values: { A: VALUE } }; });
  const r = io();
  let spawned = 0;
  const code = await laneCliMain(["secret", "exec", "A", "--", "true"], {
    env: { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-b" }, connect: sock.connect, ...r.deps, spawnWithEnv: async () => { spawned++; return 0; },
  });
  expect(code).toBe(1);
  expect(r.err[0]).toStartWith("RUNNER_LANE_AUTH_FAILED");
  expect(called).toBe(0);
  expect(spawned).toBe(0);
  expect(sock.logs).toEqual(["RUNNER_LANE_AUTH_FAILED key=lane-a verb=secret names=A"]);
});

test("a refused grant exits 1 and never spawns", async () => {
  const sock = socket(async () => ({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "not allowed for this lane" }));
  const r = io();
  let spawned = 0;
  const code = await laneCliMain(["secret", "exec", "A", "--", "true"], { env, connect: sock.connect, ...r.deps, spawnWithEnv: async () => { spawned++; return 0; } });
  expect(code).toBe(1);
  expect(r.err).toEqual(["RUNNER_SECRET_DENIED not allowed for this lane"]);
  expect(spawned).toBe(0);
});

test("a throwing grant becomes RUNNER_SECRET_FAILED", async () => {
  const sock = socket(async () => { throw new Error("SECRET_DECRYPT_FAILED boom"); });
  const r = io();
  expect(await laneCliMain(["secret", "exec", "A", "--", "true"], { env, connect: sock.connect, ...r.deps, spawnWithEnv: async () => 0 })).toBe(1);
  expect(r.err).toEqual(["RUNNER_SECRET_FAILED SECRET_DECRYPT_FAILED boom"]);
});

test("a runner without secrets answers RUNNER_SECRET_UNSUPPORTED", async () => {
  const sock = socket();
  const r = io();
  expect(await laneCliMain(["secret", "exec", "A", "--", "true"], { env, connect: sock.connect, ...r.deps, spawnWithEnv: async () => 0 })).toBe(1);
  expect(r.err[0]).toStartWith("RUNNER_SECRET_UNSUPPORTED");
  expect(sock.published).toEqual([]);
});

test("bad usage exits 2 without contacting the runner", async () => {
  let called = 0;
  const sock = socket(async () => { called++; return { ok: true, values: {} }; });
  for (const args of [
    ["secret", "exec", "--", "true"],
    ["secret", "exec", "lower", "--", "true"],
    ["secret", "exec", "A", "true"],
    ["secret", "exec", "A", "--"],
    ["secret", "exec"],
  ]) {
    const r = io();
    expect(await laneCliMain(args, { env, connect: sock.connect, ...r.deps, spawnWithEnv: async () => 0 })).toBe(2);
    expect(r.err[0]).toStartWith("usage: dori secret exec");
  }
  const other = io();
  expect(await laneCliMain(["secret", "list"], { env, connect: sock.connect, ...other.deps })).toBe(2);
  expect(other.err[0]).toStartWith("DORI_CLI_LANE_ONLY secret list:");
  expect(called).toBe(0);
});

test("the socket rejects malformed names with RUNNER_LANE_BAD_REQUEST", async () => {
  const sock = socket(async () => ({ ok: true, values: {} }));
  for (const names of [[], ["A", "A"], ["a"], [1], "A", Array.from({ length: 33 }, (_, i) => `N${i}`)]) {
    const replies: string[] = [];
    const link = await sock.connect();
    link.onLine((l) => { replies.push(l); });
    link.send(`${JSON.stringify({ kind: "secret", key: "lane-a", token: "tok-a", names })}\n`);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(JSON.parse(replies[0] ?? "{}").code).toBe("RUNNER_LANE_BAD_REQUEST");
  }
});
