import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { parseToodoStart } from "../src/toodo-start.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;
let calls: string[][];
beforeEach(() => { state = withState(); withSqliteStore(state.dir); world = newWorld(); calls = []; });
afterEach(() => state.done());

const response = (patch: Record<string, unknown> = {}) => JSON.stringify({
  id: 580, worktreePath: state.dir, herdrWorkspaceId: "w7", branch: "feat/x",
  panes: [{ paneId: "w7:p1", agent: null, agentStatus: null, title: "shell" }], ...patch,
});

const deps = (liveShellPanes: string[]) => {
  const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00Z")), state.dir);
  world.panes = liveShellPanes.map((pane_id) => ({ pane_id, workspace_id: "w7", cwd: state.dir }));
  const run: Runner = async (argv, opts) => {
    calls.push([...argv]);
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "get") {
      const pane = world.panes.find((p) => p.pane_id === argv[3]);
      return pane ? { code: 0, err: "", out: JSON.stringify({ result: { pane } }) } : { code: 1, out: "", err: `pane ${argv[3]} not found` };
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: 1, foreground_process_group_id: 1 } } }) };
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, err: "", out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab_id: "w1:t9" } }) };
    return base.run(argv, opts);
  };
  return { ...base, run };
};

const launch = async (live: string[], start: string) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "work\n");
  const toodo = parseToodoStart(start);
  return launchLane(deps(live), { key: "toodo-lane", title: "t", brief, done: "merged acme/app#1", cwd: toodo.worktreePath, toodo });
};

const ranIn = () => calls.find((c) => c[1] === "pane" && c[2] === "run")?.[3];
const tabCreated = () => calls.find((c) => c[1] === "tab" && c[2] === "create");

test("an MCP result wrapper is unwrapped and agent panes are not lane targets", () => {
  const start = parseToodoStart(JSON.stringify({ content: [{ type: "text", text: response({ panes: [{ paneId: "w7:p1", agent: "claude" }, { paneId: "w7:p2", agent: null }] }) }] }));
  expect(start).toMatchObject({ taskId: 580, worktreePath: state.dir, herdrWorkspaceId: "w7", shellPanes: ["w7:p2"] });
  expect(() => parseToodoStart(JSON.stringify({ id: 1, title: "not a start" }))).toThrow("not a start_task response");
});

test("the lane runs in the pane start_task returned, without a new tab", async () => {
  const r = await launch(["w7:p1"], response());
  expect(ranIn()).toBe("w7:p1");
  expect(tabCreated()).toBeUndefined();
  expect(r.notes).toEqual([]);
  expect(r.lane).toMatchObject({ pane: "w7:p1", cwd: state.dir });
});

test("a stale pane id is found again through the task's herdr workspace", async () => {
  const r = await launch(["w7:p2"], response());
  expect(ranIn()).toBe("w7:p2");
  expect(tabCreated()).toBeUndefined();
  expect(r.notes[0]).toStartWith("LAUNCH_PANE_REFOUND toodo-lane pane=w7:p2: pane w7:p1 does not exist");
});

test("no pane (runner plain) falls back to a new tab in the task's worktree and says why", async () => {
  const r = await launch([], response({ herdrWorkspaceId: null, panes: [], paneError: "task 580 has no herdr workspace; start it first" }));
  expect(tabCreated()).toEqual(expect.arrayContaining(["--cwd", state.dir]));
  expect(ranIn()).toBe("w1:p9");
  expect(r.notes).toEqual(["LAUNCH_FALLBACK toodo-lane new tab: start_task listed no shell pane (task 580 has no herdr workspace; start it first)"]);
});
