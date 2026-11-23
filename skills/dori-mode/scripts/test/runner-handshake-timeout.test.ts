import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import type { Timers } from "../src/runner/call.ts";
import { backoffMs, HANDSHAKE_TIMEOUT_MS, RunnerClient } from "../src/runner/client.ts";
import { RunnerHub } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { acceptRunners } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { acceptWs, dialWs } from "../src/runner/ws-transport.ts";
import { fakeClock, withState } from "./fakes.ts";
import { memoryNetwork, memoryPair, type MemoryPairOptions } from "./support/memory-transport.ts";

const LABEL = "r1";

let tmp: ReturnType<typeof withState>;
const cleanups: (() => void)[] = [];
beforeEach(() => { tmp = withState(); });
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); tmp.done(); });

/** Timers the test fires by hand, as the client's `timer` and as `acceptRunners`' `timers`; a cancelled timer leaves `armed`. */
const manualTimers = () => {
  const armed: { ms: number; fire: () => void }[] = [];
  const waiting: (() => void)[] = [];
  const timer = (ms: number, fire: () => void) => {
    const entry = { ms, fire };
    armed.push(entry);
    for (const wake of waiting.splice(0)) wake();
    return () => { const index = armed.indexOf(entry); if (index >= 0) armed.splice(index, 1); };
  };
  const timers: Timers = { set: (fn, ms) => timer(ms, fn), clear: (cancel) => { (cancel as () => void)(); } };
  return {
    armed,
    timer,
    timers,
    /** The armed handshake deadlines (the supervisor's silence watchdog stays armed beside them). */
    deadlines: () => armed.filter((t) => t.ms === HANDSHAKE_TIMEOUT_MS),
    /** Resolves once a handshake deadline is armed. */
    handshake: async (): Promise<() => void> => {
      while (!armed.some((t) => t.ms === HANDSHAKE_TIMEOUT_MS)) await new Promise<void>((resolve) => { waiting.push(resolve); });
      const entry = armed.find((t) => t.ms === HANDSHAKE_TIMEOUT_MS)!;
      return () => { armed.splice(armed.indexOf(entry), 1); entry.fire(); };
    },
  };
};

/** Runner pieces in their own directory, enrolled with `supervisor` up front when given. */
const runnerParts = (supervisor?: SupervisorAuth) => {
  const dir = join(tmp.dir, "runner");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clock = fakeClock(1_000);
  const outbox = new Outbox(dir, { now: clock.now });
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  cleanups.push(() => { outbox.close(); state.close(); });
  if (!supervisor) return { outbox, state, clock };
  const auth = new RunnerAuth(dir);
  const code = supervisor.issueCode(LABEL).code;
  const request = auth.enrollRequest(code, LABEL, "host-1");
  const enrolled = supervisor.enroll(request);
  if (!enrolled.ok) throw new Error(enrolled.detail);
  auth.pinSupervisor(code, request, enrolled.reply, supervisor.fingerprint);
  return { outbox, state, clock, auth };
};

const supervisorParts = (auth: boolean) => {
  const stateDir = join(tmp.dir, "sup");
  const hub = new RunnerHub({ stateDir, commit: () => true, now: () => 1_000, monotonic: () => 1_000, epoch: 3 });
  const supervisorAuth = auth ? new SupervisorAuth(stateDir, { now: () => 1_000 }) : undefined;
  cleanups.push(() => { supervisorAuth?.close(); hub.close(); });
  return { hub, auth: supervisorAuth };
};

test("a runner that gets no hello.ok within the handshake deadline closes the link and reconnects after the backoff", async () => {
  const { outbox, state } = runnerParts();
  const timers = manualTimers();
  const pairs: ReturnType<typeof memoryPair>[] = [];
  // A peer that accepts the connection and never answers.
  const connect: Connector = async () => { const pair = memoryPair(); pairs.push(pair); return pair.runner; };
  const sleeps: { ms: number; wake: () => void }[] = [];
  let slept: (() => void) | undefined;
  const clock = { now: () => 1_000, sleep: (ms: number) => new Promise<void>((wake) => { sleeps.push({ ms, wake }); slept?.(); }) };
  const logs: string[] = [];
  const client = new RunnerClient({ label: LABEL, hostId: "host-1" }, {
    connect, outbox, state, clock, random: () => 0.5, timer: timers.timer, log: (line) => { logs.push(line); },
  });
  const abort = new AbortController();
  const running = client.run(abort.signal);
  const expire = await timers.handshake();
  expect(pairs).toHaveLength(1);
  expect(pairs[0]!.runner.open).toBe(true);
  expect(sleeps).toEqual([]);

  const backedOff = new Promise<void>((resolve) => { slept = resolve; });
  expire();
  expect(pairs[0]!.runner.open).toBe(false);
  expect(logs).toEqual([`RUNNER_HELLO_TIMEOUT no hello.ok within ${HANDSHAKE_TIMEOUT_MS / 1000}s`]);
  await backedOff;
  expect(sleeps.map((s) => s.ms)).toEqual([backoffMs(0, () => 0.5)]);
  expect(pairs).toHaveLength(1);

  sleeps[0]!.wake();
  const expireSecond = await timers.handshake();
  expect(pairs).toHaveLength(2);
  abort.abort();
  // The second attempt is as silent as the first; its deadline ends it so `run` sees the abort.
  expireSecond();
  await running;
});

test("a hello.ok in time cancels the runner's handshake deadline", async () => {
  const { outbox, state, clock } = runnerParts();
  const { hub } = supervisorParts(false);
  const net = memoryNetwork();
  cleanups.push(acceptRunners(hub, net.listener, { log: () => {}, timers: { set: () => undefined, clear: () => {} } }));
  const timers = manualTimers();
  const client = new RunnerClient({ label: LABEL, hostId: "host-1" }, { connect: net.connect, outbox, state, clock, timer: timers.timer });
  const outcome = client.connectOnce();
  await timers.handshake();
  net.pairs[0]!.pump();
  expect(await outcome).toMatchObject({ ok: true });
  expect(timers.armed).toEqual([]);
  expect(client.connected).toBe(true);
});

const supervisorRig = (options: MemoryPairOptions = {}) => {
  const { hub, auth } = supervisorParts(true);
  const net = memoryNetwork(options);
  const timers = manualTimers();
  const logs: string[] = [];
  cleanups.push(acceptRunners(hub, net.listener, { auth, log: (line) => { logs.push(line); }, timers: timers.timers }));
  return { auth: auth as SupervisorAuth, net, timers, logs };
};

test("the supervisor closes a connection that sends nothing within the handshake deadline", async () => {
  const sup = supervisorRig();
  const runnerEnd: Transport = await sup.net.connect();
  const supervisorEnd = sup.net.pairs[0]!.supervisor;
  const expire = await sup.timers.handshake();
  expect(supervisorEnd.open).toBe(true);
  expire();
  expect(supervisorEnd.open).toBe(false);
  expect(runnerEnd.open).toBe(false);
  expect(sup.logs).toEqual([`RUNNER_HELLO_TIMEOUT runner=- phase=start not admitted within ${HANDSHAKE_TIMEOUT_MS / 1000}s`]);
});

test("the supervisor closes a connection whose auth.proof never arrives, and keeps an admitted one", async () => {
  // The runner's proof is lost on the way, so the supervisor waits in phase proof.
  const sup = supervisorRig({ drop: (line, direction) => direction === "to-supervisor" && (JSON.parse(line) as { type: string }).type === "auth.proof" });
  const { outbox, state, clock, auth } = runnerParts(sup.auth);
  const client = new RunnerClient({ label: LABEL, hostId: "host-1" }, { connect: sup.net.connect, outbox, state, clock, auth, timer: () => () => {} });
  const outcome = client.connectOnce();
  const expire = await sup.timers.handshake();
  while (sup.net.pairs[0]!.pump() > 0) { /* hello, challenge, the dropped proof */ }
  expire();
  expect(sup.net.pairs[0]!.supervisor.open).toBe(false);
  expect(await outcome).toMatchObject({ ok: false, code: "RUNNER_CLOSED" });
  expect(sup.logs).toEqual([`RUNNER_HELLO_TIMEOUT runner=${LABEL} phase=proof not admitted within ${HANDSHAKE_TIMEOUT_MS / 1000}s`]);
});

test("the supervisor cancels the deadline of a connection it admits", async () => {
  const sup = supervisorRig();
  const { outbox, state, clock, auth } = runnerParts(sup.auth);
  const client = new RunnerClient({ label: LABEL, hostId: "host-1" }, { connect: sup.net.connect, outbox, state, clock, auth, timer: () => () => {} });
  const outcome = client.connectOnce();
  await sup.timers.handshake();
  while (sup.net.pairs[0]!.pump() > 0) { /* the whole handshake */ }
  expect(await outcome).toMatchObject({ ok: true });
  expect(sup.timers.deadlines()).toEqual([]);
  expect(sup.net.pairs[0]!.supervisor.open).toBe(true);
});

test("over real sockets, a silent connection that takes the runner's slot first does not keep the supervisor out", async () => {
  const SHORT_DEADLINE_MS = 300;
  const { hub, auth } = supervisorParts(true);
  const { outbox, state, auth: runnerAuth } = runnerParts(auth);
  const worker = acceptWs("127.0.0.1:0");
  cleanups.push(() => { worker.close(); });
  let runnerConnected: (() => void) | undefined;
  const runnerConnectedNow = new Promise<void>((resolve) => { runnerConnected = resolve; });
  // Hands each line to the client first, then reports once the client counts itself connected (its hello.ok).
  const connect: Connector = async () => {
    const transport = await worker.connect();
    return {
      send: (line) => { transport.send(line); },
      onLine: (handler) => transport.onLine((line) => { handler(line); if (client.connected) runnerConnected?.(); }),
      onClose: (handler) => transport.onClose(handler),
      close: (reason) => { transport.close(reason); },
      get open() { return transport.open; },
    };
  };
  const client: RunnerClient = new RunnerClient({ label: LABEL, hostId: "host-1" }, {
    connect, outbox, state, auth: runnerAuth, random: () => 0.5,
    clock: { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
    // The real handshake deadline, shortened so the test runs in about a second.
    timer: (ms, fire) => {
      const handle = setTimeout(fire, ms === HANDSHAKE_TIMEOUT_MS ? SHORT_DEADLINE_MS : ms);
      return () => { clearTimeout(handle); };
    },
  });
  const abort = new AbortController();
  const running = client.run(abort.signal);
  cleanups.push(() => { abort.abort(); });

  // The squatter connects first, takes the slot (the runner's hello goes to it) and never answers.
  const squatter = new WebSocket(`ws://127.0.0.1:${worker.port}`);
  const squatterClosed = new Promise<void>((resolve) => { squatter.addEventListener("close", () => { resolve(); }); });
  await new Promise<void>((resolve) => { squatter.addEventListener("message", () => { resolve(); }, { once: true }); });
  const started = Date.now();

  const logs: string[] = [];
  let admitted: (() => void) | undefined;
  const admittedNow = new Promise<void>((resolve) => { admitted = resolve; });
  const network = dialWs({ endpoints: () => ({ [LABEL]: `127.0.0.1:${worker.port}` }), random: () => 0.5, log: (line) => { logs.push(line); } });
  const stop = acceptRunners(hub, network, { auth, log: (line) => { logs.push(line); }, onHello: () => { admitted?.(); } });
  cleanups.push(() => { stop(); network.close(); });

  // Deadline, the runner's 1 s backoff and the supervisor's 1 s redial, with room to spare; never without the fix.
  const bound = SHORT_DEADLINE_MS + 2 * backoffMs(0, () => 0.5) + 2_000;
  let expired: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    admittedNow.then(() => "admitted"),
    new Promise<string>((resolve) => { expired = setTimeout(() => { resolve("still locked out"); }, bound); }),
  ]);
  clearTimeout(expired);
  expect(outcome).toBe("admitted");
  expect(Date.now() - started).toBeLessThan(bound);
  await squatterClosed;
  await runnerConnectedNow;
  expect(logs.filter((line) => line.startsWith(`RUNNER_CONNECTED runner=${LABEL}`))).toHaveLength(1);
  expect(client.connected).toBe(true);
  abort.abort();
  await running;
});
