import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SecretRule } from "../src/config.ts";
import { readDecisions } from "../src/owner-decisions.ts";
import { SecretStoreError } from "../src/secret-store.ts";
import { RunnerAuth, SupervisorAuth, type Session } from "../src/runner/auth.ts";
import { RunnerHub } from "../src/runner/hub.ts";
import { decodeFrame, encodeFrame, runnerControl, type SupervisorControl, type SupervisorControlBodies } from "../src/runner/protocol.ts";
import { secretAuditPath } from "../src/runner/secret-grant.ts";
import { supervisorCommandRunner, supervisorGranter, supervisorSecretHandler, type SupervisorSecretDeps } from "../src/runner/secret-serve.ts";
import { acceptRunners, type SecretFrame, type SecretReplyContext } from "../src/runner/serve.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import { fakeClock, withState } from "./fakes.ts";

const LABEL = "r1";
const HOST = "host-1";
const VALUE = "dori-test-throwaway-123";
const RID = "0123456789abcdef0123456789abcdef";
const HEAD = { runner: LABEL, gen: 3, epoch: 2 };

const clock = fakeClock(Date.parse("2026-11-11T00:00:00Z"));
let tmp: ReturnType<typeof withState>;
const closers: (() => void)[] = [];
beforeEach(() => { tmp = withState(); });
afterEach(() => { for (const done of closers.splice(0).reverse()) done(); tmp.done(); });

/** One real enroll + signed handshake; returns both ends' sessions. */
const handshake = (): { runner: Session; supervisor: Session } => {
  const sup = new SupervisorAuth(join(tmp.dir, "sup"), { now: clock.now });
  closers.push(() => sup.close());
  const runDir = join(tmp.dir, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const run = new RunnerAuth(runDir);
  const { code } = sup.issueCode(LABEL);
  const request = run.enrollRequest(code, LABEL, HOST);
  const enrolled = sup.enroll(request);
  if (!enrolled.ok) throw new Error(enrolled.detail);
  run.pinSupervisor(code, request, enrolled.reply, sup.fingerprint);
  const hello = { label: LABEL, hostId: HOST, gen: HEAD.gen };
  const pending = run.startHello();
  const begun = sup.beginHello({ ...hello, nonce: pending.nonce, dh: pending.dh } as Parameters<SupervisorAuth["beginHello"]>[0]);
  if (!begun.ok) throw new Error(begun.detail);
  const answer = run.answerChallenge(pending, hello, begun.challenge);
  if (!answer.ok) throw new Error(answer.detail);
  const supervisor = sup.finishHello(begun.pending, answer.sig);
  if (!supervisor) throw new Error("handshake failed");
  return { runner: answer.session, supervisor };
};

type Reply = { readonly type: string; readonly body: SupervisorControlBodies["secret.value"] };
const context = (session: Session | undefined, proto = 6): SecretReplyContext & { readonly replies: Reply[] } => {
  const replies: Reply[] = [];
  return { session, proto, head: HEAD, replies, reply: (type, body) => { replies.push({ type, body }); } };
};
const getFrame = (key: string, names: readonly string[], repo?: string): SecretFrame =>
  runnerControl(HEAD, "secret.get", { rid: RID, key, names, ...(repo !== undefined ? { repo } : {}) });

const RULES: Record<string, SecretRule> = { API_TOKEN: { lanes: ["lane-a"], repos: [] }, REPO_TOKEN: { lanes: [], repos: ["Acme/Widget"] } };

/** The production granter over a fake store, with the deps every test shares. */
const harness = (patch: Partial<SupervisorSecretDeps> = {}, store: Record<string, string> = { API_TOKEN: VALUE, REPO_TOKEN: VALUE }) => {
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  const owners: Record<string, string> = { "lane-a": LABEL, "lane-b": "r2", "lane-c": LABEL };
  const handler = supervisorSecretHandler({
    laneOwner: (key) => owners[key],
    runnerUnsandboxed: () => false,
    granter: supervisorGranter({
      stateDir: tmp.dir, rules: async () => RULES, commands: async () => ({}), now: clock.now, log,
      store: {
        read: async (name) => {
          if (!Object.hasOwn(store, name)) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING ${name}`);
          return store[name] as string;
        },
      },
    }),
    commandRunner: supervisorCommandRunner({
      stateDir: tmp.dir, rules: async () => RULES, now: clock.now, log, hostEnv: { PATH: process.env.PATH }, home: tmp.dir,
      commands: async () => ({ show: { argv: ["sh", "-c", "printf 'out %s' \"$API_TOKEN\"; exit 4"], secrets: ["API_TOKEN"], lanes: ["lane-a"], repos: [], timeoutSec: 60 } }),
      store: { read: async () => VALUE },
    }),
    log,
    ...patch,
  });
  return { handler, logs };
};

const refusal = (ctx: { replies: Reply[] }) => {
  expect(ctx.replies).toHaveLength(1);
  const [reply] = ctx.replies;
  expect(reply?.type).toBe("secret.value");
  expect(reply?.body.ok).toBe(false);
  expect(reply?.body.sealed).toBeUndefined();
  expect(JSON.stringify(reply)).not.toContain(VALUE);
  return reply?.body as SupervisorControlBodies["secret.value"];
};

describe("supervisorSecretHandler", () => {
  test("a grant goes out sealed and opens with the runner's session to the values", async () => {
    const { runner, supervisor } = handshake();
    const { handler, logs } = harness();
    const ctx = context(supervisor);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN"]), ctx);
    expect(ctx.replies).toHaveLength(1);
    const body = ctx.replies[0]?.body as SupervisorControlBodies["secret.value"];
    expect(body).toMatchObject({ rid: RID, ok: true });
    expect(JSON.stringify(ctx.replies)).not.toContain(VALUE);
    const opened = runner.openSecret("s2r", { ...HEAD, type: "secret.value", rid: RID }, body.sealed as { n: string; c: string });
    expect(JSON.parse(opened as string)).toEqual({ values: { API_TOKEN: VALUE } });
    // Bound to its frame: another rid does not open it.
    expect(runner.openSecret("s2r", { ...HEAD, type: "secret.value", rid: "f".repeat(32) }, body.sealed as { n: string; c: string })).toBeUndefined();
    expect(logs).toEqual([`RUNNER_SECRET_GRANTED runner=${LABEL} lane=lane-a names=API_TOKEN`]);
    const audit = readFileSync(secretAuditPath(tmp.dir), "utf8");
    expect(JSON.parse(audit)).toEqual({ at: "2026-11-11T00:00:00.000Z", runner: LABEL, lane: "lane-a", names: ["API_TOKEN"], allowed: true });
    expect(audit).not.toContain(VALUE);
    expect(statSync(secretAuditPath(tmp.dir)).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toContain(VALUE);
  });

  test("the repo from the frame matches a repos rule", async () => {
    const { runner, supervisor } = handshake();
    const { handler } = harness();
    const ctx = context(supervisor);
    await handler(LABEL, getFrame("lane-c", ["REPO_TOKEN"], "acme/widget"), ctx);
    const body = ctx.replies[0]?.body as SupervisorControlBodies["secret.value"];
    expect(body.ok).toBe(true);
    expect(JSON.parse(runner.openSecret("s2r", { ...HEAD, type: "secret.value", rid: RID }, body.sealed as { n: string; c: string }) as string)).toEqual({ values: { REPO_TOKEN: VALUE } });
  });

  test("no session -> UNSUPPORTED, before anything else is read", async () => {
    let asked = false;
    const { handler } = harness({ laneOwner: () => { asked = true; return LABEL; } });
    const ctx = context(undefined);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN"]), ctx);
    expect(refusal(ctx)).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "unauthenticated link" });
    expect(asked).toBe(false);
  });

  test("a connection below proto 6 -> OUTDATED", async () => {
    const { supervisor } = handshake();
    const { handler } = harness();
    const ctx = context(supervisor, 5);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN"]), ctx);
    expect(refusal(ctx)).toMatchObject({ code: "RUNNER_SECRET_OUTDATED", detail: "runner speaks proto 5; secrets need proto 6" });
  });

  test("another runner's lane or an unknown lane is DENIED and logged as forged, with no audit", async () => {
    const { supervisor } = handshake();
    const { handler, logs } = harness();
    for (const key of ["lane-b", "lane-x"]) {
      const ctx = context(supervisor);
      await handler(LABEL, getFrame(key, ["API_TOKEN"]), ctx);
      expect(refusal(ctx)).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: `${key} is not a lane of runner ${LABEL}` });
    }
    expect(logs).toEqual([`RUNNER_FORGED_SECRET runner=${LABEL} key=lane-b`, `RUNNER_FORGED_SECRET runner=${LABEL} key=lane-x`]);
    expect(() => statSync(secretAuditPath(tmp.dir))).toThrow();
  });

  test("an unsandboxed runner is DENIED", async () => {
    const { supervisor } = handshake();
    const { handler } = harness({ runnerUnsandboxed: (label) => label === LABEL });
    const ctx = context(supervisor);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN"]), ctx);
    expect(refusal(ctx)).toMatchObject({ code: "RUNNER_SECRET_DENIED" });
    expect(ctx.replies[0]?.body.detail).toContain("allowUnsandboxed");
  });

  test("a name outside the allowlist is DENIED by the granter and audited, the detail names only names", async () => {
    const { supervisor } = handshake();
    const { handler, logs } = harness();
    const ctx = context(supervisor);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN", "REPO_TOKEN"]), ctx);
    expect(refusal(ctx)).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: `lane-a may not receive REPO_TOKEN (config secrets); the owner is asked in an owner decision; run the command again after the lead says it was answered` });
    expect(readDecisions(tmp.dir).secretRequests).toEqual([{ lane: "lane-a", names: ["REPO_TOKEN"], at: clock.now() }]);
    expect(logs).toEqual([`RUNNER_SECRET_DENIED runner=${LABEL} lane=lane-a names=API_TOKEN,REPO_TOKEN`]);
    expect(JSON.parse(readFileSync(secretAuditPath(tmp.dir), "utf8"))).toMatchObject({ allowed: false, reason: "not allowed: REPO_TOKEN" });
  });

  test("a name missing from the store -> MISSING", async () => {
    const { supervisor } = handshake();
    const { handler } = harness({}, {});
    const ctx = context(supervisor);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN"]), ctx);
    expect(refusal(ctx)).toMatchObject({ code: "RUNNER_SECRET_MISSING", detail: "API_TOKEN is not in the secret store" });
  });

  test("secret.run runs the op here and its result goes out sealed, opening to the redacted output", async () => {
    const { runner, supervisor } = handshake();
    const { handler, logs } = harness();
    const ctx = context(supervisor);
    await handler(LABEL, runnerControl(HEAD, "secret.run", { rid: RID, key: "lane-a", op: "show" }), ctx);
    expect(ctx.replies).toHaveLength(1);
    const reply = ctx.replies[0] as Reply;
    expect(reply.type).toBe("secret.run.result");
    expect(reply.body).toMatchObject({ rid: RID, ok: true });
    const sealed = reply.body.sealed as { n: string; c: string };
    // Bound to the result frame type: the same box does not open as a secret.value.
    expect(runner.openSecret("s2r", { ...HEAD, type: "secret.value", rid: RID }, sealed)).toBeUndefined();
    const opened = runner.openSecret("s2r", { ...HEAD, type: "secret.run.result", rid: RID }, sealed) as string;
    expect(JSON.parse(opened)).toEqual({ exitCode: 4, stdout: "out [REDACTED:API_TOKEN]", stderr: "", truncated: false });
    expect(opened).not.toContain(VALUE);
    expect(logs).toEqual([`RUNNER_SECRET_RUN runner=${LABEL} lane=lane-a op=show exit=4`]);
    const audit = readFileSync(secretAuditPath(tmp.dir), "utf8");
    expect(JSON.parse(audit)).toEqual({ at: "2026-11-11T00:00:00.000Z", runner: LABEL, lane: "lane-a", op: "show", names: ["API_TOKEN"], allowed: true, exitCode: 4 });
    expect([audit, ...logs, JSON.stringify(ctx.replies)].join("\n")).not.toContain(VALUE);
  });

  test("secret.run for another runner's lane is DENIED unsealed and logged as forged; nothing runs", async () => {
    const { supervisor } = handshake();
    let ran = 0;
    const { handler, logs } = harness({ commandRunner: () => async () => { ran++; return { ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const ctx = context(supervisor);
    await handler(LABEL, runnerControl(HEAD, "secret.run", { rid: RID, key: "lane-b", op: "show" }), ctx);
    expect(ctx.replies).toEqual([{ type: "secret.run.result", body: { rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: `lane-b is not a lane of runner ${LABEL}` } }]);
    expect(logs).toEqual([`RUNNER_FORGED_SECRET runner=${LABEL} key=lane-b`]);
    expect(ran).toBe(0);
  });

  test("secret.run refused by the op rules goes out unsealed with code and detail", async () => {
    const { supervisor } = handshake();
    const { handler } = harness();
    const ctx = context(supervisor);
    await handler(LABEL, runnerControl(HEAD, "secret.run", { rid: RID, key: "lane-c", op: "show" }), ctx);
    expect(ctx.replies).toEqual([{ type: "secret.run.result", body: { rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-c may not run show (config secretCommands); ops this lane may run: none" } }]);
  });

  test("without a command runner secret.run is answered secret.run.result UNSUPPORTED", async () => {
    const { supervisor } = handshake();
    const handler = supervisorSecretHandler({
      laneOwner: () => LABEL, runnerUnsandboxed: () => false, log: () => {},
      granter: () => async () => ({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "unused" }),
    });
    const ctx = context(supervisor);
    await handler(LABEL, runnerControl(HEAD, "secret.run", { rid: RID, key: "lane-a", op: "deploy" }), ctx);
    expect(ctx.replies).toEqual([{ type: "secret.run.result", body: { rid: RID, ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "proxy execution is not enabled" } }]);
  });

  test("a throwing dependency -> FAILED", async () => {
    const { supervisor } = handshake();
    const { handler } = harness({ laneOwner: async () => { throw new Error("registry unreadable"); } });
    const ctx = context(supervisor);
    await handler(LABEL, getFrame("lane-a", ["API_TOKEN"]), ctx);
    expect(refusal(ctx)).toMatchObject({ code: "RUNNER_SECRET_FAILED", detail: "registry unreadable" });
  });
});

describe("acceptRunners secret frames", () => {
  /** An admitted proto-6 connection on an unauthenticated memory link; returns the frames the runner end receives. */
  const admitted = async (onSecret?: (label: string, frame: SecretFrame, ctx: SecretReplyContext) => void) => {
    const hub = new RunnerHub({ stateDir: tmp.dir, now: () => 1000, monotonic: () => 1000, epoch: 2, commit: () => true });
    closers.push(() => hub.close());
    const network = memoryNetwork();
    const logs: string[] = [];
    closers.push(acceptRunners(hub, network.listener, { log: (line) => { logs.push(line); }, ...(onSecret ? { onSecret } : {}) }));
    const transport = await network.connect();
    const received: SupervisorControl[] = [];
    transport.onLine((line) => { received.push(decodeFrame(line, "supervisor") as SupervisorControl); });
    transport.send(encodeFrame(runnerControl(HEAD, "hello", { label: LABEL, hostId: HOST, gen: HEAD.gen, proto: 6, cmdAck: 0 })));
    network.pairs[0]!.pump();
    expect(received.map((f) => f.type)).toEqual(["hello.ok"]);
    const send = (frame: SecretFrame): void => { transport.send(encodeFrame(frame)); network.pairs[0]!.pump(); };
    return { received, send, logs };
  };

  test("without the hook both secret frames are answered UNSUPPORTED", async () => {
    const { received, send } = await admitted();
    send(getFrame("lane-a", ["API_TOKEN"]));
    send(runnerControl(HEAD, "secret.run", { rid: RID, key: "lane-a", op: "deploy" }));
    expect(received.slice(1).map((f) => [f.type, f.runner, f.gen, f.epoch, (f.body as { code?: string }).code])).toEqual([
      ["secret.value", LABEL, HEAD.gen, 2, "RUNNER_SECRET_UNSUPPORTED"], ["secret.run.result", LABEL, HEAD.gen, 2, "RUNNER_SECRET_UNSUPPORTED"],
    ]);
  });

  test("the hook gets the frame, no session on this link, the hello proto and the head; its reply goes out on the connection", async () => {
    const seen: { label: string; key: string; session: Session | undefined; proto: number; head: object }[] = [];
    const { received, send, logs } = await admitted((label, frame, ctx) => {
      seen.push({ label, key: frame.body.key, session: ctx.session, proto: ctx.proto, head: ctx.head });
      ctx.reply("secret.value", { rid: frame.body.rid, ok: false, code: "RUNNER_SECRET_DENIED", detail: "test" });
    });
    send(getFrame("lane-a", ["API_TOKEN"]));
    expect(seen).toEqual([{ label: LABEL, key: "lane-a", session: undefined, proto: 6, head: { ...HEAD, epoch: 2 } }]);
    expect(received.slice(1)).toMatchObject([{ type: "secret.value", body: { rid: RID, code: "RUNNER_SECRET_DENIED" } }]);
    expect(logs.join("\n")).not.toContain("API_TOKEN");
  });

  test("the real handler on an unauthenticated link answers UNSUPPORTED", async () => {
    const { handler } = harness();
    let done: Promise<void> | undefined;
    const { received, send } = await admitted((label, frame, ctx) => { done = handler(label, frame, ctx); });
    send(getFrame("lane-a", ["API_TOKEN"]));
    await done;
    expect(received.slice(1)).toMatchObject([{ type: "secret.value", body: { rid: RID, ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "unauthenticated link" } }]);
  });
});
