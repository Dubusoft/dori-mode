import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { callerLane, claimDone, closeLane, laneActRefusal, laneSendRefusal, unpushedWork, watchTick } from "../src/done-flow.ts";
import { lastReportLine } from "../src/freshness.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { run, type Runner } from "../src/run.ts";
import { laneOps, type LaneOps } from "../src/lane-ops.ts";
import type { RunnerCall } from "../src/runner/call.ts";
import { laneGitEffect } from "../src/runner/lane-git.ts";
import type { AnySupervisorControl, SupervisorCommandBodies } from "../src/runner/protocol.ts";
import { answerQuery } from "../src/runner/queries.ts";
import { depsFor, fakeClock, newWorld, withState, type World, WT, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
/** The lanes whose runner was asked to close them (`lane.close`). */
const closes = () => world.ops.filter((e) => e.op === "close").map((e) => e.key);
const removes = () => world.ops.filter((e) => e.op === "git" && (e.args as { op: string }).op === "worktree-remove");

/**
 * The lane facade over the runner's own code on this host: `q.lane.inspect`/`q.stat` answered by runner/queries.ts and
 * `lane.git` by runner/lane-git.ts, both running `run`, so git facts and cleanup are real; every other operation is
 * `base` (the fake World's). Each `lane.git` is recorded in `w.ops`.
 */
const runnerGitOps = (run: Runner, base: LaneOps, w: World): LaneOps => {
  const call: RunnerCall = {
    query: async (_label, type, body) =>
      (await answerQuery({ run, clock: fakeClock(T0), lane: () => undefined }, { type, body: { qid: "q", ...body } } as unknown as AnySupervisorControl)) as never,
    call: async (_label, type, body, opts) => {
      if (type !== "lane.git") throw new Error(`unexpected runner command ${type}`);
      const r = await laneGitEffect(run, body as Omit<SupervisorCommandBodies["lane.git"], "cmdId">);
      return { cmdId: opts?.cmdId ?? "-", state: "verified", detail: r.detail, result: r.result } as never;
    },
    connected: () => true,
  };
  const real = laneOps(call, { now: () => T0 });
  return {
    ...base, inspect: real.inspect, exists: real.exists,
    git: async (lane, op, opts) => { w.ops.push({ op: "git", key: lane.key, args: { ...op, ...(opts ? { opts } : {}) } }); return real.git(lane, op, opts); },
  };
};

beforeEach(async () => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  // The lane's pane is listed, so a close's pane-close operation has something to close.
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

// Item 1: untracked files count as dirty work.
test("a worktree the runner reads dirty (untracked files count) blocks the automatic close", async () => {
  world.dirty = "?? notes/new-file.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closes()).toHaveLength(0);
});

test("in a real worktree an untracked file is unpushed work and a gitignored file is not", async () => {
  const git = async (...args: string[]) => {
    const r = await run(["git", ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  };
  const origin = join(state.dir, "origin.git");
  const repo = join(state.dir, "repo");
  await git("init", "-q", "--bare", origin);
  await git("clone", "-q", origin, repo);
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  await git("-C", repo, "add", ".gitignore");
  await git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  await git("-C", repo, "push", "-q", "origin", "HEAD");
  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "out.js"), "ignored");
  const base = depsFor(world, fakeClock(T0), state.dir, { defaultCwd: repo });
  const d = { ...base, run, exists: undefined, ops: runnerGitOps(run, base.ops, world) };
  const real: Lane = { ...lane, cwd: repo, worktrees: [repo] };
  expect(await unpushedWork(d, real)).toEqual([]);
  writeFileSync(join(repo, "draft.md"), "not committed");
  expect(await unpushedWork(d, real)).toEqual([`unpushed work in ${repo}`]);
});

// Item 2: manual close checks unpushed work, and removes the worktree before the pane closes.
test("dori close refuses unpushed work unless forced, and leaves pane, worktree and registry alone", async () => {
  world.aheadCount = "2";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toBe(`REFUSED demo-lane: unpushed work in ${WT} (commit and push it, or dori close --force)`);
  expect(closes()).toHaveLength(0);
  expect(removes()).toHaveLength(0);
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).toBe("working");
  const forced = await closeLane(at(T0), lane, "manual", { force: true });
  expect(forced.closed).toBe(true);
  expect(closes()).toEqual(["demo-lane"]);
});

test("the worktree is removed before the pane closes, and a failed removal keeps the pane and the lane open", async () => {
  const ok = await closeLane(at(T0), lane, "manual");
  expect(ok.closed).toBe(true);
  const order = world.ops.map((e) => (e.op === "git" ? "remove" : e.op === "close" ? "close" : "")).filter(Boolean);
  expect(order).toEqual(["remove", "close"]);
});

test("a lane whose worktree was removed before the close (Toodo got there first) closes and records it as already removed", async () => {
  world.removed = [WT];
  const toodoLane: Lane = { ...lane, cwd: WT };
  await at(T0).registry.write(toodoLane);
  const r = await closeLane(at(T0), toodoLane, "manual");
  expect(r.closed).toBe(true);
  expect(r.lines).toContain(`SIGNAL_CWD demo-lane: lane cwd ${WT} no longer exists; Done signals and git ran in defaultCwd /repo`);
  expect(removes()).toHaveLength(0);
  const receipt = (await at(T0).registry.read("demo-lane"))?.receipt as { cleanup?: string[] } | undefined;
  expect(receipt?.cleanup).toContain(`worktree ${WT} already removed`);
});

test("a failed worktree removal refuses the close and keeps the pane, the thread and the lane open", async () => {
  const base = at(T0);
  const failing = { ...base, ops: { ...base.ops, git: async () => ({ code: 128, out: "", err: "fatal: locked" }) } };
  const r = await closeLane(failing, lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith(`REFUSED demo-lane: worktree ${WT} not removed: fatal: locked`);
  expect(closes()).toHaveLength(0);
  expect(statusOf((await base.registry.read("demo-lane")) ?? lane)).toBe("working");
  expect((await closeLane(failing, lane, "manual", { force: true })).closed).toBe(true);
  expect(closes()).toEqual(["demo-lane"]);
});

// Item 3: a close never touches the lane's thread, shared or not; the owner closes it.
test("closing a lane leaves its thread alone, whether another open lane shares it or not", async () => {
  await at(T0).registry.write({ ...lane, key: "sibling-lane", pane: "w:p2", cwd: "/repo2" });
  const first = await closeLane(at(T0), lane, "Done: first");
  expect(first.closed).toBe(true);
  const firstCleanup = ((await at(T0).registry.read("demo-lane"))?.receipt as { cleanup: string[] }).cleanup;
  expect(firstCleanup.filter((line) => line.startsWith("thread"))).toEqual([]);
  const sibling = (await at(T0).registry.read("sibling-lane")) ?? lane;
  const second = await closeLane(at(T0), sibling, "Done: second");
  expect(second.closed).toBe(true);
  const secondCleanup = ((await at(T0).registry.read("sibling-lane"))?.receipt as { cleanup: string[] }).cleanup;
  expect(secondCleanup.filter((line) => line.startsWith("thread"))).toEqual([]);
});

// Item 4: lane identity and permissions.
test("callerLane is DORI_LANE_KEY, else the open lane registered for HERDR_PANE_ID; the lead pane and no env mean the lead", async () => {
  const d = at(T0);
  expect(await callerLane(d, {})).toBeUndefined();
  expect(await callerLane(d, { DORI_LANE_KEY: "demo-lane" })).toBe("demo-lane");
  expect(await callerLane(d, { HERDR_PANE_ID: "w:p1" })).toBe("demo-lane");
  expect(await callerLane(d, { HERDR_PANE_ID: "lead:p1" })).toBeUndefined();
  expect(await callerLane(d, { HERDR_PANE_ID: "w:unknown" })).toBeUndefined();
});

test("a lane may act only on its own key and may not send at all; the lead may do both anywhere", () => {
  expect(laneActRefusal(undefined, "close", "other-lane")).toBeUndefined();
  expect(laneActRefusal("demo-lane", "close", "demo-lane")).toBeUndefined();
  expect(laneActRefusal("demo-lane", "close", "other-lane")).toStartWith("LANE_PERMISSION_DENIED lane demo-lane may not close lane other-lane");
  expect(laneSendRefusal(undefined)).toBeUndefined();
  // Even its own work thread: only the lead talks to the owner; the lane asks with a question report.
  expect(laneSendRefusal("demo-lane")).toBe('LANE_PERMISSION_DENIED lane demo-lane may not run send; it is lead-only. Ask the lead instead: dori report demo-lane question --text "..."');
});

const cli = async (args: string[], env: Record<string, string>) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: state.dir, TMPDIR: process.env.TMPDIR ?? state.dir, DORI_CONFIG: join(state.dir, "no-config.json"), DORI_STATE_DIR: state.dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("the dori CLI inside a lane may not close, pause, resume or send at all, and claims only its own key; the registry is untouched", async () => {
  const d = at(T0);
  await d.registry.write({ ...lane, key: "other-lane", pane: undefined, thread: "discord:111/333" });
  const inLane = { DORI_LANE_KEY: "demo-lane", DORI_LANE_TOKEN: "tok" };
  for (const args of [["close", "other-lane"], ["pause", "other-lane"], ["resume", "demo-lane"], ["send", "discord", "--to", "discord:111/222", "--text", "hi from Dori"]]) {
    const r = await cli(args, inLane);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(`DORI_CLI_LANE_ONLY ${args[0]}:`);
  }
  const claim = await cli(["claim-done", "other-lane", "--evidence", "x"], inLane);
  expect(claim.code).toBe(1);
  expect(claim.err).toContain("LANE_PERMISSION_DENIED lane demo-lane may report only for itself, not other-lane");
  expect(statusOf((await d.registry.read("other-lane")) ?? lane)).toBe("working");
});

// Item 5: the remote [REPORT] matcher is anchored to a whole line.
test("lastReportLine reads only a whole [REPORT] line, never one inside command output or prose", () => {
  const key = "remote-lane";
  expect(lastReportLine("[REPORT] remote-lane | done | closed acme/app#3\n❯ ", key)).toBe("[REPORT] remote-lane | done | closed acme/app#3");
  expect(lastReportLine("  ● [REPORT] remote-lane | done | closed acme/app#3", key)).toBe("[REPORT] remote-lane | done | closed acme/app#3");
  for (const screen of [
    "docs/notes.md:12: [REPORT] remote-lane | done | closed acme/app#3",
    "INFO watcher saw [REPORT] remote-lane | done | closed acme/app#3",
    "│ [REPORT] remote-lane | done | closed acme/app#3 │",
    "  ⎿  [REPORT] remote-lane | done | closed acme/app#3",
    "echo '[REPORT] remote-lane | done | closed acme/app#3'",
    "[REPORT] remote-lane-2 | done | closed acme/app#3",
    "[REPORT] remote-lane | finished | closed acme/app#3",
  ]) expect(lastReportLine(screen, key)).toBeNull();
});

test("a remote lane whose screen shows a [REPORT] shape inside command output is not claimed", async () => {
  const remote: Lane = { ...lane, key: "remote-lane", machine: "box", cwd: undefined };
  await at(T0).registry.write(remote);
  const d = at(T0);
  world.screen = "$ grep -rn REPORT docs\ndocs/a.md:3:[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
  expect(await watchTick(d)).toEqual([]);
  expect(statusOf((await at(T0).registry.read("remote-lane")) ?? remote)).toBe("working");
  world.screen = "[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
  await watchTick(d);
  expect(statusOf((await at(T0).registry.read("remote-lane")) ?? remote)).toBe("done-claimed");
});
