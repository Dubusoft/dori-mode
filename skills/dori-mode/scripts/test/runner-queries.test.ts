import { expect, test } from "bun:test";

import type { Ran, Runner } from "../src/run.ts";
import type { RunnerControlBodies } from "../src/runner/protocol.ts";
import {
  laneInspect, observeMachine, queryDispatcher, type QueryDeps, queryProcess, queryScreen, queryStat, SCREEN_MAX_LINES,
} from "../src/runner/queries.ts";
import { fakeClock, fakeRunner, newWorld, WT } from "./fakes.ts";

const T0 = 1_800_000_000_000;

const inspectWorld = () => {
  const w = newWorld();
  w.panes = [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "omo", agent_status: "working", cwd: "/repo" }];
  w.dirty = " M src/a.ts\n";
  w.aheadCount = "3";
  return w;
};

const depsOf = (run: Runner, over: Partial<QueryDeps> = {}): QueryDeps => ({
  run, clock: fakeClock(T0), lane: (key) => (key === "demo-lane" ? { pane: "p1", cwd: "/repo" } : undefined), exists: () => true, ...over,
});

test("laneInspect({git:true, done}) returns the worktrees with dirty/ahead and the Done checks", async () => {
  const w = inspectWorld();
  const got = await laneInspect(depsOf(fakeRunner(w)), { key: "demo-lane", git: true, roots: ["/repo"], done: "merged o/r#1; closed o/r#2" });
  expect(got.status).toBe("working");
  expect(got.pane?.pane_id).toBe("p1");
  expect(got.cwd).toBe("/repo");
  expect(got.cwdExists).toBe(true);
  expect(got.git?.worktrees).toEqual([{ path: WT, branch: "demo-lane", exists: true, dirty: true, ahead: 3 }]);
  expect(got.done).toEqual({
    cwd: "/repo", fallback: false,
    checks: [{ signal: "merged o/r#1", ok: true, detail: "MERGED abc1234567" }, { signal: "closed o/r#2", ok: true, detail: "CLOSED" }],
  });
  // git and gh ran on this host, in the lane's directories
  expect(w.calls.some((c) => c.join(" ") === `git -C ${WT} status --porcelain --untracked-files=normal`)).toBe(true);
  expect(w.calls.some((c) => c[0] === "gh" && c[1] === "pr")).toBe(true);
});

test("laneInspect runs Done checks in doneCwd when the lane cwd is gone (fallback), and with no record reads missing", async () => {
  const w = inspectWorld();
  const cwds: (string | undefined)[] = [];
  const run: Runner = async (argv, opts) => { cwds.push(opts?.cwd); return fakeRunner(w)(argv, opts); };
  const got = await laneInspect(depsOf(run, { exists: (p) => p !== "/repo" }), { key: "demo-lane", done: 'command ["true"]', doneCwd: "/lead" });
  expect(got.cwdExists).toBe(false);
  expect(got.done?.cwd).toBe("/lead");
  expect(got.done?.fallback).toBe(true);
  expect(cwds).toContain("/lead");
  const none = await laneInspect(depsOf(fakeRunner(w)), { key: "unknown", cwd: "/repo", done: "closed o/r#2", doneCwd: "/lead" });
  expect(none.status).toBe("missing");
  expect(none.pane).toBeUndefined();
  expect(none.done?.cwd).toBe("/repo");
  expect(none.done?.fallback).toBe(false);
  expect(none.git).toBeUndefined();
});

test("laneInspect session: resolveSession on this host from the pane's shell", async () => {
  const run: Runner = async (argv): Promise<Ran> => {
    const a = argv.join(" ");
    if (a === "herdr pane list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "p1", workspace_id: "w1", agent: "omo", agent_status: "idle" }] } }), err: "" };
    if (a.startsWith("herdr pane process-info")) return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 10 } } }), err: "" };
    if (a === "ps -A -o pid=,ppid=,command=") return { code: 0, out: "10 1 bash\n11 10 node senpi/dist/bundle/cli.js --session 11111111-2222-3333-4444-555555555555\n", err: "" };
    return { code: 1, out: "", err: `unexpected ${a}` };
  };
  const got = await laneInspect(depsOf(run), { key: "demo-lane", session: true, sessionsDir: "/s" });
  expect(got.status).toBe("idle");
  expect(got.process).toEqual({ shell_pid: 10 });
  expect(got.session).toEqual({ id: "11111111-2222-3333-4444-555555555555", via: "argv" });
});

test("q.screen caps lines and picks the source; q.process and q.stat", async () => {
  const w = newWorld();
  w.screen = "hello";
  const run = fakeRunner(w);
  expect(await queryScreen({ run }, { pane: "p1", lines: 5000, source: "recent" })).toEqual({ text: "hello" });
  expect(w.calls.at(-1)).toEqual(["herdr", "pane", "read", "p1", "--source", "recent", "--lines", String(SCREEN_MAX_LINES)]);
  await queryScreen({ run }, { pane: "p1", lines: 10, source: "visible" });
  expect(w.calls.at(-1)).toEqual(["herdr", "pane", "read", "p1", "--source", "visible"]);
  const failing: Runner = async () => ({ code: 1, out: "", err: "no such pane" });
  expect(await queryProcess({ run: failing }, { pane: "p1" })).toEqual({ error: "no such pane" });
  expect(queryStat({ exists: (p) => p === "/a" }, { paths: ["/a", "/b"] })).toEqual({ exists: [true, false] });
});

test("observeMachine fills the pane count from the pane list, -1 when it is unreadable", async () => {
  const w = newWorld();
  w.panes = [{ pane_id: "p1", workspace_id: "w1" }, { pane_id: "p2", workspace_id: "w1" }];
  const run: Runner = async (argv, opts) => (argv[0] === "df" ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 100 50 10485760", err: "" } : fakeRunner(w)(argv, opts));
  const mem = async () => "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
  const got = await observeMachine(depsOf(run, { os: "linux", readMemInfo: mem }));
  expect(got.os).toBe("linux");
  expect(got.sampledAt).toBe(T0);
  expect(got.panes.map((p) => p.pane_id)).toEqual(["p1", "p2"]);
  expect(got.sample.panes).toBe(2);
  expect(got.sample.diskFreeGb).toBe(10);
  if (process.platform === "linux") expect(got.sample.memFreePct).toBe(25);
  const down: Runner = async (argv, opts) => (argv[0] === "herdr" ? { code: 1, out: "", err: "herdr down" } : run(argv, opts));
  const blind = await observeMachine(depsOf(down, { os: "linux", readMemInfo: mem }));
  expect(blind.panes).toEqual([]);
  expect(blind.sample.panes).toBe(-1);
});

// ---------------------------------------------------------------------------------------------------------------

const frame = (type: string, body: object) => ({ v: 1, runner: "local", gen: 1, epoch: 1, type, body });

const dispatch = (run: Runner, jobs: "allow" | "deny" = "allow") => {
  const replies: RunnerControlBodies["q.result"][] = [];
  const logs: string[] = [];
  let settle: () => void = () => {};
  let next = new Promise<void>((r) => { settle = r; });
  const d = queryDispatcher({
    ...depsOf(run), policy: { jobs },
    reply: (body) => { replies.push(body); settle(); next = new Promise<void>((r) => { settle = r; }); },
    log: (line) => { logs.push(line); },
  });
  return { d, replies, logs, answered: () => next };
};

test("queryDispatcher answers each query with one q.result carrying its qid", async () => {
  const w = inspectWorld();
  const t = dispatch(fakeRunner(w));
  const answered = t.answered();
  t.d(frame("q.panes", { qid: "q1" }));
  await answered;
  expect(t.replies).toHaveLength(1);
  expect(t.replies[0]?.qid).toBe("q1");
  expect(t.replies[0]?.ok).toBe(true);
  expect((t.replies[0]?.result as { panes: { pane_id: string }[] }).panes[0]?.pane_id).toBe("p1");
});

test("queryDispatcher: a failed read is ok:false with its error; jobs deny refuses an inspect with done; no qid is dropped", async () => {
  const down: Runner = async () => ({ code: 1, out: "", err: "herdr down" });
  const t = dispatch(down, "deny");
  const failed = t.answered();
  t.d(frame("q.panes", { qid: "q2" }));
  await failed;
  expect(t.replies[0]).toEqual({ qid: "q2", ok: false, detail: "RUNNER_QUERY_FAILED q.panes herdr pane list failed: herdr down" });
  t.d(frame("q.lane.inspect", { qid: "q3", key: "demo-lane", done: "closed o/r#1" }));
  expect(t.replies[1]).toEqual({ qid: "q3", ok: false, detail: "RUNNER_CMD_REJECTED jobs-denied" });
  t.d(frame("q.screen", { qid: "q4", pane: "p1", lines: 5, source: "sideways" }));
  expect(t.replies[2]).toEqual({ qid: "q4", ok: false, detail: "RUNNER_CMD_REJECTED field-type" });
  t.d(frame("q.panes", {}));
  t.d(frame("hello.ok", { proto: 3, epoch: 1, eventAck: 0 }));
  expect(t.replies).toHaveLength(3);
  expect(t.logs.some((l) => l.startsWith("RUNNER_QUERY_DROPPED type=q.panes"))).toBe(true);
});
