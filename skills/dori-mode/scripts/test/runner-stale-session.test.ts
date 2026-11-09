import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { RunnerLanes, serveLaneSocket } from "../src/runner/lanes.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";
import { fakeClock } from "./fakes.ts";

/**
 * Replaces the deleted done-perms-close test "the dori CLI refuses claim-done and report from a replaced session's old
 * pane": a relaunch gives the new session its own token file, so the old session, which keeps its unchanged
 * DORI_LANE_TOKEN_FILE and re-reads it on every call, no longer finds a valid token (gate review B5, probe E2).
 */

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: false, expectedLaneGen: 0, files: FILES };

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "runner-stale-session-"));
  dirs.push(root);
  const runnerDir = join(root, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const world = { panes: [] as object[], nextPane: 1, paneGet: {} as Record<string, object>, processInfo: {} as Record<string, object> };
  const launches: string[] = [];
  let tokens = 0;
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" }) as Ran;
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(0), token: () => `tok-${++tokens}`, publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    realpath: (p) => p,
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    run: async (argv) => {
      const verb = argv.slice(0, 3).join(" ");
      if (verb === "herdr tab create") {
        const n = world.nextPane++;
        return ok(JSON.stringify({ result: { tab_id: `t${n}`, root_pane: { pane_id: `p${n}`, tab_id: `t${n}` } } }));
      }
      if (verb === "herdr pane list") return ok(JSON.stringify({ result: { panes: world.panes } }));
      if (verb === "herdr pane get") {
        const pane = world.paneGet[argv[3] ?? ""];
        return pane ? ok(JSON.stringify({ result: { pane } })) : ({ code: 1, out: "", err: "pane not found" } as Ran);
      }
      if (verb === "herdr pane process-info") {
        const info = world.processInfo[argv[4] ?? ""];
        return info ? ok(JSON.stringify({ result: { process_info: info } })) : ok();
      }
      if (verb === "herdr pane run") launches.push(argv[4] ?? "");
      return ok();
    },
  });
  const net = memoryNetwork();
  const reports: [RunnerEventType, unknown][] = [];
  serveLaneSocket(net.listener, lanes, (type, body) => { reports.push([type, body]); }, () => {});
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
  /** The real lane CLI (real file reads) in the environment one session was launched with. */
  const cli = (args: string[], env: Record<string, string>) => laneCliMain(args, { env, connect, runnerDir, out: () => {}, err: (l) => { err.push(l); } });
  /** The environment the runner's launch line gave a session: its key, its token file and its pane. */
  const envOf = (launch: string, pane: string): Record<string, string> => {
    const file = /DORI_LANE_TOKEN_FILE=(\S+)/.exec(launch)?.[1] ?? "";
    return { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: file, HERDR_PANE_ID: pane };
  };
  return { lanes, world, launches, reports, err, cli, envOf };
};

test("after a relaunch the old session's unchanged DORI_LANE_TOKEN_FILE is refused; the replacement session is accepted", async () => {
  const t = setup();
  await t.lanes.start(START);
  const oldEnv = t.envOf(t.launches[0] ?? "", "p1");
  expect(await t.cli(["report", "lane-a", "progress", "--text", "first session"], oldEnv)).toBe(0);

  t.world.panes = []; // the pane is gone; the old agent process may live on outside it (no sandbox)
  expect((await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=p2 tab=t2");
  const newEnv = t.envOf(t.launches[1] ?? "", "p2");
  expect(newEnv.DORI_LANE_TOKEN_FILE).not.toBe(oldEnv.DORI_LANE_TOKEN_FILE);
  expect(existsSync(oldEnv.DORI_LANE_TOKEN_FILE ?? "")).toBe(false);

  expect(await t.cli(["claim-done", "lane-a", "--evidence", "stale merge"], oldEnv)).toBe(1);
  expect(t.err.at(-1)).toStartWith("RUNNER_LANE_AUTH_FAILED");
  expect(await t.cli(["report", "lane-a", "done", "--text", "stale session report"], oldEnv)).toBe(1);
  expect(t.err.at(-1)).toStartWith("RUNNER_LANE_AUTH_FAILED");

  expect(await t.cli(["claim-done", "lane-a", "--evidence", "abc123 merged"], newEnv)).toBe(0);
  expect(t.reports.map(([, body]) => (body as { text: string }).text)).toEqual(["first session", "abc123 merged"]);
});

test("an unsandboxed lane started in a target pane is fenced the same way after its relaunch", async () => {
  const t = setup();
  t.world.paneGet.p9 = { pane_id: "p9", workspace_id: "w1", tab_id: "t9", cwd: "/repo/wt" };
  t.world.processInfo.p9 = { shell_pid: 50, foreground_process_group_id: 50, foreground_processes: [{ pid: 50, name: "bash" }] };
  await t.lanes.start({ ...START, target: { pane: "p9" } });
  const oldEnv = t.envOf(t.launches[0] ?? "", "p9");
  t.world.panes = [];
  await t.lanes.recover("lane-a", undefined, undefined, "# fresh brief\n", FILES);
  const newEnv = t.envOf(t.launches[1] ?? "", "p1");
  expect(await t.cli(["report", "lane-a", "done", "--text", "from the old target pane"], oldEnv)).toBe(1);
  expect(t.err.at(-1)).toStartWith("RUNNER_LANE_AUTH_FAILED");
  expect(await t.cli(["report", "lane-a", "milestone", "--text", "replacement"], newEnv)).toBe(0);
  expect(t.reports).toHaveLength(1);
});

test("an adopted lane keeps its stable briefs/<key>.token, found by key without a token variable", async () => {
  const t = setup();
  t.world.paneGet.p5 = { pane_id: "p5", workspace_id: "w1", tab_id: "t5", cwd: "/repo/z" };
  const adopted = await t.lanes.adopt({ cmdId: "a1", key: "lane-a", pane: "p5", mode: "ulw", model: "m1" });
  expect(adopted.result.tokenFile).toEndWith(join("briefs", "lane-a.token"));
  expect(await t.cli(["report", "lane-a", "progress", "--text", "adopted"], { HERDR_PANE_ID: "p5", DORI_LANE_KEY: "lane-a" })).toBe(0);
});
