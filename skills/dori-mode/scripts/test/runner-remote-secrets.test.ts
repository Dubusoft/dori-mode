import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerAuth, SupervisorAuth, enrollOverStdio, type PendingHello, type Session } from "../src/runner/auth.ts";
import { SECRET_COMMAND_MAX_TIMEOUT_SEC } from "../src/config.ts";
import { RunnerClient, SECRET_RUN_TIMEOUT_MS, SECRET_TIMEOUT_MS } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import {
  decodeFrame, encodeFrame, supervisorControl,
  type AnySupervisorControl, type RunnerControl, type RunnerControlBodies, type SupervisorControlBodies, type SupervisorControlType,
} from "../src/runner/protocol.ts";
import { remoteSecretDepositor, remoteSecretGranter, remoteSecretRunner } from "../src/runner/remote-secrets.ts";
import { supervisorDepositor, supervisorGranter, supervisorSecretHandler } from "../src/runner/secret-serve.ts";
import type { SecretFrame } from "../src/runner/serve.ts";
import type { SecretRule } from "../src/config.ts";
import { SecretStoreError } from "../src/secret-store.ts";
import { RunnerState } from "../src/runner/state.ts";
import { memoryNetwork, type Transport } from "../src/runner/transport.ts";
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

/** A secret request the fake supervisor saw: `secret.get`, `secret.run` or `secret.put`. */
type SecretGet = RunnerControl<"secret.get"> | RunnerControl<"secret.run"> | RunnerControl<"secret.put">;
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
      if (frame.type === "secret.get" || frame.type === "secret.run" || frame.type === "secret.put") { received.push(frame as SecretGet); onSecret(frame as SecretGet, session, reply); }
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
  test("a grant: secret.get carries key, names, repo and a 32-hex rid; the sealed values reach the lane and the mask", async () => {
    const { sup, run } = await connected();
    sup.onSecret = (frame, session, reply) => {
      reply("secret.value", { rid: frame.body.rid, ok: true, sealed: sealFor(session as Session, frame, JSON.stringify({ values: { API_TOKEN: VALUE } })) });
    };
    const masked: string[] = [];
    const logs: string[] = [];
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => "acme/app", log: (l) => { logs.push(l); }, onGranted: (v) => { masked.push(...v); } });
    expect(await drive(sup, grant("lane-a", ["API_TOKEN"]))).toEqual({ ok: true, values: { API_TOKEN: VALUE } });
    expect(sup.received).toHaveLength(1);
    expect(sup.received[0]?.body).toEqual({ rid: sup.received[0]?.body.rid as string, key: "lane-a", names: ["API_TOKEN"], repo: "acme/app" });
    expect(sup.received[0]?.body.rid).toMatch(/^[0-9a-f]{32}$/);
    expect(sup.badMacs).toEqual([]);
    expect(masked).toEqual([VALUE]);
    expect(logs).toEqual(["RUNNER_SECRET_GRANTED lane=lane-a names=API_TOKEN"]);
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
    expect(await drive(sup, grant("lane-a", ["API_TOKEN", "OTHER"]))).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not receive API_TOKEN (config secrets)" });
    expect(sup.received[0]?.body).not.toHaveProperty("repo");
    expect(logs).toEqual(["RUNNER_SECRET_DENIED lane=lane-a names=API_TOKEN,OTHER code=RUNNER_SECRET_DENIED"]);
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
    expect(await grant("lane-a", ["API_TOKEN"])).toEqual({ ok: false, code: "RUNNER_SECRET_OUTDATED", detail: "supervisor speaks proto 5; secrets need proto 6" });
    for (const pair of sup.net.pairs) pair.pump();
    expect(sup.received).toEqual([]);
    expect(run.timers).toEqual([]);
    expect(logs).toEqual(["RUNNER_SECRET_DENIED lane=lane-a names=API_TOKEN code=RUNNER_SECRET_OUTDATED"]);
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
    expect(await drive(sup, grant("lane-a", ["API_TOKEN"]))).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "sealed reply did not open" });
    expect(logs).toEqual(["RUNNER_SECRET_DENIED lane=lane-a names=API_TOKEN code=RUNNER_SECRET_FAILED"]);
  });

  test("a grant that does not carry exactly the asked names is refused", async () => {
    const { sup, run } = await connected();
    sup.onSecret = (frame, session, reply) => {
      reply("secret.value", { rid: frame.body.rid, ok: true, sealed: sealFor(session as Session, frame, JSON.stringify({ values: { OTHER: VALUE } })) });
    };
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    const result = await drive(sup, grant("lane-a", ["API_TOKEN"]));
    expect(result).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "the supervisor's grant does not carry exactly API_TOKEN" });
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  test("ssh-key kinds in the sealed grant reach the lane; a kind for an ungranted name or an unknown kind is refused", async () => {
    const { sup, run } = await connected();
    const answers = [
      { values: { DEPLOY_KEY: VALUE }, kinds: { DEPLOY_KEY: "ssh-key" } },
      { values: { DEPLOY_KEY: VALUE }, kinds: { OTHER: "ssh-key" } },
      { values: { DEPLOY_KEY: VALUE }, kinds: { DEPLOY_KEY: "pem" } },
    ];
    sup.onSecret = (frame, session, reply) => {
      reply("secret.value", { rid: frame.body.rid, ok: true, sealed: sealFor(session as Session, frame, JSON.stringify(answers.shift())) });
    };
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    expect(await drive(sup, grant("lane-a", ["DEPLOY_KEY"]))).toEqual({ ok: true, values: { DEPLOY_KEY: VALUE }, kinds: { DEPLOY_KEY: "ssh-key" } });
    for (let i = 0; i < 2; i++) {
      const refused = await drive(sup, grant("lane-a", ["DEPLOY_KEY"]));
      expect(refused).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "the supervisor's grant does not carry exactly DEPLOY_KEY" });
    }
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

describe("lane-made secrets over the link (a remote runner such as the mac-mini)", () => {
  /** The production supervisor handler (granter + depositor) over an in-memory store, answering on the fake link. */
  const realSupervisor = (sup: Sup, rules: Record<string, SecretRule>, proto = 8) => {
    const store = new Map<string, string>();
    const logs: string[] = [];
    const log = (line: string): void => { logs.push(line); };
    const base = { stateDir: join(tmp.dir, "sup-state"), rules: async () => rules, now: clock.now, log };
    const handler = supervisorSecretHandler({
      laneOwner: () => LABEL, runnerUnsandboxed: () => false, log,
      granter: supervisorGranter({
        ...base, commands: async () => ({}),
        store: { read: async (name) => { const v = store.get(name); if (v === undefined) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING ${name}`); return v; } },
      }),
      depositor: supervisorDepositor({
        ...base, store: { put: async (name, value) => { const created = !store.has(name); store.set(name, value); return { name, backend: "plain" as const, created }; } },
      }),
    });
    const answer = (frame: SecretGet, session: Session | undefined, reply: Reply): void => {
      void handler(LABEL, frame as SecretFrame, { session, proto, head: { runner: LABEL, gen: frame.gen, epoch: EPOCH }, reply: (type, body) => { reply(type, body); } });
    };
    sup.onSecret = answer;
    return { store, logs, answer };
  };

  test("an allowed lane's value is stored sealed through the supervisor, and that lane's exec stays denied", async () => {
    const { sup, run } = await connected({ proto: 8 });
    const real = realSupervisor(sup, { UPLOAD_KEY: { lanes: [], repos: [], put: { lanes: ["lane-a"], repos: [] } } });
    const masked: string[] = [];
    const logs: string[] = [];
    const put = remoteSecretDepositor({ client: run.client, laneRepo: async () => "acme/app", log: (l) => { logs.push(l); }, onGranted: (v) => { masked.push(...v); } });
    expect(await drive(sup, put("lane-a", "UPLOAD_KEY", VALUE))).toEqual({ ok: true, created: true, backend: "plain" });
    expect(real.store.get("UPLOAD_KEY")).toBe(VALUE);
    // The value crossed the link only inside the r2s box.
    expect(sup.received.map((f) => f.type)).toEqual(["secret.put"]);
    expect(JSON.stringify(sup.received)).not.toContain(VALUE);
    expect(sup.badMacs).toEqual([]);
    expect(masked).toEqual([VALUE]);
    expect(logs).toEqual(["RUNNER_SECRET_STORED lane=lane-a names=UPLOAD_KEY put"]);
    expect(real.logs).toEqual([`RUNNER_SECRET_STORED runner=${LABEL} lane=lane-a names=UPLOAD_KEY put`]);
    // Write only: the lane that stored it cannot read it back.
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => "acme/app", log: () => {} });
    expect(await drive(sup, grant("lane-a", ["UPLOAD_KEY"]))).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
    // A second put replaces it.
    expect(await drive(sup, put("lane-a", "UPLOAD_KEY", `${VALUE}-2`))).toEqual({ ok: true, created: false, backend: "plain" });
    expect([...logs, ...real.logs, ...run.logs].join("\n")).not.toContain(VALUE);
  });

  test("a lane without put is refused and nothing is stored; a proto 7 supervisor gets no secret.put frame", async () => {
    const { sup, run } = await connected({ proto: 8 });
    const real = realSupervisor(sup, { UPLOAD_KEY: { lanes: ["lane-a"], repos: [], put: { lanes: ["lane-b"], repos: [] } } });
    const put = remoteSecretDepositor({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    expect(await drive(sup, put("lane-a", "UPLOAD_KEY", VALUE))).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not store UPLOAD_KEY (config secrets.UPLOAD_KEY.put)" });
    expect(real.store.size).toBe(0);

    const old = await connected({ proto: 7 });
    const oldPut = remoteSecretDepositor({ client: old.run.client, laneRepo: async () => undefined, log: () => {} });
    expect(await oldPut("lane-b", "UPLOAD_KEY", VALUE)).toEqual({ ok: false, code: "RUNNER_SECRET_OUTDATED", detail: "supervisor speaks proto 7; secret put needs proto 8" });
    for (const pair of old.sup.net.pairs) pair.pump();
    expect(old.sup.received).toEqual([]);
  });

  test("a runner below proto 8 is refused by the supervisor, and a box moved to another rid does not open", async () => {
    const { sup, run } = await connected({ proto: 8 });
    const rules = { UPLOAD_KEY: { lanes: [], repos: [], put: { lanes: ["lane-a"], repos: [] } } };
    const put = remoteSecretDepositor({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    const old = realSupervisor(sup, rules, 7);
    expect(await drive(sup, put("lane-a", "UPLOAD_KEY", VALUE))).toEqual({ ok: false, code: "RUNNER_SECRET_OUTDATED", detail: "runner speaks proto 7; secret put needs proto 8" });
    expect(old.store.size).toBe(0);
    const real = realSupervisor(sup, rules);
    sup.onSecret = (frame, session, reply) => {
      const rid = frame.body.rid;
      real.answer({ ...frame, body: { ...frame.body, rid: "0".repeat(32) } } as SecretGet, session, ((type, body) => { reply(type, { ...body, rid } as never); }) as Reply);
    };
    expect(await drive(sup, put("lane-a", "UPLOAD_KEY", VALUE))).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "sealed value did not open" });
    expect(real.store.size).toBe(0);
  });

  test("a file-kind grant from the real supervisor reaches the remote lane as kind file", async () => {
    const { sup, run } = await connected({ proto: 8 });
    const real = realSupervisor(sup, { SA_JSON: { lanes: ["lane-a"], repos: [], as: "file", put: { lanes: ["lane-a"], repos: [] } } });
    const put = remoteSecretDepositor({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    const json = JSON.stringify({ type: "service_account", private_key: VALUE });
    expect(await drive(sup, put("lane-a", "SA_JSON", json))).toMatchObject({ ok: true, created: true });
    const grant = remoteSecretGranter({ client: run.client, laneRepo: async () => undefined, log: () => {} });
    expect(await drive(sup, grant("lane-a", ["SA_JSON"]))).toEqual({ ok: true, values: { SA_JSON: json }, kinds: { SA_JSON: "file" } });
    expect(real.store.get("SA_JSON")).toBe(json);
  });
});
