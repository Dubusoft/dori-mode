import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { launchLane } from "../src/launch.ts";
import { managedPanesPath, readManagedPanes, saveLeadPane } from "../src/managed-panes.ts";
import type { Ran } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = () => {
  const s = withState();
  cleanups.push(s.done);
  return s;
};

test("a legacy config leadPane seeds dori state once; later config values and a legacy lanes workspace are ignored", async () => {
  const s = state();
  const path = join(s.dir, "config.json");
  const stateDir = join(s.dir, "state");
  writeFileSync(path, JSON.stringify({ stateDir, leadPane: "hc:t1", laneWorkspace: "wS", workspaces: ["wS"] }));
  const first = await loadConfig(path, s.dir);
  expect(first.leadPane).toBe("hc:t1");
  expect(first).not.toHaveProperty("laneWorkspace");
  expect(readManagedPanes(stateDir)).toEqual({ leadPane: "hc:t1", migrated: true });
  expect(statSync(managedPanesPath(stateDir)).mode & 0o777).toBe(0o600);

  writeFileSync(path, JSON.stringify({ stateDir, leadPane: "hc:t9" }));
  expect((await loadConfig(path, s.dir)).leadPane).toBe("hc:t1");

  saveLeadPane(stateDir, "hc:t2");
  expect((await loadConfig(path, s.dir)).leadPane).toBe("hc:t2");
});

test("a config with only legacy lanes workspace keys seeds nothing", async () => {
  const s = state();
  const path = join(s.dir, "config.json");
  const stateDir = join(s.dir, "state");
  writeFileSync(path, JSON.stringify({ stateDir, laneWorkspace: "wS", workspaces: ["wS"] }));
  expect((await loadConfig(path, s.dir)).leadPane).toBe("");
  expect(readManagedPanes(stateDir)).toEqual({});
});

test("a config without pane keys and no state leaves the lead pane empty and writes nothing", async () => {
  const s = state();
  const path = join(s.dir, "config.json");
  const stateDir = join(s.dir, "state");
  writeFileSync(path, JSON.stringify({ stateDir }));
  expect((await loadConfig(path, s.dir)).leadPane).toBe("");
  expect(readManagedPanes(stateDir)).toEqual({});
});

test("the lead pane is read and updated at the existing herdr-panes.json path", () => {
  const s = state();
  const path = join(s.dir, "herdr-panes.json");
  writeFileSync(path, JSON.stringify({ leadPane: "hc:t2", migrated: true }));
  expect(readManagedPanes(s.dir)).toEqual({ leadPane: "hc:t2", migrated: true });
  saveLeadPane(s.dir, "hc:t4");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ leadPane: "hc:t4", migrated: true });
});

test("a local launch delegates terminal creation to the runner without a workspace", async () => {
  const s = state();
  const w = newWorld();
  const calls: string[] = [];
  const deps = {
    ...depsFor(w, fakeClock(T0), s.dir, { defaultModel: "m1" }),
    run: async (argv: readonly string[]): Promise<Ran> => {
      calls.push(argv.join(" "));
      return argv[0] === "lane-sandbox" ? { code: 0, out: "", err: "" } : { code: 1, out: "", err: "unexpected command" };
    },
  };
  const brief = join(s.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  await launchLane(deps, { key: "lane-h", title: "h", brief, done: "command [\"true\"]", thread: "none", cwd: "/repo" });
  expect(w.ops.find((e) => e.op === "start" && e.key === "lane-h")?.args).not.toHaveProperty("tabWorkspace");
  expect(calls.every((c) => c.startsWith("lane-sandbox "))).toBe(true);
});
