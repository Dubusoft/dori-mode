import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { serveLaneSocket } from "../src/runner/lane-socket.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: false, expectedLaneGen: 0 };

/** A RunnerLanes with lane-a started on pane p1 (token tok-a), served on an in-memory lane socket. */
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-lane-socket-"));
  dirs.push(root);
  const runnerDir = join(root, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(0), token: () => "tok-a", publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    run: async (argv) => (argv.slice(0, 3).join(" ") === "herdr tab create"
      ? { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" }
      : { code: 0, out: "", err: "" }) as Ran,
  });
  await lanes.start(START);
  const net = memoryNetwork();
  const published: [RunnerEventType, unknown][] = [];
  const logs: string[] = [];
  serveLaneSocket(net.listener, lanes, (type, body) => { published.push([type, body]); }, (line) => { logs.push(line); });
  /** One request line, its one reply. */
  const ask = async (body: object | string): Promise<Record<string, unknown>> => {
    const link = await net.connect();
    const pair = net.pairs.at(-1) as (typeof net.pairs)[number];
    const reply = new Promise<string>((resolve) => { link.onLine(resolve); });
    link.send(`${typeof body === "string" ? body : JSON.stringify(body)}\n`);
    pair.pump();
    const line = await reply;
    link.close("done");
    return JSON.parse(line) as Record<string, unknown>;
  };
  return { lanes, ask, published, logs };
};

test("whoami by pane answers the lane's key without a token; an unknown pane answers no key", async () => {
  const t = await setup();
  expect(await t.ask({ kind: "whoami", pane: "p1" })).toEqual({ ok: true, key: "lane-a" });
  expect(await t.ask({ kind: "whoami", pane: "p9" })).toEqual({ ok: true });
  expect(await t.ask({ kind: "whoami" })).toMatchObject({ ok: false, code: "RUNNER_LANE_BAD_REQUEST" });
});

test("status answers the default before any notify, then the notice lane.notify stored", async () => {
  const t = await setup();
  expect(await t.ask({ kind: "status", key: "lane-a", token: "tok-a" })).toEqual({ ok: true, status: "working", objection: null, claim: null });
  await t.lanes.notify({ cmdId: "n1", key: "lane-a", status: "not-done", objection: { at: "2026-11-06T00:00:00Z", reasons: ["CI red"] } });
  expect(await t.ask({ kind: "status", key: "lane-a", token: "tok-a" })).toEqual({
    ok: true, status: "not-done", objection: { at: "2026-11-06T00:00:00Z", reasons: ["CI red"] }, claim: null,
  });
  // The notice is in lanes.json, so a restarted runner answers the same.
  expect(t.lanes.notice("lane-a")?.status).toBe("not-done");
});

test("ack publishes lane.ack; report publishes lane.report; a wrong token is refused for every verb but whoami", async () => {
  const t = await setup();
  expect(await t.ask({ kind: "ack", key: "lane-a", token: "tok-a", id: "msg-7" })).toEqual({ ok: true });
  expect(await t.ask({ kind: "milestone", key: "lane-a", token: "tok-a", text: "PR open" })).toEqual({ ok: true });
  expect(t.published).toEqual([["lane.ack", { key: "lane-a", id: "msg-7" }], ["lane.report", { key: "lane-a", kind: "milestone", text: "PR open" }]]);
  for (const kind of ["status", "ack", "progress"]) {
    expect(await t.ask({ kind, key: "lane-a", token: "forged", id: "x", text: "x" })).toMatchObject({ ok: false, code: "RUNNER_LANE_AUTH_FAILED" });
  }
  expect(t.published).toHaveLength(2);
  expect(await t.ask({ kind: "ack", key: "lane-a", token: "tok-a" })).toMatchObject({ ok: false, code: "RUNNER_LANE_BAD_REQUEST" });
  expect(await t.ask({ kind: "deploy", key: "lane-a", token: "tok-a", text: "x" })).toMatchObject({ ok: false, code: "RUNNER_LANE_BAD_REQUEST" });
  expect(await t.ask("not json")).toMatchObject({ ok: false, code: "RUNNER_LANE_BAD_REQUEST", detail: "not JSON" });
  expect(t.logs.filter((l) => l.startsWith("RUNNER_LANE_AUTH_FAILED"))).toHaveLength(3);
});
