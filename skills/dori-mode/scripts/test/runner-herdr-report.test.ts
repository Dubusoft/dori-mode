import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { checkHerdrReport, herdrControlSocket, herdrReportSocketPath, HerdrReportSockets } from "../src/runner/herdr-report.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const runnerDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "runner-herdr-"));
  dirs.push(root);
  const dir = join(root, "runner");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

/** The request omo's herdr extension sends for a state change. */
const report = (params: Record<string, unknown>, method = "pane.report_agent") =>
  JSON.stringify({ id: "custom:omo:1:a", method, params: { pane_id: "w1:p2", source: "custom:omo", agent: "omo", state: "working", seq: 7, ...params } });

test("the lane's own pane report and release are forwarded rebuilt from the checked fields only", () => {
  expect(checkHerdrReport(report({ message: null, agent_session_path: "/home/u/.omo/s.jsonl" }), "w1:p2")).toEqual({
    ok: true, id: "custom:omo:1:a",
    request: JSON.stringify({ id: "custom:omo:1:a", method: "pane.report_agent", params: { pane_id: "w1:p2", source: "custom:omo", agent: "omo", seq: 7, state: "working", agent_session_path: "/home/u/.omo/s.jsonl" } }),
  });
  const release = JSON.stringify({ id: "r", method: "pane.release_agent", params: { pane_id: "w1:p2", source: "custom:omo", agent: "omo", seq: 8 } });
  expect(checkHerdrReport(release, "w1:p2")).toEqual({ ok: true, id: "r", request: release });
});

test("another pane, another herdr method, resume_argv, unknown fields and malformed requests are refused", () => {
  const refused = (line: string) => {
    const verdict = checkHerdrReport(line, "w1:p2");
    return verdict.ok ? "forwarded" : verdict.code;
  };
  expect(refused(report({ pane_id: "w1:p1" }))).toBe("forbidden");
  expect(checkHerdrReport(report({}), undefined)).toMatchObject({ ok: false, code: "forbidden" });
  for (const method of ["workspace.list", "server.stop", "layout.apply", "agent.list"]) {
    expect({ method, verdict: refused(report({}, method)) }).toEqual({ method, verdict: "forbidden" });
  }
  // The own pane is never closed, written to or split into by id; a pane the lane did not create is never written to,
  // and its layout changes go on to the socket's tab check.
  const call = (method: string, params: Record<string, unknown>) => refused(JSON.stringify({ id: "q", method, params }));
  const extra: Record<string, Record<string, unknown>> = { "pane.rename": { label: "l" }, "pane.send_input": { text: "x" }, "pane.send_text": { text: "x" } };
  for (const method of ["pane.close", "pane.rename", "pane.zoom", "pane.send_input", "pane.send_text"]) {
    for (const pane_id of ["w1:p2", "w1:p9"]) {
      const verdict = pane_id === "w1:p9" && !method.startsWith("pane.send_") ? "forwarded" : "forbidden";
      expect({ method, pane_id, verdict: call(method, { pane_id, ...extra[method] }) }).toEqual({ method, pane_id, verdict });
    }
  }
  expect(call("pane.split", { target_pane_id: "w1:p9", direction: "right" })).toBe("forbidden");
  expect(call("pane.split", { target_pane_id: "w1:p2", direction: "right", env: { A: "1" } })).toBe("invalid_request");
  expect(call("pane.split", { target_pane_id: "w1:p2", direction: "right", command: "sh" })).toBe("invalid_request");
  expect(call("pane.split", { target_pane_id: "w1:p2", direction: "right", ratio: 0.65, cwd: "/wt", focus: false, right_click: "herdr" })).toBe("forwarded");
  expect(call("pane.report_agent_session", { pane_id: "w1:p2", source: "s", agent: "a", resume_argv: ["sh"] })).toBe("forbidden");
  expect(call("pane.report_metadata", { pane_id: "w1:p1", source: "s", agent: "a", title: "t" })).toBe("forbidden");
  expect(refused(JSON.stringify({ id: "p", method: "ping", params: { x: 1 } }))).toBe("invalid_request");
  expect(refused(report({ resume_argv: ["sh", "-c", "touch /tmp/x"] }))).toBe("forbidden");
  expect(refused(report({ state: "idle" }, "pane.release_agent"))).toBe("invalid_request");
  expect(refused(report({ cwd: "/" }))).toBe("invalid_request");
  expect(refused(report({ state: "done" }))).toBe("invalid_request");
  expect(refused(report({ seq: -1 }))).toBe("invalid_request");
  expect(refused(report({ source: "" }))).toBe("invalid_request");
  expect(refused(report({ agent_session_path: "relative" }))).toBe("invalid_request");
  expect(refused(JSON.stringify({ id: "x", method: "pane.report_agent", params: { pane_id: "w1:p2", source: "s", agent: "a", state: "idle" }, extra: 1 }))).toBe("invalid_request");
  expect(refused(JSON.stringify({ method: "pane.report_agent", params: { pane_id: "w1:p2", source: "s", agent: "a", state: "idle" } }))).toBe("invalid_request");
  expect(refused("not json")).toBe("invalid_request");
  expect(refused("[]")).toBe("invalid_request");
});

test("ping, own-pane session and metadata reports, and reads are forwarded; lane panes are tracked by the caller's map", () => {
  const ok = (line: string, panes?: ReadonlyMap<string, boolean>) => checkHerdrReport(line, "w1:p2", panes).ok;
  expect(ok(JSON.stringify({ id: "p", method: "ping", params: {} }))).toBe(true);
  expect(ok(JSON.stringify({ id: "p", method: "ping" }))).toBe(true);
  const own = { pane_id: "w1:p2", source: "custom:omo", agent: "omo", seq: 1 };
  const send = (method: string, params: Record<string, unknown>) => JSON.stringify({ id: "m", method, params: { ...own, ...params } });
  expect(ok(send("pane.report_agent_session", { agent_session_id: "s1", agent_session_path: "/s.jsonl" }))).toBe(true);
  expect(ok(send("pane.report_metadata", { title: "t", ttl_ms: 5 }))).toBe(true);
  expect(ok(send("pane.report_metadata", { pane_id: "w1:p5", title: "t" }))).toBe(false);
  expect(ok(send("pane.report_metadata", { pane_id: "w1:p5", title: "t" }), new Map([["w1:p5", false]]))).toBe(true);
  expect(ok(JSON.stringify({ id: "g", method: "pane.get", params: { pane_id: "w1:p5" } }))).toBe(true);
  expect(ok(JSON.stringify({ id: "l", method: "pane.list", params: {} }))).toBe(true);
  const lane = new Map([["w1:p5", false]]);
  const input = JSON.stringify({ id: "i", method: "pane.send_input", params: { pane_id: "w1:p5", text: "node v.mjs", keys: ["Enter"] } });
  expect(ok(input)).toBe(false);
  expect(ok(input, lane)).toBe(true);
  expect(ok(JSON.stringify({ id: "i", method: "pane.send_input", params: { pane_id: "w1:p5", text: "x", keys: ["Ctrl-C"] } }), lane)).toBe(false);
  expect(ok(input, new Map([["w1:p5", true]]))).toBe(false);
  const text = JSON.stringify({ id: "t", method: "pane.send_text", params: { pane_id: "w1:p5", text: "y" } });
  expect(ok(text, lane)).toBe(false);
  expect(ok(text, new Map([["w1:p5", true]]))).toBe(true);
});

test("herdr's control socket is found the way its CLI finds it", () => {
  expect(herdrControlSocket({ HERDR_SOCKET_PATH: "/s/h.sock", XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/s/h.sock");
  expect(herdrControlSocket({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/herdr/herdr.sock");
  expect(herdrControlSocket({}, "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
});

/** One request line over the real unix socket at `path`, its reply. */
const ask = async (path: string, line: string): Promise<Record<string, unknown>> => {
  let got = "";
  const { promise, resolve } = Promise.withResolvers<string>();
  const socket = await Bun.connect({
    unix: path,
    socket: { data(_s, chunk) { got += Buffer.from(chunk).toString(); if (got.includes("\n")) resolve(got); }, close() { resolve(got); } },
  });
  socket.write(`${line}\n`);
  const reply = await promise;
  socket.end();
  return JSON.parse(reply) as Record<string, unknown>;
};

/** A herdr control socket that records each request line and answers it ok. */
const fakeHerdr = (dir: string) => {
  const path = join(dir, "herdr.sock");
  const received: string[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        for (const line of Buffer.from(chunk).toString().split("\n").filter(Boolean)) {
          received.push(line);
          socket.write(`${JSON.stringify({ id: (JSON.parse(line) as { id: string }).id, result: { type: "ok" } })}\n`);
        }
      },
    },
  });
  closers.push(() => { server.stop(true); });
  return { path, received };
};

test("a lane's socket relays its own pane's report to herdr and herdr's reply back; a refusal never reaches herdr", async () => {
  const dir = runnerDir();
  const herdr = fakeHerdr(join(dir, ".."));
  const logs: string[] = [];
  const panes: Record<string, string> = { "lane-a": "w1:p2" };
  const sockets = new HerdrReportSockets({ runnerDir: dir, herdrSocket: herdr.path, laneOf: (key) => (panes[key] ? { pane: panes[key] } : undefined), log: (line) => { logs.push(line); } });
  closers.push(() => { sockets.stop(); });
  sockets.open("lane-a");
  const path = herdrReportSocketPath(dir, "lane-a");
  expect(statSync(join(dir, "sock", "herdr.d", "lane-a")).mode & 0o777).toBe(0o700);

  expect(await ask(path, report({}))).toEqual({ id: "custom:omo:1:a", result: { type: "ok" } });
  expect(herdr.received.map((l) => JSON.parse(l) as unknown)).toEqual([
    { id: "custom:omo:1:a", method: "pane.report_agent", params: { pane_id: "w1:p2", source: "custom:omo", agent: "omo", seq: 7, state: "working" } },
  ]);

  expect(await ask(path, report({ pane_id: "w1:p1" }))).toMatchObject({ id: "custom:omo:1:a", error: { code: "forbidden" } });
  expect(await ask(path, JSON.stringify({ id: "z", method: "pane.send_input", params: { pane_id: "w1:p2", text: "rm -rf ~\n" } }))).toMatchObject({ id: "z", error: { code: "forbidden" } });
  expect(herdr.received).toHaveLength(1);
  expect(logs.filter((l) => l.startsWith("HERDR_REPORT_REFUSED lane=lane-a"))).toHaveLength(2);

  // A relaunch moves the lane to a new pane: the socket follows the record, and the old pane is refused.
  panes["lane-a"] = "w1:p9";
  expect(await ask(path, report({}))).toMatchObject({ error: { code: "forbidden" } });

  sockets.close("lane-a");
  expect(existsSync(join(dir, "sock", "herdr.d", "lane-a"))).toBe(false);
});

test("a sandboxed lane runs a command in a pane it split behind its sandbox, and closes only panes of its own tab", async () => {
  const dir = runnerDir();
  const path = join(dir, "..", "herdr-tabs.sock");
  const tabs: Record<string, string> = { "w1:p2": "w1:t1", "w1:p5": "w1:t1", "w1:p6": "w1:t1", "w1:p8": "w1:t9" };
  const received: { method: string; params: Record<string, unknown> }[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        for (const line of Buffer.from(chunk).toString().split("\n").filter(Boolean)) {
          const req = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
          received.push(req);
          const result = req.method === "pane.get" ? { pane: { pane_id: req.params.pane_id, tab_id: tabs[req.params.pane_id as string] } }
            : req.method === "pane.split" ? { pane: { pane_id: "w1:p5", tab_id: "w1:t1" } } : { type: "ok" };
          socket.write(`${JSON.stringify({ id: req.id, result })}\n`);
        }
      },
    },
  });
  closers.push(() => { server.stop(true); });
  const sockets = new HerdrReportSockets({
    runnerDir: dir, herdrSocket: path, log: () => {},
    laneOf: () => ({ pane: "w1:p2", sandbox: true, profile: "sandboxed", sandboxPrefix: "env DORI_LANE_KEY=lane-a lane-sandbox" }),
  });
  closers.push(() => { sockets.stop(); });
  sockets.open("lane-a");
  const lane = herdrReportSocketPath(dir, "lane-a");
  const call = (method: string, params: Record<string, unknown>) => ask(lane, JSON.stringify({ id: "q", method, params }));

  expect(await call("pane.split", { target_pane_id: "w1:p2", direction: "right" })).toMatchObject({ result: { pane: { pane_id: "w1:p5" } } });
  expect(await call("pane.send_input", { pane_id: "w1:p5", text: "node viewer.mjs", keys: ["Enter"] })).toEqual({ id: "q", result: { type: "ok" } });
  expect(received.at(-1)).toMatchObject({ method: "pane.send_input", params: { pane_id: "w1:p5", text: "exec env DORI_LANE_KEY=lane-a lane-sandbox /bin/sh -c 'node viewer.mjs'" } });
  // w1:p6 was split before this runner started: in the lane's tab it may be closed, never written to.
  expect(await call("pane.close", { pane_id: "w1:p6" })).toEqual({ id: "q", result: { type: "ok" } });
  expect(await call("pane.send_text", { pane_id: "w1:p6", text: "x" })).toMatchObject({ error: { code: "forbidden" } });
  expect(await call("pane.close", { pane_id: "w1:p8" })).toMatchObject({ error: { code: "forbidden", message: "only panes in the lane's own tab" } });
  expect(received.filter((r) => r.method === "pane.close").map((r) => r.params.pane_id)).toEqual(["w1:p6"]);
});

test("a report herdr cannot take answers an error instead of hanging the lane", async () => {
  const dir = runnerDir();
  const logs: string[] = [];
  const sockets = new HerdrReportSockets({ runnerDir: dir, herdrSocket: join(dir, "no-herdr.sock"), laneOf: () => ({ pane: "w1:p2" }), log: (line) => { logs.push(line); } });
  closers.push(() => { sockets.stop(); });
  sockets.open("lane-a");
  expect(await ask(herdrReportSocketPath(dir, "lane-a"), report({}))).toMatchObject({ id: "custom:omo:1:a", error: { code: "herdr_unreachable" } });
  expect(logs.filter((l) => l.startsWith("HERDR_REPORT_FAILED lane=lane-a"))).toHaveLength(1);
});

test("a started lane's socket exists before its command runs in the pane and is gone after the lane closes", async () => {
  const dir = runnerDir();
  const path = herdrReportSocketPath(dir, "lane-a");
  let socketAtRun: boolean | undefined;
  const reports: string[] = [];
  const lanes = new RunnerLanes({
    runnerDir: dir, clock: fakeClock(0), token: () => "tok-a", publish: () => {}, instance: async () => "server-1",
    startup: async () => ({ verdict: "ok", detail: "ready" }),
    policy: { agents: { omo: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    herdrReports: { open: (key) => { reports.push(`open ${key}`); mkdirSync(join(path, ".."), { recursive: true }); }, close: (key) => { reports.push(`close ${key}`); rmSync(join(path, ".."), { recursive: true, force: true }); } },
    run: async (argv) => {
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      if (argv.slice(0, 3).join(" ") === "herdr pane run") socketAtRun = existsSync(join(path, ".."));
      if (argv.slice(0, 3).join(" ") === "herdr pane list") return { code: 0, out: JSON.stringify({ result: { panes: [] } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  const files = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };
  await lanes.start({ cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: false, expectedLaneGen: 0, files, tabWorkspace: "w1" });
  expect(socketAtRun).toBe(true);
  await lanes.close("lane-a");
  expect(reports).toEqual(["open lane-a", "close lane-a"]);
  expect(existsSync(join(path, ".."))).toBe(false);
});
