import { afterEach, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { launchLane } from "../src/launch.ts";
import { ensureLaneWorkspace, ManagedPanesError, managedPanesPath, readManagedPanes, saveManagedPanes } from "../src/managed-panes.ts";
import type { Ran } from "../src/run.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = () => {
  const s = withState();
  cleanups.push(s.done);
  return s;
};

test("legacy config pane keys seed dori state once; later config values are ignored", async () => {
  const s = state();
  const path = join(s.dir, "config.json");
  const stateDir = join(s.dir, "state");
  writeFileSync(path, JSON.stringify({ stateDir, leadPane: "wA:p1", laneWorkspace: "wS", workspaces: ["wS"] }));
  const first = await loadConfig(path, s.dir);
  expect({ leadPane: first.leadPane, laneWorkspace: first.laneWorkspace, workspaces: first.workspaces }).toEqual({ leadPane: "wA:p1", laneWorkspace: "wS", workspaces: ["wS"] });
  expect(readManagedPanes(stateDir)).toEqual({ leadPane: "wA:p1", laneWorkspace: "wS", migrated: true });
  expect(statSync(managedPanesPath(stateDir)).mode & 0o777).toBe(0o600);

  writeFileSync(path, JSON.stringify({ stateDir, leadPane: "wZ:p9", laneWorkspace: "wZ" }));
  const later = await loadConfig(path, s.dir);
  expect({ leadPane: later.leadPane, laneWorkspace: later.laneWorkspace }).toEqual({ leadPane: "wA:p1", laneWorkspace: "wS" });

  saveManagedPanes(stateDir, { leadPane: "wB:p2" });
  expect((await loadConfig(path, s.dir)).leadPane).toBe("wB:p2");
});

test("a config without pane keys and no state leaves both ids empty and writes nothing", async () => {
  const s = state();
  const path = join(s.dir, "config.json");
  const stateDir = join(s.dir, "state");
  writeFileSync(path, JSON.stringify({ stateDir }));
  const config = await loadConfig(path, s.dir);
  expect({ leadPane: config.leadPane, laneWorkspace: config.laneWorkspace, workspaces: config.workspaces }).toEqual({ leadPane: "", laneWorkspace: "", workspaces: [] });
  expect(readManagedPanes(stateDir)).toEqual({});
});

test("ensureLaneWorkspace keeps a live recorded workspace, finds a lost one by label, else creates and records it", async () => {
  const s = state();
  const w = newWorld();
  const run = fakeRunner(w);
  const log: string[] = [];
  saveManagedPanes(s.dir, { laneWorkspace: "wL" });
  expect(await ensureLaneWorkspace(run, s.dir, "/repo", (l) => { log.push(l); })).toBe("wL");
  expect(log).toEqual([]);

  w.workspaces = [{ label: "Dori", workspace_id: "wD" }, { label: "lanes", workspace_id: "wN" }];
  expect(await ensureLaneWorkspace(run, s.dir, "/repo", (l) => { log.push(l); })).toBe("wN");
  expect(readManagedPanes(s.dir).laneWorkspace).toBe("wN");
  expect(log).toEqual(["LANE_WORKSPACE_REGISTERED wN (found by label; wL is gone)"]);

  w.workspaces = [{ label: "Dori", workspace_id: "wD" }];
  expect(await ensureLaneWorkspace(run, s.dir, "/repo", (l) => { log.push(l); })).toBe("w2");
  expect(w.calls.find((c) => c[1] === "workspace" && c[2] === "create")).toEqual(["herdr", "workspace", "create", "--label", "lanes", "--cwd", "/repo", "--no-focus"]);
  expect(readManagedPanes(s.dir)).toEqual({ laneWorkspace: "w2", migrated: true });
});

test("ensureLaneWorkspace refuses when herdr cannot list workspaces", async () => {
  const s = state();
  const down = async (): Promise<Ran> => ({ code: 1, out: "", err: "server not running" });
  expect(ensureLaneWorkspace(down, s.dir, "/repo", () => {})).rejects.toThrow(ManagedPanesError);
});

test("a local launch opens its tab in the managed lanes workspace; a pane target and a remote lane get none", async () => {
  const s = state();
  const w = newWorld();
  w.workspaces = [{ label: "dori-mode", workspace_id: "wP" }, { label: "lanes", workspace_id: "wS" }];
  const deps = depsFor(w, fakeClock(T0), s.dir, { defaultModel: "m1" });
  const brief = join(s.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const local = await launchLane(deps, { key: "lane-a", title: "a", brief, done: "command [\"true\"]", thread: "none", cwd: "/repo" });
  const start = w.ops.find((e) => e.op === "start" && e.key === "lane-a")?.args as { tabWorkspace?: string };
  expect(start.tabWorkspace).toBe("wS");
  expect(local.notes).toContain("LANE_WORKSPACE_REGISTERED wS (found by label)");

  writeFileSync(brief, "# brief\n");
  await launchLane(deps, { key: "lane-r", title: "r", brief, done: "command [\"true\"]", thread: "none", cwd: "/repo", machine: "box" });
  expect((w.ops.find((e) => e.op === "start" && e.key === "lane-r")?.args as { tabWorkspace?: string }).tabWorkspace).toBeUndefined();
});

test("a local launch is refused, not sent to herdr's focused workspace, when herdr cannot give a lanes workspace", async () => {
  const s = state();
  const w = newWorld();
  const deps = { ...depsFor(w, fakeClock(T0), s.dir, { defaultModel: "m1" }), run: async (): Promise<Ran> => ({ code: 1, out: "", err: "server not running" }) };
  const brief = join(s.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  expect(launchLane(deps, { key: "lane-a", title: "a", brief, done: "command [\"true\"]", thread: "none", cwd: "/repo" })).rejects.toThrow("no lanes workspace");
  expect(w.ops.some((e) => e.op === "start")).toBe(false);
});

test("the runner opens a lane tab in tabWorkspace and a relaunch uses the workspace it is given, else the recorded one", async () => {
  const s = state();
  const runnerDir = join(s.dir, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const herdr: string[][] = [];
  let panes: { pane_id: string; workspace_id: string; tab_id: string }[] = [];
  let n = 0;
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(T0), token: () => "tok",
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    publish: () => {},
    run: async (argv) => {
      herdr.push([...argv]);
      if (argv.slice(0, 3).join(" ") === "herdr tab create") {
        n += 1;
        const ws = argv[argv.indexOf("--workspace") + 1] ?? "";
        panes = [{ pane_id: `p${n}`, workspace_id: ws, tab_id: `t${n}` }];
        return { code: 0, out: JSON.stringify({ result: { tab_id: `t${n}`, root_pane: { pane_id: `p${n}`, tab_id: `t${n}` } } }), err: "" } as Ran;
      }
      if (argv.slice(0, 3).join(" ") === "herdr pane list") return { code: 0, out: JSON.stringify({ result: { panes } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  const creates = () => herdr.filter((a) => a.slice(0, 3).join(" ") === "herdr tab create");
  await lanes.start({ cmdId: "c1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m", sandbox: false, expectedLaneGen: 0, tabWorkspace: "wS" });
  expect(creates()[0]).toEqual(["herdr", "tab", "create", "--workspace", "wS", "--cwd", "/repo", "--label", "lane-a", "--no-focus"]);
  expect(lanes.records()["lane-a"]?.tabWorkspace).toBe("wS");

  panes = [];
  await lanes.recover("lane-a", undefined, "wT");
  expect(creates()[1]?.slice(3, 5)).toEqual(["--workspace", "wT"]);
  panes = [];
  await lanes.recover("lane-a");
  expect(creates()[2]?.slice(3, 5)).toEqual(["--workspace", "wT"]);
});
