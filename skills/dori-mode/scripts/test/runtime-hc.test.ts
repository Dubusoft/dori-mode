import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPanes, readScreen } from "../src/panes.ts";
import type { Ran } from "../src/run.ts";
import { ensureHc, HC_MIN_VERSION, hcRuntime } from "../src/runtime/hc.ts";
import { sessionRuntime } from "../src/runtime/index.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { localPolicy, localRunnerPolicy } from "../src/runner/local-policy.ts";
import { parsePolicy, POLICY_FILE } from "../src/runner/policy.ts";
import { resolveSession } from "../src/session-id.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
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

test("an hc terminal reads as a pane row: its reported agent and status, an hc: id and a terminal id that a reused address never matches", async () => {
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

test("resolveSession finds the agent under an hc terminal's shell", async () => {
  const hc = fakeHc();
  const id = "44444444-4444-4444-8444-444444444444";
  hc.terminals.set("t2", { address: "t2", state: "live", pid: 41, created_ms: 1, foreground: { pid: 42, name: "omo", argv: ["omo"] } });
  const table = [{ pid: 41, ppid: 1, cmd: "zsh" }, { pid: 42, ppid: 41, cmd: `/usr/bin/omo --session-id ${id}` }, { pid: 43, ppid: 1, cmd: "/usr/bin/omo" }];
  expect(await resolveSession("hc:t2", "/w", table, { run: hc.run, sessionsDir: "/none" })).toEqual({ id, via: "argv", pid: 42 });
  expect(hc.calls).toContainEqual(["hc", "--json", "get", "t2"]);
});

test("listPanes and readScreen use the cached hc adapter", async () => {
  const hc = fakeHc();
  const { run } = hc;
  hc.terminals.set("t1", { address: "t1", state: "live", created_ms: 1 });
  expect(sessionRuntime(run)).toBe(sessionRuntime(run));
  expect((await listPanes(run)).map((p) => p.pane_id)).toEqual(["hc:t1"]);
  expect(await readScreen(run, "hc:t1", 1)).toBe("three");
  expect(hc.calls).toEqual([
    ["hc", "--json", "ls"], ["hc", "--json", "get", "t1"], ["hc", "--json", "read", "t1", "--lines", "1"],
  ]);
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
  expect(ensureHc(never)).rejects.toThrow(/^RUNNER_HC_UNAVAILABLE hc is not on the runner's PATH: install it with curl -fsSL /);
});

test("on Windows ensureHc installs with install.ps1 under Windows PowerShell, and the runtime starts the core and opens PowerShell terminals", async () => {
  const seen: string[][] = [];
  let version: string | undefined;
  const run = async (argv: readonly string[]): Promise<Ran> => {
    seen.push([...argv]);
    if (argv[1] === "--version") return version ? { code: 0, out: `hc ${version}`, err: "" } : fail("not found", 127);
    if (argv[0] === "powershell.exe") version = HC_MIN_VERSION;
    return { code: 0, out: "", err: "" };
  };
  expect(await ensureHc(run, "win32")).toBe(HC_MIN_VERSION);
  expect(seen[1]).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://releases.herdr.dev/core/install.ps1 | iex"]);
  const never = async (argv: readonly string[]): Promise<Ran> => (argv[1] === "--version" ? fail("not found", 127) : { code: 0, out: "", err: "" });
  expect(ensureHc(never, "win32")).rejects.toThrow(/^RUNNER_HC_UNAVAILABLE hc is not on the runner's PATH: install it with powershell -c "irm /);

  const hc = fakeHc();
  const rt = hcRuntime(hc.run, undefined, "win32");
  expect(await rt.instance()).toBe("hc:core-1");
  expect(hc.calls.slice(1)).toEqual([["hc", "--json", "server", "start"], ["hc", "--json", "server", "status"]]);
  await rt.open({ key: "lane-a", cwd: "C:\\w" });
  expect(hc.calls.find((a) => a[2] === "run")?.at(-1)).toBe("powershell.exe");
  const posix = fakeHc();
  await hcRuntime(posix.run, "zsh", "linux").instance();
  expect(posix.calls.slice(1)).toEqual([["hc", "--json", "server", "status"]]);
});

test("an hc lane opens a terminal running only the shell, types the launch line into it, and is killed and removed on close", async () => {
  const hc = fakeHc();
  const runnerDir = join(mkdtempSync(join(tmpdir(), "runtime-hc-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const lanes = new RunnerLanes({
    runnerDir, run: hc.run, clock: fakeClock(0), publish: () => {}, token: () => "secret-token", realpath: (p) => p,
    startup: async () => ({ verdict: "ok", detail: "ready" }), legacyMcp: async () => false,
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
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
  expect(lanes.records()["lane-a"]).toMatchObject({ pane: "hc:t1", tab: "", hcInstance: "hc:core-1", terminalId: "hc:t1@5" });
  const closed = await lanes.close("lane-a");
  expect(closed.result).toEqual({ closed: "pane", gone: true });
  expect(hc.calls.filter((c) => c[2] === "kill" || c[2] === "rm").map((c) => c[2])).toEqual(["kill", "rm"]);
  expect(lanes.records()).toEqual({});
});

test("a retired runner-config laneRuntime is ignored with one RUNNER_CONFIG_KEY_IGNORED warning, whatever its value", () => {
  for (const value of ["hc", "herdr", "tmux"]) {
    const warnings: string[] = [];
    const policy = parsePolicy({ laneRuntime: value }, "/h", "/t", { warn: (line) => { warnings.push(line); } });
    expect(policy).not.toHaveProperty("laneRuntime");
    expect(warnings).toEqual(["RUNNER_CONFIG_KEY_IGNORED laneRuntime: hc is the only terminal runtime; every lane opens on hc; remove it from runner-config.json (dori runner setup does)"]);
  }
});

test("a local runner-config holding only a retired laneRuntime keeps the policy derived from config.json", () => {
  const runnerDir = mkdtempSync(join(tmpdir(), "runtime-hc-"));
  dirs.push(runnerDir);
  writeFileSync(join(runnerDir, POLICY_FILE), JSON.stringify({ laneRuntime: "hc" }));
  const cfg = { agentCommand: ["omo", "{prompt}"], leadCwd: "/work/lead", worktreeRoot: "" };
  const warnings: string[] = [];
  const env = { home: homedir(), tmp: tmpdir() };
  expect(localRunnerPolicy(runnerDir, cfg, { ...env, warn: (line) => { warnings.push(line); } })).toEqual(localPolicy(cfg, env));
  expect(warnings).toHaveLength(1);
});
