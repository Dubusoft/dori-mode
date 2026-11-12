import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerAuth, SupervisorAuth, type Session } from "../src/runner/auth.ts";
import { fakeClock, withState } from "./fakes.ts";

const LABEL = "r1";
const HOST = "host-1";
const VALUE = "dori-test-throwaway-123";
const AAD = { runner: LABEL, gen: 3, epoch: 2, type: "secret.value", rid: "0123456789abcdef0123456789abcdef" };

const clock = fakeClock(1_000_000);
let tmp: ReturnType<typeof withState>;
const closers: (() => void)[] = [];
beforeEach(() => { tmp = withState(); });
afterEach(() => { for (const done of closers.splice(0)) done(); tmp.done(); });

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
  const hello = { label: LABEL, hostId: HOST, gen: 3 };
  const pending = run.startHello();
  const begun = sup.beginHello({ ...hello, nonce: pending.nonce, dh: pending.dh } as Parameters<SupervisorAuth["beginHello"]>[0]);
  if (!begun.ok) throw new Error(begun.detail);
  const answer = run.answerChallenge(pending, hello, begun.challenge);
  if (!answer.ok) throw new Error(answer.detail);
  const supervisor = sup.finishHello(begun.pending, answer.sig);
  if (!supervisor) throw new Error("handshake failed");
  return { runner: answer.session, supervisor };
};

describe("secret AEAD", () => {
  test("roundtrips, and a runner and supervisor session from one handshake open each other's boxes", () => {
    const { runner, supervisor } = handshake();
    expect(supervisor.openSecret("s2r", AAD, supervisor.sealSecret("s2r", AAD, VALUE))).toBe(VALUE);
    expect(runner.openSecret("s2r", AAD, supervisor.sealSecret("s2r", AAD, VALUE))).toBe(VALUE);
    expect(supervisor.openSecret("r2s", AAD, runner.sealSecret("r2s", AAD, VALUE))).toBe(VALUE);
  });

  test("fails for the other direction, a changed aad field, a flipped ciphertext byte or a changed nonce", () => {
    const { runner, supervisor } = handshake();
    const box = supervisor.sealSecret("s2r", AAD, VALUE);
    expect(runner.openSecret("r2s", AAD, box)).toBeUndefined();
    for (const changed of [{ ...AAD, rid: "f".repeat(32) }, { ...AAD, type: "secret.run.result" }, { ...AAD, gen: 4 }, { ...AAD, runner: "r2" }]) {
      expect(runner.openSecret("s2r", changed, box)).toBeUndefined();
    }
    const bytes = Buffer.from(box.c, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(runner.openSecret("s2r", AAD, { ...box, c: bytes.toString("base64") })).toBeUndefined();
    const nonce = Buffer.from(box.n, "base64");
    nonce[0] = (nonce[0] ?? 0) ^ 1;
    expect(runner.openSecret("s2r", AAD, { ...box, n: nonce.toString("base64") })).toBeUndefined();
  });

  test("a box from another handshake does not open", () => {
    const first = handshake();
    const second = handshake();
    expect(second.runner.openSecret("s2r", AAD, first.supervisor.sealSecret("s2r", AAD, VALUE))).toBeUndefined();
  });

  test("garbage input returns undefined without throwing", () => {
    const { runner } = handshake();
    const good = runner.sealSecret("r2s", AAD, VALUE);
    expect(runner.openSecret("r2s", AAD, { n: "!!!", c: "@@@" })).toBeUndefined();
    expect(runner.openSecret("r2s", AAD, { n: good.n, c: "AAAA" })).toBeUndefined();
    expect(runner.openSecret("r2s", AAD, { n: "AAAA", c: good.c })).toBeUndefined();
    expect(runner.openSecret("r2s", AAD, { n: good.n, c: "" })).toBeUndefined();
    expect(runner.openSecret("r2s", AAD, {} as never)).toBeUndefined();
  });

  test("two seals of the same plaintext differ in nonce and ciphertext, and the box does not hold the plaintext", () => {
    const { runner } = handshake();
    const a = runner.sealSecret("r2s", AAD, VALUE);
    const b = runner.sealSecret("r2s", AAD, VALUE);
    expect(a.n).not.toBe(b.n);
    expect(a.c).not.toBe(b.c);
    expect(JSON.stringify(a)).not.toContain(VALUE);
    expect(Buffer.from(a.n, "base64")).toHaveLength(12);
  });
});
