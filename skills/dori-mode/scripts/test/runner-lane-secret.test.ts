import { expect, test } from "bun:test";
import { SecretStore } from "../src/secret-store.ts";
import { secretGranter } from "../src/runner/secret-grant.ts";
import { withState } from "./fakes.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { type LaneSocketLanes, serveLaneSocket } from "../src/runner/lane-socket.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { memoryNetwork } from "./support/memory-transport.ts";

const VALUE = "dori-test-throwaway-123";
const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-a", PATH: "/bin" };

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } };
};

const socket = (secrets?: LaneSocketLanes["secrets"], secretRun?: LaneSocketLanes["secretRun"]) => {
  const net = memoryNetwork();
  const published: [RunnerEventType, unknown][] = [];
  const logs: string[] = [];
  const lanes: LaneSocketLanes = { tokenFor: (key, token) => (key === "lane-a" && token === "tok-a") || (key === "lane-b" && token === "tok-b"), ...(secrets ? { secrets } : {}), ...(secretRun ? { secretRun } : {}) };
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

test("env exports every value with POSIX quoting and no names in the request", async () => {
  const calls: string[] = [];
  const values = { API_TOKEN: VALUE, QUOTED: "it's $safe;\nsecond line" };
  const sock = socket(async (key) => { calls.push(key); return { ok: true, values }; });
  const r = io();
  expect(await laneCliMain(["secret", "env"], { env, connect: sock.connect, ...r.deps })).toBe(0);
  expect(calls).toEqual(["lane-a"]);
  expect(r.out).toEqual([`export API_TOKEN='${VALUE}'`, "export QUOTED='it'\\''s $safe;\nsecond line'"]);
  expect(r.err).toEqual([]);
  expect(sock.published).toEqual([]);
  expect(sock.logs).toEqual([]);
  const child = Bun.spawn(["sh", "-c", r.out.join("\n") + '; printf "%s" "$QUOTED"'], { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await new Response(child.stdout).text()).toBe(values.QUOTED);
  expect(await child.exited).toBe(0);
});

test("env refusals and failures print only code and detail to stderr", async () => {
  for (const grant of [undefined, async () => ({ ok: false as const, code: "RUNNER_SECRET_DENIED", detail: "unsandboxed" }), async () => { throw new Error("unreadable"); }]) {
    const sock = socket(grant);
    const r = io();
    expect(await laneCliMain(["secret", "env"], { env, connect: sock.connect, ...r.deps })).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toMatch(/^RUNNER_SECRET_(UNSUPPORTED|DENIED|FAILED) /);
  }
});

test("env refuses a terminal stdout before reading any values", async () => {
  let called = false;
  const sock = socket(async () => { called = true; return { ok: true, values: { API_TOKEN: VALUE } }; });
  const r = io();
  expect(await laneCliMain(["secret", "env"], { env, connect: sock.connect, stdoutIsTTY: true, ...r.deps })).toBe(2);
  expect(called).toBe(false);
  expect(r.out).toEqual([]);
  expect(r.err).toHaveLength(1);
  expect(r.err[0]).toStartWith("SECRET_ENV_TTY_REFUSED ");
  expect(r.err[0]).not.toContain(VALUE);
});

test("env rejects another lane token before reading any values", async () => {
  let called = false;
  const sock = socket(async () => { called = true; return { ok: true, values: {} }; });
  const r = io();
  expect(await laneCliMain(["secret", "env"], { env: { ...env, DORI_LANE_TOKEN: "tok-b" }, connect: sock.connect, ...r.deps })).toBe(1);
  expect(called).toBe(false);
  expect(r.out).toEqual([]);
  expect(r.err).toEqual(["RUNNER_LANE_AUTH_FAILED not lane-a's lane token"]);
});

test("env rejects arguments before contacting the runner", async () => {
  let connected = false;
  for (const args of [["secret"], ["secret", "env", "A"], ["secret", "list"]]) {
    const r = io();
    expect(await laneCliMain(args, { env, connect: async () => { connected = true; throw new Error("unused"); }, ...r.deps })).toBe(2);
  }
  expect(connected).toBe(false);
});

/** Sends one raw request line on the socket and returns the parsed reply. */
const ask = async (sock: ReturnType<typeof socket>, body: object): Promise<Record<string, unknown>> => {
  const replies: string[] = [];
  const link = await sock.connect();
  link.onLine((l) => { replies.push(l); });
  link.send(`${JSON.stringify(body)}\n`);
  for (let i = 0; i < 20 && !replies.length; i++) await Promise.resolve();
  return JSON.parse(replies[0] ?? "{}") as Record<string, unknown>;
};

const ran = { ok: true, exitCode: 3, stdout: "out [REDACTED:API_TOKEN]\n", stderr: "err\n", truncated: false } as const;

test("secret-run: the verb runs the op for the token's lane and replies with exit code and output, logging neither", async () => {
  const calls: string[][] = [];
  const sock = socket(undefined, async (key, op) => { calls.push([key, op]); return ran; });
  expect(await ask(sock, { kind: "secret-run", key: "lane-a", token: "tok-a", op: "deploy" })).toEqual(ran);
  expect(calls).toEqual([["lane-a", "deploy"]]);
  expect(sock.logs).toEqual([]);
  expect(sock.published).toEqual([]);
});

test("secret-run: the token is checked before op; a bad op is BAD_REQUEST; no runner support is UNSUPPORTED", async () => {
  let called = 0;
  const sock = socket(undefined, async () => { called++; return ran; });
  expect(await ask(sock, { kind: "secret-run", key: "lane-a", token: "tok-b", op: "Not An Op" })).toMatchObject({ ok: false, code: "RUNNER_LANE_AUTH_FAILED" });
  expect(sock.logs).toEqual(["RUNNER_LANE_AUTH_FAILED key=lane-a verb=secret-run"]);
  for (const op of ["Deploy", "1x", "", "a".repeat(65), 7, undefined]) {
    expect(await ask(sock, { kind: "secret-run", key: "lane-a", token: "tok-a", op })).toMatchObject({ ok: false, code: "RUNNER_LANE_BAD_REQUEST" });
  }
  expect(called).toBe(0);
  expect(await ask(socket(), { kind: "secret-run", key: "lane-a", token: "tok-a", op: "deploy" })).toMatchObject({ ok: false, code: "RUNNER_SECRET_UNSUPPORTED" });
  const throwing = socket(undefined, async () => { throw new Error("boom"); });
  expect(await ask(throwing, { kind: "secret-run", key: "lane-a", token: "tok-a", op: "deploy" })).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "boom" });
});

test("dori secret run writes the output to its own stdout/stderr and exits with the op's exit code", async () => {
  const sock = socket(undefined, async () => ran);
  const r = io();
  const written: [string, string][] = [];
  const code = await laneCliMain(["secret", "run", "deploy"], { env, connect: sock.connect, ...r.deps, write: (stream, text) => { written.push([stream, text]); } });
  expect(code).toBe(3);
  expect(written).toEqual([["stdout", "out [REDACTED:API_TOKEN]\n"], ["stderr", "err\n"]]);
  expect([...r.out, ...r.err, ...written.map((w) => w[1])].join("\n")).not.toContain(VALUE);
});

test("dori host <op> is dori secret run <op>: same verb and output; bad usage exits 2 without the socket", async () => {
  const ops: string[] = [];
  const sock = socket(undefined, async (_key, op) => { ops.push(op); return ran; });
  const r = io();
  const written: [string, string][] = [];
  expect(await laneCliMain(["host", "probe-sandbox"], { env, connect: sock.connect, ...r.deps, write: (stream, text) => { written.push([stream, text]); } })).toBe(3);
  expect(ops).toEqual(["probe-sandbox"]);
  expect(written).toEqual([["stdout", "out [REDACTED:API_TOKEN]\n"], ["stderr", "err\n"]]);
  let connects = 0;
  const counting: Connector = async () => { connects++; throw new Error("unused"); };
  for (const args of [["host"], ["host", "Probe"], ["host", "run", "probe"]]) {
    const u = io();
    expect(await laneCliMain(args, { env, connect: counting, ...u.deps })).toBe(2);
    expect(u.err).toEqual(["usage: dori host <op>"]);
  }
  expect(connects).toBe(0);
});

test("dori secret run: a refusal prints code and detail and exits 1; bad usage exits 2 without the socket", async () => {
  const denied = socket(undefined, async () => ({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not run deploy (config secretCommands)" }));
  const r = io();
  const written: string[] = [];
  expect(await laneCliMain(["secret", "run", "deploy"], { env, connect: denied.connect, ...r.deps, write: (_s, t) => { written.push(t); } })).toBe(1);
  expect(r.err).toEqual(["RUNNER_SECRET_DENIED lane-a may not run deploy (config secretCommands)"]);
  expect(written).toEqual([]);
  let connects = 0;
  const counting: Connector = async () => { connects++; throw new Error("unused"); };
  for (const args of [["secret", "run"], ["secret", "run", "Deploy"], ["secret", "run", "deploy", "extra"]]) {
    const u = io();
    expect(await laneCliMain(args, { env, connect: counting, ...u.deps })).toBe(2);
    expect(u.err).toEqual(["usage: dori secret run <op>"]);
  }
  expect(connects).toBe(0);
});

test("env pulls a local store through the granter without publishing values", async () => {
  const state = withState();
  try {
    const store = new SecretStore({ dir: state.dir + "/secrets" });
    await store.add("LOCAL_TOKEN", "local throwaway");
    const masked: string[] = [];
    const sock = socket(secretGranter({ store, onGranted: (values) => { masked.push(...values); } }));
    const r = io();
    expect(await laneCliMain(["secret", "env"], { env, connect: sock.connect, ...r.deps })).toBe(0);
    expect(r.out).toEqual(["export LOCAL_TOKEN='local throwaway'"]);
    expect(masked).toEqual(["local throwaway"]);
    expect(sock.published).toEqual([]);
    expect(sock.logs).toEqual([]);
  } finally { state.done(); }
});
