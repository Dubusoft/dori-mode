import { describe, expect, test } from "bun:test";

import { LaneOpsError, laneOps, type LaneOps, type LaneRef, machineRunner, runnerOf } from "../src/lane-ops.ts";
import { type CallOptions, type CallResult, type RunnerCall, RunnerUnavailable } from "../src/runner/call.ts";
import type { JsonValue } from "../src/runner/protocol.ts";
import { LOCAL_RUNNER } from "../src/runner/serve.ts";
import { fakeLaneOps, newWorld, sent, WT } from "./fakes.ts";

type Invocation =
  | { readonly fn: "call"; readonly label: string; readonly type: string; readonly body: unknown; readonly opts?: CallOptions }
  | { readonly fn: "query"; readonly label: string; readonly type: string; readonly body: unknown };

/** A RunnerCall that records every invocation and answers from a script keyed by type. */
const recording = (answers: {
  readonly calls?: Record<string, () => CallResult<unknown>>;
  readonly queries?: Record<string, () => unknown>;
  readonly connected?: (label: string) => boolean;
} = {}): RunnerCall & { readonly seen: Invocation[] } => {
  const seen: Invocation[] = [];
  return {
    seen,
    call: async (label, type, body, opts) => {
      seen.push({ fn: "call", label, type, body, ...(opts ? { opts } : {}) });
      const answer = answers.calls?.[type];
      if (!answer) throw new Error(`no scripted answer for ${type}`);
      return answer() as never;
    },
    query: async (label, type, body) => {
      seen.push({ fn: "query", label, type, body });
      const answer = answers.queries?.[type];
      if (!answer) throw new Error(`no scripted answer for ${type}`);
      return answer() as never;
    },
    connected: (label) => answers.connected?.(label) ?? true,
  };
};

const verified = (result: JsonValue | Record<string, unknown>) => (): CallResult<unknown> => ({ cmdId: "c1", state: "verified", detail: "ok", result });
const failed = (detail: string) => (): CallResult<unknown> => ({ cmdId: "c1", state: "failed", detail });
const ambiguous = (detail: string) => (): CallResult<unknown> => ({ cmdId: "c1", state: "ambiguous", detail });
const down = (label: string, why: "disconnected" | "timeout" | "outdated" = "disconnected") => (): never => {
  throw new RunnerUnavailable(label, why, "no admitted connection");
};

const local: LaneRef = { key: "demo", pane: "w1:p1", tab: "w1:t1", cwd: "/repo/demo", mode: "ulw", model: "m" };
const remote: LaneRef = { key: "far", machine: "box", runner: "box", pane: "w9:p2", tab: "w9:t2", remoteCwd: "/srv/far", mode: "ulw", model: "m" };
const PANE = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "working" };
const INSPECTION = { status: "working", cwd: "/repo/demo", cwdExists: true };
const OBSERVATION = { os: "linux", sampledAt: 5, sample: { load1: 0.1, memFreePct: 50, diskFreeGb: 10, swapFreeGb: 0, swapTotalGb: 0, panes: 1 }, panes: [PANE] };

const clock = () => { const c = { at: 1_000_000, now: () => c.at }; return c; };

/** Runs one facade method against a recording RunnerCall answering every type. */
const ALL = {
  calls: {
    "lane.start": verified({ pane: "w1:p1", tab: "w1:t1", startup: { verdict: "ok", detail: "" } }),
    "lane.adopt": verified({ pane: "w1:p1", tab: "w1:t1", tokenFile: "/t" }),
    "lane.close": verified({ closed: "tab", gone: true }),
    "lane.pause": verified({ goal: "confirmed", working: false, stopped: true }),
    "lane.resume": verified({ goal: "confirmed" }),
    "lane.recover": verified({ pane: "w1:p3", tab: "w1:t3", relaunched: true, resumed: true }),
    "lane.send": verified({ delivery: "delivered" }),
    "lane.notify": verified({}),
    "lane.attach": verified({ dir: "/r/briefs/far.files/a0001" }),
    "lane.git": verified({ code: 0, out: "removed", err: "" }),
    "lane.observe": verified({ status: "idle" }),
    "guard.kill": verified({ killed: [{ pid: 42, lane: "demo", comm: "node", rssKb: 100 }] }),
  },
  queries: {
    "q.panes": () => ({ panes: [PANE] }),
    "q.screen": () => ({ text: "screen text" }),
    "q.process": () => ({ info: { shell_pid: 7 } }),
    "q.stat": () => ({ exists: [true, false] }),
    "q.lane.inspect": () => INSPECTION,
    "q.machine.observe": () => OBSERVATION,
    "q.lane.files": () => ({}),
  },
};

describe("laneOps: one runner call per method", () => {
  const cases: readonly [keyof LaneOps, (ops: LaneOps) => Promise<unknown>, Invocation, unknown][] = [
    ["panes", (o) => o.panes("box"), { fn: "query", label: "box", type: "q.panes", body: {} }, [PANE]],
    ["screen", (o) => o.screen({ pane: "w1:p1" }), { fn: "query", label: LOCAL_RUNNER, type: "q.screen", body: { pane: "w1:p1", lines: 0, source: "visible" } }, "screen text"],
    ["screen", (o) => o.screen({ machine: "box", pane: "w9:p2" }, 200), { fn: "query", label: "box", type: "q.screen", body: { pane: "w9:p2", lines: 200, source: "recent" } }, "screen text"],
    ["processInfo", (o) => o.processInfo({ pane: "w1:p1" }), { fn: "query", label: LOCAL_RUNNER, type: "q.process", body: { pane: "w1:p1" } },
      { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 7 } } }), err: "" }],
    ["status", (o) => o.status({ pane: "w1:p1" }), { fn: "query", label: LOCAL_RUNNER, type: "q.panes", body: {} }, { status: "working" }],
    ["exists", (o) => o.exists("box", ["/a", "/b"]), { fn: "query", label: "box", type: "q.stat", body: { paths: ["/a", "/b"] } }, [true, false]],
    ["inspect", (o) => o.inspect(local, { git: true, roots: ["/repo"], branches: ["b1"], session: true, sessionsDir: "/s" }),
      { fn: "query", label: LOCAL_RUNNER, type: "q.lane.inspect", body: { key: "demo", cwd: "/repo/demo", git: true, roots: ["/repo"], branches: ["b1"], session: true, sessionsDir: "/s" } }, INSPECTION],
    ["observeMachine", (o) => o.observeMachine("box"), { fn: "query", label: "box", type: "q.machine.observe", body: {} }, OBSERVATION],
    ["files", (o) => o.files(remote), { fn: "query", label: "box", type: "q.lane.files", body: { key: "far" } }, undefined],
    ["send", (o) => o.send(remote, "hi", { mode: "guarded", refuseWhileAsking: true, inputCheck: false, cmdId: "op:9" }),
      { fn: "call", label: "box", type: "lane.send", body: { key: "far", text: "hi", verify: false, mode: "guarded", refuseWhileAsking: true }, opts: { cmdId: "op:9" } }, "delivered"],
    ["pause", (o) => o.pause(local, "stop"), { fn: "call", label: LOCAL_RUNNER, type: "lane.pause", body: { key: "demo", step: "stop" } },
      { goal: "confirmed", working: false, stopped: true }],
    ["resume", (o) => o.resume(remote), { fn: "call", label: "box", type: "lane.resume", body: { key: "far" } }, { goal: "confirmed" }],
    ["start", (o) => o.start({
      key: "demo", machine: "box", briefText: "B", done: "merged a/b#1", thread: "t", cwd: "/srv/demo", sandbox: true, mode: "ulw", model: "m",
      keywords: "ulw", session: "s1", target: { pane: "w9:p1" }, heavySlots: 2, heavyMaxLoad: 4, cmdId: "lane-start:demo:1",
    }), {
      fn: "call", label: "box", type: "lane.start", body: {
        key: "demo", briefText: "B", done: "merged a/b#1", thread: "t", cwd: "/srv/demo", agentProfile: "sandboxed", mode: "ulw", model: "m",
        sandbox: true, expectedLaneGen: 0, keywords: "ulw", session: "s1", target: { pane: "w9:p1" }, heavySlots: 2, heavyMaxLoad: 4,
      }, opts: { cmdId: "lane-start:demo:1" },
    }, { pane: "w1:p1", tab: "w1:t1", startup: { verdict: "ok", detail: "" } }],
    ["adopt", (o) => o.adopt({ key: "demo", pane: "w1:p1", cwd: "/repo/demo", mode: "ulw", model: "m" }),
      { fn: "call", label: LOCAL_RUNNER, type: "lane.adopt", body: { key: "demo", pane: "w1:p1", mode: "ulw", model: "m", cwd: "/repo/demo" } },
      { pane: "w1:p1", tab: "w1:t1", tokenFile: "/t" }],
    ["recover", (o) => o.recover(local, { session: "s2" }), { fn: "call", label: LOCAL_RUNNER, type: "lane.recover", body: { key: "demo", session: "s2" }, opts: { cmdId: "recover:demo:1000000" } },
      { pane: "w1:p3", tab: "w1:t3", relaunched: true, resumed: true }],
    ["close", (o) => o.close(remote, { cmdId: "op:3" }), { fn: "call", label: "box", type: "lane.close", body: { key: "far", worktreeChecks: false }, opts: { cmdId: "op:3" } },
      { closed: "tab", gone: true }],
    ["git", (o) => o.git(local, { op: "worktree-remove", root: "/repo", path: WT }, { cmdId: "op:4" }),
      { fn: "call", label: LOCAL_RUNNER, type: "lane.git", body: { key: "demo", op: "worktree-remove", root: "/repo", path: WT }, opts: { cmdId: "op:4" } },
      { code: 0, out: "removed", err: "" }],
    ["notify", (o) => o.notify(local, { status: "not-done", objection: { at: "t", reasons: ["r1"] } }),
      { fn: "call", label: LOCAL_RUNNER, type: "lane.notify", body: { key: "demo", status: "not-done", objection: { at: "t", reasons: ["r1"] } } }, undefined],
    ["attach", (o) => o.attach(remote, { directories: [], files: [] }), { fn: "call", label: "box", type: "lane.attach", body: { key: "far", tree: { directories: [], files: [] } } },
      { dir: "/r/briefs/far.files/a0001" }],
    ["kill", (o) => o.kill(undefined, ["demo"]), { fn: "call", label: LOCAL_RUNNER, type: "guard.kill", body: { keys: ["demo"] } },
      [{ pid: 42, lane: "demo", comm: "node", rssKb: 100 }]],
    ["observe", (o) => o.observe(remote), { fn: "call", label: "box", type: "lane.observe", body: { key: "far" } }, "idle"],
    // A runner that records no turn answers none.
    ["turn", (o) => o.turn(remote), { fn: "call", label: "box", type: "lane.observe", body: { key: "far" } }, undefined],
  ];

  for (const [name, run, expected, value] of cases) {
    test(`${name} → ${expected.type} on ${expected.label}`, async () => {
      const call = recording(ALL);
      expect(await run(laneOps(call, clock()))).toEqual(value as never);
      expect(call.seen).toEqual([expected]);
    });
  }

  test("git forwards fetch-branch and worktree-add bodies", async () => {
    const call = recording({ calls: { "lane.git": verified({ code: 0, out: "", err: "" }) } });
    const ops = laneOps(call, clock());
    await ops.git(local, { op: "fetch-branch", root: "/repo", remote: "origin", branch: "feat" });
    await ops.git(local, { op: "worktree-add", root: "/repo", path: "/wt/k", ref: "refs/remotes/origin/feat" });
    expect(call.seen.map((s) => s.body)).toEqual([
      { key: "demo", op: "fetch-branch", root: "/repo", remote: "origin", branch: "feat" },
      { key: "demo", op: "worktree-add", root: "/repo", path: "/wt/k", ref: "refs/remotes/origin/feat" },
    ]);
  });

  test("git forwards a branch delete's sha; inspect forwards process", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const call = recording(ALL);
    const ops = laneOps(call, clock());
    await ops.git(local, { op: "branch-delete", root: "/repo", branch: "demo-fix", sha });
    await ops.git(remote, { op: "remote-branch-delete", root: "/srv", branch: "far-fix", remote: "origin", sha }, { cmdId: "op:5" });
    await ops.git(local, { op: "branch-delete", root: "/repo", branch: "demo-fix" });
    await ops.inspect(local, { process: true });
    await ops.inspect(local, {});
    expect(call.seen).toEqual([
      { fn: "call", label: LOCAL_RUNNER, type: "lane.git", body: { key: "demo", op: "branch-delete", root: "/repo", branch: "demo-fix", sha } },
      { fn: "call", label: "box", type: "lane.git", body: { key: "far", op: "remote-branch-delete", root: "/srv", branch: "far-fix", remote: "origin", sha }, opts: { cmdId: "op:5" } },
      { fn: "call", label: LOCAL_RUNNER, type: "lane.git", body: { key: "demo", op: "branch-delete", root: "/repo", branch: "demo-fix" } },
      { fn: "query", label: LOCAL_RUNNER, type: "q.lane.inspect", body: { key: "demo", cwd: "/repo/demo", process: true } },
      { fn: "query", label: LOCAL_RUNNER, type: "q.lane.inspect", body: { key: "demo", cwd: "/repo/demo" } },
    ]);
  });

  test("every LaneOps method is covered", () => {
    const covered = new Set([...cases.map(([n]) => n), "connected"]);
    expect(Object.keys(laneOps(recording(), clock())).filter((k) => !covered.has(k as keyof LaneOps))).toEqual([]);
  });

  test("connected asks the machine's runner", () => {
    const asked: string[] = [];
    const ops = laneOps(recording({ connected: (l) => { asked.push(l); return l === "box"; } }), clock());
    expect([ops.connected("box"), ops.connected()]).toEqual([true, false]);
    expect(asked).toEqual(["box", LOCAL_RUNNER]);
  });
});

describe("laneOps routing", () => {
  test("start and recover explicitly forward fresh file pairs while files queries the owning runner", async () => {
    const call = recording(ALL), ops = laneOps(call, clock());
    const files = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: true }, tree: { directories: [], files: [] }, references: [] };
    await ops.start({ key: "k", briefText: "body", files, done: "d", thread: "none", cwd: "/repo", sandbox: true, mode: "ulw", model: "m", keywords: "ulw", cmdId: "start" });
    await ops.recover(remote, { briefText: "fresh", files, cmdId: "recover" });
    expect(call.seen.map((s) => [s.label, s.type, s.body, "opts" in s ? s.opts : undefined])).toEqual([
      ["local", "lane.start", { key: "k", briefText: "body", files, done: "d", thread: "none", cwd: "/repo", agentProfile: "sandboxed", mode: "ulw", model: "m", sandbox: true, expectedLaneGen: 0, keywords: "ulw" }, { cmdId: "start" }],
      ["box", "lane.recover", { key: "far", briefText: "fresh", files }, { cmdId: "recover" }],
    ]);
  });

  test("files rejects unknown query fields and malformed nested manifests", async () => {
    for (const value of [{ files: null }, { extra: true }, { files: { run: {}, tree: {} } }]) {
      const call = recording({ queries: { "q.lane.files": () => value } });
      await expect(laneOps(call, clock()).files(remote)).rejects.toThrow("malformed q.result q.lane.files");
    }
  });

  test("runnerOf prefers Lane.runner, then the machine, then the local runner", () => {
    expect(runnerOf({ runner: "r", machine: "m" })).toBe("r");
    expect(runnerOf({ machine: "m" })).toBe("m");
    expect(runnerOf({})).toBe(LOCAL_RUNNER);
    expect(machineRunner(undefined)).toBe(LOCAL_RUNNER);
  });

  test("a remote lane's Done checks run on the local runner in doneCwd (D10)", async () => {
    const call = recording(ALL);
    await laneOps(call, clock()).inspect(remote, { done: "merged a/b#1", doneCwd: "/repo" });
    expect(call.seen).toEqual([{ fn: "query", label: LOCAL_RUNNER, type: "q.lane.inspect", body: { key: "far", cwd: "/repo", done: "merged a/b#1", doneCwd: "/repo" } }]);
  });

  test("a remote lane's other reads go to its runner with its remote cwd", async () => {
    const call = recording(ALL);
    await laneOps(call, clock()).inspect(remote, { git: true });
    expect(call.seen).toEqual([{ fn: "query", label: "box", type: "q.lane.inspect", body: { key: "far", cwd: "/srv/far", git: true } }]);
  });

  test("an unsandboxed start names the default profile and omits unset options", async () => {
    const call = recording(ALL);
    await laneOps(call, clock()).start({ key: "k", briefText: "B", done: "d", thread: "t", cwd: "/c", sandbox: false, mode: "mass-ulw", model: "m", keywords: "mass-ulw" });
    expect(call.seen).toEqual([{ fn: "call", label: LOCAL_RUNNER, type: "lane.start", body: {
      key: "k", briefText: "B", done: "d", thread: "t", cwd: "/c", agentProfile: "default", mode: "mass-ulw", model: "m", sandbox: false, expectedLaneGen: 0, keywords: "mass-ulw",
    }, opts: { cmdId: "lane-start:k:1000000" } }]);
  });

  test("send verifies by default and pause sends no step when none is asked", async () => {
    const call = recording(ALL);
    const ops = laneOps(call, clock());
    await ops.send(local, "x");
    await ops.pause(local);
    expect(call.seen.map((s) => s.body)).toEqual([{ key: "demo", text: "x", verify: true }, { key: "demo" }]);
  });
});

describe("laneOps failures", () => {
  test("send on RunnerUnavailable returns failed and logs once per lane per minute", async () => {
    const lines: string[] = [];
    const c = clock();
    const ops = laneOps(recording({ calls: { "lane.send": down("local") } }), { now: c.now, log: (l) => lines.push(l) });
    expect(await ops.send(local, "a")).toBe("failed");
    c.at += 30_000;
    expect(await ops.send(local, "b")).toBe("failed");
    c.at += 30_000;
    expect(await ops.send(local, "c")).toBe("failed");
    expect(lines).toEqual([
      "LANE_SEND_FAILED demo runner=local RUNNER_UNAVAILABLE runner=local disconnected: no admitted connection",
      "LANE_SEND_FAILED demo runner=local RUNNER_UNAVAILABLE runner=local disconnected: no admitted connection",
    ]);
  });

  test("send: a failed result is failed, an ambiguous one unconfirmed, a refusal failed", async () => {
    const one = async (answer: () => CallResult<unknown>) => laneOps(recording({ calls: { "lane.send": answer } }), clock()).send(local, "x");
    expect(await one(failed("RUNNER_LANE_PANE_MISSING"))).toBe("failed");
    expect(await one(ambiguous("lost"))).toBe("unconfirmed");
    expect(await one(verified({ delivery: "failed", refusal: "asking" }))).toBe("failed");
    expect(await one(verified({ delivery: "sent" }))).toBe("sent");
    expect(await one(verified({ nonsense: 1 }))).toBe("failed");
  });

  test("reads and effects of a disconnected runner throw RUNNER_UNAVAILABLE, of an outdated one RUNNER_OUTDATED", async () => {
    const off = laneOps(recording({ queries: { "q.panes": down("box") }, calls: { "lane.close": down("box") } }), clock());
    const old = laneOps(recording({ queries: { "q.screen": down("box", "outdated") }, calls: { "lane.pause": down("box", "outdated") } }), clock());
    const codeOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: LaneOpsError) => `${e.code} ${e.label}`);
    expect(await codeOf(off.panes("box"))).toBe("RUNNER_UNAVAILABLE box");
    expect(await codeOf(off.close(remote))).toBe("RUNNER_UNAVAILABLE box");
    expect(await codeOf(old.screen({ machine: "box", pane: "p" }))).toBe("RUNNER_OUTDATED box");
    expect(await codeOf(old.pause(remote))).toBe("RUNNER_OUTDATED box");
  });

  test("an effect that failed throws LANE_OP_FAILED with the runner's detail; an ambiguous close throws LANE_OP_AMBIGUOUS", async () => {
    const ops = laneOps(recording({ calls: { "lane.start": failed("RUNNER_CMD_REJECTED cwd-outside-roots"), "lane.close": ambiguous("no read-back") } }), clock());
    const start = ops.start({ key: "k", briefText: "B", done: "d", thread: "t", cwd: "/x", sandbox: false, mode: "ulw", model: "m", keywords: "ulw" });
    await expect(start).rejects.toMatchObject({ code: "LANE_OP_FAILED", detail: "lane.start RUNNER_CMD_REJECTED cwd-outside-roots" });
    await expect(ops.close(local)).rejects.toMatchObject({ code: "LANE_OP_AMBIGUOUS", label: LOCAL_RUNNER });
  });

  test("git maps failed to code 1 and ambiguous to code 2", async () => {
    const op = { op: "branch-delete", root: "/repo", branch: "b" } as const;
    expect(await laneOps(recording({ calls: { "lane.git": failed("not merged") } }), clock()).git(local, op)).toEqual({ code: 1, out: "", err: "not merged" });
    expect(await laneOps(recording({ calls: { "lane.git": ambiguous("lost") } }), clock()).git(local, op)).toEqual({ code: 2, out: "", err: "ambiguous: lost" });
  });

  test("a malformed q.result is LANE_OP_FAILED", async () => {
    const ops = laneOps(recording({ queries: { "q.panes": () => ({ panes: [{ id: 1 }] }), "q.lane.inspect": () => ({ status: "zombie" }), "q.stat": () => ({ exists: [true] }) } }), clock());
    await expect(ops.panes()).rejects.toMatchObject({ code: "LANE_OP_FAILED", detail: "malformed q.result q.panes" });
    await expect(ops.inspect(local, {})).rejects.toMatchObject({ code: "LANE_OP_FAILED", detail: "malformed q.result q.lane.inspect" });
    await expect(ops.exists(undefined, ["/a", "/b"])).rejects.toMatchObject({ code: "LANE_OP_FAILED" });
  });

  test("a malformed cmd.result is LANE_OP_FAILED", async () => {
    const ops = laneOps(recording({ calls: { "lane.resume": verified({ goal: "maybe" }) } }), clock());
    await expect(ops.resume(local)).rejects.toMatchObject({ code: "LANE_OP_FAILED", detail: "malformed cmd.result lane.resume" });
  });

  test("status and notify never throw", async () => {
    const lines: string[] = [];
    const ops = laneOps(recording({ queries: { "q.panes": down("local") }, calls: { "lane.notify": down("local") } }), { now: () => 0, log: (l) => lines.push(l) });
    expect(await ops.status({ pane: "w1:p1" })).toEqual({ error: "RUNNER_UNAVAILABLE runner=local disconnected: no admitted connection" });
    await ops.notify(local, { status: "working" });
    expect(lines).toEqual(["LANE_NOTIFY_FAILED demo runner=local RUNNER_UNAVAILABLE runner=local disconnected: no admitted connection"]);
  });

  test("a q.process error comes back as code 1", async () => {
    const ops = laneOps(recording({ queries: { "q.process": () => ({ error: "pane not found" }) } }), clock());
    expect(await ops.processInfo({ pane: "x" })).toEqual({ code: 1, out: "", err: "pane not found" });
  });
});

describe("fakeLaneOps", () => {
  test("records ops, applies onEnterStatus on send and feeds sent()", async () => {
    const w = newWorld();
    w.panes = [{ ...PANE, agent_status: "idle" }];
    w.onEnterStatus = "working";
    const ops = fakeLaneOps(w);
    expect(await ops.send(local, "hello")).toBe("delivered");
    expect(w.panes[0]?.agent_status).toBe("working");
    expect(sent(w)).toEqual(["hello"]);
    expect(w.ops.map((e) => [e.op, e.key])).toEqual([["send", "demo"]]);
  });

  test("close drops the pane; git worktree-remove marks the worktree removed and inspect no longer lists it", async () => {
    const w = newWorld();
    w.panes = [{ ...PANE }];
    const ops = fakeLaneOps(w);
    expect((await ops.inspect(local, { git: true })).git?.worktrees.map((t) => t.path)).toEqual(["/repo", WT]);
    await ops.git(local, { op: "worktree-remove", root: "/repo", path: WT });
    expect(await ops.exists(undefined, [WT])).toEqual([false]);
    expect((await ops.inspect(local, { git: true })).git?.worktrees.map((t) => t.path)).toEqual(["/repo"]);
    expect(await ops.close(local)).toEqual({ closed: "tab", gone: true });
    expect(await ops.panes()).toEqual([]);
  });

  test("inspect runs Done checks through the fake runner", async () => {
    const w = newWorld();
    const r = await fakeLaneOps(w).inspect(local, { done: "merged owner/repo#1" });
    expect(r.done?.checks.map((c) => c.ok)).toEqual([true]);
  });

  test("runnerDown: effects throw RUNNER_UNAVAILABLE, send fails, status reports an error", async () => {
    const w = newWorld();
    w.runnerDown = true;
    const ops = fakeLaneOps(w);
    await expect(ops.close(local)).rejects.toBeInstanceOf(LaneOpsError);
    await expect(ops.panes()).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
    expect(await ops.send(local, "x")).toBe("failed");
    expect((await ops.status({ pane: "w1:p1" })).error).toContain("RUNNER_UNAVAILABLE");
    expect(ops.connected()).toBe(false);
  });
});
