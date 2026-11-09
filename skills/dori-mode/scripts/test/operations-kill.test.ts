import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openOperations } from "../src/operations.ts";
import { type Lane, Registry, statusOf } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { TEST_STORE, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const WORKER = join(import.meta.dir, "fixtures", "close-kill-worker.ts");

let state: ReturnType<typeof withState>;
let world: string;

const stateDir = () => join(state.dir, "state");

const seed = async (): Promise<void> => {
  state = withState();
  world = join(state.dir, "world");
  for (const dir of ["repo", "wt/demo-lane", "wt/demo-lane-2"]) mkdirSync(join(world, dir), { recursive: true });
  // The lane's cwd is the main checkout (its .git is a directory), which a close never removes.
  mkdirSync(join(world, "repo", ".git"));
  writeFileSync(join(world, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(world, "world.json"), JSON.stringify({ panes: [{ pane_id: "w:p1", workspace_id: "w" }] }));
  mkdirSync(stateDir());
  if (TEST_STORE === "sqlite") new SqliteStore(join(stateDir(), SQLITE_FILE), { create: true }).close();
  const lane: Lane = {
    key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1",
    cwd: join(world, "repo"), openedAt: new Date(T0 - 60 * 60_000).toISOString(), status: "done-claimed",
    claim: { at: new Date(T0 - 10 * 60_000).toISOString(), evidence: "merged acme/app#1", emitted: true },
  };
  await new Registry(stateDir()).write(lane);
};

beforeEach(seed);
afterEach(() => state.done());

const worker = async (killAt: number, mode: "watch" | "close" = "watch"): Promise<{ killed: boolean; steps: number; lines: string[] }> => {
  const proc = Bun.spawn(["bun", WORKER, stateDir(), world, String(killAt), mode], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_TEST_STORE: TEST_STORE } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (proc.signalCode === "SIGKILL") return { killed: true, steps: killAt, lines: [] };
  if (proc.exitCode !== 0) throw new Error(`worker exited ${proc.exitCode}: ${err}`);
  return { killed: false, ...(JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { steps: number; lines: string[] }) };
};

const effects = (): string[] => {
  const path = join(world, "effects.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
};
const ops = () => {
  const store = openOperations({ stateDir: stateDir(), store: TEST_STORE });
  try { return store.list(); } finally { store.close(); }
};
const laneStatus = async () => statusOf((await new Registry(stateDir()).read("demo-lane")) as Lane);
const ALL_EFFECTS = [`worktree-remove ${join("WORLD", "wt/demo-lane")}`, `worktree-remove ${join("WORLD", "wt/demo-lane-2")}`, "pane-close w:p1"].sort();

test("an uninterrupted automatic close runs each effect once and verifies every operation", async () => {
  const run = await worker(-1);
  expect(run.lines.at(-1)).toStartWith("LANE_CLOSED demo-lane ");
  expect(effects().map((line) => line.replace(world, "WORLD")).sort()).toEqual(ALL_EFFECTS);
  expect(ops().map((op) => `${op.action} ${op.state}`).sort()).toEqual([
    "close verified", "pane-close verified", "worktree-remove verified", "worktree-remove verified",
  ]);
  expect(await laneStatus()).toBe("closed");
}, 30_000);

/**
 * The acceptance test of design 1.1: a SIGKILL after every step of the close sequence (each operation write, so before
 * every effect and between effects, each effect itself, each registry write), then a restart. Every run ends with each
 * effect done at most once and every operation verified or ambiguous. Every effect of a close has a read-back, so no
 * effect operation is left ambiguous and the restart always finishes the close.
 */
test("a kill at every step of a close ends verified or ambiguous after restart, never with a repeated effect", async () => {
  const total = (await worker(-1)).steps;
  state.done();
  expect(total).toBeGreaterThan(10);
  for (let killAt = 0; killAt <= total; killAt++) {
    if (killAt > 0) state.done();
    await seed();
    const first = await worker(killAt);
    expect({ killAt, killed: first.killed }).toEqual({ killAt, killed: true });
    await worker(-1);
    await worker(-1);
    const done = effects().map((line) => line.replace(world, "WORLD"));
    expect({ killAt, repeated: done.filter((line, i) => done.indexOf(line) !== i) }).toEqual({ killAt, repeated: [] });
    const rows = ops();
    expect({ killAt, open: rows.filter((op) => op.state !== "verified" && op.state !== "ambiguous").map((op) => `${op.id} ${op.state}`) }).toEqual({ killAt, open: [] });
    const ambiguous = rows.filter((op) => op.state === "ambiguous" && op.action !== "close");
    expect({ killAt, ambiguous: ambiguous.map((op) => op.id) }).toEqual({ killAt, ambiguous: [] });
    expect({ killAt, status: await laneStatus(), effects: [...done].sort() }).toEqual({ killAt, status: "closed", effects: ALL_EFFECTS });
  }
}, 300_000);
