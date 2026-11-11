import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretRule } from "../src/config.ts";
import { RunnerAuth, SupervisorAuth, type Session } from "../src/runner/auth.ts";
import {
  decodeFrame, encodeFrame, HANDLE_PROTO, handlesSupported, PROTO, RUNNER_CONTROL_TYPES, runnerControl, SUPERVISOR_CONTROL_TYPES, supervisorControl,
  type SealedBody, type SupervisorControlBodies,
} from "../src/runner/protocol.ts";
import { secretAuditPath } from "../src/runner/secret-grant.ts";
import { handleId, SECRET_HANDLE_PATTERN } from "../src/runner/secret-handles.ts";
import { supervisorHandles, supervisorSecretHandler, type SupervisorSecretDeps } from "../src/runner/secret-serve.ts";
import type { SecretFrame, SecretReplyContext } from "../src/runner/serve.ts";
import { fakeClock, withState } from "./fakes.ts";

const VALUE = "dori-test-throwaway-123";
const ORIGIN = "https://app.example.com";
const RID = "0123456789abcdef0123456789abcdef";
const RULES: Record<string, SecretRule> = {
  WEB_PASSWORD: { lanes: ["lane-a", "lane-b"], repos: [], origins: [ORIGIN] },
  REPO_PASSWORD: { lanes: [], repos: ["acme/widget"], origins: [ORIGIN] },
  API_TOKEN: { lanes: ["lane-a"], repos: [] },
};
const OWNERS: Record<string, string> = { "lane-a": "r1", "lane-b": "r2", "lane-c": "r1" };

const clock = fakeClock(Date.parse("2026-11-11T00:00:00Z"));
let tmp: ReturnType<typeof withState>;
const closers: (() => void)[] = [];
beforeEach(() => { tmp = withState(); clock.at = Date.parse("2026-11-11T00:00:00Z"); });
afterEach(() => { for (const done of closers.splice(0).reverse()) done(); tmp.done(); });

/** One real enroll + signed handshake for runner `label`; returns both ends' sessions. */
const handshake = (sup: SupervisorAuth, label: string, gen = 3): { runner: Session; supervisor: Session } => {
  const runDir = join(tmp.dir, `run-${label}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const run = new RunnerAuth(runDir);
  const { code } = sup.issueCode(label);
  const request = run.enrollRequest(code, label, `host-${label}`);
  const enrolled = sup.enroll(request);
  if (!enrolled.ok) throw new Error(enrolled.detail);
  run.pinSupervisor(code, request, enrolled.reply, sup.fingerprint);
  const hello = { label, hostId: `host-${label}`, gen };
  const pending = run.startHello();
  const begun = sup.beginHello({ ...hello, nonce: pending.nonce, dh: pending.dh } as Parameters<SupervisorAuth["beginHello"]>[0]);
  if (!begun.ok) throw new Error(begun.detail);
  const answer = run.answerChallenge(pending, hello, begun.challenge);
  if (!answer.ok) throw new Error(answer.detail);
  const supervisor = sup.finishHello(begun.pending, answer.sig);
  if (!supervisor) throw new Error("handshake failed");
  return { runner: answer.session, supervisor };
};

type Answer = SupervisorControlBodies["secret.handle.result"];
type Reply = { readonly type: string; readonly body: Answer };
const head = (label: string) => ({ runner: label, gen: 3, epoch: 2 });
const context = (label: string, session: Session | undefined, proto = PROTO): SecretReplyContext & { readonly replies: Reply[] } => {
  const replies: Reply[] = [];
  return { session, proto, head: head(label), replies, reply: (type, body) => { replies.push({ type, body }); } };
};
const issueFrame = (label: string, key: string, name: string, repo?: string): SecretFrame =>
  runnerControl(head(label), "secret.handle", { rid: RID, key, name, ...(repo !== undefined ? { repo } : {}) });
const exchangeFrame = (label: string, key: string, handle: string, origin = ORIGIN): SecretFrame =>
  runnerControl(head(label), "secret.exchange", { rid: RID, key, handle, origin });

/** Supervisor auth with two enrolled runners, and the production handler over one shared handle table. */
const system = (patch: Partial<SupervisorSecretDeps> = {}) => {
  const sup = new SupervisorAuth(join(tmp.dir, "sup"), { now: clock.now });
  closers.push(() => sup.close());
  const r1 = handshake(sup, "r1");
  const r2 = handshake(sup, "r2");
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  let n = 0;
  const handler = supervisorSecretHandler({
    laneOwner: (key) => OWNERS[key],
    runnerUnsandboxed: () => false,
    granter: () => async () => ({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "unused" }),
    handles: supervisorHandles({
      stateDir: tmp.dir, rules: async () => RULES, now: clock.now, log, store: { read: async () => VALUE },
      random: () => Buffer.alloc(32, ++n),
    }),
    log,
    ...patch,
  });
  /** Sends `frame` as `label` and returns its one reply. */
  const ask = async (label: string, frame: SecretFrame, proto = PROTO): Promise<Reply> => {
    const ctx = context(label, (label === "r1" ? r1 : r2).supervisor, proto);
    await handler(label, frame, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(JSON.stringify(ctx.replies)).not.toContain(VALUE);
    return ctx.replies[0] as Reply;
  };
  const open = (label: string, reply: Reply): unknown =>
    JSON.parse((label === "r1" ? r1 : r2).runner.openSecret("s2r", { ...head(label), type: reply.type, rid: RID }, reply.body.sealed as SealedBody) as string);
  const issue = async (label: string, key: string, name = "WEB_PASSWORD", repo?: string): Promise<string> => {
    const reply = await ask(label, issueFrame(label, key, name, repo));
    expect(reply).toMatchObject({ type: "secret.handle.result", body: { rid: RID, ok: true } });
    const { handle } = open(label, reply) as { handle: string };
    expect(JSON.stringify(reply)).not.toContain(handle);
    return handle;
  };
  return { handler, ask, open, issue, logs, r1, r2 };
};

describe("proto 7 secret handle frames", () => {
  test("the version gate and the frame shapes", () => {
    expect([PROTO, HANDLE_PROTO]).toEqual([7, 7]);
    expect([undefined, 5, 6].map(handlesSupported)).toEqual([false, false, false]);
    expect([7, 8].map(handlesSupported)).toEqual([true, true]);
    const issue = runnerControl(head("r1"), "secret.handle", { rid: RID, key: "lane-a", name: "WEB_PASSWORD", repo: "acme/app" });
    expect(decodeFrame(encodeFrame(issue), "runner")).toEqual(issue);
    const exchange = runnerControl(head("r1"), "secret.exchange", { rid: RID, key: "lane-a", handle: `dsh_${"A".repeat(43)}`, origin: ORIGIN });
    expect(decodeFrame(encodeFrame(exchange), "runner")).toEqual(exchange);
    expect(() => decodeFrame(JSON.stringify({ ...exchange, body: { ...exchange.body, repo: "x" } }), "runner")).toThrow("unknown-field body.repo");
    expect(() => decodeFrame(JSON.stringify({ ...exchange, seq: 1 }), "runner")).toThrow("RUNNER_FRAME_INVALID sequence");
    for (const type of ["secret.handle.result", "secret.exchange.result"] as const) {
      const ok = supervisorControl(head("r1"), type, { rid: RID, ok: true, sealed: { n: "bg==", c: "Yw==" } });
      expect(decodeFrame(encodeFrame(ok), "supervisor")).toEqual(ok);
      expect(() => decodeFrame(JSON.stringify({ ...ok, body: { ...ok.body, value: "x" } }), "supervisor")).toThrow("unknown-field body.value");
      expect(() => decodeFrame(encodeFrame(ok), "runner")).toThrow("wrong-direction");
    }
    expect(RUNNER_CONTROL_TYPES).toEqual(expect.arrayContaining(["secret.handle", "secret.exchange"]));
    expect(SUPERVISOR_CONTROL_TYPES).toEqual(expect.arrayContaining(["secret.handle.result", "secret.exchange.result"]));
  });
});

describe("supervisorSecretHandler handle frames", () => {
  test("issue then exchange: both answers sealed s2r and bound to their type and rid; audited by handleId only", async () => {
    const s = system();
    const issued = await s.ask("r1", issueFrame("r1", "lane-a", "WEB_PASSWORD"));
    const opened = s.open("r1", issued) as { handle: string; expiresAt: number };
    expect(opened.handle).toMatch(SECRET_HANDLE_PATTERN);
    expect(opened.expiresAt).toBe(clock.now() + 5 * 60 * 1000);
    // The issue box does not open as an exchange answer or for another rid.
    expect(s.r1.runner.openSecret("s2r", { ...head("r1"), type: "secret.exchange.result", rid: RID }, issued.body.sealed as SealedBody)).toBeUndefined();
    expect(s.r1.runner.openSecret("s2r", { ...head("r1"), type: "secret.handle.result", rid: "f".repeat(32) }, issued.body.sealed as SealedBody)).toBeUndefined();
    const exchanged = await s.ask("r1", exchangeFrame("r1", "lane-a", opened.handle));
    expect(exchanged).toMatchObject({ type: "secret.exchange.result", body: { rid: RID, ok: true } });
    expect(s.open("r1", exchanged)).toEqual({ value: VALUE });
    const id = handleId(opened.handle);
    expect(s.logs).toEqual([
      `RUNNER_SECRET_GRANTED runner=r1 lane=lane-a names=WEB_PASSWORD kind=handle.issue handleId=${id}`,
      `RUNNER_SECRET_GRANTED runner=r1 lane=lane-a names=WEB_PASSWORD kind=handle.exchange handleId=${id}`,
    ]);
    const audit = readFileSync(secretAuditPath(tmp.dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toEqual([
      { at: "2026-11-11T00:00:00.000Z", runner: "r1", lane: "lane-a", names: ["WEB_PASSWORD"], allowed: true, kind: "handle.issue", handleId: id },
      { at: "2026-11-11T00:00:00.000Z", runner: "r1", lane: "lane-a", names: ["WEB_PASSWORD"], allowed: true, kind: "handle.exchange", handleId: id, origin: ORIGIN },
    ]);
    const text = [readFileSync(secretAuditPath(tmp.dir), "utf8"), ...s.logs].join("\n");
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(opened.handle);
    // One-time: a second exchange is refused unsealed.
    expect((await s.ask("r1", exchangeFrame("r1", "lane-a", opened.handle))).body).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: `secret handle ${id} was already used` });
  });

  test("the repo of the issue frame matches a repos rule at issue and again at exchange", async () => {
    const s = system();
    const handle = await s.issue("r1", "lane-c", "REPO_PASSWORD", "acme/widget");
    expect(s.open("r1", await s.ask("r1", exchangeFrame("r1", "lane-c", handle)))).toEqual({ value: VALUE });
    expect((await s.ask("r1", issueFrame("r1", "lane-c", "REPO_PASSWORD"))).body).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  });

  test("a forged lane is refused before the table, for issue and exchange", async () => {
    const s = system();
    for (const frame of [issueFrame("r1", "lane-b", "WEB_PASSWORD"), issueFrame("r1", "lane-x", "WEB_PASSWORD"), exchangeFrame("r1", "lane-b", `dsh_${"A".repeat(43)}`)]) {
      const reply = await s.ask("r1", frame);
      expect(reply.body).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: `${frame.body.key} is not a lane of runner r1` });
    }
    expect(s.logs).toEqual(["RUNNER_FORGED_SECRET runner=r1 key=lane-b", "RUNNER_FORGED_SECRET runner=r1 key=lane-x", "RUNNER_FORGED_SECRET runner=r1 key=lane-b"]);
  });

  test("another runner's lane handle cannot be exchanged by this runner, and the attempt consumes it", async () => {
    const s = system();
    const handle = await s.issue("r2", "lane-b");
    // r1 names r2's lane: forged, the handle is untouched.
    expect((await s.ask("r1", exchangeFrame("r1", "lane-b", handle))).body).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-b is not a lane of runner r1" });
    // r1 names its own lane with r2's handle: wrong lane, and the handle is spent.
    const id = handleId(handle);
    expect((await s.ask("r1", exchangeFrame("r1", "lane-a", handle))).body).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: `secret handle ${id} was not issued to lane-a` });
    expect((await s.ask("r2", exchangeFrame("r2", "lane-b", handle))).body).toMatchObject({ ok: false, detail: `secret handle ${id} was already used` });
    expect(s.logs).toContain(`RUNNER_SECRET_DENIED runner=r1 lane=lane-a names=WEB_PASSWORD kind=handle.exchange handleId=${id}`);
  });

  test("an origin outside the rule is refused; an origins-less rule gets no handle", async () => {
    const s = system();
    const handle = await s.issue("r1", "lane-a");
    expect((await s.ask("r1", exchangeFrame("r1", "lane-a", handle, "https://evil.example.com"))).body).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
    expect((await s.ask("r1", issueFrame("r1", "lane-a", "API_TOKEN"))).body).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  });

  test("a proto 6 connection is OUTDATED for both frames; no session is UNSUPPORTED; no handles dep is UNSUPPORTED", async () => {
    const s = system();
    for (const frame of [issueFrame("r1", "lane-a", "WEB_PASSWORD"), exchangeFrame("r1", "lane-a", `dsh_${"A".repeat(43)}`)]) {
      expect((await s.ask("r1", frame, 6)).body).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_OUTDATED", detail: "runner speaks proto 6; secret handles need proto 7" });
      const ctx = context("r1", undefined);
      await s.handler("r1", frame, ctx);
      expect(ctx.replies[0]?.body).toMatchObject({ code: "RUNNER_SECRET_UNSUPPORTED", detail: "unauthenticated link" });
    }
    const bare = supervisorSecretHandler({ laneOwner: (key) => OWNERS[key], runnerUnsandboxed: () => false, log: () => {}, granter: () => async () => ({ ok: false, code: "X", detail: "unused" }) });
    const ctx = context("r1", s.r1.supervisor);
    await bare("r1", issueFrame("r1", "lane-a", "WEB_PASSWORD"), ctx);
    expect(ctx.replies[0]?.body).toEqual({ rid: RID, ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "secret handles are not enabled" });
    expect(s.logs).toEqual([]);
  });

  test("an unsandboxed runner gets no handle", async () => {
    const s = system({ runnerUnsandboxed: () => true });
    expect((await s.ask("r1", issueFrame("r1", "lane-a", "WEB_PASSWORD"))).body).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  });
});
