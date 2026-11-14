import { describe, expect, test } from "bun:test";

import {
  decodeFrame, encodeFrame, PROTO, RUNNER_CONTROL_TYPES, runnerControl, SECRET_PROTO, secretsSupported, SUPERVISOR_CONTROL_TYPES, supervisorControl,
  ProtocolError, QUERY_TYPES,
} from "../src/runner/protocol.ts";

const HEAD = { runner: "r1", gen: 1, epoch: 1 };
const RID = "0123456789abcdef0123456789abcdef";
const SEALED = { n: "bm9uY2U=", c: "Y2lwaGVydGV4dA==" };
const raw = (value: unknown, from: "runner" | "supervisor") => () => decodeFrame(JSON.stringify(value), from);

describe("proto 6 secret frames", () => {
  test("the version gate", () => {
    expect(PROTO).toBe(9);
    expect(SECRET_PROTO).toBe(6);
    expect([undefined, 0, 5].map(secretsSupported)).toEqual([false, false, false]);
    expect([6, 7, 8].map(secretsSupported)).toEqual([true, true, true]);
  });

  test("runner secret.get and secret.run decode, with and without repo", () => {
    const get = runnerControl(HEAD, "secret.get", { rid: RID, key: "lane-a", names: ["NPM_TOKEN"], repo: "acme/app" });
    expect(decodeFrame(encodeFrame(get), "runner")).toEqual(get);
    const bare = runnerControl(HEAD, "secret.get", { rid: RID, key: "lane-a", names: [] });
    expect(decodeFrame(encodeFrame(bare), "runner")).toEqual(bare);
    const run = runnerControl(HEAD, "secret.run", { rid: RID, key: "lane-a", op: "deploy", repo: "acme/app" });
    expect(decodeFrame(encodeFrame(run), "runner")).toEqual(run);
  });

  test("supervisor secret.value and secret.run.result decode, sealed or refused, and are control frames", () => {
    for (const type of ["secret.value", "secret.run.result"] as const) {
      const ok = supervisorControl(HEAD, type, { rid: RID, ok: true, sealed: SEALED });
      expect(decodeFrame(encodeFrame(ok), "supervisor")).toEqual(ok);
      const refused = supervisorControl(HEAD, type, { rid: RID, ok: false, code: "RUNNER_SECRET_DENIED", detail: "NPM_TOKEN is not granted to lane-a" });
      expect(decodeFrame(encodeFrame(refused), "supervisor")).toEqual(refused);
      expect(SUPERVISOR_CONTROL_TYPES).toContain(type);
      expect(QUERY_TYPES as readonly string[]).not.toContain(type);
    }
    expect(RUNNER_CONTROL_TYPES).toEqual(expect.arrayContaining(["secret.get", "secret.run"]));
  });

  test("a frame sent by the wrong side is rejected", () => {
    const get = runnerControl(HEAD, "secret.get", { rid: RID, key: "k", names: ["A"] });
    const value = supervisorControl(HEAD, "secret.value", { rid: RID, ok: true, sealed: SEALED });
    expect(raw(get, "supervisor")).toThrow("RUNNER_FRAME_INVALID wrong-direction");
    expect(raw(value, "runner")).toThrow("RUNNER_FRAME_INVALID wrong-direction");
    expect(raw(supervisorControl(HEAD, "secret.run.result", { rid: RID, ok: true }), "runner")).toThrow("wrong-direction");
  });

  test("an unknown field, a missing rid, a wrong shape and a sequence number are rejected", () => {
    const get = runnerControl(HEAD, "secret.get", { rid: RID, key: "k", names: ["A"] });
    expect(raw({ ...get, body: { ...get.body, extra: 1 } }, "runner")).toThrow("RUNNER_FRAME_INVALID unknown-field body.extra");
    const { rid: _rid, ...noRid } = get.body;
    expect(raw({ ...get, body: noRid }, "runner")).toThrow("RUNNER_FRAME_INVALID missing-field body.rid");
    expect(raw({ ...get, body: { ...get.body, names: "A" } }, "runner")).toThrow("RUNNER_FRAME_INVALID field-type body.names");
    expect(raw({ ...get, seq: 1 }, "runner")).toThrow("RUNNER_FRAME_INVALID sequence");
    const run = runnerControl(HEAD, "secret.run", { rid: RID, key: "k", op: "deploy" });
    const { rid: _r2, ...runNoRid } = run.body;
    expect(raw({ ...run, body: runNoRid }, "runner")).toThrow("missing-field body.rid");
    const value = supervisorControl(HEAD, "secret.value", { rid: RID, ok: true, sealed: SEALED });
    const { rid: _r3, ...valueNoRid } = value.body;
    expect(raw({ ...value, body: valueNoRid }, "supervisor")).toThrow("missing-field body.rid");
    expect(raw({ ...value, body: { ...value.body, value: "x" } }, "supervisor")).toThrow("unknown-field body.value");
    expect(raw({ ...value, body: { ...value.body, sealed: { n: "a" } } }, "supervisor")).toThrow("missing-field body.sealed.c");
    expect(raw({ ...value, body: { ...value.body, sealed: { ...SEALED, k: "x" } } }, "supervisor")).toThrow(ProtocolError);
  });
});
