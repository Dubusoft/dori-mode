import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sign } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ENROLL_CODE_TTL_MS, RUNNER_KEY_FILES, RunnerAuth, SupervisorAuth, enrollOverStdio, enrollRunner, fingerprint, transcript, type HandshakeParams,
} from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { RunnerHub } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import {
  decodeFrame, encodeFrame, runnerControl, runnerEvent, supervisorControl, type RunnerControlBodies, type SupervisorControlBodies,
} from "../src/runner/protocol.ts";
import { acceptRunners } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import { fakeClock, withState } from "./fakes.ts";

const clock = fakeClock(1_000_000);
const LABEL = "r1";
const HOST = "host-1";
const stateBody = { key: "lane-a", status: "working" } as const;

let tmp: ReturnType<typeof withState>;
const cleanups: (() => void)[] = [];
beforeEach(() => { tmp = withState(); clock.at = 1_000_000; });
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); tmp.done(); });

type Net = ReturnType<typeof memoryNetwork>;

/** Pumps every pair on microtask turns until `promise` settles (the connector resolves on a microtask). */
const drive = async <T>(nets: readonly Net[], promise: Promise<T>): Promise<T> => {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 100 && !settled; i += 1) {
    await Promise.resolve();
    for (const net of nets) for (const pair of net.pairs) pair.pump();
  }
  expect(settled).toBe(true);
  return promise;
};

const pumpAll = (net: Net): void => { for (const pair of net.pairs) pair.pump(); };


/** A supervisor: key, hub and an authenticated listener on its own in-memory network. */
const supervisor = (name: string) => {
  const stateDir = join(tmp.dir, name);
  const auth = new SupervisorAuth(stateDir, { now: clock.now });
  const committed: string[] = [];
  const hub = new RunnerHub({ stateDir, commit: (id) => { committed.push(id); return true; }, now: clock.now, monotonic: clock.now, epoch: 2 });
  const net = memoryNetwork();
  const logs: string[] = [];
  const accept = acceptRunners(hub, net.listener, { auth, log: (line) => { logs.push(line); } });
  cleanups.push(() => { accept(); hub.close(); auth.close(); });
  return { auth, hub, net, logs, committed, accept };
};

/** A runner directory with its state, outbox, keys and a client pointed at `net`. */
const runner = (name: string, net: Net) => {
  const dir = join(tmp.dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const auth = new RunnerAuth(dir);
  const logs: string[] = [];
  const client = new RunnerClient({ label: LABEL, hostId: HOST }, {
    connect: net.connect, outbox, state, clock, auth, log: (line) => { logs.push(line); },
  });
  cleanups.push(() => { outbox.close(); state.close(); });
  return { dir, state, outbox, auth, logs, client };
};

type Sup = ReturnType<typeof supervisor>;
type Run = ReturnType<typeof runner>;

const enroll = (sup: Sup, run: Run, code = sup.auth.issueCode(LABEL).code) =>
  drive([sup.net], enrollRunner({ auth: run.auth, connect: sup.net.connect, code, label: LABEL, hostId: HOST, expectedFingerprint: sup.auth.fingerprint }));

const connect = (sup: Sup, run: Run) => drive([sup.net], run.client.connectOnce());

test("SSH enrollment exchanges the original proof frames and refuses a wrong fingerprint before pinning", () => {
  const sup = supervisor("ssh-supervisor");
  const run = runner("ssh-worker", sup.net);
  const code = sup.auth.issueCode(LABEL).code;
  const params = { auth: run.auth, code, label: LABEL, hostId: HOST, expectedFingerprint: sup.auth.fingerprint };
  const request = enrollOverStdio(params)!;
  expect(request).not.toContain(code);
  expect(request).not.toContain("PRIVATE KEY");
  expect(run.auth.enrolled).toBe(false);
  const body = decodeFrame(request, "runner").body as RunnerControlBodies["enroll"];
  const accepted = sup.auth.enroll(body);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.detail);
  const reply = Buffer.from(encodeFrame(supervisorControl({ runner: LABEL, gen: 0, epoch: 0 }, "enroll.ok", accepted.reply))).toString("base64");
  expect(() => enrollOverStdio({ ...params, expectedFingerprint: `sha256:${"0".repeat(64)}` }, reply)).toThrow("RUNNER_AUTH_FAILED");
  expect(run.auth.enrolled).toBe(false);
  expect(enrollOverStdio(params, reply)).toBeUndefined();
  expect(run.auth.supervisorKey()).toBe(sup.auth.publicKey);
  expect(sup.auth.enroll(body)).toMatchObject({ ok: false, detail: "enrollment code already used" });
});

describe("runner authentication", () => {
  test("a hello answer signed by a different supervisor key makes the runner close the connection", async () => {
    const a = supervisor("sup-a");
    const b = supervisor("sup-b");
    const run = runner("runner", b.net);
    expect(await enroll(a, run)).toEqual({ ok: true, supervisorFingerprint: a.auth.fingerprint });
    expect(statSync(join(run.auth.dir, RUNNER_KEY_FILES.supervisor)).mode & 0o777).toBe(0o600);
    expect(statSync(join(run.auth.dir, RUNNER_KEY_FILES.key)).mode & 0o777).toBe(0o600);
    // Supervisor B knows the runner's key too, so the refusal can only come from the runner's check of B's signature.
    expect(b.auth.enroll(run.auth.enrollRequest(b.auth.issueCode(LABEL).code, LABEL, HOST)).ok).toBe(true);

    const outcome = await connect(b, run);
    expect(outcome).toMatchObject({ ok: false, code: "RUNNER_AUTH_FAILED" });
    expect(run.logs).toContain("RUNNER_AUTH_FAILED hello answer is not signed by the pinned supervisor key");
    expect(b.net.pairs.at(-1)?.runner.open).toBe(false);
    expect(run.client.connected).toBe(false);
    expect(b.hub.runner(LABEL)).toBeUndefined();
  });

  test("a frame with a wrong MAC is dropped and RUNNER_AUTH_FAILED is produced, on both sides", async () => {
    const sup = supervisor("sup");
    const run = runner("runner", sup.net);
    expect((await enroll(sup, run)).ok).toBe(true);
    expect(await connect(sup, run)).toEqual({ ok: true, eventAck: 0, replayed: 0 });
    const pair = sup.net.pairs.at(-1);
    if (!pair) throw new Error("no pair");
    const head = { runner: LABEL, gen: run.state.gen(), epoch: 2 };

    pair.runner.send(encodeFrame({ ...runnerEvent(head, 1, "lane.state", stateBody), mac: Buffer.alloc(32).toString("base64") }));
    pair.runner.send(encodeFrame(runnerEvent(head, 1, "lane.state", stateBody)));
    pair.pump();
    expect(sup.logs.filter((line) => line.startsWith("RUNNER_AUTH_FAILED"))).toEqual([
      "RUNNER_AUTH_FAILED runner=r1 frame dropped: bad mac type=lane.state",
      "RUNNER_AUTH_FAILED runner=r1 frame dropped: bad mac type=lane.state",
    ]);
    expect(sup.committed).toEqual([]);
    expect(sup.hub.runner(LABEL)?.eventAck).toBe(0);
    expect(pair.supervisor.open).toBe(true);

    pair.supervisor.send(encodeFrame({ ...supervisorControl(head, "ack", { eventAck: 99 }), mac: "AAAA" }));
    pair.pump();
    expect(run.logs).toContain("RUNNER_AUTH_FAILED frame dropped: bad mac type=ack");
    expect(run.client.eventAck).toBe(0);

    // A sealed frame from the real client still goes through.
    run.client.publish("lane.state", stateBody);
    pair.pump();
    expect(sup.committed).toEqual(["runner:r1:1"]);
    expect(run.client.eventAck).toBe(1);
  });

  test("reusing a used enrollment code is refused", async () => {
    const sup = supervisor("sup");
    const first = runner("runner-1", sup.net);
    const second = runner("runner-2", sup.net);
    const { code } = sup.auth.issueCode(LABEL);
    expect((await enroll(sup, first, code)).ok).toBe(true);
    expect(await enroll(sup, second, code)).toMatchObject({ ok: false, code: "RUNNER_ENROLL_REFUSED" });
    expect(sup.logs).toContain("RUNNER_ENROLL_REFUSED runner=r1 enrollment code already used");
    expect(second.auth.enrolled).toBe(false);
    expect(sup.auth.key(LABEL)?.pubKey).toBe(first.auth.keyPair().pub);
  });

  test("an expired enrollment code is refused", async () => {
    const sup = supervisor("sup");
    const run = runner("runner", sup.net);
    const { code } = sup.auth.issueCode(LABEL);
    clock.at += ENROLL_CODE_TTL_MS;
    expect(await enroll(sup, run, code)).toMatchObject({ ok: false, code: "RUNNER_ENROLL_REFUSED" });
    expect(sup.logs).toContain("RUNNER_ENROLL_REFUSED runner=r1 enrollment code expired");
    expect(run.auth.enrolled).toBe(false);
    expect(sup.auth.key(LABEL)).toBeUndefined();
  });

  test("after the rotation ack a hello signed with the old runner key is refused", async () => {
    const sup = supervisor("sup");
    const run = runner("runner", sup.net);
    expect((await enroll(sup, run)).ok).toBe(true);
    expect((await connect(sup, run)).ok).toBe(true);
    const old = run.auth.keyPair();

    const cmdId = sup.accept.rotate(LABEL);
    expect(cmdId).toBe("rotate:r1:1");
    pumpAll(sup.net);
    const fresh = run.auth.keyPair();
    expect(fresh.pub).not.toBe(old.pub);
    expect(sup.auth.key(LABEL)?.pubKey).toBe(fresh.pub);
    expect(existsSync(join(run.auth.dir, RUNNER_KEY_FILES.next))).toBe(false);
    expect(run.state.command(cmdId as string)?.state).toBe("verified");
    expect(run.state.cmdAck()).toBe(1);
    expect(sup.logs).toContain(`RUNNER_KEY_ROTATED runner=r1 key=${fingerprint(fresh.pub)}`);

    // A peer holding only the old key: it answers the challenge with a correct transcript signed by that key.
    const transport = await sup.net.connect();
    const pair = sup.net.pairs.at(-1);
    if (!pair) throw new Error("no pair");
    const lines: string[] = [];
    transport.onLine((line) => { lines.push(line); });
    const pending = run.auth.startHello();
    const head = { runner: LABEL, gen: run.state.gen(), epoch: 2 };
    transport.send(encodeFrame(runnerControl(head, "hello", {
      proto: 1, gen: head.gen, label: LABEL, hostId: HOST, cmdAck: 0, nonce: pending.nonce, dh: pending.dh,
    })));
    pair.pump();
    const challenge = decodeFrame(lines[0] as string, "supervisor");
    expect(challenge.type).toBe("hello.challenge");
    const body = challenge.body as SupervisorControlBodies["hello.challenge"];
    expect(body.keyFp).toBe(fingerprint(fresh.pub));
    const params: HandshakeParams = {
      label: LABEL, hostId: HOST, gen: head.gen, runnerNonce: pending.nonce, supervisorNonce: body.nonce,
      runnerDh: pending.dh, supervisorDh: body.dh, runnerPubKey: old.pub, supervisorPubKey: sup.auth.publicKey,
    };
    transport.send(encodeFrame(runnerControl(head, "auth.proof", { sig: sign(null, transcript("runner", params), old.privateKey).toString("base64") })));
    pair.pump();
    expect(sup.logs).toContain("RUNNER_AUTH_FAILED runner=r1 hello proof is not signed by the enrolled runner key");
    expect(transport.open).toBe(false);

    // The runner itself reconnects with the new key.
    sup.net.pairs[1]?.sever("link down");
    expect((await connect(sup, run)).ok).toBe(true);
  });

  test("a revoked runner is disconnected and its later hellos are refused", async () => {
    const sup = supervisor("sup");
    const run = runner("runner", sup.net);
    expect((await enroll(sup, run)).ok).toBe(true);
    expect((await connect(sup, run)).ok).toBe(true);

    expect(sup.accept.revoke(LABEL)).toBe(true);
    expect(run.client.connected).toBe(false);
    expect(sup.auth.key(LABEL)?.pubKey).toBeUndefined();

    expect(await connect(sup, run)).toMatchObject({ ok: false, code: "RUNNER_REVOKED" });
    expect(sup.logs).toContain("RUNNER_REVOKED runner=r1 runner r1 is revoked");
  });
});
