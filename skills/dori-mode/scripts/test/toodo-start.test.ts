import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { cliSocketPath } from "../src/runner/cli-relay.ts";
import { defaultRunnerDir } from "../src/runner/fs-safety.ts";

import { launchLane } from "../src/launch.ts";
import type { LaneOps, StartInput } from "../src/lane-ops.ts";
import type { LaneInspection } from "../src/runner/protocol.ts";
import { parseToodoStart } from "../src/toodo-start.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => { state = withState(); withSqliteStore(state.dir); world = newWorld(); });
afterEach(() => state.done());

const response = (patch: Record<string, unknown> = {}) => JSON.stringify({
  id: 580, worktreePath: state.dir, herdrWorkspaceId: "w7", branch: "feat/x",
  panes: [{ paneId: "w7:p1", agent: null, agentStatus: null, title: "shell" }], ...patch,
});

/** The local runner lists `liveShellPanes` (idle shells of workspace w7) and starts a lane in the target pane, else in a new tab's pane w1:p9. */
const deps = (liveShellPanes: string[]) => {
  const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00Z")), state.dir);
  world.panes = liveShellPanes.map((pane_id) => ({ pane_id, workspace_id: "w7", cwd: state.dir }));
  world.inspection = { process: { shell_pid: 1, foreground_process_group_id: 1 }, git: undefined } as Partial<LaneInspection>;
  const ops: LaneOps = {
    ...base.ops,
    start: async (input) => {
      world.ops.push({ op: "start", key: input.key, args: input });
      return { pane: input.target?.pane ?? "w1:p9", tab: input.target ? "" : "w1:t9", startup: { verdict: "ok", detail: "ready" } };
    },
  };
  return { ...base, ops };
};

const launch = async (live: string[], start: string) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "work\n");
  const toodo = parseToodoStart(start);
  return launchLane(deps(live), { key: "toodo-lane", title: "t", brief, done: "merged acme/app#1", cwd: toodo.worktreePath, toodo });
};

const started = () => world.ops.find((e) => e.op === "start")?.args as StartInput | undefined;

test("an MCP result wrapper is unwrapped and agent panes are not lane targets", () => {
  const start = parseToodoStart(JSON.stringify({ content: [{ type: "text", text: response({ panes: [{ paneId: "w7:p1", agent: "claude" }, { paneId: "w7:p2", agent: null }] }) }] }));
  expect(start).toMatchObject({ taskId: 580, worktreePath: state.dir, herdrWorkspaceId: "w7", shellPanes: ["w7:p2"] });
  expect(() => parseToodoStart(JSON.stringify({ id: 1, title: "not a start" }))).toThrow("not a start_task response");
});

test("the lane runs in the pane start_task returned, without a new tab", async () => {
  const r = await launch(["w7:p1"], response());
  expect(started()?.target).toEqual({ pane: "w7:p1" });
  expect(r.notes).toEqual([]);
  expect(r.lane).toMatchObject({ pane: "w7:p1", cwd: state.dir });
});

test("a stale pane id is found again through the task's herdr workspace", async () => {
  const r = await launch(["w7:p2"], response());
  expect(started()?.target).toEqual({ pane: "w7:p2" });
  expect(r.lane.pane).toBe("w7:p2");
  expect(r.notes[0]).toStartWith("LAUNCH_PANE_REFOUND toodo-lane pane=w7:p2: pane w7:p1 does not exist");
});

test("no pane (runner plain) falls back to a new tab in the task's worktree and says why", async () => {
  const r = await launch([], response({ herdrWorkspaceId: null, panes: [], paneError: "task 580 has no herdr workspace; start it first" }));
  expect(started()?.target).toBeUndefined();
  expect(started()?.cwd).toBe(state.dir);
  expect(r.lane).toMatchObject({ pane: "w1:p9", tab: "w1:t9" });
  expect(r.notes).toEqual(["LAUNCH_FALLBACK toodo-lane new tab: start_task listed no shell pane (task 580 has no herdr workspace; start it first)", "LANE_WORKSPACE_REGISTERED wL (found by label)"]);
  expect(started()?.tabWorkspace).toBe("wL");
});

/**
 * `dori launch --toodo-start` through the real CLI with a fake supervisor relay: `q.stat` answers `exists`, every other
 * request fails (so placement HOLDs, exit 4, after the worktree check). Returns the exit, stderr and each q.stat body.
 */
const cliLaunch = async (worktreePath: string, exists: boolean) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "toodo-cli-"));
  const sock = cliSocketPath(defaultRunnerDir(dir));
  mkdirSync(dirname(sock), { recursive: true });
  const stats: unknown[] = [];
  let pending = "";
  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, data) {
        pending += data.toString();
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          const request = JSON.parse(pending.slice(0, nl)) as { id: string; label: string; type?: string; body?: unknown };
          pending = pending.slice(nl + 1);
          if (request.type === "q.stat") stats.push({ label: request.label, body: request.body });
          socket.write(`${JSON.stringify(request.type === "q.stat"
            ? { id: request.id, ok: true, value: { exists: [exists] } }
            : { id: request.id, ok: false, code: "LANE_OP_FAILED", label: request.label, detail: "not in this test" })}\n`);
        }
      },
    },
  });
  try {
    const brief = join(dir, "brief.md");
    await Bun.write(brief, "work\n");
    const start = JSON.stringify({ id: 580, worktreePath, herdrWorkspaceId: null, branch: "feat/x", panes: [] });
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "launch", "toodo-cli-lane", "--title", "t", "--brief", brief, "--done", "merged acme/app#1", "--toodo-start", start], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: join(dir, "state") },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code, stats };
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
};

test("launch --toodo-start asks the local runner whether the task's worktree exists, not this process's filesystem", async () => {
  // On this host but absent for the runner: refused with the placement error.
  const absent = await cliLaunch(state.dir, false);
  expect(absent.code, absent.err).toBe(1);
  expect(absent.err).toContain(`start_task's worktree ${state.dir} is not on this host; for a task on a remote workspace pass --machine <its herdr machine>`);
  expect(absent.stats).toEqual([{ label: "local", body: { paths: [state.dir] } }]);
  // Absent on this filesystem but present for the runner: the check passes and placement decides (HOLD, exit 4).
  const elsewhere = join(state.dir, "not-on-this-filesystem");
  const present = await cliLaunch(elsewhere, true);
  expect(present.err).not.toContain("is not on this host");
  expect(present.code, present.err).toBe(4);
  expect(present.stats).toEqual([{ label: "local", body: { paths: [elsewhere] } }]);
}, 60_000);
