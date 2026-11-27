import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { RunnerLanes, serveLaneSocket } from "../src/runner/lanes.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { memoryNetwork } from "./support/memory-transport.ts";
import { fakeClock } from "./fakes.ts";
import { hcAnswer, launchLines, newHcWorld } from "./runner-hc-world.ts";

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
  const world = newHcWorld();
  const calls: string[][] = [];
  let tokens = 0;
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(0), token: () => `tok-${++tokens}`, publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    realpath: (p) => p,
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    run: async (argv) => {
      calls.push([...argv]);
      return hcAnswer(world, argv) ?? ({ code: 0, out: "", err: "" } as Ran);
    },
  });
  /** The launch lines typed so far, oldest first. */
  const launches = (): string[] => launchLines(calls);
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
  /** The lane identity and token exported by the runner's launch line. */
  const envOf = (launch: string): Record<string, string> => {
    const file = /DORI_LANE_TOKEN_FILE=(\S+)/.exec(launch)?.[1] ?? "";
    return { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: file };
  };
  return { lanes, world, launches, reports, err, cli, envOf };
};

test("after a relaunch the old session's unchanged DORI_LANE_TOKEN_FILE is refused; the replacement session is accepted", async () => {
  const t = setup();
  await t.lanes.start(START);
  const oldEnv = t.envOf(t.launches()[0] ?? "");
  expect(await t.cli(["report", "lane-a", "progress", "--text", "first session"], oldEnv)).toBe(0);

  t.world.panes = []; // the pane is gone; the old agent process may live on outside it (no sandbox)
  expect((await t.lanes.recover("lane-a", undefined, "# fresh brief\n", FILES)).detail).toBe("started pane=hc:t2");
  const newEnv = t.envOf(t.launches()[1] ?? "");
  expect(newEnv.DORI_LANE_TOKEN_FILE).not.toBe(oldEnv.DORI_LANE_TOKEN_FILE);
  expect(existsSync(oldEnv.DORI_LANE_TOKEN_FILE ?? "")).toBe(false);

  expect(await t.cli(["claim-done", "lane-a", "--evidence", "stale merge"], oldEnv)).toBe(1);
  expect(t.err.at(-1)).toStartWith("RUNNER_LANE_AUTH_FAILED");
  expect(await t.cli(["report", "lane-a", "done", "--text", "stale session report"], oldEnv)).toBe(1);
  expect(t.err.at(-1)).toStartWith("RUNNER_LANE_AUTH_FAILED");

  expect(await t.cli(["claim-done", "lane-a", "--evidence", "abc123 merged"], newEnv)).toBe(0);
  expect(t.reports.map(([, body]) => (body as { text: string }).text)).toEqual(["first session", "abc123 merged"]);
});

test("an adopted lane keeps its stable briefs/<key>.token, found by key without a token variable", async () => {
  const t = setup();
  t.world.panes = [{ pane_id: "hc:t5", cwd: "/repo/z" }];
  const adopted = await t.lanes.adopt({ cmdId: "a1", key: "lane-a", pane: "hc:t5", mode: "ulw", model: "m1" });
  expect(adopted.result.tokenFile).toEndWith(join("briefs", "lane-a.token"));
  expect(await t.cli(["report", "lane-a", "progress", "--text", "adopted"], { DORI_LANE_KEY: "lane-a" })).toBe(0);
});
