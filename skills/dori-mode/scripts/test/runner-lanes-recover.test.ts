import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { laneFilePaths } from "../src/runner/lane-files.ts";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Ran } from "../src/run.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { agentArgv, outsideDenyRules } from "../src/runner/lane-launch.ts";
import { RunnerLanes, type RunnerLanesDeps, serveLaneSocket } from "../src/runner/lanes.ts";
import type { RunnerPolicy } from "../src/runner/policy.ts";
import { acceptLaneEvent, type LaneHubDeps, reconcileInventory } from "../src/runner/lanes-hub.ts";
import { type RunnerEventType, runnerEvent, type TurnEvidence } from "../src/runner/protocol.ts";
import { STARTUP_GRACE_MS } from "../src/runner/serve.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { memoryNetwork } from "./support/memory-transport.ts";
import { fakeClock } from "./fakes.ts";
import { closes, hcAnswer, type HcPane, launchLines, newHcWorld, opens, sentTo } from "./runner-hc-world.ts";

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const QUESTION = ["work output", "? Question pending (1 unanswered) · 30m", "  deploy - Which region?", "  [ seoul ]  [ tokyo ]  [ own answer… ]", ""].join("\n");
const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };
const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES };

/** A RunnerLanes over a scripted hc (runner-hc-world.ts): `world` decides each hc answer, every call is recorded. */
const setup = (over: Partial<RunnerLanesDeps> = {}) => {
  const runnerDir = join(mkdtempSync(join(tmpdir(), "runner-lanes-recover-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const world = newHcWorld();
  const control = { checkOut: "DORI_LANE_FILES=1\n", checkCode: 0, checkThrows: false, runThrows: false, beforeRun: () => {} };
  const calls: string[][] = [];
  const published: [RunnerEventType, unknown][] = [];
  let tokens = 0;
  const make = () => new RunnerLanes({
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
      if (argv[0] === "hc" && argv[2] === "send" && (argv[5] ?? "").startsWith("export ")) {
        control.beforeRun();
        if (control.runThrows) throw new Error("lost run reply");
      }
      return hcAnswer(world, argv) ?? ({ code: 0, out: "", err: "" } as Ran);
    },
  });
  return { runnerDir, world, calls, published, lanes: make(), make, control };
};

test("a reused pane id after a server restart cannot be observed, steered or closed as the old lane", async () => {
  const t = setup();
  await t.lanes.start(START);
  expect(t.lanes.records()["lane-a"]?.hcInstance).toBe("hc:core-1");
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "working" }];
  t.world.instance = "core-2";
  const before = t.calls.length;
  await expect(t.make().send("lane-a", "unsafe", false)).rejects.toThrow("RUNNER_LANE_ABSENT");
  await expect(t.lanes.pause("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  await expect(t.lanes.resume("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  await expect(t.lanes.observe("lane-a")).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect(await t.lanes.askTick()).toEqual([]);
  expect((await t.lanes.close("lane-a")).result).toEqual({ closed: "none", gone: true });
  expect(t.calls.slice(before).filter((a) => ["run", "send-text", "send-keys", "close", "read"].includes(a[2] ?? ""))).toEqual([]);
  expect(t.published).toContainEqual(["lane.state", { key: "lane-a", status: "missing", pane: "hc:t1", reason: "pane-missing" }]);
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
  t.world.panes = [{ pane_id: "hc:t1", agent_status: "working" }];
  await t.lanes.recover("lane-a", undefined, "new brief", next);
  expect(readFileSync(join(paths.input, "input.md"), "utf8")).toBe("first");
  expect(t.lanes.records()["lane-a"]?.fileRun).toEqual(FILES.run);
  expect(t.published.at(-1)).toEqual(["lane.started", { key: "lane-a", pane: "hc:t1", tab: "", session: "", fileRun: FILES.run }]);
  t.world.panes = [];
  await t.lanes.recover("lane-a", undefined, "new brief", next);
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
  await expect(t.lanes.recover("lane-a", undefined, "brief")).rejects.toThrow("(recover-pair)");
  await expect(t.lanes.recover("lane-a")).rejects.toThrow("LANE_FILES_RECOVER_INPUT_REQUIRED");
  expect(t.calls.slice(before).some((a) => a[2] === "kill" || a[2] === "run")).toBe(false);
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
    t.world.sendCode = ambiguous ? 0 : 1;
    await expect(t.lanes.start(START)).rejects.toThrow(ambiguous ? "lost run reply" : "hc send failed");
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
  const t = setup({ policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] } });
  await t.lanes.start(START);
  t.world.instance = "core-2";
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "working" }];
  const before = t.calls.length;
  expect((await t.lanes.recover("lane-a", "session-a", "# fresh brief\n", FILES)).result).toMatchObject({ pane: "hc:t2", relaunched: true, resumed: true });
  expect(t.calls.slice(before).some((a) => a[2] === "kill")).toBe(false);
  expect(t.lanes.records()["lane-a"]?.hcInstance).toBe("hc:core-2");
});

test("terminal identity fences a recycled pane even while the server identity is unchanged", async () => {
  const t = setup();
  await t.lanes.start(START);
  expect(t.lanes.records()["lane-a"]?.terminalId).toBe("hc:t1@0");
  // The same address handed out again: another terminal, created later.
  t.world.panes = [{ pane_id: "hc:t1", created: 5, agent: "omo", agent_status: "working" }];
  await expect(t.lanes.send("lane-a", "unsafe", false)).rejects.toThrow("RUNNER_LANE_ABSENT");
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).result).toMatchObject({ pane: "hc:t2", relaunched: true });
  expect(closes(t.calls)).toEqual([]);
});

test("an unknown server instance refuses a launch before opening a terminal or typing", async () => {
  const t = setup();
  t.world.instance = undefined;
  await expect(t.lanes.start(START)).rejects.toThrow("RUNNER_HC_INSTANCE_UNKNOWN");
  expect(opens(t.calls)).toBe(0);
  expect(sentTo(t.calls)).toEqual([]);
});

test("identity checks read no process info", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "idle" }];
  const before = t.calls.length;
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "idle" });
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).result).toMatchObject({ relaunched: false });
  // A get per listed terminal and nothing more: no process read.
  const ran = t.calls.slice(before);
  expect(ran.filter((a) => a[2] === "get")).toHaveLength(ran.filter((a) => a[2] === "ls").length);
});

test("P6: a recover whose relaunch fails keeps the lane's record, and a later recover relaunches it", async () => {
  const t = setup();
  await t.lanes.start(START);
  const before = t.lanes.records()["lane-a"];
  expect(before?.pane).toBe("hc:t1");
  t.world.panes = []; // the lane's pane is gone
  // hc's open tries once with the terminal name and once without it.
  t.world.runFails = 2;
  await expect(t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).rejects.toThrow("hc run failed");
  expect(t.lanes.records()["lane-a"]).toEqual(before as NonNullable<typeof before>);
  expect(t.lanes.tokenFor("lane-a", "tok-1")).toBe(true);

  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=hc:t2");
  expect(t.lanes.records()["lane-a"]?.pane).toBe("hc:t2");
  expect(t.lanes.tokenFor("lane-a", "tok-2")).toBe(true);
  expect(t.lanes.tokenFor("lane-a", "tok-1")).toBe(false);
});

test("lane.asking: an owned lane's on-screen question is published once, and again only once it is a new question", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.published.length = 0;
  t.world.screen = QUESTION;
  t.world.panes = [{ pane_id: "hc:t1" }];
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

test("observe answers dead but leaves publishing a dead agent to the serve loop, which holds it through its grace windows", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  const started = t.lanes.records()["lane-a"]?.startedAt ?? 0;
  // A just-launched lane: hc names its agent unknown until the agent first reports its state.
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "unknown" }];
  clock.at = started + STARTUP_GRACE_MS - 1;
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "dead" });
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "working" }];
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "working" });
  expect(t.published).toEqual([["lane.state", { key: "lane-a", status: "working", pane: "hc:t1" }]]);
  // Past the startup window too: answered, not published.
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "unknown" }];
  clock.at = started + STARTUP_GRACE_MS;
  expect((await t.lanes.observe("lane-a")).result).toEqual({ status: "dead" });
  expect(t.published).toEqual([["lane.state", { key: "lane-a", status: "working", pane: "hc:t1" }]]);
});

test("observe and recover keep a lane whose agent process still runs though hc no longer detects it", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  clock.at = (t.lanes.records()["lane-a"]?.startedAt ?? 0) + STARTUP_GRACE_MS;
  t.world.panes = [{ pane_id: "hc:t1", agent_status: "unknown", shellPid: 10 }];
  t.world.proc.t1 = { pid: 11, argv: ["omo", `Read and execute the lane brief at ${t.lanes.briefPath("lane-a")} in full.`] };
  expect((await t.lanes.observe("lane-a")).detail).toBe("observed idle");
  expect(t.published).toEqual([["lane.state", { key: "lane-a", status: "idle", pane: "hc:t1" }]]);
  const calls = t.calls.length;
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("alive pane=hc:t1");
  expect(t.calls.slice(calls).filter((c) => c[0] === "hc" && (c[2] === "kill" || c[2] === "run"))).toEqual([]);
  // The agent exited: only the shell is left, and the lane is dead.
  t.world.proc.t1 = { pid: 10, argv: ["sh"] };
  expect((await t.lanes.observe("lane-a")).detail).toBe("observed dead");
});

test("recover leaves a lane still in its startup window alone instead of closing its terminal and starting it again", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  const started = t.lanes.records()["lane-a"]?.startedAt ?? 0;
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "unknown" }];
  clock.at = started + STARTUP_GRACE_MS - 1;
  const calls = t.calls.length;
  expect(await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).toEqual({ detail: "starting pane=hc:t1", result: { pane: "hc:t1", tab: "", relaunched: false, resumed: false } });
  expect(t.calls.slice(calls).filter((c) => c[0] === "hc" && (c[2] === "kill" || c[2] === "run"))).toEqual([]);
  expect(t.published).toEqual([["lane.started", { key: "lane-a", pane: "hc:t1", tab: "", session: "", fileRun: FILES.run }]]);
  // A pane that is gone is not starting: it is started again at once.
  t.world.panes = [];
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=hc:t2");
});

test("alive criteria: observe and recover use paneAlive (agent_status), not the agent field", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  t.published.length = 0;
  clock.at = (t.lanes.records()["lane-a"]?.startedAt ?? 0) + STARTUP_GRACE_MS;
  // hc still names the agent, but its status is not an alive one: the supervisor's laneStatus calls this dead.
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "unknown" }];
  expect((await t.lanes.observe("lane-a")).detail).toBe("observed dead");
  expect(t.published).toEqual([]);
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=hc:t2");
  // An alive status without an agent field is alive, as paneAlive says.
  t.world.panes = [{ pane_id: "hc:t2", agent_status: "blocked" }];
  expect((await t.lanes.observe("lane-a")).detail).toBe("observed idle");
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("alive pane=hc:t2");
});

test("the lane token is never on the hc command line; the lane CLI authenticates through DORI_LANE_TOKEN_FILE", async () => {
  const t = setup();
  await t.lanes.start(START);
  const file = t.lanes.tokenPath("lane-a");
  expect(launchLines(t.calls)[0]).toStartWith(`export DO_NOT_TRACK=1 DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${file} DORI_LANE_OUT=${join(t.runnerDir, "briefs", "lane-a.out")}; eval "$(dori secret env)"; omo --model m1 `);
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
  t.world.panes = [{ pane_id: "hc:t1", agent_status: "working", agent: "omo" }];
  const head = { runner: "worker-a", gen: 1, epoch: 1 };
  let seq = 0;
  let lane: Record<string, unknown> = { key: "lane-a", runner: "worker-a", openedAt: "2026-11-01T00:00:00Z", pane: "hc:t1", tab: "", fileRun: FILES.run };
  const deps = {
    registry: { read: async () => lane, open: async () => [lane], update: async (_k: string, fn: (l: unknown) => unknown) => { lane = fn(lane) as Record<string, unknown>; return lane; } },
    stateDir: join(t.runnerDir, "state"), prepareRecovery: async () => ({ cmdId: "recover:lane-a:1000", notes: [] }),
    reports: () => undefined, emit: () => {}, recover: () => 1, now: () => 1000,
  } as unknown as LaneHubDeps;
  await reconcileInventory(deps, "worker-a", []); // a stale hello from before the launch
  expect(lane.recoveryPending).toBe(true);
  t.published.length = 0;
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("alive pane=hc:t1");
  expect(t.published).toEqual([["lane.started", { key: "lane-a", pane: "hc:t1", tab: "", session: "", fileRun: FILES.run }]]);
  for (const [type, body] of t.published) await acceptLaneEvent(deps, "worker-a", runnerEvent(head, ++seq, type, body as never) as Parameters<typeof acceptLaneEvent>[2]);
  expect(lane.recoveryPending).toBeFalsy();
});

test("B3: the launch command runs under /bin/sh when the runner directory has a space, and keeps the token off the command", async () => {
  const t = setup();
  const runnerDir = join(t.runnerDir, "space in runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  mkdirSync(join(runnerDir, "bin"), { mode: 0o700 });
  writeFileSync(join(runnerDir, "bin", "dori"), "#!/bin/sh\n[ \"$1 $2\" = \"secret env\" ]\n", { mode: 0o700 });
  let command = "";
  const world = newHcWorld();
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(T0), token: () => "secret-not-on-argv",
    policy: { agents: { omo: ["/usr/bin/env"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
    publish: () => {},
    run: async (argv) => {
      if (argv[0] === "lane-sandbox") return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      if (argv[0] === "hc" && argv[2] === "send") command = argv[5] ?? "";
      return hcAnswer(world, argv) ?? ({ code: 0, out: "", err: "" } as Ran);
    },
  });
  await lanes.start(START);
  const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: `${join(runnerDir, "bin")}:${process.env.PATH ?? ""}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
  expect(started.detail).toBe("started pane=hc:t1");
  expect(started.result.startup.verdict).toBe("unconfirmed");
  const first = launchLines(t.calls)[0] ?? "";
  expect(first).toStartWith(`export DO_NOT_TRACK=1 DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${t.lanes.tokenPath("lane-a")} DORI_LANE_OUT=${join(t.runnerDir, "briefs", "lane-a.out")} DORI_HEAVY_SLOTS=2 DORI_HEAVY_MAX_LOAD=40; eval "$(dori secret env)"; omo --model m1 --permission-preset full-access --no-ask-user=true 'ulw set goal and work. Read and execute`);
  t.world.panes = [];
  const recovered = await t.lanes.recover("lane-a", "ses_123", "# fresh brief\n", FILES);
  expect(recovered.result).toMatchObject({ pane: "hc:t2", tab: "", relaunched: true, resumed: true });
  const second = launchLines(t.calls).at(-1) ?? "";
  expect(second).toContain(`DORI_HEAVY_SLOTS=2 DORI_HEAVY_MAX_LOAD=40; eval "$(dori secret env)"; omo --model m1 --permission-preset full-access --no-ask-user=true --session ses_123 'ulw set goal and work.`);
});

test("agentArgv runs every lane under omo's full-access preset unless its profile already names a preset, and without omo's question tool", () => {
  const values = { prompt: "go", model: "m1", brief: "/b.md" };
  const policy = (template: readonly string[]) => ({ agents: { p: template }, allowedRoots: [], sandbox: "optional", jobs: "allow" }) as unknown as RunnerPolicy;
  const sandboxed = ["env", "V=1", "lane-sandbox", "omo", "--model", "{model}", "{prompt}"];
  expect(agentArgv(policy(sandboxed), "p", values)).toEqual(["env", "V=1", "lane-sandbox", "omo", "--model", "m1", "--permission-preset", "full-access", "--no-ask-user=true", "go"]);
  expect(agentArgv(policy(sandboxed), "p", values, "ses_1")).toEqual(["env", "V=1", "lane-sandbox", "omo", "--model", "m1", "--permission-preset", "full-access", "--no-ask-user=true", "--session", "ses_1", "go"]);
  expect(agentArgv(policy(["omo", "--permission-preset", "workspace", "{prompt}"]), "p", values)).toEqual(["omo", "--permission-preset", "workspace", "--no-ask-user=true", "go"]);
  expect(agentArgv(policy(["omo", "--permission-preset=ask", "{prompt}"]), "p", values)).toEqual(["omo", "--permission-preset=ask", "--no-ask-user=true", "go"]);
  expect(agentArgv(policy(["omo", "--no-ask-user=true", "{prompt}"]), "p", values)).toEqual(["omo", "--no-ask-user=true", "--permission-preset", "full-access", "go"]);
  expect(agentArgv(policy(["omo", "--model", "{model}"]), "p", values)).toEqual(["omo", "--model", "m1"]);
  // A lane without a sandbox also gets the rules that refuse every outside path but the allowed ones.
  expect(agentArgv(policy(["omo", "{prompt}"]), "p", values, undefined, "external_directory=deny")).toEqual(["omo", "--permission-preset", "full-access", "--permission", "external_directory=deny", "--no-ask-user=true", "go"]);
  expect(outsideDenyRules(["C:\\Users\\u\\.dori\\runner", "C:\\a,b", "C:\\x=y", "", "C:\\Users\\u\\.dori\\runner"], win32.join))
    .toBe("external_directory=deny,external_directory:C:\\Users\\u\\.dori\\runner=allow,external_directory:C:\\Users\\u\\.dori\\runner\\*=allow");
});

test("a lane.start without a sandbox refuses outside paths but its cwd, the runner dir, repos and worktree roots, temp and ~/.omo; a sandboxed one gets no rules", async () => {
  const policy = { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", reposRoot: "/srv/repos", sandboxCheck: ["lane-sandbox", "--check"] } as const;
  const bare = setup({ policy });
  await bare.lanes.start({ ...START, sandbox: false });
  const line = launchLines(bare.calls)[0] ?? "";
  const rules = [START.cwd, bare.runnerDir, "/srv/repos", "/srv/repos/worktrees", tmpdir(), join(homedir(), ".omo")]
    .flatMap((dir) => [`external_directory:${dir}=allow`, `external_directory:${dir}/*=allow`]);
  expect(line).toContain(` omo --permission-preset full-access --permission '${["external_directory=deny", ...rules].join(",")}' --no-ask-user=true 'ulw`);
  const boxed = setup({ policy });
  await boxed.lanes.start(START);
  expect(launchLines(boxed.calls)[0]).toContain(" omo --permission-preset full-access --no-ask-user=true 'ulw");
});

test("lane.start hands the policy's repos and worktree roots to the lane sandbox, the worktree root defaulting under the repos root", async () => {
  const policy = { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] } as const;
  const both = setup({ policy: { ...policy, reposRoot: "/Users/u/work/repos", worktreeRoot: "/Users/u/work/worktrees" } });
  await both.lanes.start(START);
  expect(launchLines(both.calls)[0]).toContain(` LANE_SANDBOX_REPOS=/Users/u/work/repos LANE_SANDBOX_WORKTREES=/Users/u/work/worktrees; eval "$(dori secret env)"; omo --model m1 `);
  const repos = setup({ policy: { ...policy, reposRoot: "/Users/u/work/repos" } });
  await repos.lanes.start(START);
  expect(launchLines(repos.calls)[0]).toContain(` LANE_SANDBOX_REPOS=/Users/u/work/repos LANE_SANDBOX_WORKTREES=/Users/u/work/repos/worktrees; eval "$(dori secret env)"; omo --model m1 `);
});

test("lane.adopt takes an existing hc terminal with a token file; keyForPane maps it; recover refuses to relaunch it", async () => {
  const t = setup();
  await expect(t.lanes.adopt({ cmdId: "a0", key: "lane-z", pane: "hc:t5", mode: "ulw", model: "m1" })).rejects.toThrow("RUNNER_LANE_PANE_MISSING");
  t.world.panes = [{ pane_id: "hc:t5", cwd: "/repo/z" }];
  const adopted = await t.lanes.adopt({ cmdId: "a1", key: "lane-z", pane: "hc:t5", mode: "ulw", model: "m1" });
  expect(adopted.result).toEqual({ pane: "hc:t5", tab: "", tokenFile: t.lanes.tokenPath("lane-z") });
  expect(readFileSync(t.lanes.tokenPath("lane-z"), "utf8")).toBe("tok-1");
  expect(t.lanes.tokenFor("lane-z", "tok-1")).toBe(true);
  expect(t.lanes.records()["lane-z"]).toMatchObject({ cwd: "/repo/z", adopted: true, hcInstance: "hc:core-1", terminalId: "hc:t5@0" });
  expect(t.lanes.keyForPane("hc:t5")).toBe("lane-z");
  expect(t.published.at(-1)).toEqual(["lane.started", { key: "lane-z", pane: "hc:t5", tab: "", session: "" }]);
  await expect(t.lanes.adopt({ cmdId: "a2", key: "lane-y", pane: "hc:t5", mode: "ulw", model: "m1" })).rejects.toThrow("RUNNER_LANE_TARGET_BUSY");
  t.world.panes = [];
  await expect(t.lanes.recover("lane-z")).rejects.toThrow("RUNNER_LANE_ADOPTED");
});

test("B7: adopt checks the pane's own cwd against allowedRoots (real paths, symlink escape)", async () => {
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

  t.world.panes = [
    { pane_id: "hc:t1", cwd: outside }, { pane_id: "hc:t2", cwd: join(allowed, "escape") }, { pane_id: "hc:t3", cwd: outside },
    { pane_id: "hc:t4", cwd: join(allowed, "wt") },
  ];
  await expect(adopt("lane-1", "hc:t1")).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  await expect(adopt("lane-2", "hc:t2")).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  // A permitted body.cwd does not cover the pane's own directory.
  await expect(adopt("lane-3", "hc:t3", join(allowed, "wt"))).rejects.toThrow("RUNNER_CMD_REJECTED cwd-outside-roots");
  expect(t.lanes.records()).toEqual({});
  expect(tokenFiles()).toEqual([]);
  expect((await adopt("lane-4", "hc:t4")).result.pane).toBe("hc:t4");
});

test("send refuses while a question shows when asked to, guarded mode answers sent, and close reads the pane back", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "idle" }];
  t.world.screen = QUESTION;
  await t.lanes.askTick();
  const before = t.calls.length;
  expect((await t.lanes.send("lane-a", "hello", true, { refuseWhileAsking: true })).result).toEqual({ delivery: "failed", refusal: "RUNNER_LANE_ASKING lane-a shows a question prompt; not typed" });
  expect(t.calls.length).toBe(before);
  t.world.screen = "❯ \n";
  expect((await t.lanes.send("lane-a", "hello", false, { mode: "guarded" })).result).toEqual({ delivery: "sent" });
  expect(sentTo(t.calls, "hc:t1")).toContain("hello");
  const closedWhileListed = await t.lanes.close("lane-a");
  expect(closedWhileListed.result).toEqual({ closed: "pane", gone: false });
  // A pane still listed keeps the lane's record and token file, so a later close can still reach it.
  expect(t.lanes.records()["lane-a"]).toBeDefined();
  expect(existsSync(t.lanes.tokenPath("lane-a"))).toBe(true);
  t.world.panes = [];
  expect((await t.lanes.close("lane-a")).result).toEqual({ closed: "none", gone: true });
  expect(t.lanes.records()["lane-a"]).toBeUndefined();
  expect(existsSync(t.lanes.tokenPath("lane-a"))).toBe(false);
  await t.lanes.start({ ...START, key: "lane-b" });
  t.world.panes = [];
  expect((await t.lanes.close("lane-b")).result).toEqual({ closed: "none", gone: true });
});

test("pause and resume run the lane-control sequences on the lane's pane; a recover keeps the lane's notice", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.world.panes = [{ pane_id: "hc:t1", agent: "omo", agent_status: "idle" }];
  t.world.screen = "❯ \n";
  const paused = await t.lanes.pause("lane-a", "stop");
  expect(paused.result).toEqual({ working: false, stopped: true });
  const resumed = await t.lanes.resume("lane-a");
  expect(resumed.result.goal).toBe("unconfirmed");
  await t.lanes.notify({ cmdId: "n", key: "lane-a", status: "paused" });
  t.world.panes = [];
  await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES);
  expect(t.lanes.notice("lane-a")).toEqual({ status: "paused" });
  await expect(t.lanes.notify({ cmdId: "n2", key: "nope", status: "x" })).rejects.toThrow("RUNNER_LANE_UNKNOWN");
});

const ABORTED = ["● Editing src/a.ts", "Operation aborted", "", "─".repeat(30), "(😺 OmO) Pursuing goal (4m)", ""].join("\n");
const FINISHED = ["● Editing src/a.ts", "All checks pass.", "", "─".repeat(30), "(😺 OmO) Pursuing goal (6m)", ""].join("\n");
const lanePane = (status: string): HcPane => ({ pane_id: "hc:t1", agent: "omo", agent_status: status });

test("a lane's stopped turn is recorded once per stop for its generation, kept across a runner restart, and answered by observe", async () => {
  const clock = fakeClock(T0);
  const t = setup({ clock });
  await t.lanes.start(START);
  const launched = t.calls.length;
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
  expect(t.calls.slice(launched).filter((a) => a[0] === "hc" && ["send", "keys"].includes(a[2] ?? ""))).toEqual([]);
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

test("lane.start hands a lane's grants to the sandbox as LANE_SANDBOX_RW/RO and keeps the names for a relaunch; a name the table lacks opens no terminal", async () => {
  const policy = {
    agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"],
    grants: { "blog-topic": { write: ["/srv/blog-writer/runs"], read: ["/srv/notes", "/srv/more"] } },
  } as const;
  const granted = setup({ policy });
  await granted.lanes.start({ ...START, grants: ["blog-topic"] });
  expect(launchLines(granted.calls)[0]).toContain(` LANE_SANDBOX_RW=/srv/blog-writer/runs LANE_SANDBOX_RO=/srv/notes:/srv/more; eval "$(dori secret env)"; omo --model m1 `);
  expect(granted.lanes.records()["lane-a"]?.grants).toEqual(["blog-topic"]);

  const plain = setup({ policy });
  await plain.lanes.start(START);
  expect(launchLines(plain.calls)[0]).not.toContain("LANE_SANDBOX_R");

  const gone = setup({ policy: { ...policy, grants: {} } });
  await expect(gone.lanes.start({ ...START, grants: ["blog-topic"] })).rejects.toThrow("RUNNER_CMD_REJECTED grant-unknown blog-topic");
  expect(opens(gone.calls)).toBe(0);
});

test("lane.start and a relaunching lane.recover report the model the agent argv runs: the one a profile pins over the requested one", async () => {
  const t = setup({ policy: {
    agents: { omo: ["omo", "--model", "{model}", "{prompt}"], pinned: ["omo", "--model=pinned/sonnet", "{prompt}"], bare: ["omo", "{prompt}"] },
    allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"],
  } });
  expect((await t.lanes.start(START)).result).toMatchObject({ model: "m1" });
  expect((await t.lanes.start({ ...START, cmdId: "c2", key: "lane-b", agentProfile: "pinned" })).result).toMatchObject({ model: "pinned/sonnet" });
  expect((await t.lanes.start({ ...START, cmdId: "c3", key: "lane-c", agentProfile: "bare" })).result).not.toHaveProperty("model");
  const next = { ...FILES, run: { ...FILES.run, id: "00000000-0000-4000-8000-000000000002" } };
  expect((await t.lanes.recover("lane-b", undefined, "new brief", next)).result).toMatchObject({ relaunched: true, model: "pinned/sonnet" });
});
