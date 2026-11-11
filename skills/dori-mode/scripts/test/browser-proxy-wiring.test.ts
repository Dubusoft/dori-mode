import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import type { SecretRule } from "../src/config.ts";
import type { Ran } from "../src/run.ts";
import type { BrowserProxyDeps } from "../src/runner/browser-proxy.ts";
import { BrowserProxies, browserProxiesEnabled, realBskHome } from "../src/runner/browser-proxies.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { type SecretAuditEntry } from "../src/runner/secret-grant.ts";
import { SecretHandles } from "../src/runner/secret-handles.ts";
import { fakeClock } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const ORIGIN = "https://login.example.com";
const VALUE = "dori-test-throwaway-pw";
const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };
const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: false, expectedLaneGen: 0, files: FILES };

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

const tempRunnerDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bfw-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const runnerDir = join(root, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  return runnerDir;
};

/** A RunnerLanes over a scripted herdr that records each `herdr pane run` command line. */
const lanesWith = (runnerDir: string, browser?: ConstructorParameters<typeof RunnerLanes>[0]["browser"], logs: string[] = []) => {
  const commands: string[] = [];
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(T0), token: () => "tok-1", realpath: (p: string) => p, log: (line) => { logs.push(line); },
    policy: { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    publish: () => {}, startup: async () => ({ verdict: "unconfirmed" }) as never, legacyMcp: async () => false,
    ...(browser ? { browser } : {}),
    run: async (argv) => {
      const ok = (out = ""): Ran => ({ code: 0, out, err: "" }) as Ran;
      if (argv[1] === "tab" && argv[2] === "create") return ok(JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }));
      if (argv[1] === "pane" && argv[2] === "list") return ok(JSON.stringify({ result: { panes: [] } }));
      if (argv[1] === "pane" && argv[2] === "run") commands.push(argv[4] ?? "");
      return ok();
    },
  });
  return { lanes, commands, logs };
};

/** A BrowserProxies whose proxies are recorded, not started. */
const recordingProxies = (runnerDir: string, fail = false) => {
  const events: string[] = [];
  const proxies = new BrowserProxies({
    runnerDir, bskHome: "/home/u/.bsk", exchange: async () => ({ ok: false, code: "X", detail: "" }), log: () => {}, pid: 1,
    startProxy: (deps: BrowserProxyDeps) => {
      if (fail) throw new Error("listen failed");
      events.push(`start ${deps.key} ${deps.dir}`);
      return { sockPath: join(deps.dir, "daemon.sock"), home: deps.dir, stop: async () => { events.push(`stop ${deps.key}`); } };
    },
  });
  return { proxies, events };
};

test("enablement: a real bsk home on darwin or linux, never win32", () => {
  expect(realBskHome({ BSK_HOME: "/x/bsk" }, "/home/u")).toBe("/x/bsk");
  expect(realBskHome({}, "/home/u")).toBe("/home/u/.bsk");
  expect(browserProxiesEnabled("linux", "/b", () => true)).toBe(true);
  expect(browserProxiesEnabled("darwin", "/b", () => true)).toBe(true);
  expect(browserProxiesEnabled("win32", "/b", () => true)).toBe(false);
  expect(browserProxiesEnabled("linux", "/b", () => false)).toBe(false);
});

test("when enabled the launch line points BSK_HOME at the lane's own proxy, started before the pane runs; close stops it", async () => {
  const runnerDir = tempRunnerDir();
  const { proxies, events } = recordingProxies(runnerDir);
  const t = lanesWith(runnerDir, {
    env: (key) => proxies.env(key),
    start: async (key) => { await proxies.start(key); events.push(`started-before-run=${t.commands.length === 0}`); },
    stop: (key) => proxies.stop(key),
  });
  await t.lanes.start(START);
  const home = join(runnerDir, "browser", "lane-a");
  expect(t.commands[0]).toContain(` BSK_HOME=${home} LANE_SANDBOX_BSK_HOME=/home/u/.bsk omo --model m1 `);
  expect(events).toEqual([`start lane-a ${home}`, "started-before-run=true"]);
  expect(proxies.running("lane-a")).toBe(true);
  await t.lanes.close("lane-a");
  expect(events.at(-1)).toBe("stop lane-a");
  expect(proxies.running("lane-a")).toBe(false);
});

test("when not enabled the launch line has no BSK_HOME", async () => {
  const t = lanesWith(tempRunnerDir());
  await t.lanes.start(START);
  expect(t.commands[0]).not.toContain("BSK_HOME");
});

test("a proxy that fails to start is logged and the lane still launches", async () => {
  const runnerDir = tempRunnerDir();
  const { proxies } = recordingProxies(runnerDir, true);
  const t = lanesWith(runnerDir, proxies);
  await t.lanes.start(START);
  expect(t.commands).toHaveLength(1);
  expect(t.logs).toEqual(["RUNNER_BROWSER_PROXY_FAILED lane=lane-a listen failed"]);
});

type Box = { buf: Buffer };

/** A fake BrowserSkill daemon: the target is a top-frame password input on ORIGIN; records fill values. */
const fakeDaemon = (path: string) => {
  const fills: unknown[] = [];
  const answer = (req: { id: unknown; method: string; params: Record<string, unknown> }): unknown => {
    if (req.method === "tool.cooperate") return { id: req.id, result: { context_id: "ctx" } };
    if (req.method === "tool.evaluate") return { id: req.id, result: { value: { origin: ORIGIN, top: true, masked: true } } };
    if (req.method === "tool.fill") { fills.push(req.params.value); return { id: req.id, result: { ok: true } }; }
    return { id: req.id, error: { code: "unknown_method", message: req.method, data: {} } };
  };
  const server = Bun.listen<Box>({
    unix: path,
    socket: {
      open: (s) => { s.data = { buf: Buffer.alloc(0) }; },
      data: (s: Socket<Box>, chunk) => {
        s.data.buf = Buffer.concat([s.data.buf, chunk]);
        for (let i = s.data.buf.indexOf(10); i >= 0; i = s.data.buf.indexOf(10)) {
          const req = JSON.parse(s.data.buf.subarray(0, i).toString());
          s.data.buf = s.data.buf.subarray(i + 1);
          s.write(`${JSON.stringify(answer(req))}\n`);
        }
      },
    },
  });
  return { fills, stop: () => server.stop(true) };
};

/** One NDJSON call to the proxy socket; resolves with the parsed reply. */
const call = (sock: string, body: object): Promise<{ result?: unknown; error?: { data?: { reason?: string } } }> => new Promise((resolve, reject) => {
  let text = "";
  Bun.connect<undefined>({
    unix: sock,
    socket: {
      open: (s) => { s.write(`${JSON.stringify(body)}\n`); },
      data: (s, chunk) => {
        text += chunk.toString();
        const nl = text.indexOf("\n");
        if (nl >= 0) { resolve(JSON.parse(text.slice(0, nl))); s.end(); }
      },
      close: () => { reject(new Error("closed before a reply")); },
    },
  }).catch(reject);
});

test("local path end to end: an issued handle fills the value once, only through its own lane's proxy", async () => {
  const runnerDir = tempRunnerDir();
  const bskHome = join(runnerDir, "..", "bsk");
  mkdirSync(bskHome);
  const daemon = fakeDaemon(join(bskHome, "d.sock"));
  cleanup.push(() => daemon.stop());
  writeFileSync(join(bskHome, "daemon.json"), JSON.stringify({ sock_path: join(bskHome, "d.sock") }));
  const audit: SecretAuditEntry[] = [];
  const granted: string[] = [];
  const rule = { lanes: ["lane-a", "lane-b"], repos: [], origins: [ORIGIN] } as unknown as SecretRule;
  const handles = new SecretHandles({
    store: { read: async () => VALUE }, rules: async () => ({ SITE_PW: rule }), laneRepo: async () => undefined,
    audit: (e) => { audit.push(e); }, runner: "local", now: () => T0, onGranted: (v) => { granted.push(...v); },
  });
  const logs: string[] = [];
  const proxies = new BrowserProxies({ runnerDir, bskHome, exchange: (key, h, o) => handles.exchange(key, h, o), log: (l) => { logs.push(l); }, pid: process.pid });
  cleanup.push(() => proxies.stopAll());
  await proxies.startAll(["lane-a", "lane-b"]);
  const sock = (key: string) => join(proxies.home(key), "daemon.sock");
  expect(existsSync(sock("lane-a")) && existsSync(sock("lane-b"))).toBe(true);

  const issued = await handles.issue("lane-a", "SITE_PW");
  if (!issued.ok) throw new Error(issued.code);
  const fill = (key: string, handle: string, id: number) => call(sock(key), { id, method: "tool.fill", params: { selector: "#pw", value: handle } });
  expect((await fill("lane-a", issued.handle, 1)).result).toEqual({ ok: true });
  expect(daemon.fills).toEqual([VALUE]);
  expect(granted).toEqual([VALUE]);
  expect((await fill("lane-a", issued.handle, 2)).error?.data?.reason).toBe("secret_origin_not_allowed");

  const other = await handles.issue("lane-a", "SITE_PW");
  if (!other.ok) throw new Error(other.code);
  expect((await fill("lane-b", other.handle, 3)).error?.data?.reason).toBe("secret_origin_not_allowed");
  expect(daemon.fills).toEqual([VALUE]);
  expect(audit.filter((e) => e.kind === "handle.exchange").map((e) => [e.lane, e.allowed, e.reason])).toEqual([
    ["lane-a", true, undefined], ["lane-a", false, "used"], ["lane-b", false, "wrong lane"],
  ]);
  for (const line of [...logs, ...audit.map((e) => JSON.stringify(e))]) {
    expect(line).not.toContain(VALUE);
    expect(line).not.toContain(issued.handle);
    expect(line).not.toContain(other.handle);
  }
  await proxies.stopAll();
  expect(existsSync(proxies.home("lane-a"))).toBe(false);
});
