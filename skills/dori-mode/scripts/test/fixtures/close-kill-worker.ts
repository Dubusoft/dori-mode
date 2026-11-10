// One supervisor pass over a done-claimed lane whose window has passed (the automatic close).
// argv: <stateDir> <worldDir> <killAt> <mode: watch|close>. The process SIGKILLs itself right after its killAt-th step;
// a step is an operation row write, an effect on the world, or a registry write. killAt -1 never kills and prints
// {"steps": n, "lines": [...]}. The world (panes, worktree directories, effect log) lives in worldDir.
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../../src/config.ts";
import { closeLane, type FlowDeps, watchTick } from "../../src/done-flow.ts";
import { openOperations, type OperationStore } from "../../src/operations.ts";
import { Registry } from "../../src/registry.ts";
import type { LaneOps } from "../../src/lane-ops.ts";
import type { Ran, Runner } from "../../src/run.ts";
import { checkDone } from "../../src/signals.ts";
import { fakeClock, fakeLaneOps, newWorld, TEST_STORE, testTunables } from "../fakes.ts";

const [stateDir = "", worldDir = "", killArg = "-1", mode = "watch"] = process.argv.slice(2);
const killAt = Number(killArg);
let steps = 0;
const step = (): void => {
  steps++;
  if (steps === killAt) process.kill(process.pid, "SIGKILL");
};
if (killAt === 0) process.kill(process.pid, "SIGKILL");

const worldFile = join(worldDir, "world.json");
const effect = (line: string): void => { appendFileSync(join(worldDir, "effects.log"), `${line}\n`); step(); };
const panes = (): { pane_id: string; workspace_id: string }[] => (JSON.parse(readFileSync(worldFile, "utf8")) as { panes: { pane_id: string; workspace_id: string }[] }).panes;
const repo = join(worldDir, "repo");
const wtRoot = join(worldDir, "wt");

// The lead host's own commands: only gh (the Done signal) runs here.
const runner: Runner = async (argv) => {
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  if (argv[0] === "gh") return ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc1234567890" } }));
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

/** The lane's runner over the world directory: worktree facts and removals, the pane list and pane close are effects on disk. */
const laneOps: LaneOps = {
  ...fakeLaneOps(newWorld()),
  panes: async () => panes(),
  exists: async (_machine, paths) => paths.map((p) => existsSync(p)),
  inspect: async (lane, want) => {
    const cwd = (want.cwd ?? lane.cwd ?? repo).replace(/\/\.$/, "");
    const wts = existsSync(wtRoot) ? readdirSync(wtRoot) : [];
    const worktrees = [{ path: repo, branch: "main" }, ...wts.map((name) => ({ path: join(wtRoot, name), branch: name }))]
      .map((w) => ({ ...w, dirty: false, ahead: 0, exists: true }));
    const done = want.done !== undefined ? { cwd, fallback: false, checks: await checkDone(want.done, runner, { cwd }) } : undefined;
    return { status: "idle", cwd, cwdExists: existsSync(cwd), ...(want.git ? { git: { toplevel: repo, branch: "main", worktrees } } : {}), ...(done ? { done } : {}) };
  },
  git: async (_lane, op) => {
    if (op.op !== "worktree-remove") return { code: 1, out: "", err: `unexpected ${op.op}` };
    rmSync(op.path, { recursive: true, force: true });
    effect(`worktree-remove ${op.path}`);
    return { code: 0, out: "", err: "" };
  },
  close: async (lane) => {
    writeFileSync(worldFile, JSON.stringify({ panes: panes().filter((p) => p.pane_id !== lane.pane) }));
    effect(`pane-close ${lane.pane}`);
    return { closed: "pane", gone: true };
  },
};

class StepRegistry extends Registry {
  override async update(...args: Parameters<Registry["update"]>): ReturnType<Registry["update"]> {
    const stored = await super.update(...args);
    step();
    return stored;
  }
}

const config = { ...defaultConfig("/home/test"), stateDir, leadCwd: repo, leadPane: "lead:p1", store: TEST_STORE };
const inner = openOperations(config);
const operations: OperationStore = {
  get: (id) => inner.get(id),
  put: (op) => { inner.put(op); step(); },
  list: (filter) => inner.list(filter),
  prune: (now) => inner.prune(now),
  close: () => inner.close(),
};
const deps: FlowDeps = { run: runner, clock: fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), registry: new StepRegistry(stateDir), config, tunables: testTunables(), operations, ops: laneOps };
const lines: string[] = [];
if (mode === "close") {
  const lane = await deps.registry.read("demo-lane");
  if (lane) lines.push(...(await closeLane(deps, lane, "closed by the lead")).lines);
} else {
  lines.push(...(await watchTick(deps)));
}
inner.close();
console.log(JSON.stringify({ steps, lines }));
