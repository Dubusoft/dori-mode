import { describe, expect, test } from "bun:test";
import { RunnerCalls, RunnerUnavailable, QueryFailed } from "../src/runner/call.ts";
import type { RunnerCallsDeps, Timers } from "../src/runner/call.ts";
import { MIN_PROTO, type AnyRunnerEvent, type RunnerControl } from "../src/runner/protocol.ts";

type Timer = { fn: () => void; ms: number; live: boolean };
const fakeTimers = () => {
  const timers: Timer[] = [];
  const api: Timers = {
    set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clear: (h) => { (h as Timer).live = false; },
  };
  return { api, timers, fire: (i = 0) => { const t = timers.filter((x) => x.live)[i]!; t.live = false; t.fn(); } };
};

const setup = (over: { connected?: boolean; proto?: number; lowRefusal?: Error; attemptFailure?: Error } = {}) => {
  const sent: { label: string; type: string; body: Record<string, unknown> }[] = [];
  const controls: { label: string; type: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const attempts: string[] = [], settledAttempts: string[] = [];
  const t = fakeTimers();
  let connected = over.connected ?? true;
  const deps: RunnerCallsDeps = {
    accept: {
      command: ((label: string, type: string, body: Record<string, unknown>) => { if (over.lowRefusal) throw over.lowRefusal; if (!connected) return undefined; sent.push({ label, type, body }); return sent.length; }) as never,
      control: ((label: string, type: string, body: Record<string, unknown>) => { if (!connected) return false; controls.push({ label, type, body }); return true; }) as never,
      connected: () => connected,
    },
    proto: () => "proto" in over ? over.proto : MIN_PROTO,
    now: () => 1000,
    timers: t.api,
    log: (l) => logs.push(l),
    attempts: { record: (_label, _type, id) => { if (over.attemptFailure) throw over.attemptFailure; attempts.push(id); }, settle: (_label, id) => { settledAttempts.push(id); } },
  };
  return { calls: new RunnerCalls(deps), sent, controls, logs, attempts, settledAttempts, t, setConnected: (v: boolean) => { connected = v; } };
};
const result = (cmdId: string, state: "verified" | "failed" | "ambiguous", detail: string, res?: unknown) =>
  ({ type: "cmd.result", body: { cmdId, cmdSeq: 1, state, detail, result: res } }) as unknown as AnyRunnerEvent;
const qresult = (qid: string, ok: boolean, detail: string, res?: unknown) => ({ type: "q.result", body: { qid, ok, detail, result: res } }) as unknown as RunnerControl<"q.result">;
const never = Symbol("pending");
const settled = async (p: Promise<unknown>): Promise<unknown> => Promise.race([p, Promise.resolve().then(() => Promise.resolve()).then(() => never)]);

describe("RunnerCalls.call", () => {
  test("throws RunnerUnavailable at once for an unconnected label and sends nothing", async () => {
    const s = setup({ connected: false });
    const err = await s.calls.call("local", "lane.stop", { key: "a" }).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerUnavailable);
    expect(err.why).toBe("disconnected");
    expect(s.sent).toHaveLength(0);
    expect(s.calls.pending()).toBe(0);
  });

  test("resolves on the matching cmd.result with the structured result", async () => {
    const s = setup();
    const p = s.calls.call("local", "lane.stop", { key: "a" });
    expect(s.sent[0]!.type).toBe("lane.stop");
    const cmdId = s.sent[0]!.body.cmdId as string;
    expect(cmdId).toBe("lane.stop:a:1000:1");
    s.calls.onEvent("local", result("other", "verified", "x", {}));
    s.calls.onEvent("w1", result(cmdId, "verified", "wrong runner", {}));
    expect(await settled(p)).toBe(never);
    s.calls.onEvent("local", result(cmdId, "verified", "closed", { closed: "tab", gone: true }));
    expect(await p).toEqual({ cmdId, state: "verified", detail: "closed", result: { closed: "tab", gone: true } });
    expect(s.calls.pending()).toBe(0);
  });

  test("failed and ambiguous resolve as data; opts.cmdId is used", async () => {
    const s = setup();
    const a = s.calls.call("local", "lane.close", { key: "a", worktreeChecks: false }, { cmdId: "op:1" });
    s.calls.onEvent("local", result("op:1", "failed", "RUNNER_LANE_PANE_MISSING"));
    expect(await a).toEqual({ cmdId: "op:1", state: "failed", detail: "RUNNER_LANE_PANE_MISSING" });
    const b = s.calls.call("local", "lane.close", { key: "a", worktreeChecks: false }, { cmdId: "op:2" });
    s.calls.onEvent("local", result("op:2", "ambiguous", "unknown"));
    expect((await b).state).toBe("ambiguous");
  });

  test("lane.start uses the lane-start id shape and its own timeout; timeout rejects via the injected timer", async () => {
    const s = setup();
    const p = s.calls.call("local", "lane.start", { key: "a" } as never);
    expect(s.sent[0]!.body.cmdId).toBe("lane-start:a:1000");
    expect(s.t.timers[0]!.ms).toBe(90_000);
    s.t.fire();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(RunnerUnavailable);
    expect(err.why).toBe("timeout");
    expect(s.calls.pending()).toBe(0);
    s.calls.onEvent("local", result("lane-start:a:1000", "verified", "late", {}));
    s.calls.onEvent("local", result("lane-start:a:1000", "verified", "late", {}));
    expect(s.logs).toEqual(["RUNNER_CALL_LATE cmdId=lane-start:a:1000 runner=local"]);
  });

  test("a disconnect keeps a pending call waiting for the replayed result", async () => {
    const s = setup();
    const p = s.calls.call("local", "lane.stop", { key: "a" });
    s.calls.disconnected("local");
    expect(s.calls.pending()).toBe(1);
    s.calls.onEvent("local", result(s.sent[0]!.body.cmdId as string, "verified", "ok", {}));
    expect((await p).state).toBe("verified");
  });
});

describe("RunnerCalls.query", () => {
  test("throws at once when not connected", async () => {
    expect((await setup({ connected: false }).calls.query("local", "q.panes", {}).catch((e) => e)).why).toBe("disconnected");
  });

  test("resolves on q.result and sends a control frame with a qid", async () => {
    const s = setup();
    const p = s.calls.query("local", "q.screen", { pane: "p1", lines: 5, source: "recent" });
    const c = s.controls[0]!;
    expect(c.type).toBe("q.screen");
    expect(c.body).toMatchObject({ pane: "p1", lines: 5, source: "recent" });
    s.calls.onControl("local", qresult(c.body.qid as string, true, "ok", { text: "hello" }));
    expect(await p).toEqual({ text: "hello" });
    expect(s.calls.pending()).toBe(0);
  });

  test("ok:false rejects with QueryFailed carrying the detail", async () => {
    const s = setup();
    const p = s.calls.query("local", "q.panes", {});
    s.calls.onControl("local", qresult(s.controls[0]!.body.qid as string, false, "hc down"));
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(QueryFailed);
    expect(err.message).toBe("hc down");
  });

  test("times out on the injected timer and rejects on disconnect", async () => {
    const s = setup();
    const p = s.calls.query("local", "q.panes", {});
    expect(s.t.timers[0]!.ms).toBe(15_000);
    s.t.fire();
    expect((await p.catch((e) => e)).why).toBe("timeout");
    const q = s.calls.query("local", "q.panes", {});
    const r = s.calls.query("w1", "q.panes", {});
    s.calls.disconnected("local");
    expect((await q.catch((e) => e)).why).toBe("disconnected");
    expect(s.calls.pending()).toBe(1);
    s.calls.onControl("w1", qresult(s.controls[2]!.body.qid as string, true, "ok", { panes: [] }));
    expect(await r).toEqual({ panes: [] });
  });

  test("a late q.result is logged once", () => {
    const s = setup();
    s.calls.onControl("local", qresult("q:1:9", true, "ok"));
    s.calls.onControl("local", qresult("q:1:9", true, "ok"));
    expect(s.logs).toHaveLength(1);
  });
});

test("file operations fail closed for an unknown proto before attempts, sends or timers", async () => {
  const s = setup({ proto: undefined });
  const detail = "lane files need the runner's proto (unknown); wait for its hello and retry";
  for (const type of ["lane.start", "lane.recover", "q.lane.files"] as const) {
    const p = type === "q.lane.files" ? s.calls.query("box", type, { key: "a" }) : s.calls.call("box", type, { key: "a" } as never);
    await expect(p).rejects.toMatchObject({ why: "outdated", message: `RUNNER_UNAVAILABLE runner=box outdated: ${detail}` });
  }
  expect([s.sent.length, s.controls.length, s.attempts.length, s.t.timers.length, s.calls.pending()]).toEqual([0, 0, 0, 0, 0]);
});

test("an unknown proto still sends commands and ordinary queries", async () => {
  const s = setup({ proto: undefined });
  const command = s.calls.call("box", "lane.observe", { key: "a" } as never);
  s.calls.onEvent("box", result(s.sent[0]!.body.cmdId as string, "verified", "ok", {}));
  expect((await command).state).toBe("verified");
  const query = s.calls.query("box", "q.panes", {});
  s.calls.onControl("box", qresult(s.controls[0]!.body.qid as string, true, "", { panes: [] }));
  expect(await query).toEqual({ panes: [] });
});

test("a low-level gate change settles the never-sent attempt and removes its waiter and timer", async () => {
  const refusal = new RunnerUnavailable("box", "disconnected", "no admitted connection for lane.start");
  const s = setup({ lowRefusal: refusal });
  await expect(s.calls.call("box", "lane.start", { key: "a" } as never)).rejects.toBe(refusal);
  expect(s.attempts).toEqual(["lane-start:a:1000"]);
  expect(s.settledAttempts).toEqual(s.attempts);
  expect(s.sent).toEqual([]);
  expect(s.calls.pending()).toBe(0);
  expect(s.t.timers.every((t) => !t.live)).toBe(true);
});

test("a failed attempt write rejects the call with no send, waiter or timer left to time out unhandled", async () => {
  const failure = new Error("disk write failed");
  const s = setup({ attemptFailure: failure });
  await expect(s.calls.call("box", "lane.start", { key: "a" } as never)).rejects.toBe(failure);
  expect(s.sent).toEqual([]);
  expect(s.calls.pending()).toBe(0);
  expect(s.t.timers).toEqual([]);
});

test("complete body preflight includes the exact cmdId and allocates nothing on overflow", async () => {
  const s = setup();
  const body = { key: "a", briefText: "" };
  const fixed = Buffer.byteLength(JSON.stringify({ ...body, cmdId: "c" }));
  const briefText = "x".repeat(786432 - fixed);
  const p = s.calls.call("box", "lane.start", { ...body, briefText } as never, { cmdId: "c" });
  s.calls.onEvent("box", result("c", "verified", "ok", {})); await p;
  const before = [s.attempts.length, s.sent.length, s.t.timers.length];
  await expect(s.calls.call("box", "lane.start", { ...body, briefText: briefText + "x" } as never, { cmdId: "c" })).rejects.toThrow("LANE_FILES_FRAME_TOO_LARGE");
  expect([s.attempts.length, s.sent.length, s.t.timers.length]).toEqual(before);
});
