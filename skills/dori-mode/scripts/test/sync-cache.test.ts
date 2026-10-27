import { afterEach, beforeEach, expect, test } from "bun:test";

import type { Runner } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const A = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const B = "01a22550-ee81-7f90-b2ed-dcc7d51a0adf";
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => { state = withState(); withSqliteStore(state.dir); world = newWorld(); });
afterEach(() => state.done());

const ok = (out: string) => ({ code: 0, out, err: "" });
const shellOf = (pane: string) => 1000 + Number(pane.replace(/\D/g, ""));
const processInfo = (pane: string) => ok(JSON.stringify({ result: { process_info: { shell_pid: shellOf(pane) } } }));

// Every pane's shell runs an agent with no --session flag and no child env, so resolution reaches the directory fallback.
const fallbackDeps = (paneIds: readonly string[], onProcessInfo: (pane: string) => Promise<void> = async () => {}) => {
  const base = depsFor(world, fakeClock(T0), state.dir, { sessionsDir: "/sessions", workspaces: ["w"] });
  world.panes = paneIds.map((pane_id) => ({ pane_id, workspace_id: "w", agent: "pi", cwd: "/repo", title: pane_id }));
  const table = paneIds.flatMap((p) => [`${shellOf(p)} 1 zsh`, `${shellOf(p) + 500} ${shellOf(p)} omo`]).join("\n");
  const calls: string[][] = [];
  const run: Runner = async (argv, opts) => {
    calls.push([...argv]);
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") {
      const pane = argv[argv.indexOf("--pane") + 1] ?? "";
      await onProcessInfo(pane);
      return processInfo(pane);
    }
    if (argv[0] === "ps" && argv[1] === "-A") return ok(table);
    if (argv[0] === "ps" && argv[1] === "-o") return ok("Thu Jan  1 12:00:00 2026 GMT");
    if (argv[0] === "ps") return ok("");
    return base.run(argv, opts);
  };
  return { deps: { ...base, run }, calls };
};

test("sync reads a shared cwd session directory once for two fallback panes", async () => {
  const { deps, calls } = fallbackDeps(["w:p1", "w:p2"]);
  const reads: string[] = [];
  const result = await syncRegistry(deps, false, (dir) => { reads.push(dir); return []; });
  expect(result.unregistered.map((r) => r.pane)).toEqual(["w:p1", "w:p2"]);
  expect(calls.filter((argv) => argv[0] === "herdr" && argv[2] === "process-info")).toHaveLength(2);
  expect(reads).toEqual(["/sessions/--repo--"]);
});

test("the directory cache is shared by registered lanes and unregistered panes, and reset per sync", async () => {
  const { deps } = fallbackDeps(["w:p1", "w:p2"]);
  await deps.registry.write({ key: "lane", title: "lane", thread: "none", pane: "w:p1", brief: "/b.md", cwd: "/repo", done: "closed acme/app#1", openedAt: new Date(T0).toISOString() });
  const name = `2026-01-01T12-00-01-000Z_${A}.jsonl`;
  const reads: string[] = [];
  const reader = (dir: string) => { reads.push(dir); return [name]; };
  const first = await syncRegistry(deps, true, reader);
  expect(first.rows[0]?.session).toBe(`${A} (start-time)`);
  expect(first.unregistered.map((r) => r.pane)).toEqual(["w:p2"]);
  expect(reads).toEqual(["/sessions/--repo--"]);
  expect((await deps.registry.read("lane"))?.session).toBe(A);
  await syncRegistry(deps, false, reader);
  expect(reads).toHaveLength(2);
});

test("sync resolves panes concurrently but never more than four at once, keeping pane order", async () => {
  const paneIds = ["w:p1", "w:p2", "w:p3", "w:p4", "w:p5", "w:p6"];
  let inFlight = 0;
  let started = 0;
  let peak = 0;
  let waiting: (() => void)[] = [];
  const gate = async () => {
    inFlight++;
    started++;
    peak = Math.max(peak, inFlight);
    // Hold each call until the cap is reached (or nothing more can start), so overlap is forced, not timed.
    const held = new Promise<void>((resolve) => waiting.push(resolve));
    if (inFlight === 4 || started === paneIds.length) { const release = waiting; waiting = []; for (const r of release) r(); }
    await held;
    inFlight--;
  };
  const { deps } = fallbackDeps(paneIds, gate);
  const result = await syncRegistry(deps, false, () => []);
  expect(peak).toBe(4);
  expect(result.unregistered.map((r) => r.pane)).toEqual(paneIds);
});

test("one batched ps eww attributes the session to the first child in tree order", async () => {
  const table = [{ pid: 11, ppid: 10, cmd: "omo" }, { pid: 13, ppid: 11, cmd: "bun b" }, { pid: 14, ppid: 11, cmd: "bun c" }];
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "herdr") return ok(JSON.stringify({ result: { process_info: { shell_pid: 10 } } }));
    return { code: 1, out: `14 bun c PI_SESSION_ID=${B}\n13 bun b PI_SESSION_ID=${A}\n`, err: "" };
  };
  expect(await resolveSession("w:p1", "/repo", table, { run, sessionsDir: "/s" })).toEqual({ id: A, via: "child-env", pid: 11 });
  expect(calls.filter((argv) => argv[0] === "ps")).toEqual([["ps", "eww", "-o", "pid=,command=", "-p", "13,14"]]);
});
