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

const setup = (over: { connected?: boolean; proto?: number; lowRefusal?: Error } = {}) => {
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
    proto: () => "proto" in over ? over.proto : 5,
    now: () => 1000,
    timers: t.api,
    log: (l) => logs.push(l),
    attempts: { record: (_label, _type, id) => { attempts.push(id); }, settle: (_label, id) => { settledAttempts.push(id); } },
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

test.each([undefined, 4])("file operations fail closed for proto %s before attempts, sends or timers", async (proto) => {
  const s = setup({ proto });
  const detail = proto === undefined
    ? "lane files require proto 5 (runner proto unknown); run dori runner update, wait for its hello, and retry"
    : "lane files require proto 5 (runner proto 4); run dori runner update";
  for (const type of ["lane.start", "lane.recover", "q.lane.files"] as const) {
    const p = type === "q.lane.files" ? s.calls.query("box", type, { key: "a" }) : s.calls.call("box", type, { key: "a" } as never);
    await expect(p).rejects.toMatchObject({ why: "outdated", message: `RUNNER_UNAVAILABLE runner=box outdated: ${detail}` });
  }
  expect([s.sent.length, s.controls.length, s.attempts.length, s.t.timers.length, s.calls.pending()]).toEqual([0, 0, 0, 0, 0]);
});

test("unknown proto retains existing host.herdr and ordinary query behavior; known proto 3 retains its minimum", async () => {
  const s = setup({ proto: undefined });
  const command = s.calls.call("box", "host.herdr", {} as never);
  s.calls.onEvent("box", result(s.sent[0]!.body.cmdId as string, "verified", "ok", {}));
  expect((await command).state).toBe("verified");
  const query = s.calls.query("box", "q.panes", {});
  s.calls.onControl("box", qresult(s.controls[0]!.body.qid as string, true, "", { panes: [] }));
  expect(await query).toEqual({ panes: [] });
  await expect(setup({ proto: 3 }).calls.call("box", "host.herdr", {} as never)).rejects.toThrow("host.herdr needs runner proto 4, the runner speaks 3");
});

test("a low-level gate change settles the never-sent attempt and removes its waiter and timer", async () => {
  const refusal = new RunnerUnavailable("box", "outdated", "lane files require proto 5 (runner proto 4); run dori runner update");
  const s = setup({ lowRefusal: refusal });
  await expect(s.calls.call("box", "lane.start", { key: "a" } as never)).rejects.toBe(refusal);
  expect(s.attempts).toEqual(["lane-start:a:1000"]);
  expect(s.settledAttempts).toEqual(s.attempts);
  expect(s.sent).toEqual([]);
  expect(s.calls.pending()).toBe(0);
  expect(s.t.timers.every((t) => !t.live)).toBe(true);
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
