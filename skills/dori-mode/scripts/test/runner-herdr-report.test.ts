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
  for (const method of ["pane.send_input", "pane.close", "workspace.list", "server.stop", "pane.report_metadata", "pane.report_agent_session"]) {
    expect({ method, verdict: refused(report({}, method)) }).toEqual({ method, verdict: "forbidden" });
  }
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
  const sockets = new HerdrReportSockets({ runnerDir: dir, herdrSocket: herdr.path, paneOf: (key) => panes[key], log: (line) => { logs.push(line); } });
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

test("a report herdr cannot take answers an error instead of hanging the lane", async () => {
  const dir = runnerDir();
  const logs: string[] = [];
  const sockets = new HerdrReportSockets({ runnerDir: dir, herdrSocket: join(dir, "no-herdr.sock"), paneOf: () => "w1:p2", log: (line) => { logs.push(line); } });
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
