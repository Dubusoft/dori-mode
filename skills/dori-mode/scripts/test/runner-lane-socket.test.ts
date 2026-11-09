import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { serveLaneSocket } from "../src/runner/lane-socket.ts";
import { RunnerLanes, type RunnerLanesDeps } from "../src/runner/lanes.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };
const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: false, expectedLaneGen: 0, files: FILES };

/** A RunnerLanes with lane-a started on pane p1 (token tok-a), served on an in-memory lane socket. */
const setup = async (over: Partial<RunnerLanesDeps> = {}, requiredReport = false) => {
  const root = mkdtempSync(join(tmpdir(), "runner-lane-socket-"));
  dirs.push(root);
  const runnerDir = join(root, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const lanes = new RunnerLanes({
    ...over,
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(0), token: () => "tok-a", publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    run: async (argv) => (argv.slice(0, 3).join(" ") === "herdr tab create"
      ? { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" }
      : { code: 0, out: "", err: "" }) as Ran,
  });
  await lanes.start({ ...START, tabWorkspace: "w1", files: { ...FILES, run: { ...FILES.run, requiredReport } } });
  const storage = { fail: false, loseReply: false };
  const net = memoryNetwork({ drop: (_line, direction) => storage.loseReply && direction === "to-runner" });
  const published: [RunnerEventType, unknown][] = [];
  const logs: string[] = [];
  serveLaneSocket(net.listener, lanes, (type, body) => { if (storage.fail) throw new Error("disk full"); published.push([type, body]); }, (line) => { logs.push(line); });
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
  return { lanes, ask, published, logs, runnerDir, storage, net };
};

test("whoami by pane answers the lane's key without a token; an unknown pane answers no key", async () => {
  const t = await setup();
  expect(await t.ask({ kind: "whoami", pane: "p1" })).toEqual({ ok: true, key: "lane-a" });
  expect(await t.ask({ kind: "whoami", pane: "p9" })).toEqual({ ok: true });
  expect(await t.ask({ kind: "whoami" })).toMatchObject({ ok: false, code: "RUNNER_LANE_BAD_REQUEST" });
});

test("authentication precedes capture and only done captures; retries keep bytes and revision", async () => {
  let reads = 0;
  const t = await setup({ fileReaders: { lstat: ((path: string) => { reads++; return lstatSync(path); }) as typeof lstatSync } });
  const request = { kind: "done", key: "lane-a", token: "tok-a", text: "done" };
  expect(await t.ask({ ...request, token: "wrong" })).toMatchObject({ ok: false, code: "RUNNER_LANE_AUTH_FAILED" });
  expect(reads).toBe(0);
  expect(await t.ask({ ...request, kind: "progress" })).toEqual({ ok: true });
  expect(reads).toBe(0);
  const path = join(t.runnerDir, "briefs/lane-a.out/report.bin");
  writeFileSync(path, Buffer.from([255, 0, 128]));
  expect(await t.ask(request)).toEqual({ ok: true });
  expect(await t.ask(request)).toEqual({ ok: true });
  const reports = t.published.slice(1).map(([, body]) => body as { files: { revision: number; tree: { files: { base64: string }[] } } });
  expect(reports[0]?.files).toEqual(reports[1]?.files);
  expect(reports[0]?.files.revision).toBe(1);
  expect(readFileSync(path)).toEqual(Buffer.from([255, 0, 128]));
  writeFileSync(path, "changed");
  expect(await t.ask(request)).toEqual({ ok: true });
  expect((t.published.at(-1)?.[1] as { files: { revision: number } }).files.revision).toBe(2);
});

for (const remote of [false, true]) test(`required report refusal names the ${remote ? "remote" : "local"} CLI verbatim`, async () => {
  const t = await setup({ remote }, true);
  const reply = await t.ask({ kind: "done", key: "lane-a", token: "tok-a", text: "done" });
  expect(reply).toEqual({ ok: false, code: "LANE_REPORT_REQUIRED",
    detail: `lane-a: DORI_LANE_OUT is empty; write your report to ${JSON.stringify(join(t.runnerDir, "briefs/lane-a.out/report.md"))}, then run ${remote ? "~/.dori/runner/bin/dori" : "dori"} report lane-a done --text "<one line>" --evidence "<summary>"` });
  expect(t.published).toEqual([]);
});

test("oversize, unsafe, and failed durable storage reply false without publishing", async () => {
  const t = await setup(), path = join(t.runnerDir, "briefs/lane-a.out/report.md");
  const req = { kind: "done", key: "lane-a", token: "tok-a", text: "done" };
  writeFileSync(path, Buffer.alloc(262145));
  expect(await t.ask(req)).toEqual({ ok: false, code: "LANE_REPORT_TOO_LARGE", detail:
    `lane-a: output file ${JSON.stringify(path)} is 262145 bytes; the limit is 262144 bytes; reduce it in DORI_LANE_OUT and claim done again` });
  rmSync(path); symlinkSync(join(t.runnerDir, "missing"), path);
  expect(await t.ask(req)).toEqual({ ok: false, code: "LANE_REPORT_UNSAFE", detail:
    `lane-a: output ${JSON.stringify(path)} is unsafe (symlink); replace it with a regular file or directory without links and claim done again` });
  rmSync(path); writeFileSync(path, "ok");
  t.storage.fail = true;
  expect(await t.ask(req)).toEqual({ ok: false, code: "LANE_REPORT_STORE_FAILED", detail:
    "lane-a: the complete report was not stored by the runner; fix runner disk space and permissions, then claim done again" });
  expect(t.published).toEqual([]);
  t.storage.fail = false;
  expect(await t.ask(req)).toEqual({ ok: true });
  expect((t.published[0]?.[1] as { files: { revision: number } }).files.revision).toBe(1);
});

test("a lost reply followed by retry keeps the complete snapshot and revision", async () => {
  const t = await setup(), path = join(t.runnerDir, "briefs/lane-a.out/report.bin");
  writeFileSync(path, Buffer.from([0, 255, 128]));
  const request = { kind: "done", key: "lane-a", token: "tok-a", text: "done" };
  const link = await t.net.connect();
  let replies = 0;
  link.onLine(() => { replies++; });
  t.storage.loseReply = true;
  link.send(JSON.stringify(request) + "\n");
  t.net.pairs.at(-1)!.pump();
  expect(t.published).toHaveLength(1);
  expect(replies).toBe(0);
  link.close();
  t.storage.loseReply = false;
  expect(await t.ask(request)).toEqual({ ok: true });
  expect(t.published[1]).toEqual(t.published[0]);
  expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
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
