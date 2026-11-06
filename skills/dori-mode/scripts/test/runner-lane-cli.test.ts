import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("any other command exits 2 with DORI_CLI_LANE_ONLY", async () => {
  for (const sub of ["send", "launch", "serve", "close", "wait"]) {
    const r = io();
    expect(await laneCliMain([sub, "lane-a", "hi"], { env, connect: laneSocket().connect, ...r.deps })).toBe(2);
    expect(r.err[0]).toStartWith(`DORI_CLI_LANE_ONLY ${sub}:`);
  }
  const other = io();
  expect(await laneCliMain(["lane", "list"], { env, connect: laneSocket().connect, ...other.deps })).toBe(2);
  expect(other.err[0]).toStartWith("DORI_CLI_LANE_ONLY lane list:");
});

/** A connector over a scripted reply: records each request body the lane CLI sends. */
const scripted = (reply: object, requests: object[]): Connector => async () => {
  const lines = new Set<(l: string) => void>();
  return {
    send: (line) => { requests.push(JSON.parse(line)); queueMicrotask(() => { for (const h of lines) h(JSON.stringify(reply)); }); },
    onLine: (h) => { lines.add(h); return () => { lines.delete(h); }; },
    onClose: () => () => {}, close: () => {}, open: true,
  } satisfies Transport;
};

test("lane status sends {kind:status} and prints the reply; report ack sends {kind:ack}", async () => {
  const requests: object[] = [];
  const status = { ok: true, status: "done-claimed", objection: null, claim: { at: "t", evidence: "abc" } };
  const s = io();
  expect(await laneCliMain(["lane", "status"], { env, connect: scripted(status, requests), ...s.deps })).toBe(0);
  expect(requests).toEqual([{ kind: "status", key: "lane-a", token: "tok-a" }]);
  expect(JSON.parse(s.out[0] as string)).toEqual({ status: "done-claimed", objection: null, claim: { at: "t", evidence: "abc" } });

  const wrong = io();
  expect(await laneCliMain(["lane", "status", "lane-b"], { env, connect: scripted(status, requests), ...wrong.deps })).toBe(1);
  expect(wrong.err[0]).toStartWith("LANE_PERMISSION_DENIED");

  const a = io();
  expect(await laneCliMain(["report", "ack", "m-1"], { env, connect: scripted({ ok: true }, requests), ...a.deps })).toBe(0);
  expect(requests.at(-1)).toEqual({ kind: "ack", id: "m-1", key: "lane-a", token: "tok-a" });
  expect(a.out[0]).toContain("m-1");
});

test("the token falls back to briefs/<key>.token under the runner dir", async () => {
  const requests: object[] = [];
  const r = io();
  const code = await laneCliMain(["lane", "status"], {
    env: { DORI_LANE_KEY: "lane-a" }, connect: scripted({ ok: true, status: "working" }, requests), ...r.deps,
    runnerDir: "/r", readFile: (p) => { if (p === "/r/briefs/lane-a.token") return "file-tok\n"; throw new Error("ENOENT"); },
  });
  expect(code).toBe(0);
  expect(requests).toEqual([{ kind: "status", key: "lane-a", token: "file-tok" }]);
});

test("the socket client retries ENOENT/ECONNREFUSED every second for 60 s on the injected clock", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  const requests: object[] = [];
  let calls = 0;
  const inner = scripted({ ok: true, status: "working" }, requests);
  const flaky: Connector = async () => {
    calls += 1;
    if (calls <= 3) throw Object.assign(new Error("connect failed"), { code: calls === 1 ? "ENOENT" : "ECONNREFUSED" });
    return inner();
  };
  const ok = io();
  expect(await laneCliMain(["lane", "status"], { env, connect: flaky, clock, ...ok.deps })).toBe(0);
  expect(sleeps).toEqual([1000, 1000, 1000]);

  now = 0; sleeps.length = 0;
  const never: Connector = async () => { throw Object.assign(new Error("connect ENOENT /x"), { code: "ENOENT" }); };
  const bad = io();
  expect(await laneCliMain(["lane", "status"], { env, connect: never, clock, ...bad.deps })).toBe(1);
  expect(bad.err[0]).toStartWith("RUNNER_LANE_SOCKET_UNAVAILABLE");
  expect(sleeps).toHaveLength(60);
  expect(now).toBe(60_000);

  const other: Connector = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  const eacces = io();
  expect(await laneCliMain(["lane", "status"], { env, connect: other, clock, ...eacces.deps })).toBe(1);
  expect(sleeps).toHaveLength(60);
});

test("dori heavy waits for ~/.dori/heavy/slot.1 that guard-agent.sh heavy holds, then takes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "runner-lane-heavy-"));
  dirs.push(home);
  // The old footer's job holds the slot until the test writes to this fifo: no stdin pipe whose early close would free it.
  const release = join(home, "release.fifo");
  expect(Bun.spawnSync(["mkfifo", release]).exitCode).toBe(0);
  const agent = Bun.spawn(["sh", GUARD_AGENT_TEMPLATE, "heavy", "old-footer", "--", "sh", "-c", 'echo HOLDING; cat "$0" >/dev/null', release], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
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
      sleep: async () => { waited += 1; if (waited === 1) { writeFileSync(release, ""); await agent.exited; } },
    },
    spawn: async () => { ownerWhileRunning = readFileSync(join(slot, "owner"), "utf8"); return 0; },
  });
  expect(code).toBe(0);
  expect(waited).toBe(1);
  expect(ownerWhileRunning).toContain("lane-a:build");
  expect(existsSync(slot)).toBe(false);
});
