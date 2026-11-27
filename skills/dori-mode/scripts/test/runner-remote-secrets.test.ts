import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerAuth, SupervisorAuth, enrollOverStdio, type PendingHello, type Session } from "../src/runner/auth.ts";
import { SECRET_COMMAND_MAX_TIMEOUT_SEC } from "../src/config.ts";
import { HANDSHAKE_TIMEOUT_MS, RunnerClient, SECRET_RUN_TIMEOUT_MS, SECRET_TIMEOUT_MS } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import {
  decodeFrame, encodeFrame, supervisorControl,
  type AnySupervisorControl, type RunnerControl, type RunnerControlBodies, type SupervisorControlBodies, type SupervisorControlType,
} from "../src/runner/protocol.ts";
import { hostCommandRouter, remoteSecretGranter, remoteSecretRunner } from "../src/runner/remote-secrets.ts";
import { secretCommandRunner, type SecretRunResult } from "../src/runner/secret-run.ts";
import type { SecretCommand } from "../src/config.ts";
import type { SecretFrame } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Transport } from "../src/runner/transport.ts";
import { memoryNetwork } from "./support/memory-transport.ts";
import { fakeClock, withState } from "./fakes.ts";

const clock = fakeClock(1_000_000);
const LABEL = "r1";
const HOST = "host-1";
const EPOCH = 2;
const VALUE = "dori-test-throwaway-123";

let tmp: ReturnType<typeof withState>;
const cleanups: (() => void)[] = [];
beforeEach(() => { tmp = withState(); clock.at = 1_000_000; });
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); tmp.done(); });

/** A secret request the fake supervisor saw: `secret.get` or `secret.run`. */
type SecretGet = RunnerControl<"secret.get"> | RunnerControl<"secret.run">;
type Reply = <T extends SupervisorControlType>(type: T, body: SupervisorControlBodies[T]) => void;

/**
 * A fake supervisor: the real signed handshake (SupervisorAuth) on an in-memory network, answering `hello.ok` with
 * `proto`, then handing every MAC-checked `secret.get` to `onSecret` with the session and a sealed reply function.
 */
const supervisor = (opts: { proto?: number; auth?: boolean } = {}) => {
  const stateDir = join(tmp.dir, "sup");
  const auth = new SupervisorAuth(stateDir, { now: clock.now });
  const net = memoryNetwork();
  const received: SecretGet[] = [];
  const badMacs: string[] = [];
  let onSecret: (frame: SecretGet, session: Session | undefined, reply: Reply) => void = () => {};
  net.listener.onConnection((link: Transport) => {
    let pending: PendingHello | undefined;
    let session: Session | undefined;
    let gen = 0;
    const reply: Reply = (type, body) => {
      const frame = supervisorControl({ runner: LABEL, gen, epoch: EPOCH }, type, body) as AnySupervisorControl;
      link.send(encodeFrame(session ? session.seal(frame) : frame));
    };
    const ok = (): void => { reply("hello.ok", { proto: opts.proto ?? 6, epoch: EPOCH, eventAck: 0 }); };
    link.onLine((line) => {
      const frame = decodeFrame(line, "runner");
      if (frame.type === "hello") {
        const hello = frame.body as RunnerControlBodies["hello"];
        gen = hello.gen;
        if (opts.auth === false) { ok(); return; }
        const begun = auth.beginHello(hello);
        if (!begun.ok) throw new Error(begun.detail);
        pending = begun.pending;
        reply("hello.challenge", begun.challenge);
        return;
      }
      if (frame.type === "auth.proof") {
        session = auth.finishHello(pending as PendingHello, (frame.body as RunnerControlBodies["auth.proof"]).sig);
        if (!session) throw new Error("proof did not verify");
        ok();
        return;
      }
      if (session && !session.check(frame)) { badMacs.push(frame.type); return; }
      if (frame.type === "secret.get" || frame.type === "secret.run") { received.push(frame as SecretGet); onSecret(frame as SecretGet, session, reply); }
    });
  });
  cleanups.push(() => { auth.close(); });
  return { auth, net, received, badMacs, set onSecret(f: typeof onSecret) { onSecret = f; } };
};
type Sup = ReturnType<typeof supervisor>;

/** A runner with its state, outbox, enrolled keys (unless `auth: false`) and a client with a manual secret timer. */
const runner = (sup: Sup, opts: { auth?: boolean } = {}) => {
  const dir = join(tmp.dir, "runner");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const logs: string[] = [];
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    // The handshake deadline never fires here; only the secret timers are recorded.
    if (ms === HANDSHAKE_TIMEOUT_MS) return () => {};
    const t = { ms, fire, cancelled: false };
    timers.push(t);
    return () => { t.cancelled = true; };
  };
  let auth: RunnerAuth | undefined;
  if (opts.auth !== false) {
    auth = new RunnerAuth(dir);
    const params = { auth, code: sup.auth.issueCode(LABEL).code, label: LABEL, hostId: HOST, expectedFingerprint: sup.auth.fingerprint };
    const accepted = sup.auth.enroll(decodeFrame(enrollOverStdio(params) as string, "runner").body as RunnerControlBodies["enroll"]);
    if (!accepted.ok) throw new Error(accepted.detail);
    const answer = Buffer.from(encodeFrame(supervisorControl({ runner: LABEL, gen: 0, epoch: 0 }, "enroll.ok", accepted.reply))).toString("base64");
    expect(enrollOverStdio(params, answer)).toBeUndefined();
  }
  const client = new RunnerClient({ label: LABEL, hostId: HOST }, {
    connect: sup.net.connect, outbox, state, clock, timer, log: (line) => { logs.push(line); }, ...(auth ? { auth } : {}),
  });
  cleanups.push(() => { outbox.close(); state.close(); });
  return { client, logs, timers };
};

/** Pumps the network on microtask turns until `promise` settles (bounded: fails instead of hanging). */
const drive = async <T>(sup: Sup, promise: Promise<T>): Promise<T> => {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 100 && !settled; i += 1) {
    await Promise.resolve();
    for (const pair of sup.net.pairs) pair.pump();
  }
  expect(settled).toBe(true);
  return promise;
};

const connected = async (opts: { proto?: number; auth?: boolean } = {}) => {
  const sup = supervisor(opts);
  const run = runner(sup, opts);
  expect(await drive(sup, run.client.connectOnce())).toMatchObject({ ok: true });
  return { sup, run };
};

/** Seals `plaintext` for the answer to `frame` the way the supervisor does (s2r, aad of the answer frame). */
const sealFor = (session: Session, frame: SecretGet, plaintext: string, rid = frame.body.rid) =>
  session.sealSecret("s2r", { runner: LABEL, gen: frame.gen, epoch: EPOCH, type: "secret.value", rid }, plaintext);

describe("remote runner secrets over the link", () => {
  test("a grant: secret.get carries key, an empty names list and a 32-hex rid; the sealed values reach the lane and the mask", async () => {
    const { sup, run } = await connected();
    sup.onSecret = (frame, session, reply) => {
      reply("secret.value", { rid: frame.body.rid, ok: true, sealed: sealFor(session as Session, frame, JSON.stringify({ values: { API_TOKEN: VALUE } })) });
    };
    const masked: string[] = [];
    const logs: string[] = [];
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => "acme/app", log: (l) => { logs.push(l); }, onGranted: (v) => { masked.push(...v); } });
    expect(await drive(sup, grant("lane-a"))).toEqual({ ok: true, values: { API_TOKEN: VALUE } });
    expect(sup.received).toHaveLength(1);
    expect(sup.received[0]?.body).toEqual({ rid: sup.received[0]?.body.rid as string, key: "lane-a", names: [] });
    expect(sup.received[0]?.body.rid).toMatch(/^[0-9a-f]{32}$/);
    expect(sup.badMacs).toEqual([]);
    expect(masked).toEqual([VALUE]);
    expect(logs).toEqual([]);
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0]).toMatchObject({ ms: SECRET_TIMEOUT_MS, cancelled: true });
    expect([...logs, ...run.logs].join("\n")).not.toContain(VALUE);
  });

  test("a refusal passes through with its code and detail, logged without values", async () => {
    const { sup, run } = await connected();
    sup.onSecret = (frame, _s, reply) => {
      reply("secret.value", { rid: frame.body.rid, ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not receive API_TOKEN (config secrets)" });
    };
    const logs: string[] = [];
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => undefined, log: (l) => { logs.push(l); } });
    expect(await drive(sup, grant("lane-a"))).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not receive API_TOKEN (config secrets)" });
    expect(sup.received[0]?.body).not.toHaveProperty("repo");
    expect(logs).toEqual([]);
  });

  test("no answer within 30 s is RUNNER_SECRET_TIMEOUT, and a late answer is dropped", async () => {
    const { sup, run } = await connected();
    let late: (() => void) | undefined;
    sup.onSecret = (frame, session, reply) => {
      late = () => { reply("secret.value", { rid: frame.body.rid, ok: true, sealed: sealFor(session as Session, frame, JSON.stringify({ values: { API_TOKEN: VALUE } })) }); };
    };
    const answer = run.client.secretRequest("secret.get", { key: "lane-a", names: ["API_TOKEN"] });
    for (const pair of sup.net.pairs) pair.pump();
    expect(sup.received).toHaveLength(1);
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0]?.ms).toBe(SECRET_TIMEOUT_MS);
    run.timers[0]?.fire();
    expect(await answer).toEqual({ ok: false, code: "RUNNER_SECRET_TIMEOUT", detail: "no answer to secret.get within 30s" });
    late?.();
    for (const pair of sup.net.pairs) pair.pump();
    expect(run.client.connected).toBe(true);
  });

  test("a lost connection settles open requests RUNNER_SECRET_FAILED, and later requests are not connected", async () => {
    const { sup, run } = await connected();
    const answer = run.client.secretRequest("secret.get", { key: "lane-a", names: ["API_TOKEN"] });
    sup.net.pairs.at(-1)?.sever("link down");
    expect(await answer).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "connection lost" });
    expect(run.timers[0]?.cancelled).toBe(true);
    expect(await run.client.secretRequest("secret.get", { key: "lane-a", names: ["API_TOKEN"] }))
      .toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "not connected" });
  });

  test("a supervisor that speaks proto 5 gets no secret frame: RUNNER_SECRET_OUTDATED", async () => {
    const { sup, run } = await connected({ proto: 5 });
    const logs: string[] = [];
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => "acme/app", log: (l) => { logs.push(l); } });
    expect(await grant("lane-a")).toEqual({ ok: false, code: "RUNNER_SECRET_OUTDATED", detail: "supervisor speaks proto 5; secret.get needs proto 6" });
    for (const pair of sup.net.pairs) pair.pump();
    expect(sup.received).toEqual([]);
    expect(run.timers).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("an unauthenticated link sends nothing: RUNNER_SECRET_UNSUPPORTED", async () => {
    const { sup, run } = await connected({ auth: false });
    expect(await run.client.secretRequest("secret.get", { key: "lane-a", names: ["API_TOKEN"] }))
      .toEqual({ ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "unauthenticated link" });
    for (const pair of sup.net.pairs) pair.pump();
    expect(sup.received).toEqual([]);
  });

  test.each([
    ["a flipped ciphertext byte", (box: { n: string; c: string }) => {
      const c = Buffer.from(box.c, "base64");
      c[0] = (c[0] as number) ^ 1;
      return { n: box.n, c: c.toString("base64") };
    }, undefined],
    ["a box sealed for another rid", (box: { n: string; c: string }) => box, "0".repeat(32)],
  ] as const)("%s is RUNNER_SECRET_FAILED sealed reply did not open", async (_name, tamper, otherRid) => {
    const { sup, run } = await connected();
    sup.onSecret = (frame, session, reply) => {
      const box = sealFor(session as Session, frame, JSON.stringify({ values: { API_TOKEN: VALUE } }), otherRid ?? frame.body.rid);
      reply("secret.value", { rid: frame.body.rid, ok: true, sealed: tamper(box) });
    };
    const logs: string[] = [];
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => undefined, log: (l) => { logs.push(l); } });
    expect(await drive(sup, grant("lane-a"))).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "sealed reply did not open" });
    expect(logs).toEqual([]);
  });

  test("a grant validates every returned name and value", async () => {
    const { sup, run } = await connected();
    sup.onSecret = (frame, session, reply) => {
      reply("secret.value", { rid: frame.body.rid, ok: true, sealed: sealFor(session as Session, frame, JSON.stringify({ values: { invalid: VALUE } })) });
    };
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    const result = await drive(sup, grant("lane-a"));
    expect(result).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "the supervisor's grant is not a map of secret names to values" });
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });


  test("secret.run: key, op and repo go out, the sealed result opens to exit code and output for the lane", async () => {
    const { sup, run } = await connected();
    const result = { exitCode: 5, stdout: "out [REDACTED:API_TOKEN]", stderr: "warn", truncated: true };
    sup.onSecret = (frame, session, reply) => {
      const box = (session as Session).sealSecret("s2r", { runner: LABEL, gen: frame.gen, epoch: EPOCH, type: "secret.run.result", rid: frame.body.rid }, JSON.stringify(result));
      reply("secret.run.result", { rid: frame.body.rid, ok: true, sealed: box });
    };
    const logs: string[] = [];
    const runOp = remoteSecretRunner({ client: run.client, laneRepo: async () => "acme/app", log: (l) => { logs.push(l); } });
    expect(await drive(sup, runOp("lane-a", "deploy"))).toEqual({ ok: true, ...result });
    expect(sup.received.map((f) => f.type)).toEqual(["secret.run"]);
    expect(sup.received[0]?.body).toEqual({ rid: sup.received[0]?.body.rid as string, key: "lane-a", op: "deploy", repo: "acme/app" });
    expect(sup.badMacs).toEqual([]);
    expect(logs).toEqual(["RUNNER_SECRET_RUN lane=lane-a op=deploy exit=5"]);
    expect([...logs, ...run.logs].join("\n")).not.toContain(VALUE);
  });

  test("secret.run waits for the longest op timeoutSec plus a margin, not the 30 s of secret.get", async () => {
    const { sup, run } = await connected();
    const result = { exitCode: 0, stdout: "deployed", stderr: "", truncated: false };
    let answer: (() => void) | undefined;
    sup.onSecret = (frame, session, reply) => {
      answer = () => {
        const box = (session as Session).sealSecret("s2r", { runner: LABEL, gen: frame.gen, epoch: EPOCH, type: "secret.run.result", rid: frame.body.rid }, JSON.stringify(result));
        reply("secret.run.result", { rid: frame.body.rid, ok: true, sealed: box });
      };
    };
    const runOp = remoteSecretRunner({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    const pending = runOp("lane-a", "deploy");
    await drive(sup, (async () => { while (!answer) await Promise.resolve(); })());
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0]?.ms).toBe(SECRET_RUN_TIMEOUT_MS);
    expect(SECRET_RUN_TIMEOUT_MS).toBeGreaterThan(SECRET_COMMAND_MAX_TIMEOUT_SEC * 1000);
    answer?.();
    expect(await drive(sup, pending)).toEqual({ ok: true, ...result });
    expect(run.timers[0]?.cancelled).toBe(true);

    const late = run.client.secretRequest("secret.run", { key: "lane-a", op: "deploy" });
    for (const pair of sup.net.pairs) pair.pump();
    run.timers[1]?.fire();
    expect(await late).toEqual({ ok: false, code: "RUNNER_SECRET_TIMEOUT", detail: `no answer to secret.run within ${SECRET_RUN_TIMEOUT_MS / 1000}s` });
  });

  test("secret.run: a refusal passes through; a box sealed as secret.value or a malformed result is FAILED", async () => {
    const { sup, run } = await connected();
    let answer: "deny" | "wrong-type" | "malformed" = "deny";
    sup.onSecret = (frame, session, reply) => {
      const rid = frame.body.rid;
      if (answer === "deny") { reply("secret.run.result", { rid, ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not run deploy (config secretCommands)" }); return; }
      const type = answer === "wrong-type" ? "secret.value" : "secret.run.result";
      const box = (session as Session).sealSecret("s2r", { runner: LABEL, gen: frame.gen, epoch: EPOCH, type, rid }, JSON.stringify(answer === "wrong-type" ? { exitCode: 0, stdout: "", stderr: "", truncated: false } : { exitCode: "0" }));
      reply("secret.run.result", { rid, ok: true, sealed: box });
    };
    const logs: string[] = [];
    const runOp = remoteSecretRunner({ client: run.client, laneRepo: async () => undefined, log: (l) => { logs.push(l); } });
    expect(await drive(sup, runOp("lane-a", "deploy"))).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not run deploy (config secretCommands)" });
    expect(sup.received[0]?.body).not.toHaveProperty("repo");
    answer = "wrong-type";
    expect(await drive(sup, runOp("lane-a", "deploy"))).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "sealed reply did not open" });
    answer = "malformed";
    expect(await drive(sup, runOp("lane-a", "deploy"))).toMatchObject({ ok: false, code: "RUNNER_SECRET_FAILED" });
    expect(logs).toEqual([
      "RUNNER_SECRET_DENIED lane=lane-a op=deploy code=RUNNER_SECRET_DENIED",
      "RUNNER_SECRET_DENIED lane=lane-a op=deploy code=RUNNER_SECRET_FAILED",
      "RUNNER_SECRET_DENIED lane=lane-a op=deploy code=RUNNER_SECRET_FAILED",
    ]);
  });
});

describe("hostCommandRouter (worker runner-config hostCommands)", () => {
  const hostOp = (argv: readonly string[], lanes: readonly string[]): SecretCommand => ({ argv, secrets: [], lanes, repos: [], timeoutSec: 30 });
  /** A router over a real secretCommandRunner (real spawn) and a fake supervisor that records each op it is sent. */
  const router = (table: Record<string, SecretCommand>, supervisorReply: SecretRunResult) => {
    const sent: string[] = [];
    const logs: string[] = [];
    const onHost = secretCommandRunner({
      store: { read: (name) => Promise.reject(new Error(`no store (${name})`)) },
      commands: async () => table, source: "runner-config hostCommands", log: (l) => { logs.push(l); }, home: tmp.dir,
    });
    const route = hostCommandRouter({
      hostCommands: () => table,
      onHost: (key, op) => onHost(key, op),
      onSupervisor: async (_key, op) => { sent.push(op); return supervisorReply; },
      allowedOnHost: async (key) => Object.entries(table).filter(([, rule]) => rule.lanes.some((l) => l === key || l === "*")).map(([name]) => name),
    });
    return { route, sent, logs };
  };
  const denied: SecretRunResult = { ok: false, code: "RUNNER_SECRET_DENIED", detail: "nope is not a configured secret command (config secretCommands); ops this lane may run: probe-sandbox" };

  test("a listed op runs on this host and never reaches the supervisor", async () => {
    const r = router({ "worker-probe": hostOp(["/bin/sh", "-c", "echo host=worker lane=$DORI_LANE_KEY"], ["lane-a"]) }, denied);
    const result = await r.route("lane-a", "worker-probe");
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: "host=worker lane=lane-a\n", stderr: "", truncated: false });
    expect(r.sent).toEqual([]);
    expect(r.logs).toEqual(["RUNNER_SECRET_RUN lane=lane-a op=worker-probe exit=0"]);
  });

  test("a listed op the lane does not match is refused here, naming runner-config hostCommands", async () => {
    const r = router({ "worker-probe": hostOp(["/bin/true"], ["lane-b"]) }, denied);
    const result = await r.route("lane-a", "worker-probe");
    expect(result).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not run worker-probe (runner-config hostCommands); ops this lane may run: none" });
    expect(r.sent).toEqual([]);
  });

  test("an unlisted op goes to the supervisor; its refusal lists the supervisor's and this lane's worker ops together", async () => {
    const r = router({ "worker-probe": hostOp(["/bin/true"], ["*"]), "other-lane": hostOp(["/bin/true"], ["lane-b"]) }, denied);
    const result = await r.route("lane-a", "nope");
    expect(r.sent).toEqual(["nope"]);
    expect(result).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "nope is not a configured secret command (config secretCommands); ops this lane may run: probe-sandbox, worker-probe" });
  });

  test("without hostCommands the supervisor's answer passes through unchanged", async () => {
    const ran: SecretRunResult = { ok: true, exitCode: 0, stdout: "host=home-server\n", stderr: "", truncated: false };
    expect(await router({}, ran).route("lane-a", "probe-sandbox")).toEqual(ran);
    expect(await router({}, denied).route("lane-a", "nope")).toEqual(denied);
  });
});
