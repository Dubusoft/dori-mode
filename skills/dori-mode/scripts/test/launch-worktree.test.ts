import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { createLaunchWorktree, type PlacedLaunch } from "../src/launch-service.ts";
import { HUB_FILE } from "../src/runner/hub.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { enrollRunners, T0 } from "./runner-guard-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const placed = { plan: {} as PlacedLaunch["plan"], target: "local", lines: [] } satisfies PlacedLaunch;
const input = { key: "k1", title: "t", brief: "/b/k1.md", done: "pr acme/app feat/x" };

/** A local runner that reported a checkout of acme/app at /repos/app and the worktree root /wt; `exists` answers every stat. */
const world = (exists: boolean) => {
  const state = withState();
  cleanups.push(state.done);
  enrollRunners(state.dir, "local");
  const db = new Database(join(state.dir, HUB_FILE));
  db.query("UPDATE runners SET workspaces = ? WHERE label = ?").run(JSON.stringify({ declared: [{ repo: "acme/app", path: "/repos/app" }], detected: [], worktreeRoot: "/wt" }), "local");
  db.close();
  const w = newWorld();
  const base = depsFor(w, fakeClock(T0), state.dir);
  return { w, deps: { ...base, ops: { ...base.ops, exists: async (_m: string | undefined, paths: readonly string[]) => paths.map(() => exists) } } };
};

test("--worktree creates <root>/<repo name>-<key> detached at the fetched base from the runner's checkout", async () => {
  const { w, deps } = world(false);
  const made = await createLaunchWorktree(deps, input, placed, { repo: "app", base: "origin/dev" });
  expect(made.path).toBe("/wt/app-k1");
  expect(w.ops.filter((o) => o.op === "git").map((o) => o.args)).toEqual([
    { op: "fetch-branch", root: "/repos/app", remote: "origin", branch: "dev" },
    { op: "worktree-add", root: "/repos/app", path: "/wt/app-k1", ref: "refs/remotes/origin/dev" },
  ]);
});

test("--worktree refuses an existing path before any git runs", async () => {
  const { w, deps } = world(true);
  await expect(createLaunchWorktree(deps, input, placed, { repo: "acme/app", base: "origin/dev" })).rejects.toThrow("LAUNCH_WORKTREE_EXISTS k1: /wt/app-k1 already exists");
  expect(w.ops.some((o) => o.op === "git")).toBe(false);
});
