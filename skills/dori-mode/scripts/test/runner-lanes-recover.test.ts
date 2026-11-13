import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { laneFilePaths } from "../src/runner/lane-files.ts";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Pane } from "../src/panes.ts";
import type { Ran } from "../src/run.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { agentArgv, outsideDenyRules, RunnerLanes, type RunnerLanesDeps, serveLaneSocket } from "../src/runner/lanes.ts";
import type { RunnerPolicy } from "../src/runner/policy.ts";
import { acceptLaneEvent, type LaneHubDeps, reconcileInventory } from "../src/runner/lanes-hub.ts";
import { type RunnerEventType, runnerEvent, type TurnEvidence } from "../src/runner/protocol.ts";
import { STARTUP_GRACE_MS } from "../src/runner/serve.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";
import { fakeClock } from "./fakes.ts";
import { writeRunnerFile } from "../src/runner/fs-safety.ts";

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const QUESTION = ["work output", "? Question pending (1 unanswered) · 30m", "  deploy - Which region?", "  [ seoul ]  [ tokyo ]  [ own answer… ]", ""].join("\n");
const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };
const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES };

/** A RunnerLanes over a scripted herdr: `world` decides each herdr answer, every call is recorded. */
const setup = (over: Partial<RunnerLanesDeps> = {}) => {
  const runnerDir = join(mkdtempSync(join(tmpdir(), "runner-lanes-recover-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const world = { panes: [] as Pane[], screen: "", tabCreateFails: 0, nextPane: 1, paneGet: {} as Record<string, object>, processInfo: {} as Record<string, object>, workspaces: [] as { workspace_id: string; label: string }[], tabs: [] as { tab_id: string; label: string }[] };
  const control = { checkOut: "DORI_LANE_FILES=1\n", checkCode: 0, checkThrows: false, runCode: 0, runThrows: false, beforeRun: () => {} };
  const calls: string[][] = [];
  const published: [RunnerEventType, unknown][] = [];
  let tokens = 0;
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" }) as Ran;
  const make = () => new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(T0), token: () => `tok-${++tokens}`, realpath: (p: string) => p,
    policy: { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
    publish: (type, body) => { published.push([type, body]); },
    ...over,
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "lane-sandbox") {
        if (control.checkThrows) throw new Error("probe failed");
        return { code: control.checkCode, out: control.checkOut, err: control.checkCode ? "probe unavailable" : "" } as Ran;
      }
      if (argv[1] === "pane" && argv[2] === "run") {
        control.beforeRun();
        if (control.runThrows) throw new Error("lost run reply");
        if (control.runCode) return { code: control.runCode, out: "", err: "refused" } as Ran;
      }
      const verb = argv.slice(0, 3).join(" ");
      if (verb === "herdr workspace list") return ok(JSON.stringify({ result: { workspaces: world.workspaces } }));
      if (verb === "herdr workspace create") {
        world.workspaces.push({ workspace_id: "wL", label: "lanes" });
        return ok(JSON.stringify({ result: { workspace: world.workspaces[0] } }));
      }
      if (verb === "herdr tab list") return ok(JSON.stringify({ result: { tabs: world.tabs } }));
      if (verb === "herdr tab create") {
        if (world.tabCreateFails > 0) { world.tabCreateFails--; return { code: 1, out: "", err: "server unreachable" } as Ran; }
        const n = world.nextPane++;
        return ok(JSON.stringify({ result: { tab_id: `t${n}`, root_pane: { pane_id: `p${n}`, tab_id: `t${n}` } } }));
      }
      if (verb === "herdr pane list") return ok(JSON.stringify({ result: { panes: world.panes } }));
      if (verb === "herdr pane read") return ok(world.screen);
      if (verb === "herdr pane get") {
        const pane = world.paneGet[argv[3] ?? ""];
        return pane ? ok(JSON.stringify({ result: { pane } })) : ({ code: 1, out: "", err: "pane not found" } as Ran);
      }
      if (verb === "herdr pane process-info") {
        const info = world.processInfo[argv[4] ?? ""];
        return info ? ok(JSON.stringify({ result: { process_info: info } })) : ok();
      }
      return ok();
    },
  });
  return { runnerDir, world, calls, published, lanes: make(), make, control };
};

test("a reused pane id after a server restart cannot be observed, steered or closed as the old lane", async () => {
  let instance = "server-1";
  const t = setup({ instance: async () => instance });
  await t.lanes.start(START);
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBe("server-1");
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "working" }];
  instance = "server-2";
  const before = t.calls.length;
  await expect(t.make().send("lane-a", "unsafe", false)).rejects.toThrow("RUNNER_LANE_ABSENT");
  await expect(t.lanes.pause("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  await expect(t.lanes.resume("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  await expect(t.lanes.observe("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect(await t.lanes.askTick()).toEqual([]);
  expect((await t.lanes.close("lane-a")).result).toEqual({ closed: "none", gone: true });
  expect(t.calls.slice(before).filter((a) => ["run", "send-text", "send-keys", "close", "read"].includes(a[2] ?? ""))).toEqual([]);
  expect(t.published).toContainEqual(["lane.state", { key: "lane-a", status: "missing", pane: "p1", reason: "pane-missing" }]);
});

test("input and output are installed before pane run; fresh dead recovery replaces inputs and preserves output", async () => {
  const t = setup(), paths = laneFilePaths(t.runnerDir, "lane-a");
  const input = (value: string, id: string) => ({ ...FILES, run: { ...FILES.run, id }, tree: { directories: [], files: [
    { path: "input.md", bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex"), base64: Buffer.from(value).toString("base64") },
  ] } });
  t.control.beforeRun = () => {
    expect(existsSync(paths.input)).toBe(true);
    expect(existsSync(paths.output)).toBe(true);
    expect(existsSync(t.lanes.briefPath("lane-a"))).toBe(true);
  };
  await t.lanes.start({ ...START, files: input("first", FILES.run.id) });
  writeFileSync(join(paths.output, "report.md"), "kept");
  expect(t.lanes.reportFiles("lane-a")?.revision).toBe(1);
  expect(t.make().reportFiles("lane-a")?.revision).toBe(1);
  writeFileSync(join(paths.output, "report.md"), "updated");
  expect(t.lanes.reportFiles("lane-a")?.revision).toBe(2);
  const next = input("second", "00000000-0000-4000-8000-000000000002");
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent_status: "working" }];
  await t.lanes.recover("lane-a", undefined, undefined, "new brief", next);
  expect(readFileSync(join(paths.input, "input.md"), "utf8")).toBe("first");
  expect(t.lanes.records()["lane-a"]?.fileRun).toEqual(FILES.run);
  expect(t.published.at(-1)).toEqual(["lane.started", { key: "lane-a", pane: "p1", tab: "t1", session: "", fileRun: FILES.run }]);
  t.world.panes = [];
  await t.lanes.recover("lane-a", undefined, undefined, "new brief", next);
  expect(readFileSync(join(paths.input, "input.md"), "utf8")).toBe("second");
  expect(readFileSync(join(paths.output, "report.md"), "utf8")).toBe("updated");
  expect(t.lanes.records()["lane-a"]?.fileRun).toEqual(next.run);
  expect(t.lanes.reportFiles("lane-a")?.revision).toBe(1);
  expect(t.calls.filter((a) => a[0] === "lane-sandbox")).toHaveLength(2);
  symlinkSync(join(t.runnerDir, "missing"), join(paths.output, "invalid"));
  await t.lanes.close("lane-a");
  expect([paths.input, paths.output, paths.stage, t.lanes.briefPath("lane-a")].map(existsSync)).toEqual([false, false, false, false]);
});

test("missing input, recover half-pairs and stale dead recovery refuse before writes or pane closure", async () => {
  const t = setup();
  await expect(t.lanes.start({ ...START, files: undefined })).rejects.toThrow("LANE_FILES_INPUT_REQUIRED");
  expect(t.calls).toEqual([]);
  expect(existsSync(t.lanes.briefPath("lane-a"))).toBe(false);
  await t.lanes.start(START);
  const before = t.calls.length;
  await expect(t.lanes.recover("lane-a", undefined, undefined, "brief")).rejects.toThrow("(recover-pair)");
  await expect(t.lanes.recover("lane-a")).rejects.toThrow("LANE_FILES_RECOVER_INPUT_REQUIRED");
  expect(t.calls.slice(before).some((a) => a[2] === "close" || a[2] === "create")).toBe(false);
  expect(readFileSync(t.lanes.briefPath("lane-a"), "utf8")).toBe(START.briefText);
});

for (const argv of [undefined, []] as const) test(`sandbox check ${argv ? "empty" : "missing"} argv has exact configuration advice before side effects`, async () => {
  const t = setup({ policy: { agents: { omo: ["omo"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: argv } });
  await expect(t.lanes.start(START)).rejects.toThrow(`LANE_FILES_SANDBOX_CHECK_MISSING lane-a: no sandboxCheck argv is configured; add "sandboxCheck": [<wrapper>, "--check"] to ${JSON.stringify(join(t.runnerDir, "runner-config.json"))} using the sandbox wrapper argv, then retry`);
  expect(t.calls).toEqual([]);
  expect(t.lanes.records()).toEqual({});
  expect(existsSync(join(t.runnerDir, "briefs"))).toBe(false);
});

test("successful old wrapper, failed probe, and thrown probe are distinct refusals before writing", async () => {
  const t = setup();
  t.control.checkOut = "custom wrapper\nDORI_LANE_FILES=10\n";
  await expect(t.lanes.start(START)).rejects.toThrow("LANE_FILES_SANDBOX_OLD lane-a: sandboxCheck succeeded without DORI_LANE_FILES=1; run dori runner update and refresh the maintained lane-sandbox wrapper, or update the configured custom wrapper to grant own-key .files read-only and .out read-write and print DORI_LANE_FILES=1 after its successful --check; then retry");
  t.control.checkCode = 3;
  await expect(t.lanes.start(START)).rejects.toThrow("RUNNER_CMD_REJECTED sandbox-unavailable probe unavailable");
  t.control.checkThrows = true;
  await expect(t.lanes.start(START)).rejects.toThrow("RUNNER_CMD_REJECTED sandbox-unavailable lane-sandbox --check: probe failed");
  expect(t.calls.every((a) => a[0] === "lane-sandbox")).toBe(true);
  expect(existsSync(join(t.runnerDir, "briefs"))).toBe(false);
});

test("definite initial failures remove all private files; ambiguous pane run preserves them", async () => {
  for (const ambiguous of [false, true]) {
    const t = setup();
    t.control.runThrows = ambiguous;
    t.control.runCode = ambiguous ? 0 : 1;
    await expect(t.lanes.start(START)).rejects.toThrow(ambiguous ? "lost run reply" : "herdr pane run failed");
    const paths = laneFilePaths(t.runnerDir, "lane-a");
    expect(existsSync(paths.input)).toBe(ambiguous);
    expect(existsSync(paths.output)).toBe(ambiguous);
    expect(existsSync(t.lanes.briefPath("lane-a"))).toBe(ambiguous);
    expect(existsSync(join(t.runnerDir, "briefs/lane-a.1.token"))).toBe(ambiguous);
    expect(existsSync(paths.stage)).toBe(false);
    expect(t.lanes.records()).toEqual({});
  }
});

test("recovery relaunches a lane whose old pane id now belongs to another live agent without closing that agent", async () => {
  let instance = "server-1";
  const t = setup({ instance: async () => instance, policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] } });
  await t.lanes.start(START);
  instance = "server-2";
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "working" }];
  const before = t.calls.length;
  expect((await t.lanes.recover("lane-a", "session-a", undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p2", relaunched: true, resumed: true });
  expect(t.calls.slice(before).some((a) => a[2] === "close")).toBe(false);
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBe("server-2");
});

test("terminal identity fences a recycled pane even while the server identity is unchanged", async () => {
  const t = setup();
  t.world.paneGet.p1 = { pane_id: "p1", terminal_id: "term-old" };
  await t.lanes.start(START);
  expect(t.lanes.records()["lane-a"]?.terminalId).toBe("term-old");
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", terminal_id: "term-new", agent: "omo", agent_status: "working" }];
  await expect(t.lanes.send("lane-a", "unsafe", false)).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p2", relaunched: true });
  expect(t.calls.some((a) => a[2] === "close")).toBe(false);
});

test("recovery reuses a restored empty shell tab only when its label still names the lane", async () => {
  let instance = "server-1";
  const t = setup({ instance: async () => instance });
  await t.lanes.start(START);
  instance = "server-2";
  t.world.panes = [{ pane_id: "p1", workspace_id: "wL", tab_id: "t1" }];
  t.world.tabs = [{ tab_id: "t1", label: "lane-a" }];
  t.world.paneGet.p1 = { pane_id: "p1", workspace_id: "wL", tab_id: "t1", cwd: "/repo", terminal_id: "term-new" };
  t.world.processInfo.p1 = { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "bash" }] };
  const before = t.calls.length;
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p1", tab: "t1", relaunched: true });
  expect(t.calls.slice(before).some((a) => a[1] === "tab" && a[2] === "create")).toBe(false);
  expect(t.calls).toContainEqual(["herdr", "tab", "list", "--workspace", "wL"]);
  expect(t.lanes.records()["lane-a"]?.terminalId).toBe("term-new");
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBe("server-2");
});

test("a restored tab with another label or a foreground job is left untouched", async () => {
  for (const busy of [false, true]) {
    let instance = "server-1";
    const t = setup({ instance: async () => instance });
    await t.lanes.start(START);
    instance = "server-2";
    t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1" }];
    t.world.tabs = [{ tab_id: "t1", label: busy ? "lane-a" : "other" }];
    t.world.paneGet.p1 = { pane_id: "p1", workspace_id: "w", tab_id: "t1", cwd: "/repo" };
    t.world.processInfo.p1 = { shell_pid: 10, foreground_process_group_id: 11 };
    const before = t.calls.length;
    expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p2", relaunched: true });
    expect(t.calls.slice(before).some((a) => a[2] === "close" || a[2] === "run" && a[3] === "p1")).toBe(false);
  }
});

test("a remote runner finds or creates its lanes workspace without relying on focus", async () => {
  const t = setup({ remote: true });
  await t.lanes.start(START);
  expect(t.calls).toContainEqual(["herdr", "workspace", "create", "--label", "lanes", "--cwd", "/repo", "--no-focus"]);
  expect(t.calls.find((a) => a[1] === "tab" && a[2] === "create")?.slice(3, 5)).toEqual(["--workspace", "wL"]);
  await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES);
  expect(t.calls.filter((a) => a[1] === "workspace" && a[2] === "create")).toHaveLength(1);
  const existing = setup({ remote: true });
  existing.world.workspaces = [{ workspace_id: "wExisting", label: "lanes" }];
  await existing.lanes.start(START);
  expect(existing.calls.some((a) => a[1] === "workspace" && a[2] === "create")).toBe(false);
  expect(existing.calls.find((a) => a[1] === "tab" && a[2] === "create")?.slice(3, 5)).toEqual(["--workspace", "wExisting"]);
});

test("an unknown server instance refuses a launch before creating a tab or typing", async () => {
  const t = setup({ instance: async () => undefined });
  await expect(t.lanes.start(START)).rejects.toThrow("RUNNER_HERDR_INSTANCE_UNKNOWN");
  expect(t.calls).toEqual([["lane-sandbox", "--check"]]);
});

test("a legacy live lane acquires server identity only after its foreground process proves ownership", async () => {
  const t = setup({ procs: async () => [{ pid: 20, ppid: 1, rssKb: 1, comm: "omo", lane: "lane-a" }] });
  await t.lanes.start(START);
  const record = t.lanes.records()["lane-a"];
  if (!record) throw new Error("missing lane");
  const { herdrInstance: _old, ...legacy } = record;
  writeRunnerFile(join(t.runnerDir, "lanes.json"), JSON.stringify({ "lane-a": legacy }));
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "idle", terminal_id: "term-current" }];
  t.world.processInfo.p1 = { foreground_processes: [{ pid: 20 }] };
  const before = t.calls.length;
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p1", relaunched: false });
  expect(t.lanes.records()["lane-a"]).toMatchObject({ herdrInstance: "server-1", terminalId: "term-current" });
  expect((await t.make().recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p1", relaunched: false });
  expect(t.calls.slice(before).filter((a) => a[2] === "process-info")).toHaveLength(1);
  expect(t.calls.slice(before).every((a) => a[2] === "list" || a[2] === "process-info")).toBe(true);
  expect(t.calls.filter((a) => a[1] === "tab" && a[2] === "create")).toHaveLength(1);
});

test("legacy migration refuses argv prompt text without process ownership attribution", async () => {
  const t = setup({ procs: async () => [] });
  await t.lanes.start(START);
  const record = t.lanes.records()["lane-a"];
  if (!record) throw new Error("missing lane");
  const { herdrInstance: _old, ...legacy } = record;
  writeRunnerFile(join(t.runnerDir, "lanes.json"), JSON.stringify({ "lane-a": legacy }));
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "idle" }];
  t.world.processInfo.p1 = { foreground_processes: [{ pid: 20, argv: ["omo", `ulw. Read and execute the lane brief at ${t.lanes.briefPath("lane-a")} in full. You are the lane-a lane; report.`] }] };
  await expect(t.lanes.observe("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBeUndefined();
});

test.each([true, false])("an unattributed legacy record never reuses its old pane or tab, agent=%s", async (agent) => {
  const t = setup({ procs: async () => [] });
  await t.lanes.start(START);
  const record = t.lanes.records()["lane-a"];
  if (!record) throw new Error("missing lane");
  const { herdrInstance: _old, ...legacy } = record;
  writeRunnerFile(join(t.runnerDir, "lanes.json"), JSON.stringify({ "lane-a": legacy }));
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", ...(agent ? { agent: "omo", agent_status: "idle" } : {}) }];
  t.world.tabs = [{ tab_id: "t1", label: "lane-a" }];
  t.world.paneGet.p1 = { pane_id: "p1", workspace_id: "w", tab_id: "t1", cwd: "/repo" };
  t.world.processInfo.p1 = { foreground_processes: [{ pid: 20, argv: ["omo", "another task"] }] };
  const before = t.calls.length;
  await expect(t.lanes.send("lane-a", "unsafe", false)).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBeUndefined();
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p2", tab: "t2", relaunched: true });
  expect(t.calls.slice(before).some((a) => a[2] === "close" || a[2] === "run" && a[3] === "p1")).toBe(false);
  expect(t.calls.slice(before).some((a) => a[1] === "tab" && a[2] === "list")).toBe(false);
});

test("a restored empty shell with the old pane id, label and cwd is not migrated", async () => {
  const t = setup({ procs: async () => [{ pid: 20, ppid: 1, rssKb: 1, comm: "bash" }] });
  await t.lanes.start(START);
  const record = t.lanes.records()["lane-a"];
  if (!record) throw new Error("missing lane");
  const { herdrInstance: _old, ...legacy } = record;
  writeRunnerFile(join(t.runnerDir, "lanes.json"), JSON.stringify({ "lane-a": legacy }));
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", cwd: "/repo", agent_status: "unknown" }];
  t.world.tabs = [{ tab_id: "t1", label: "lane-a" }];
  t.world.paneGet.p1 = { pane_id: "p1", workspace_id: "w", tab_id: "t1", cwd: "/repo" };
  t.world.processInfo.p1 = { shell_pid: 20, foreground_process_group_id: 20, foreground_processes: [{ pid: 20, name: "bash", argv: ["/bin/bash"] }] };
  t.world.screen = `Read and execute the lane brief at ${t.lanes.briefPath("lane-a")} in full.`;
  const before = t.calls.length;
  await expect(t.lanes.observe("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBeUndefined();
  expect(t.calls.slice(before)).toEqual([["herdr", "pane", "list"], ["herdr", "pane", "process-info", "--pane", "p1"]]);
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "p2", tab: "t2", relaunched: true });
  expect(t.calls.slice(before).some((a) => a[2] === "close" || a[2] === "run" && a[3] === "p1")).toBe(false);
});

test("a stamped lane record never requests process-info during identity checks", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "idle" }];
  const before = t.calls.length;
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "idle" });
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).result).toMatchObject({ relaunched: false });
  expect(t.calls.slice(before).some((a) => a[2] === "process-info")).toBe(false);
});

test("a legacy record whose pane is missing cannot acquire identity", async () => {
  const t = setup({ procs: async () => [{ pid: 20, ppid: 1, rssKb: 1, comm: "omo", lane: "lane-a" }] });
  await t.lanes.start(START);
  const record = t.lanes.records()["lane-a"];
  if (!record) throw new Error("missing lane");
  const { herdrInstance: _old, ...legacy } = record;
  writeRunnerFile(join(t.runnerDir, "lanes.json"), JSON.stringify({ "lane-a": legacy }));
  t.world.panes = [];
  t.world.processInfo.p1 = { foreground_processes: [{ pid: 20 }] };
  const before = t.calls.length;
  await expect(t.lanes.observe("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect(t.lanes.records()["lane-a"]?.herdrInstance).toBeUndefined();
  expect(t.calls.slice(before).some((a) => a[2] === "process-info")).toBe(false);
});

test("P6: a recover whose relaunch fails keeps the lane's record, and a later recover relaunches it", async () => {
  const t = setup();
  await t.lanes.start(START);
  const before = t.lanes.records()["lane-a"];
  expect(before?.pane).toBe("p1");
  t.world.panes = []; // the lane's pane is gone
  t.world.tabCreateFails = 1;
  await expect(t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).rejects.toThrow("herdr tab create failed");
  expect(t.lanes.records()["lane-a"]).toEqual(before as NonNullable<typeof before>);
  expect(t.lanes.tokenFor("lane-a", "tok-1")).toBe(true);

  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=p2 tab=t2");
  expect(t.lanes.records()["lane-a"]?.pane).toBe("p2");
  expect(t.lanes.tokenFor("lane-a", "tok-2")).toBe(true);
  expect(t.lanes.tokenFor("lane-a", "tok-1")).toBe(false);
});

test("lane.asking: an owned lane's on-screen question is published once, and again only once it is a new question", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.published.length = 0;
  t.world.screen = QUESTION;
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1" }];
  expect(await t.lanes.askTick()).toEqual(["lane-a"]);
  expect(await t.lanes.askTick()).toEqual([]);
  // A runner restart reads the remembered question from lanes.json and does not raise it again.
  expect(await t.make().askTick()).toEqual([]);
  expect(t.published).toEqual([["lane.asking", { key: "lane-a", text: expect.stringMatching(/^LANE_ASKING lane-a .*\[deploy\] Which region\? \| options: seoul \/ tokyo/) }]]);
  // An empty read changes nothing; the prompt going away and coming back raises it again.
  t.world.screen = "";
  expect(await t.lanes.askTick()).toEqual([]);
  t.world.screen = "plain output, no prompt\n";
  expect(await t.lanes.askTick()).toEqual([]);
  t.world.screen = QUESTION;
  expect(await t.lanes.askTick()).toEqual(["lane-a"]);
  expect(t.published).toHaveLength(2);
});

test("observe answers dead but publishes no lane.state dead for a lane still in its startup window", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  const started = t.lanes.records()["lane-a"]?.startedAt ?? 0;
  // A just-launched lane: herdr names its agent unknown until the agent's integration first reports.
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "unknown" }];
  clock.at = started + STARTUP_GRACE_MS - 1;
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "dead" });
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "working" }];
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "working" });
  expect(t.published).toEqual([["lane.state", { key: "lane-a", status: "working", pane: "p1" }]]);
  // Once the window is over a dead agent is published as before.
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "unknown" }];
  clock.at = started + STARTUP_GRACE_MS;
  await t.lanes.observe("lane-a");
  expect(t.published.at(-1)).toEqual(["lane.state", { key: "lane-a", status: "dead", pane: "p1", reason: "agent-gone" }]);
});

test("recover leaves a lane still in its startup window alone instead of closing its tab and starting it again", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  const started = t.lanes.records()["lane-a"]?.startedAt ?? 0;
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "unknown" }];
  clock.at = started + STARTUP_GRACE_MS - 1;
  const calls = t.calls.length;
  expect(await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).toEqual({ detail: "starting pane=p1", result: { pane: "p1", tab: "t1", relaunched: false, resumed: false } });
  expect(t.calls.slice(calls).filter((c) => c[1] === "tab" && (c[2] === "close" || c[2] === "create"))).toEqual([]);
  expect(t.published).toEqual([["lane.started", { key: "lane-a", pane: "p1", tab: "t1", session: "", fileRun: FILES.run }]]);
  // A pane that is gone is not starting: it is started again at once.
  t.world.panes = [];
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=p2 tab=t2");
});

test("alive criteria: observe and recover use paneAlive (agent_status), not the agent field", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  clock.at = (t.lanes.records()["lane-a"]?.startedAt ?? 0) + STARTUP_GRACE_MS;
  // herdr still names the agent, but its status is not an alive one: the supervisor's laneStatus calls this dead.
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "unknown" }];
  expect((await t.lanes.observe("lane-a")).detail).toBe("observed dead");
  expect(t.published).toEqual([["lane.state", { key: "lane-a", status: "dead", pane: "p1", reason: "agent-gone" }]]);
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=p2 tab=t2");
  // An alive status without an agent field is alive, as paneAlive says.
  t.world.panes = [{ pane_id: "p2", workspace_id: "w", tab_id: "t2", agent_status: "blocked" }];
  expect((await t.lanes.observe("lane-a")).detail).toBe("observed idle");
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).detail).toBe("alive pane=p2");
});

test("the lane token is never on the herdr command line; the lane CLI authenticates through DORI_LANE_TOKEN_FILE", async () => {
  const t = setup();
  await t.lanes.start(START);
  const run = t.calls.find((a) => a[2] === "run");
  const file = t.lanes.tokenPath("lane-a");
  expect(run?.[4]).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${file} DORI_LANE_OUT=${join(t.runnerDir, "briefs", "lane-a.out")} omo --model m1 `);
  expect(t.calls.flat().join("\n")).not.toContain("tok-1");
  expect(readFileSync(file, "utf8")).toBe("tok-1");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(t.runnerDir, "lanes.json"), "utf8")).not.toContain("tok-1");

  const net = memoryNetwork();
  const reports: [RunnerEventType, unknown][] = [];
  serveLaneSocket(net.listener, t.lanes, (type, body) => { reports.push([type, body]); }, () => {});
  const connect: Connector = async () => {
    const link = await net.connect();
    const pair = net.pairs.at(-1) as (typeof net.pairs)[number];
    return {
      send: (line) => { link.send(line); pair.pump(); },
      onLine: (h) => link.onLine(h), onClose: (h) => link.onClose(h), close: (reason) => { link.close(reason); },
      get open() { return link.open; },
    } satisfies Transport;
  };
  const err: string[] = [];
  const deps = { connect, out: () => {}, err: (l: string) => { err.push(l); } };
  expect(await laneCliMain(["report", "lane-a", "milestone", "--text", "PR open"], { env: { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: file }, ...deps })).toBe(0);
  // A lane an older runner started still has only DORI_LANE_TOKEN.
  expect(await laneCliMain(["report", "lane-a", "progress", "--text", "half"], { env: { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-1" }, ...deps })).toBe(0);
  expect(reports.map(([type, body]) => [type, (body as { kind: string }).kind])).toEqual([["lane.report", "milestone"], ["lane.report", "progress"]]);

  await t.lanes.close("lane-a");
  expect(existsSync(file)).toBe(false);
  expect(await laneCliMain(["report", "lane-a", "done", "--text", "x"], { env: { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: file }, ...deps })).toBe(1);
  expect(err.at(-1)).toStartWith("RUNNER_LANE_AUTH_FAILED");
});

test("B2: recovering a lane whose pane is alive publishes lane.started, which clears the supervisor's recoveryPending", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "p1", agent_status: "working", agent: "omo" } as unknown as Pane];
  const head = { runner: "worker-a", gen: 1, epoch: 1 };
  let seq = 0;
  let lane: Record<string, unknown> = { key: "lane-a", runner: "worker-a", openedAt: "2026-11-01T00:00:00Z", pane: "p1", tab: "t1", fileRun: FILES.run };
  const deps = {
    registry: { read: async () => lane, open: async () => [lane], update: async (_k: string, fn: (l: unknown) => unknown) => { lane = fn(lane) as Record<string, unknown>; return lane; } },
    stateDir: join(t.runnerDir, "state"), prepareRecovery: async () => ({ cmdId: "recover:lane-a:1000", notes: [] }),
    reports: () => undefined, emit: () => {}, recover: () => 1, now: () => 1000,
  } as unknown as LaneHubDeps;
  await reconcileInventory(deps, "worker-a", []); // a stale hello from before the launch
  expect(lane.recoveryPending).toBe(true);
  t.published.length = 0;
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).detail).toBe("alive pane=p1");
  expect(t.published).toEqual([["lane.started", { key: "lane-a", pane: "p1", tab: "t1", session: "", fileRun: FILES.run }]]);
  for (const [type, body] of t.published) await acceptLaneEvent(deps, "worker-a", runnerEvent(head, ++seq, type, body as never) as Parameters<typeof acceptLaneEvent>[2]);
  expect(lane.recoveryPending).toBeFalsy();
});

test("B3: the launch command runs under /bin/sh when the runner directory has a space, and keeps the token off the command", async () => {
  const t = setup();
  const runnerDir = join(t.runnerDir, "space in runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  let command = "";
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(T0), token: () => "secret-not-on-argv",
    policy: { agents: { omo: ["/usr/bin/env"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
    publish: () => {},
    run: async (argv) => {
      if (argv[0] === "lane-sandbox") return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      if (argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      if (argv[1] === "pane" && argv[2] === "run") command = argv[4] ?? "";
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  await lanes.start(START);
  const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain(`DORI_LANE_TOKEN_FILE=${lanes.tokenPath("lane-a")}`);
  expect(lanes.tokenPath("lane-a")).toStartWith(join(runnerDir, "briefs", "lane-a."));
  expect(out).toContain("DORI_LANE_KEY=lane-a");
  expect(out).not.toContain("secret-not-on-argv");
});

test("lane.start carries keywords and heavy env into the launch line, and a recover with a session resumes it", async () => {
  const t = setup();
  const started = await t.lanes.start({ ...START, keywords: "ulw set goal and work", heavySlots: 2, heavyMaxLoad: 40 });
  expect(started.detail).toBe("started pane=p1 tab=t1");
  expect(started.result.startup.verdict).toBe("unconfirmed");
  const first = t.calls.find((a) => a[2] === "run")?.[4] ?? "";
  expect(first).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${t.lanes.tokenPath("lane-a")} DORI_LANE_OUT=${join(t.runnerDir, "briefs", "lane-a.out")} DORI_HEAVY_SLOTS=2 DORI_HEAVY_MAX_LOAD=40 omo --model m1 --permission-preset full-access 'ulw set goal and work. Read and execute`);
  t.world.panes = [];
  const recovered = await t.lanes.recover("lane-a", "ses_123", undefined, "# fresh brief\n", FILES);
  expect(recovered.result).toMatchObject({ pane: "p2", tab: "t2", relaunched: true, resumed: true });
  const second = t.calls.filter((a) => a[2] === "run").at(-1)?.[4] ?? "";
  expect(second).toContain("DORI_HEAVY_SLOTS=2 DORI_HEAVY_MAX_LOAD=40 omo --model m1 --permission-preset full-access --session ses_123 'ulw set goal and work.");
});

test("agentArgv runs every lane under omo's full-access preset unless its profile already names a preset", () => {
  const values = { prompt: "go", model: "m1", brief: "/b.md" };
  const policy = (template: readonly string[]) => ({ agents: { p: template }, allowedRoots: [], sandbox: "optional", jobs: "allow" }) as unknown as RunnerPolicy;
  const sandboxed = ["env", "V=1", "lane-sandbox", "omo", "--model", "{model}", "{prompt}"];
  expect(agentArgv(policy(sandboxed), "p", values)).toEqual(["env", "V=1", "lane-sandbox", "omo", "--model", "m1", "--permission-preset", "full-access", "go"]);
  expect(agentArgv(policy(sandboxed), "p", values, "ses_1")).toEqual(["env", "V=1", "lane-sandbox", "omo", "--model", "m1", "--permission-preset", "full-access", "--session", "ses_1", "go"]);
  expect(agentArgv(policy(["omo", "--permission-preset", "workspace", "{prompt}"]), "p", values)).toEqual(["omo", "--permission-preset", "workspace", "go"]);
  expect(agentArgv(policy(["omo", "--permission-preset=ask", "{prompt}"]), "p", values)).toEqual(["omo", "--permission-preset=ask", "go"]);
  expect(agentArgv(policy(["omo", "--model", "{model}"]), "p", values)).toEqual(["omo", "--model", "m1"]);
  // A lane without a sandbox also gets the rules that refuse every outside path but the allowed ones.
  expect(agentArgv(policy(["omo", "{prompt}"]), "p", values, undefined, "external_directory=deny")).toEqual(["omo", "--permission-preset", "full-access", "--permission", "external_directory=deny", "go"]);
  expect(outsideDenyRules(["C:\\Users\\u\\.dori\\runner", "C:\\a,b", "C:\\x=y", "", "C:\\Users\\u\\.dori\\runner"], win32.join))
    .toBe("external_directory=deny,external_directory:C:\\Users\\u\\.dori\\runner=allow,external_directory:C:\\Users\\u\\.dori\\runner\\*=allow");
});

test("a lane.start without a sandbox refuses outside paths but the runner dir, repos and worktree roots, temp and ~/.omo; a sandboxed one gets no rules", async () => {
  const policy = { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", reposRoot: "/srv/repos", sandboxCheck: ["lane-sandbox", "--check"] } as const;
  const bare = setup({ policy });
  await bare.lanes.start({ ...START, sandbox: false });
  const line = bare.calls.find((a) => a[2] === "run")?.[4] ?? "";
  const rules = [bare.runnerDir, "/srv/repos", "/srv/repos/worktrees", tmpdir(), join(homedir(), ".omo")]
    .flatMap((dir) => [`external_directory:${dir}=allow`, `external_directory:${dir}/*=allow`]);
  expect(line).toContain(` omo --permission-preset full-access --permission '${["external_directory=deny", ...rules].join(",")}' 'ulw`);
  const boxed = setup({ policy });
  await boxed.lanes.start(START);
  expect(boxed.calls.find((a) => a[2] === "run")?.[4]).toContain(" omo --permission-preset full-access 'ulw");
});

test("lane.start hands the policy's repos and worktree roots to the lane sandbox, the worktree root defaulting under the repos root", async () => {
  const policy = { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] } as const;
  const both = setup({ policy: { ...policy, reposRoot: "/Users/u/work/repos", worktreeRoot: "/Users/u/work/worktrees" } });
  await both.lanes.start(START);
  expect(both.calls.find((a) => a[2] === "run")?.[4]).toContain(" LANE_SANDBOX_REPOS=/Users/u/work/repos LANE_SANDBOX_WORKTREES=/Users/u/work/worktrees omo --model m1 ");
  const repos = setup({ policy: { ...policy, reposRoot: "/Users/u/work/repos" } });
  await repos.lanes.start(START);
  expect(repos.calls.find((a) => a[2] === "run")?.[4]).toContain(" LANE_SANDBOX_REPOS=/Users/u/work/repos LANE_SANDBOX_WORKTREES=/Users/u/work/repos/worktrees omo --model m1 ");
});

test("lane.start with a target runs in that idle shell pane, leaves it open on a failed run, and refuses a pane another lane holds", async () => {
  const t = setup();
  t.world.paneGet.p9 = { pane_id: "p9", workspace_id: "w1", tab_id: "t9", cwd: "/repo/wt" };
  t.world.processInfo.p9 = { shell_pid: 50, foreground_process_group_id: 50, foreground_processes: [{ pid: 50, name: "bash" }] };
  const started = await t.lanes.start({ ...START, target: { pane: "p9" } });
  expect(started.result).toMatchObject({ pane: "p9", tab: "t9" });
  expect(t.calls.some((a) => a[1] === "tab" && a[2] === "create")).toBe(false);
  expect(t.lanes.records()["lane-a"]).toMatchObject({ pane: "p9", tab: "t9", cwd: "/repo/wt" });
  await expect(t.lanes.start({ ...START, key: "lane-b", target: { pane: "p9" } })).rejects.toThrow("RUNNER_LANE_TARGET_BUSY");
});

test("a new tab running cmd.exe is closed and refused before anything is typed", async () => {
  const t = setup();
  t.world.processInfo.p1 = { shell_pid: 7, foreground_processes: [{ pid: 7, name: "cmd.exe" }] };
  await expect(t.lanes.start(START)).rejects.toThrow("RUNNER_LANE_TARGET_INVALID");
  expect(t.calls.some((a) => a[2] === "run")).toBe(false);
  expect(t.calls.some((a) => a.join(" ") === "herdr tab close t1")).toBe(true);
  expect(t.lanes.records()).toEqual({});
});

test("lane.adopt takes an existing pane with a token file; whoami maps it; recover refuses to relaunch it", async () => {
  const t = setup();
  await expect(t.lanes.adopt({ cmdId: "a0", key: "lane-z", pane: "p5", mode: "ulw", model: "m1" })).rejects.toThrow("RUNNER_LANE_PANE_MISSING");
  t.world.paneGet.p5 = { pane_id: "p5", workspace_id: "w1", tab_id: "t5", cwd: "/repo/z" };
  const adopted = await t.lanes.adopt({ cmdId: "a1", key: "lane-z", pane: "p5", mode: "ulw", model: "m1" });
  expect(adopted.result).toEqual({ pane: "p5", tab: "t5", tokenFile: t.lanes.tokenPath("lane-z") });
  expect(readFileSync(t.lanes.tokenPath("lane-z"), "utf8")).toBe("tok-1");
  expect(t.lanes.tokenFor("lane-z", "tok-1")).toBe(true);
  expect(t.lanes.records()["lane-z"]).toMatchObject({ cwd: "/repo/z", adopted: true });
  expect(t.lanes.keyForPane("p5")).toBe("lane-z");
  expect(t.published.at(-1)).toEqual(["lane.started", { key: "lane-z", pane: "p5", tab: "t5", session: "" }]);
  await expect(t.lanes.adopt({ cmdId: "a2", key: "lane-y", pane: "p5", mode: "ulw", model: "m1" })).rejects.toThrow("RUNNER_LANE_TARGET_BUSY");
  await expect(t.lanes.recover("lane-z")).rejects.toThrow("RUNNER_LANE_ADOPTED");
});

test("B7: adopt and target start check the pane's effective cwd against allowedRoots (real paths, symlink escape)", async () => {
  const base = mkdtempSync(join(tmpdir(), "runner-lanes-cwd-"));
  dirs.push(base);
  const allowed = join(base, "allowed");
  const outside = join(base, "outside");
  mkdirSync(join(allowed, "wt"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(allowed, "escape"));
  // The real realpathSync (the runner's default), not the identity the other tests use.
  const t = setup({ realpath: undefined, policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: [allowed], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] } });
  const briefs = join(t.runnerDir, "briefs");
  const tokenFiles = () => (existsSync(briefs) ? readdirSync(briefs).filter((f) => f.endsWith(".token")) : []);
  const adopt = (key: string, pane: string, cwd?: string) => t.lanes.adopt({ cmdId: key, key, pane, mode: "ulw", model: "m1", ...(cwd ? { cwd } : {}) });

  t.world.paneGet.p1 = { pane_id: "p1", tab_id: "t1", cwd: outside };
  await expect(adopt("lane-1", "p1")).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  t.world.paneGet.p2 = { pane_id: "p2", tab_id: "t2", foreground_cwd: join(allowed, "escape") };
  await expect(adopt("lane-2", "p2")).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  // A permitted body.cwd does not cover the pane's own directory.
  t.world.paneGet.p3 = { pane_id: "p3", tab_id: "t3", cwd: join(allowed, "wt"), foreground_cwd: outside };
  await expect(adopt("lane-3", "p3", join(allowed, "wt"))).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  expect(t.lanes.records()).toEqual({});
  expect(tokenFiles()).toEqual([]);

  const shell = { shell_pid: 50, foreground_process_group_id: 50, foreground_processes: [{ pid: 50, name: "bash" }] };
  for (const [pane, cwd] of [["p8", outside], ["p9", join(allowed, "escape")]] as const) {
    t.world.paneGet[pane] = { pane_id: pane, workspace_id: "w1", tab_id: `t-${pane}`, cwd };
    t.world.processInfo[pane] = shell;
    await expect(t.lanes.start({ ...START, key: `lane-${pane}`, cwd: allowed, target: { pane } })).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  }
  expect(t.calls.some((a) => a[2] === "run")).toBe(false);
  expect(t.lanes.records()).toEqual({});
  expect(tokenFiles()).toEqual([]);

  t.world.paneGet.p4 = { pane_id: "p4", tab_id: "t4", cwd: join(allowed, "wt") };
  expect((await adopt("lane-4", "p4")).result.pane).toBe("p4");
});

test("send refuses while a question shows when asked to, guarded mode answers sent, and close reads the pane back", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "idle" }];
  t.world.screen = QUESTION;
  await t.lanes.askTick();
  const before = t.calls.length;
  expect((await t.lanes.send("lane-a", "hello", true, { refuseWhileAsking: true })).result).toEqual({ delivery: "failed", refusal: "RUNNER_LANE_ASKING lane-a shows a question prompt; not typed" });
  expect(t.calls.length).toBe(before);
  t.world.screen = "❯ \n";
  expect((await t.lanes.send("lane-a", "hello", false, { mode: "guarded" })).result).toEqual({ delivery: "sent" });
  expect(t.calls.some((a) => a.join(" ") === "herdr pane send-text p1 hello")).toBe(true);
  const closedWhileListed = await t.lanes.close("lane-a");
  expect(closedWhileListed.result).toEqual({ closed: "tab", gone: false });
  await t.lanes.start({ ...START, key: "lane-b" });
  t.world.panes = [];
  expect((await t.lanes.close("lane-b")).result).toEqual({ closed: "none", gone: true });
});

test("pause and resume run the lane-control sequences on the lane's pane; a recover keeps the lane's notice", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "idle" }];
  t.world.screen = "❯ \n";
  const paused = await t.lanes.pause("lane-a", "stop");
  expect(paused.result).toEqual({ working: false, stopped: true });
  const resumed = await t.lanes.resume("lane-a");
  expect(resumed.result.goal).toBe("unconfirmed");
  await t.lanes.notify({ cmdId: "n", key: "lane-a", status: "paused" });
  t.world.panes = [];
  await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES);
  expect(t.lanes.notice("lane-a")).toEqual({ status: "paused" });
  await expect(t.lanes.notify({ cmdId: "n2", key: "nope", status: "x" })).rejects.toThrow("RUNNER_LANE_UNKNOWN");
});

const ABORTED = ["● Editing src/a.ts", "Operation aborted", "", "─".repeat(30), "(😺 OmO) Pursuing goal (4m)", ""].join("\n");
const FINISHED = ["● Editing src/a.ts", "All checks pass.", "", "─".repeat(30), "(😺 OmO) Pursuing goal (6m)", ""].join("\n");
const lanePane = (status: string): Pane => ({ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: status });

test("a lane's stopped turn is recorded once per stop for its generation, kept across a runner restart, and answered by observe", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  clock.at = T0 + STARTUP_GRACE_MS + 1;
  t.world.panes = [lanePane("working")];
  t.world.screen = "● Editing src/a.ts\n";
  await t.lanes.askTick();
  expect(t.lanes.records()["lane-a"]?.turnStop).toBeUndefined();
  t.world.panes = [lanePane("idle")];
  t.world.screen = ABORTED;
  await t.lanes.askTick();
  const first: TurnEvidence = { gen: 1, stop: 1, at: T0 + STARTUP_GRACE_MS + 1, cause: "aborted", hold: "none", continuation: false };
  expect(t.lanes.records()["lane-a"]?.turnStop).toEqual(first);
  // The same stop again, or after a runner restart, is not a new one.
  clock.at += 60_000;
  await t.lanes.askTick();
  await t.make().askTick();
  expect((await t.make().observe("lane-a")).result).toEqual({ status: "idle", turn: first });
  // The next turn runs and ends normally: stop 2, and a working lane answers no turn.
  t.world.panes = [lanePane("working")];
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "working" });
  t.world.panes = [lanePane("idle")];
  t.world.screen = FINISHED;
  expect((await t.lanes.observe("lane-a")).result).toMatchObject({ turn: { gen: 1, stop: 2, cause: "finished" } });
  expect(t.calls.filter((a) => ["send-text", "send-keys"].includes(a[2] ?? ""))).toEqual([]);
});

test("a lane still in its startup window records no stopped turn", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.world.panes = [lanePane("idle")];
  t.world.screen = ABORTED;
  clock.at = T0 + STARTUP_GRACE_MS - 1;
  await t.lanes.askTick();
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "idle" });
  expect(t.lanes.records()["lane-a"]?.turnStop).toBeUndefined();
  // Past the window the first stop is recorded; an empty read records nothing.
  clock.at = T0 + STARTUP_GRACE_MS + 1;
  t.world.screen = "";
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "idle" });
  t.world.screen = ABORTED;
  expect((await t.lanes.observe("lane-a")).result).toMatchObject({ turn: { stop: 1, cause: "aborted" } });
});
