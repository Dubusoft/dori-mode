import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_AGENT_TEMPLATE } from "../src/remote-guard.ts";
import { heavyDirOf, laneCliMain } from "../src/runner/lane-cli.ts";
import { serveLaneSocket } from "../src/runner/lanes.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";
import { connectUnix, listenUnix } from "../src/runner/unix-transport.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-a" };
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } };
};
const laneSocket = () => {
  const net = memoryNetwork();
  const published: [RunnerEventType, unknown][] = [];
  serveLaneSocket(net.listener, { tokenFor: (key, token) => key === "lane-a" && token === "tok-a" }, (type, body) => { published.push([type, body]); }, () => {});
  // The in-memory link delivers on pump(); pumping on each send delivers the request and the socket's reply in order.
  const connect: Connector = async () => {
    const link = await net.connect();
    const pair = net.pairs.at(-1) as (typeof net.pairs)[number];
    return {
      send: (line) => { link.send(line); pair.pump(); },
      onLine: (h) => link.onLine(h), onClose: (h) => link.onClose(h), close: (reason) => { link.close(reason); },
      get open() { return link.open; },
    } satisfies Transport;
  };
  return { connect, published };
};

test("a lane reports only for its own key, with its own token", async () => {
  const sock = laneSocket();
  const ok = io();
  expect(await laneCliMain(["report", "lane-a", "milestone", "--text", "PR open"], { env, connect: sock.connect, ...ok.deps })).toBe(0);
  expect(sock.published).toEqual([["lane.report", { key: "lane-a", kind: "milestone", text: "PR open" }]]);

  const other = io();
  expect(await laneCliMain(["report", "lane-b", "milestone", "--text", "not mine"], { env, connect: sock.connect, ...other.deps })).toBe(1);
  expect(other.err[0]).toStartWith("LANE_PERMISSION_DENIED lane lane-a may report only for itself, not lane-b");

  const forged = io();
  expect(await laneCliMain(["report", "lane-a", "done", "--text", "x"], { env: { ...env, DORI_LANE_TOKEN: "stolen" }, connect: sock.connect, ...forged.deps })).toBe(1);
  expect(forged.err[0]).toStartWith("RUNNER_LANE_AUTH_FAILED");
  expect(sock.published).toHaveLength(1);

  const claim = io();
  expect(await laneCliMain(["claim-done", "lane-a", "--evidence", "abc123"], { env, connect: sock.connect, ...claim.deps })).toBe(0);
  expect(sock.published[1]).toEqual(["lane.report", { key: "lane-a", kind: "done", text: "abc123", evidence: "abc123" }]);
});

test("over a real unix socket the lane socket answers a report and refuses a forged token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-lane-sock-"));
  dirs.push(dir);
  const path = join(dir, "lane");
  const listener = listenUnix(path);
  const published: [RunnerEventType, unknown][] = [];
  const stop = serveLaneSocket(listener, { tokenFor: (key, token) => key === "lane-a" && token === "tok-a" }, (type, body) => { published.push([type, body]); }, () => {});
  try {
    const ok = io();
    expect(await laneCliMain(["report", "lane-a", "milestone", "--text", "PR open"], { env, connect: connectUnix(path), ...ok.deps })).toBe(0);
    expect(published).toEqual([["lane.report", { key: "lane-a", kind: "milestone", text: "PR open" }]]);
    const forged = io();
    expect(await laneCliMain(["report", "lane-a", "done", "--text", "x"], { env: { ...env, DORI_LANE_TOKEN: "stolen" }, connect: connectUnix(path), ...forged.deps })).toBe(1);
    expect(forged.err[0]).toStartWith("RUNNER_LANE_AUTH_FAILED");
    expect(published).toHaveLength(1);
  } finally {
    stop();
    listener.close();
  }
});

test("any other command exits 2 with DORI_CLI_UNSUPPORTED_ON_RUNNER", async () => {
  for (const sub of ["send", "launch", "serve", "close"]) {
    const r = io();
    expect(await laneCliMain([sub, "lane-a", "hi"], { env, connect: laneSocket().connect, ...r.deps })).toBe(2);
    expect(r.err[0]).toStartWith(`DORI_CLI_UNSUPPORTED_ON_RUNNER ${sub}`);
  }
});

test("dori heavy waits for ~/.dori/heavy/slot.1 that guard-agent.sh heavy holds, then takes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "runner-lane-heavy-"));
  dirs.push(home);
  const agent = Bun.spawn(["sh", GUARD_AGENT_TEMPLATE, "heavy", "old-footer", "--", "sh", "-c", "echo HOLDING; cat"], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = agent.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("HOLDING");
  const slot = join(heavyDirOf(home), "slot.1");
  expect(readFileSync(join(slot, "owner"), "utf8")).toContain("old-footer");

  let waited = 0;
  let ownerWhileRunning = "";
  const r = io();
  const code = await laneCliMain(["heavy", "build", "--", "true"], {
    env, connect: laneSocket().connect, ...r.deps, heavyDir: heavyDirOf(home),
    clock: {
      now: () => 0,
      // The first wait is where the old footer's job ends and frees the slot.
      sleep: async () => { waited += 1; if (waited === 1) { agent.stdin.end(); await agent.exited; } },
    },
    spawn: async () => { ownerWhileRunning = readFileSync(join(slot, "owner"), "utf8"); return 0; },
  });
  expect(code).toBe(0);
  expect(waited).toBe(1);
  expect(ownerWhileRunning).toContain("lane-a:build");
  expect(existsSync(slot)).toBe(false);
});
