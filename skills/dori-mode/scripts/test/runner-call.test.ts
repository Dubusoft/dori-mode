import { describe, expect, test } from "bun:test";
import { RunnerCalls, RunnerUnavailable, QueryFailed } from "../src/runner/call.ts";
import type { RunnerCallsDeps, Timers } from "../src/runner/call.ts";
import type { AnyRunnerEvent, RunnerControl } from "../src/runner/protocol.ts";

type Timer = { fn: () => void; ms: number; live: boolean };
const fakeTimers = () => {
  const timers: Timer[] = [];
  const api: Timers = {
    set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clear: (h) => { (h as Timer).live = false; },
  };
  return { api, timers, fire: (i = 0) => { const t = timers.filter((x) => x.live)[i]!; t.live = false; t.fn(); } };
};

const setup = (over: { connected?: boolean; proto?: number } = {}) => {
  const sent: { label: string; type: string; body: Record<string, unknown> }[] = [];
  const controls: { label: string; type: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const t = fakeTimers();
  let connected = over.connected ?? true;
  const deps: RunnerCallsDeps = {
    accept: {
      command: ((label: string, type: string, body: Record<string, unknown>) => { if (!connected) return undefined; sent.push({ label, type, body }); return sent.length; }) as never,
      control: ((label: string, type: string, body: Record<string, unknown>) => { if (!connected) return false; controls.push({ label, type, body }); return true; }) as never,
      connected: () => connected,
    },
    proto: () => over.proto ?? 3,
    now: () => 1000,
    timers: t.api,
    log: (l) => logs.push(l),
  };
  return { calls: new RunnerCalls(deps), sent, controls, logs, t, setConnected: (v: boolean) => { connected = v; } };
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

  test("a command newer than the runner's proto is outdated, a proto-2 command still goes", async () => {
    const s = setup({ proto: 2 });
    const err = await s.calls.call("w1", "lane.pause", { key: "a" }).catch((e) => e);
    expect(err.why).toBe("outdated");
    expect(s.sent).toHaveLength(0);
    const p = s.calls.call("w1", "lane.stop", { key: "a" });
    expect(s.sent).toHaveLength(1);
    s.calls.onEvent("w1", result(s.sent[0]!.body.cmdId as string, "verified", "ok", { closed: "tab", gone: true }));
    expect((await p).state).toBe("verified");
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
  test("throws at once when not connected or outdated", async () => {
    expect((await setup({ connected: false }).calls.query("local", "q.panes", {}).catch((e) => e)).why).toBe("disconnected");
    expect((await setup({ proto: 2 }).calls.query("w1", "q.panes", {}).catch((e) => e)).why).toBe("outdated");
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
    s.calls.onControl("local", qresult(s.controls[0]!.body.qid as string, false, "herdr down"));
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(QueryFailed);
    expect(err.message).toBe("herdr down");
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
