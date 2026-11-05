import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pane } from "../src/panes.ts";
import type { Ran } from "../src/run.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { RunnerLanes, serveLaneSocket } from "../src/runner/lanes.ts";
import { acceptLaneEvent, type LaneHubDeps, reconcileInventory } from "../src/runner/lanes-hub.ts";
import { type RunnerEventType, runnerEvent } from "../src/runner/protocol.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";
import { fakeClock } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const QUESTION = ["work output", "? Question pending (1 unanswered) · 30m", "  deploy - Which region?", "  [ seoul ]  [ tokyo ]  [ own answer… ]", ""].join("\n");
const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0 };

/** A RunnerLanes over a scripted herdr: `world` decides each herdr answer, every call is recorded. */
const setup = () => {
  const runnerDir = join(mkdtempSync(join(tmpdir(), "runner-lanes-recover-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const world = { panes: [] as Pane[], screen: "", tabCreateFails: 0, nextPane: 1 };
  const calls: string[][] = [];
  const published: [RunnerEventType, unknown][] = [];
  let tokens = 0;
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" }) as Ran;
  const make = () => new RunnerLanes({
    runnerDir, clock: fakeClock(T0), token: () => `tok-${++tokens}`,
    policy: { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    publish: (type, body) => { published.push([type, body]); },
    run: async (argv) => {
      calls.push([...argv]);
      const verb = argv.slice(0, 3).join(" ");
      if (verb === "herdr tab create") {
        if (world.tabCreateFails > 0) { world.tabCreateFails--; return { code: 1, out: "", err: "server unreachable" } as Ran; }
        const n = world.nextPane++;
        return ok(JSON.stringify({ result: { tab_id: `t${n}`, root_pane: { pane_id: `p${n}`, tab_id: `t${n}` } } }));
      }
      if (verb === "herdr pane list") return ok(JSON.stringify({ result: { panes: world.panes } }));
      if (verb === "herdr pane read") return ok(world.screen);
      return ok();
    },
  });
  return { runnerDir, world, calls, published, lanes: make(), make };
};

test("P6: a recover whose relaunch fails keeps the lane's record, and a later recover relaunches it", async () => {
  const t = setup();
  await t.lanes.start(START);
  const before = t.lanes.records()["lane-a"];
  expect(before?.pane).toBe("p1");
  t.world.panes = []; // the lane's pane is gone
  t.world.tabCreateFails = 1;
  await expect(t.lanes.recover("lane-a")).rejects.toThrow("herdr tab create failed");
  expect(t.lanes.records()["lane-a"]).toEqual(before as NonNullable<typeof before>);
  expect(t.lanes.tokenFor("lane-a", "tok-1")).toBe(true);

  expect(await t.lanes.recover("lane-a")).toBe("started pane=p2 tab=t2");
  expect(t.lanes.records()["lane-a"]?.pane).toBe("p2");
  expect(t.lanes.tokenFor("lane-a", "tok-2")).toBe(true);
  expect(t.lanes.tokenFor("lane-a", "tok-1")).toBe(false);
});

test("lane.asking: an owned lane's on-screen question is published once, and again only once it is a new question", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.published.length = 0;
  t.world.screen = QUESTION;
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

test("alive criteria: observe and recover use paneAlive (agent_status), not the agent field", async () => {
  const t = setup();
  await t.lanes.start(START);
  t.published.length = 0;
  // herdr still names the agent, but its status is not an alive one: the supervisor's laneStatus calls this dead.
  t.world.panes = [{ pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "unknown" }];
  expect(await t.lanes.observe("lane-a")).toBe("observed dead");
  expect(t.published).toEqual([["lane.state", { key: "lane-a", status: "dead" }]]);
  expect(await t.lanes.recover("lane-a")).toBe("started pane=p2 tab=t2");
  // An alive status without an agent field is alive, as paneAlive says.
  t.world.panes = [{ pane_id: "p2", workspace_id: "w", tab_id: "t2", agent_status: "blocked" }];
  expect(await t.lanes.observe("lane-a")).toBe("observed idle");
  expect(await t.lanes.recover("lane-a")).toBe("alive pane=p2");
});

test("the lane token is never on the herdr command line; the lane CLI authenticates through DORI_LANE_TOKEN_FILE", async () => {
  const t = setup();
  await t.lanes.start(START);
  const run = t.calls.find((a) => a[2] === "run");
  const file = t.lanes.tokenPath("lane-a");
  expect(run?.[4]).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${file} omo --model m1 `);
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
  let lane: Record<string, unknown> = { key: "lane-a", runner: "worker-a", openedAt: "2026-11-01T00:00:00Z", pane: "p1", tab: "t1" };
  const deps = {
    registry: { read: async () => lane, open: async () => [lane], update: async (_k: string, fn: (l: unknown) => unknown) => { lane = fn(lane) as Record<string, unknown>; return lane; } },
    reports: () => undefined, emit: () => {}, recover: () => 1, now: () => 1000,
  } as unknown as LaneHubDeps;
  await reconcileInventory(deps, "worker-a", []); // a stale hello from before the launch
  expect(lane.recoveryPending).toBe(true);
  t.published.length = 0;
  expect(await t.lanes.recover("lane-a")).toBe("alive pane=p1");
  expect(t.published).toEqual([["lane.started", { key: "lane-a", pane: "p1", tab: "t1", session: "" }]]);
  for (const [type, body] of t.published) await acceptLaneEvent(deps, "worker-a", runnerEvent(head, ++seq, type, body as never) as Parameters<typeof acceptLaneEvent>[2]);
  expect(lane.recoveryPending).toBeFalsy();
});

test("B3: the launch command runs under /bin/sh when the runner directory has a space, and keeps the token off the command", async () => {
  const t = setup();
  const runnerDir = join(t.runnerDir, "space in runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  let command = "";
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(T0), token: () => "secret-not-on-argv",
    policy: { agents: { omo: ["/usr/bin/env"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    publish: () => {},
    run: async (argv) => {
      if (argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      if (argv[1] === "pane" && argv[2] === "run") command = argv[4] ?? "";
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  await lanes.start(START);
  const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain(`DORI_LANE_TOKEN_FILE=${join(runnerDir, "briefs", "lane-a.token")}`);
  expect(out).toContain("DORI_LANE_KEY=lane-a");
  expect(out).not.toContain("secret-not-on-argv");
});
