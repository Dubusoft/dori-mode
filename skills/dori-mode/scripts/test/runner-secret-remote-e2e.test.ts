import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretStoreError } from "../src/secret-store.ts";
import { enrollRunner, RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { RunnerHub } from "../src/runner/hub.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { LANE_SOCKET, serveLaneSocket } from "../src/runner/lane-socket.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { remoteSecretGranter } from "../src/runner/remote-secrets.ts";
import { supervisorGranter, supervisorSecretHandler } from "../src/runner/secret-serve.ts";
import { acceptRunners } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { connectUnix, listenUnix } from "../src/runner/unix-transport.ts";
import { realClock } from "../src/run.ts";
import { withState } from "./fakes.ts";

/**
 * The whole remote secret path with real parts: enrollment and the signed handshake (SupervisorAuth/RunnerAuth) over
 * a real unix socket into `acceptRunners` with `supervisorSecretHandler`, a real `RunnerClient` with real state and
 * outbox files, the real lane socket with `remoteSecretGranter`, and `laneCliMain secret env` exporting into a real shell.
 * Only the registry, the store are fakes. Every line on the runner<->supervisor link, every log
 * line and every file under both state directories is checked for the throwaway value.
 */

const LABEL = "r1";
const HOST = "host-1";
const VALUE = "dori-test-throwaway-123";
const STORE: Record<string, string> = { API_TOKEN: VALUE, OTHER_TOKEN: VALUE };
/** The supervisor's registry: lane-b exists but belongs to another runner. */
const OWNERS: Record<string, string> = { "lane-a": LABEL, "lane-b": "r2" };
const TOKENS: Record<string, string> = { "lane-a": "token-a-0123456789", "lane-b": "token-b-0123456789" };

let tmp: ReturnType<typeof withState>;
const cleanups: (() => void)[] = [];
beforeEach(() => { tmp = withState(); });
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); tmp.done(); });

/** Records every line sent and received on `t`: the exact text the socket carries (one frame per line). */
const tap = (t: Transport, wire: string[]): Transport => ({
  send: (line) => { wire.push(line); t.send(line); },
  onLine: (handler) => t.onLine((line) => { wire.push(line); handler(line); }),
  onClose: (handler) => t.onClose(handler),
  close: (reason) => { t.close(reason); },
  get open() { return t.open; },
});

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));

/** Supervisor and enrolled remote-style runner over the control socket, plus the runner's lane socket. */
const system = async () => {
  const supDir = join(tmp.dir, "sup");
  const runnerDir = join(tmp.dir, "runner");
  for (const d of [supDir, runnerDir, join(runnerDir, "sock"), join(tmp.dir, "lane")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  const wire: string[] = [];

  const auth = new SupervisorAuth(supDir, { now: realClock.now });
  const hub = new RunnerHub({ stateDir: supDir, now: realClock.now, monotonic: () => performance.now(), epoch: 2, commit: () => true });
  const controlPath = join(supDir, "control");
  const listener = listenUnix(controlPath);
  const handled: Promise<void>[] = [];
  const handler = supervisorSecretHandler({
    laneOwner: (key) => OWNERS[key],
    runnerUnsandboxed: () => false,
    granter: supervisorGranter({
      store: { readAll: async () => new Map(Object.entries(STORE)), read: async (name) => { if (!Object.hasOwn(STORE, name)) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING ${name}`); return STORE[name] as string; } },
    }),
    log,
  });
  const stopAccept = acceptRunners(hub, listener, { auth, log, onSecret: (label, frame, ctx) => { handled.push(handler(label, frame, ctx)); } });
  cleanups.push(() => { stopAccept(); listener.close(); hub.close(); auth.close(); });

  const unix = connectUnix(controlPath);
  const connect: Connector = async () => tap(await unix(), wire);
  const runnerAuth = new RunnerAuth(runnerDir);
  const enrolled = await enrollRunner({ auth: runnerAuth, connect, code: auth.issueCode(LABEL).code, label: LABEL, hostId: HOST, expectedFingerprint: auth.fingerprint });
  expect(enrolled.ok).toBe(true);
  const state = new RunnerState(runnerDir, { now: realClock.now });
  state.boot();
  const outbox = new Outbox(runnerDir, { now: realClock.now });
  const client = new RunnerClient({ label: LABEL, hostId: HOST }, { connect, outbox, state, clock: realClock, auth: runnerAuth, log });
  expect(await client.connectOnce()).toMatchObject({ ok: true });
  cleanups.push(() => { client.rehello(); outbox.close(); state.close(); });

  const lanePath = join(runnerDir, "sock", LANE_SOCKET);
  const laneListener = listenUnix(lanePath);
  const masked: string[] = [];
  const stopLane = serveLaneSocket(laneListener, {
    tokenFor: (key, token) => TOKENS[key] === token,
    secrets: remoteSecretGranter({ client, laneRepo: async () => undefined, log, onGranted: (v) => { masked.push(...v); } }),
  }, () => { throw new Error("nothing is published in this test"); }, log);
  cleanups.push(() => { stopLane(); laneListener.close(); });

  /** Pull the environment as the authenticated lane. */
  const lane = async (key: string, token: string, env: Record<string, string> = {}) => {
    const tokenFile = join(tmp.dir, "lane", `${key}.token`);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const out: string[] = [];
    const err: string[] = [];
    const code = await laneCliMain(["secret", "env"], {
      env: { PATH: process.env.PATH, DORI_LANE_KEY: key, DORI_LANE_TOKEN_FILE: tokenFile, ...env },
      connect: connectUnix(lanePath), out: (l) => { out.push(l); }, err: (l) => { err.push(l); }, runnerDir,
    });
    logs.push(...err);
    return { code, out, err };
  };

  /** Nothing anywhere carries the value: the wire, every log line, every file of both sides (sqlite, WAL, keys). */
  const leakCheck = async (): Promise<void> => {
    await Promise.all(handled);
    expect(wire.length).toBeGreaterThan(0);
    for (const line of wire) expect(line).not.toContain(VALUE);
    for (const line of logs) expect(line).not.toContain(VALUE);
    for (const file of [...filesUnder(runnerDir), ...filesUnder(supDir)]) {
      if (statSync(file).isFile()) expect(readFileSync(file).includes(VALUE)).toBe(false);
    }
  };
  return { lane, leakCheck, wire, logs, masked, handled, runnerDir, supDir };
};

const secretFrames = (wire: readonly string[], type: string) => wire.map((l) => JSON.parse(l) as { type: string; body: Record<string, unknown> }).filter((f) => f.type === type);

describe("remote secrets end to end", () => {
  test("all values reach the lane environment and only sealed boxes cross the link", async () => {
    const s = await system();
    const result = await s.lane("lane-a", TOKENS["lane-a"]!);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([`export API_TOKEN='${VALUE}'`, `export OTHER_TOKEN='${VALUE}'`]);
    const child = Bun.spawn(["sh", "-c", result.out.join("\n") + `; sh -c 'test "$API_TOKEN" = "$EXPECTED" && test "$OTHER_TOKEN" = "$EXPECTED"'`], { env: { ...process.env, EXPECTED: VALUE }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(secretFrames(s.wire, "secret.get")[0]?.body).toMatchObject({ key: "lane-a", names: [] });
    expect(secretFrames(s.wire, "secret.value")[0]?.body).toMatchObject({ ok: true, sealed: { n: expect.any(String), c: expect.any(String) } });
    expect(s.masked).toEqual([VALUE, VALUE]);
    await s.leakCheck();
  });

  test("another lane's token is RUNNER_LANE_AUTH_FAILED and nothing reaches the supervisor", async () => {
    const s = await system();
    const marker = join(tmp.dir, "ran");
    const run = await s.lane("lane-a", TOKENS["lane-b"] as string);
    expect(run.code).toBe(1);
    expect(run.err).toEqual(["RUNNER_LANE_AUTH_FAILED not lane-a's lane token"]);
    expect(existsSync(marker)).toBe(false);
    expect(secretFrames(s.wire, "secret.get")).toEqual([]);
    await s.leakCheck();
  });

  test("a lane the registry gives to another runner is refused by the supervisor as forged", async () => {
    const s = await system();
    const marker = join(tmp.dir, "ran");
    const run = await s.lane("lane-b", TOKENS["lane-b"] as string);
    expect(run.code).toBe(1);
    expect(run.err).toEqual([`RUNNER_SECRET_DENIED lane-b is not a lane of runner ${LABEL}`]);
    expect(existsSync(marker)).toBe(false);
    expect(s.logs).toContain(`RUNNER_FORGED_SECRET runner=${LABEL} key=lane-b`);
    await s.leakCheck();
  });
});
