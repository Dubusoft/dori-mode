import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeLaneSocket } from "./fake-lane-socket.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

/** A home with no config and a supervisor state dir that does not exist: lane mode must create and read neither. */
const home = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "f2-cli-"));
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
  return { dir, state: join(dir, "state"), config: join(dir, "config.json") };
};

const cli = async (h: ReturnType<typeof home>, args: string[], env: Record<string, string>) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: h.dir, TMPDIR: process.env.TMPDIR ?? h.dir, DORI_CONFIG: h.config, DORI_STATE_DIR: h.state, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

const inLane = { DORI_LANE_KEY: "demo-lane", DORI_LANE_TOKEN: "tok-demo" };

test("dori report inside a lane sends {kind} over the lane socket and never creates or reads the supervisor's state dir, registry or report store", async () => {
  const h = home();
  const sock = fakeLaneSocket(h.dir);
  cleanups.push(sock.close);
  const r = await cli(h, ["report", "demo-lane", "question", "--text", "which base?"], inLane);
  expect(r.code, r.err).toBe(0);
  expect(r.out).toBe("LANE_REPORTED demo-lane question (through the runner)\n");
  expect(sock.requests).toEqual([{ kind: "question", text: "which base?", key: "demo-lane", token: "tok-demo" }]);
  // Nothing but the runner's socket directory exists under HOME (and bun's own ~/.bun): no state dir, no config, no
  // ~/.dori/state.
  expect(existsSync(h.state)).toBe(false);
  expect(existsSync(h.config)).toBe(false);
  expect(readdirSync(h.dir).filter((name) => name !== ".bun")).toEqual([".dori"]);
  expect(readdirSync(join(h.dir, ".dori"))).toEqual(["runner"]);
  expect(readdirSync(join(h.dir, ".dori", "runner"))).toEqual(["sock"]);
});

test("a supervisor state dir and config nobody may read do not stop a lane's report (lane mode opens neither)", async () => {
  const h = home();
  mkdirSync(h.state);
  writeFileSync(join(h.state, "supervisor.json"), "{}");
  writeFileSync(h.config, "{}");
  chmodSync(h.config, 0o000);
  chmodSync(h.state, 0o000);
  cleanups.push(() => { chmodSync(h.state, 0o700); chmodSync(h.config, 0o600); });
  const sock = fakeLaneSocket(h.dir);
  cleanups.push(sock.close);
  const r = await cli(h, ["report", "demo-lane", "done", "--text", "merged", "--evidence", "sha abc\nPR #4"], inLane);
  expect(r.code, r.err).toBe(0);
  expect(sock.requests).toEqual([{ kind: "done", text: "merged", evidence: "sha abc\nPR #4", key: "demo-lane", token: "tok-demo" }]);
});

test("claim-done, report ack and lane status inside a lane are lane socket verbs for the lane's own key", async () => {
  const h = home();
  const sock = fakeLaneSocket(h.dir, (req) => (req.kind === "status" ? { ok: true, status: "not-done", objection: { at: "t", reasons: ["CI red"] }, claim: null } : { ok: true }));
  cleanups.push(sock.close);
  expect((await cli(h, ["claim-done", "demo-lane", "--evidence", "merged acme/app#1"], inLane)).code).toBe(0);
  expect((await cli(h, ["report", "ack", "msg-1"], inLane)).out).toBe("LANE_ACKED demo-lane msg-1\n");
  const status = await cli(h, ["lane", "status"], inLane);
  expect(JSON.parse(status.out)).toEqual({ status: "not-done", objection: { at: "t", reasons: ["CI red"] }, claim: null });
  expect(sock.requests.map((r) => r.kind)).toEqual(["done", "ack", "status"]);
  expect(sock.requests[1]).toEqual({ kind: "ack", id: "msg-1", key: "demo-lane", token: "tok-demo" });
  const other = await cli(h, ["claim-done", "other-lane", "--evidence", "x"], inLane);
  expect(other.code).toBe(1);
  expect(other.err).toContain("LANE_PERMISSION_DENIED lane demo-lane may report only for itself, not other-lane");
  expect(sock.requests).toHaveLength(3);
  expect(existsSync(h.state)).toBe(false);
});

test("a lane's report and claim-done reach a runner restarted under it: the new socket at the same path answers", async () => {
  const h = home();
  const before = fakeLaneSocket(h.dir);
  expect((await cli(h, ["report", "demo-lane", "progress", "--text", "before"], inLane)).code).toBe(0);
  // A restart: the old listener goes away with its socket file, and the new runner binds a fresh one at the same path.
  before.close();
  const after = fakeLaneSocket(h.dir);
  cleanups.push(after.close);
  const report = await cli(h, ["report", "demo-lane", "progress", "--text", "after"], inLane);
  expect(report.code, report.err).toBe(0);
  const claim = await cli(h, ["claim-done", "demo-lane", "--evidence", "merged acme/app#1"], inLane);
  expect(claim.code, claim.err).toBe(0);
  expect(after.requests.map((r) => r.kind)).toEqual(["progress", "done"]);
});

test("a lane that cannot connect to sock/lane.d/lane (a sandbox set up before lane.d) reports over the pre-lane.d sock/lane", async () => {
  const h = home();
  const sock = fakeLaneSocket(h.dir, undefined, true);
  cleanups.push(sock.close);
  const r = await cli(h, ["report", "demo-lane", "progress", "--text", "old sandbox"], inLane);
  expect(r.code, r.err).toBe(0);
  expect(sock.requests.map((q) => q.text)).toEqual(["old sandbox"]);
});

test("a multi-line --text keeps its newlines on the way to the runner", async () => {
  const h = home();
  const sock = fakeLaneSocket(h.dir);
  cleanups.push(sock.close);
  const r = await cli(h, ["report", "demo-lane", "progress", "--text", "line one\nline two"], inLane);
  expect(r.code, r.err).toBe(0);
  expect(sock.requests[0]?.text).toBe("line one\nline two");
});
