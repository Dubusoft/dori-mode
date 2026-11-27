import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enrollRunner, RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { RunnerHub } from "../src/runner/hub.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { LANE_SOCKET, serveLaneSocket } from "../src/runner/lane-socket.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { remoteToodoReader } from "../src/runner/remote-secrets.ts";
import { supervisorGranter, supervisorSecretHandler } from "../src/runner/secret-serve.ts";
import { acceptRunners } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { connectUnix, listenUnix } from "../src/runner/unix-transport.ts";
import { realClock } from "../src/run.ts";
import { laneToodoReader } from "../src/toodo-lane-read.ts";
import { withState } from "./fakes.ts";
import { fakeToodo } from "./support/fake-toodo.ts";

/**
 * A lane's `dori toodo` with real parts: the lane CLI, the real lane socket, and for a remote runner enrollment, the
 * signed handshake and sealed frames into `acceptRunners` with `supervisorSecretHandler`. Only toodo-server (fake-toodo)
 * and the registry are fakes.
 */

const LABEL = "r1";
const OWNERS: Record<string, string> = { "ap-10-1": LABEL, "ap-12-1": "r2" };
const TOKENS: Record<string, string> = { "ap-10-1": "token-a-0123456789", "ap-12-1": "token-b-0123456789" };

let tmp: ReturnType<typeof withState>;
const cleanups: (() => void)[] = [];
beforeEach(() => { tmp = withState(); });
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); tmp.done(); });

const tap = (t: Transport, wire: string[]): Transport => ({
  send: (line) => { wire.push(line); t.send(line); },
  onLine: (handler) => t.onLine((line) => { wire.push(line); handler(line); }),
  onClose: (handler) => t.onClose(handler),
  close: (reason) => { t.close(reason); },
  get open() { return t.open; },
});

const toodoOf = () => {
  const tokenFile = join(tmp.dir, "web-token");
  writeFileSync(tokenFile, "web-token-value\n");
  return fakeToodo(tokenFile);
};

const laneRun = async (lanePath: string, key: string, args: readonly string[]) => {
  mkdirSync(join(tmp.dir, "lane"), { recursive: true });
  const tokenFile = join(tmp.dir, "lane", `${key}.token`);
  writeFileSync(tokenFile, `${TOKENS[key]}\n`, { mode: 0o600 });
  const out: string[] = [];
  const err: string[] = [];
  const code = await laneCliMain(["toodo", ...args], {
    env: { DORI_LANE_KEY: key, DORI_LANE_TOKEN_FILE: tokenFile }, connect: connectUnix(lanePath),
    out: (l) => { out.push(l); }, err: (l) => { err.push(l); },
  });
  return { code, out, err };
};

/** A remote-style runner enrolled with the supervisor; its lane socket asks the supervisor for every Toodo read. */
const remote = async () => {
  const supDir = join(tmp.dir, "sup");
  const runnerDir = join(tmp.dir, "runner");
  for (const d of [supDir, runnerDir, join(runnerDir, "sock")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  const wire: string[] = [];
  const toodo = toodoOf();
  const auth = new SupervisorAuth(supDir, { now: realClock.now });
  const hub = new RunnerHub({ stateDir: supDir, now: realClock.now, monotonic: () => performance.now(), epoch: 2, commit: () => true });
  const controlPath = join(supDir, "control");
  const listener = listenUnix(controlPath);
  const handler = supervisorSecretHandler({
    laneOwner: (key) => OWNERS[key],
    runnerUnsandboxed: () => false,
    granter: supervisorGranter({ store: { readAll: async () => new Map(), read: async () => "" } }),
    toodoReader: laneToodoReader({ client: toodo.client, log }),
    log,
  });
  const stopAccept = acceptRunners(hub, listener, { auth, log, onSecret: (label, frame, ctx) => { void handler(label, frame, ctx); } });
  cleanups.push(() => { stopAccept(); listener.close(); hub.close(); auth.close(); });

  const unix = connectUnix(controlPath);
  const connect: Connector = async () => tap(await unix(), wire);
  const runnerAuth = new RunnerAuth(runnerDir);
  expect((await enrollRunner({ auth: runnerAuth, connect, code: auth.issueCode(LABEL).code, label: LABEL, hostId: "host-1", expectedFingerprint: auth.fingerprint })).ok).toBe(true);
  const state = new RunnerState(runnerDir, { now: realClock.now });
  state.boot();
  const outbox = new Outbox(runnerDir, { now: realClock.now });
  const client = new RunnerClient({ label: LABEL, hostId: "host-1" }, { connect, outbox, state, clock: realClock, auth: runnerAuth, log });
  expect(await client.connectOnce()).toMatchObject({ ok: true });
  cleanups.push(() => { client.rehello(); outbox.close(); state.close(); });

  const lanePath = join(runnerDir, "sock", LANE_SOCKET);
  const laneListener = listenUnix(lanePath);
  const stopLane = serveLaneSocket(laneListener, { tokenFor: (key, token) => TOKENS[key] === token, toodoRead: remoteToodoReader({ client }) },
    () => { throw new Error("nothing is published in this test"); }, log);
  cleanups.push(() => { stopLane(); laneListener.close(); });
  return { lanePath, wire, logs, toodo };
};

const local = () => {
  const toodo = toodoOf();
  const lanePath = join(tmp.dir, "local-lane.sock");
  const listener = listenUnix(lanePath);
  const stop = serveLaneSocket(listener, { tokenFor: (key, token) => TOKENS[key] === token, toodoRead: laneToodoReader({ client: toodo.client, log: () => {} }) },
    () => { throw new Error("nothing is published in this test"); }, () => {});
  cleanups.push(() => { stop(); listener.close(); });
  return { lanePath, toodo };
};

const frames = (wire: readonly string[], type: string) => wire.map((l) => JSON.parse(l) as { type: string; body: Record<string, unknown> }).filter((f) => f.type === type);

describe("lane Toodo reads end to end", () => {
  test("a remote lane reads its task through a sealed toodo.read, and the task text never crosses the link in clear", async () => {
    const s = await remote();
    const run = await laneRun(s.lanePath, "ap-10-1", ["get"]);
    expect(run.err).toEqual([]);
    expect(run.code).toBe(0);
    const value = JSON.parse(run.out.join("\n")) as { task: { id: number; title: string }; related: { id: number }[] };
    expect(value.task).toMatchObject({ id: 10, title: "Lane task alpha" });
    expect(value.related.map((t) => t.id)).toEqual([20]);
    expect(frames(s.wire, "toodo.read")[0]?.body).toMatchObject({ key: "ap-10-1", op: "get" });
    expect(frames(s.wire, "toodo.read.result")[0]?.body).toMatchObject({ ok: true, sealed: { n: expect.any(String), c: expect.any(String) } });
    for (const line of s.wire) expect(line).not.toContain("Lane task alpha");
  });

  test("a remote lane is refused a task out of its scope, and a lane of another runner is refused as forged", async () => {
    const s = await remote();
    const out = await laneRun(s.lanePath, "ap-10-1", ["get", "30"]);
    expect(out.code).toBe(1);
    expect(out.err[0]).toStartWith("TOODO_LANE_OUT_OF_SCOPE #30 is in another workspace");
    const forged = await laneRun(s.lanePath, "ap-12-1", ["get"]);
    expect(forged.code).toBe(1);
    expect(forged.err).toEqual([`RUNNER_SECRET_DENIED ap-12-1 is not a lane of runner ${LABEL}`]);
    expect(s.logs).toContain(`RUNNER_FORGED_SECRET runner=${LABEL} key=ap-12-1`);
  });

  test("a local lane searches its workspace and reads its guidelines", async () => {
    const s = local();
    const found = await laneRun(s.lanePath, "ap-10-1", ["search", "alpha"]);
    expect(found.code).toBe(0);
    expect((JSON.parse(found.out.join("\n")) as { tasks: { id: number }[] }).tasks.map((t) => t.id)).toEqual([12, 10]);
    const rules = await laneRun(s.lanePath, "ap-10-1", ["guidelines"]);
    expect(rules.code).toBe(0);
    expect(JSON.parse(rules.out.join("\n"))).toMatchObject({ workspaceId: 1, guidelines: [{ body: "Reply in Korean" }] });
  });

  test("a lane cannot write: write subcommands are usage errors and a raw write request is refused before toodo-server", async () => {
    const s = local();
    for (const args of [["complete", "10"], ["update", "10"], ["create", "x"], ["start", "10"], ["get", "10", "--status", "done"], []]) {
      const run = await laneRun(s.lanePath, "ap-10-1", args);
      expect(run.code).toBe(2);
      expect(run.err[0]).toStartWith("usage: dori toodo get");
    }
    const link = await connectUnix(s.lanePath)();
    const reply = new Promise<string>((resolve) => { link.onLine(resolve); });
    link.send(`${JSON.stringify({ kind: "toodo", key: "ap-10-1", token: TOKENS["ap-10-1"], op: "update_task", id: 10 })}\n`);
    expect(JSON.parse(await reply)).toEqual({ ok: false, code: "RUNNER_LANE_BAD_REQUEST", detail: "toodo is read-only: op get [id], search with a query, or guidelines" });
    link.close("done");
    expect(s.toodo.paths).toEqual([]);
  });
});
