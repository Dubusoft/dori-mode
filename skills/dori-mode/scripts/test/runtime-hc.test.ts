import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPanes, readScreen } from "../src/panes.ts";
import type { Ran } from "../src/run.ts";
import { ensureHc, HC_MIN_VERSION, hcRuntime } from "../src/runtime/hc.ts";
import { unlistRuntime } from "../src/runtime/index.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { parsePolicy } from "../src/runner/policy.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
  unlistRuntime("hc");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (json: unknown): Ran => ({ code: 0, out: JSON.stringify(json), err: "" });
const fail = (err: string, code = 3): Ran => ({ code, out: "", err });

/** A scripted hc: terminals by address, every call recorded. */
const fakeHc = (version = HC_MIN_VERSION) => {
  const terminals = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  let next = 1;
  const run = async (argv: readonly string[]): Promise<Ran> => {
    calls.push([...argv]);
    if (argv[0] === "hc" && argv[1] === "--version") return { code: 0, out: `hc ${version}\n`, err: "" };
    if (argv[0] !== "hc" || argv[1] !== "--json") return { code: 0, out: "", err: "" };
    const [verb, target] = [argv[2], argv[3] ?? ""];
    if (verb === "server") return ok({ core: { id: "core-1" }, pid: 7 });
    if (verb === "ls") return ok({ terminals: [...terminals.values()].map((t) => ({ address: t.address, state: t.state })) });
    if (verb === "get") return terminals.has(target) ? ok(terminals.get(target)) : fail("not found");
    if (verb === "run") {
      const address = `t${next++}`;
      const cwd = argv[argv.indexOf("--cwd") + 1];
      terminals.set(address, { address, state: "live", cwd, pid: 100, created_ms: 5, status: null, foreground: { pid: 100, name: "zsh", argv: ["zsh"] } });
      return ok({ address });
    }
    if (verb === "send" || verb === "keys") return terminals.has(target) ? ok({ turn: 0 }) : fail("not found");
    if (verb === "kill") { const t = terminals.get(target); if (t) t.state = "finished"; return t ? ok({}) : fail("not found"); }
    if (verb === "rm") return terminals.delete(target) ? ok({ removed: target }) : fail("not found");
    if (verb === "read") return ok({ text: "one\ntwo\nthree\n\n\n" });
    return ok({});
  };
  return { terminals, calls, run };
};

test("an hc terminal reads as a herdr pane: its reported agent and status, an hc: id and a terminal id that a reused address never matches", async () => {
  const hc = fakeHc();
  hc.terminals.set("t3", {
    address: "t3", state: "live", cwd: "/w", title: "OmO", pid: 41, created_ms: 99,
    status: { app: "omo", state: "idle" }, foreground: { pid: 42, name: "omo", argv: ["omo", "go"] },
  });
  hc.terminals.set("t4", { address: "t4", state: "finished" });
  const rt = hcRuntime(hc.run, "zsh");
  expect(await rt.listPanes()).toEqual([
    { pane_id: "hc:t3", workspace_id: "", tab_id: "", terminal_id: "hc:t3@99", agent: "omo", agent_status: "idle", title: "OmO", terminal_title: "OmO", cwd: "/w" },
  ]);
  expect(await rt.processInfo("hc:t3")).toEqual({ info: { shell_pid: 41, foreground_process_group_id: 42, foreground_processes: [{ pid: 42, name: "omo", argv: ["omo", "go"] }] } });
  expect(await rt.processInfo("hc:t9")).toEqual({ error: "not found" });
  expect(await rt.read("hc:t3", 2)).toBe("two\nthree");
});

test("listPanes gathers hc terminals only once hc is listed, and a pane id picks the runtime that reads it", async () => {
  const hc = fakeHc();
  const run = async (argv: readonly string[]): Promise<Ran> =>
    argv[0] === "herdr" ? ok({ result: { panes: [{ pane_id: "w1:p1", workspace_id: "w1" }] } }) : hc.run(argv);
  hc.terminals.set("t1", { address: "t1", state: "live", created_ms: 1 });
  expect((await listPanes(run)).map((p) => p.pane_id)).toEqual(["w1:p1"]);
  expect(hc.calls).toEqual([]);
  const lanes = new RunnerLanes({
    runnerDir: mkdtempSync(join(tmpdir(), "runtime-hc-")), run, clock: fakeClock(0), publish: () => {},
    policy: { agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow", laneRuntime: "hc" },
  });
  expect(lanes.records()).toEqual({});
  expect((await listPanes(run)).map((p) => p.pane_id)).toEqual(["w1:p1", "hc:t1"]);
  expect(await readScreen(run, "hc:t1", 1)).toBe("three");
});

test("ensureHc installs a missing hc, updates an old one in place, and refuses with the fix when neither works", async () => {
  const seen: string[][] = [];
  let version: string | undefined;
  const run = async (argv: readonly string[]): Promise<Ran> => {
    seen.push([...argv]);
    if (argv[1] === "--version") return version ? { code: 0, out: `hc ${version}`, err: "" } : fail("not found", 127);
    if (argv[0] === "sh") version = "0.1.30";
    if (argv[1] === "update") version = HC_MIN_VERSION;
    return { code: 0, out: "", err: "" };
  };
  expect(await ensureHc(run)).toBe("0.1.30");
  expect(seen[1]?.[0]).toBe("sh");
  seen.length = 0;
  version = "0.1.9";
  expect(await ensureHc(run)).toBe(HC_MIN_VERSION);
  expect(seen[1]).toEqual(["hc", "update", "--version", HC_MIN_VERSION]);
  const never = async (argv: readonly string[]): Promise<Ran> => (argv[1] === "--version" ? fail("not found", 127) : { code: 0, out: "", err: "" });
  expect(ensureHc(never)).rejects.toThrow(/^RUNNER_HC_UNAVAILABLE .*laneRuntime/);
});

test("an hc lane opens a terminal running only the shell, types the launch line into it, and is killed and removed on close", async () => {
  const hc = fakeHc();
  const runnerDir = join(mkdtempSync(join(tmpdir(), "runtime-hc-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const lanes = new RunnerLanes({
    runnerDir, run: hc.run, clock: fakeClock(0), publish: () => {}, token: () => "secret-token", realpath: (p) => p,
    startup: async () => ({ verdict: "ok", detail: "ready" }), legacyMcp: async () => false,
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", laneRuntime: "hc" },
  });
  const files = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };
  const started = await lanes.start({
    cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m",
    sandbox: false, expectedLaneGen: 0, files,
  });
  expect(started.result).toMatchObject({ pane: "hc:t1", tab: "" });
  const opened = hc.calls.find((c) => c[2] === "run")!;
  expect(opened.slice(opened.indexOf("--") + 1)).toHaveLength(1);
  expect(opened).toContain("--no-parent");
  expect(opened).toContain("--no-notify");
  expect(opened.join(" ")).not.toContain("DORI_LANE");
  const typed = hc.calls.find((c) => c[2] === "send")!;
  expect(typed.slice(0, 5)).toEqual(["hc", "--json", "send", "t1", "--"]);
  expect(typed[5]).toContain("DORI_LANE_TOKEN_FILE=");
  expect(typed[5]).toContain('eval "$(dori secret env)"');
  expect(hc.calls.flat().join(" ")).not.toContain("secret-token");
  expect(lanes.records()["lane-a"]).toMatchObject({ pane: "hc:t1", tab: "", herdrInstance: "hc:core-1", terminalId: "hc:t1@5" });
  const closed = await lanes.close("lane-a");
  expect(closed.result).toEqual({ closed: "pane", gone: true });
  expect(hc.calls.filter((c) => c[2] === "kill" || c[2] === "rm").map((c) => c[2])).toEqual(["kill", "rm"]);
  expect(lanes.records()).toEqual({});
});

test("runner-config laneRuntime takes herdr or hc and refuses anything else", () => {
  expect(parsePolicy({ laneRuntime: "hc" }, "/h", "/t").laneRuntime).toBe("hc");
  expect(parsePolicy({}, "/h", "/t").laneRuntime).toBeUndefined();
  expect(() => parsePolicy({ laneRuntime: "tmux" }, "/h", "/t")).toThrow("laneRuntime must be herdr|hc");
});
