import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { enrollRunner, RunnerAuth } from "../src/runner/auth.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { readRunnerRows, resetRunnerGen } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import type { AnyRunnerEvent, RunnerEventBodies } from "../src/runner/protocol.ts";
import {
  commandDispatcher, drainRunnerAdmin, parseEnrollInput, queueRunnerAdmin, runnerAdminResult,
} from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Connector } from "../src/runner/transport.ts";
import { connectUnix, controlSocketPath } from "../src/runner/unix-transport.ts";
import { connectWs } from "../src/runner/ws-transport.ts";
import { openRunnerHub } from "../src/supervise-loop.ts";
import { fakeClock, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

/** A promise that resolves the first time `match` sees a value. */
const waiter = <T>() => {
  const waiting: { match: (value: T) => boolean; resolve: (value: T) => void }[] = [];
  return {
    see(value: T) { for (const w of waiting.splice(0)) if (w.match(value)) w.resolve(value); else waiting.push(w); },
    when: (match: (value: T) => boolean) => new Promise<T>((resolve) => { waiting.push({ match, resolve }); }),
  };
};

/** A runner process's pieces in its own directory: keys, state (booted once), outbox, and a client with the dispatcher. */
const runnerAt = (dir: string, label: string, hostId: string, connect: Connector, clock: ReturnType<typeof fakeClock>) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const auth = new RunnerAuth(dir);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  cleanups.push(() => { outbox.close(); state.close(); });
  const logs: string[] = [];
  const client: RunnerClient = new RunnerClient({ label, hostId }, {
    connect, outbox, state, clock, auth, log: (line) => { logs.push(line); },
    onCommand: (c) => dispatch(c), onInvalidCommand: (c) => dispatch(c),
  });
  const dispatch = commandDispatcher({
    state, policy: DEFAULT_POLICY, realpath: (p) => p, log: (line) => { logs.push(line); },
    publish: (body) => { client.publish("cmd.result", body); },
  });
  return { auth, state, outbox, client, logs };
};

test("enroll over the unix socket, connect, a policy-rejected command answers RUNNER_CMD_REJECTED, then gen fencing, rotate and revoke", async () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const stateDir = join(tmp.dir, "state");
  const runnerDir = join(tmp.dir, "runner");
  const clock = fakeClock(Date.parse("2026-11-05T00:00:00Z"));
  const logs = waiter<string>();
  const events = waiter<{ label: string; frame: AnyRunnerEvent }>();
  const lines: string[] = [];
  const handle = openRunnerHub(stateDir, runnerDir, clock.now, clock.now, (line) => { lines.push(line); logs.see(line); }, {
    hostId: "host-a", onEvent: (label, frame) => { events.see({ label, frame }); },
  });
  cleanups.push(() => handle.close());
  expect(lines).toContain("RUNNER_ENROLLED runner=local hostId=host-a local");

  // Authentication is always on: a runner that never enrolled is refused, and so is a hello without the handshake,
  // even for the enrolled local label.
  const connect = connectUnix(controlSocketPath(runnerDir));
  const stranger = runnerAt(join(tmp.dir, "stranger"), "stranger", "host-x", connect, clock);
  expect(await stranger.client.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_AUTH_FAILED" });
  const bare = new RunnerClient({ label: "local", hostId: "host-a" }, { connect, outbox: stranger.outbox, state: stranger.state, clock });
  expect(await bare.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_AUTH_FAILED" });
  expect(readRunnerRows(stateDir).map((r) => r.label)).toEqual([]);

  // `dori runner enroll --machine lab` output, as the runner reads it from stdin.
  const issued = handle.auth.issueCode("lab");
  const input = parseEnrollInput(`code=${issued.code}\nfingerprint=${handle.auth.fingerprint}\n`);
  expect(input).toEqual({ code: issued.code, fingerprint: handle.auth.fingerprint });
  const lab = runnerAt(join(tmp.dir, "lab"), "lab", "host-b", connect, clock);
  const enrolled = await enrollRunner({
    auth: lab.auth, connect, code: input?.code as string, label: "lab", hostId: "host-b", expectedFingerprint: input?.fingerprint as string,
  });
  expect(enrolled).toEqual({ ok: true, supervisorFingerprint: handle.auth.fingerprint });
  expect(handle.auth.key("lab")?.hostId).toBe("host-b");

  expect(await lab.client.connectOnce()).toEqual({ ok: true, eventAck: 0, replayed: 0 });
  expect(handle.accept.connected("lab")).toBe(true);

  // Default policy: no allowed roots, so a job's cwd is refused before anything runs; a lane command has no effect yet.
  const rejected = events.when((e) => e.frame.type === "cmd.result" && e.frame.body.cmdId === "job-1");
  expect(handle.accept.command("lab", "job.run", {
    cmdId: "job-1", opKey: "op-1", name: "build", command: ["true"], cwd: "/srv/elsewhere", timeoutSec: 5, heavy: false,
  })).toBe(1);
  const first = (await rejected).frame.body as RunnerEventBodies["cmd.result"];
  expect(first).toEqual({ cmdId: "job-1", cmdSeq: 1, state: "failed", detail: "RUNNER_CMD_REJECTED cwd-outside-roots" });
  const unsupported = events.when((e) => e.frame.type === "cmd.result" && e.frame.body.cmdId === "obs-1");
  handle.accept.command("lab", "lane.observe", { cmdId: "obs-1", key: "demo" });
  expect(((await unsupported).frame.body as RunnerEventBodies["cmd.result"]).detail).toBe("RUNNER_CMD_UNSUPPORTED lane.observe");
  expect(lab.state.cmdAck()).toBe(2);
  expect(lab.state.command("job-1")?.state).toBe("failed");

  // A second process with the same gen while the first is connected is a duplicate; a restart (higher gen) replaces it.
  const twin = new RunnerClient({ label: "lab", hostId: "host-b" }, { connect, outbox: lab.outbox, state: lab.state, clock, auth: lab.auth });
  expect(await twin.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_CONFLICT" });
  lab.state.boot();
  const replaced = logs.when((line) => line.startsWith("RUNNER_REPLACED runner=lab"));
  expect(await twin.connectOnce()).toMatchObject({ ok: true });
  expect(await replaced).toBe("RUNNER_REPLACED runner=lab gen=1->2");

  // dori runner reset-gen: the stored maxGen is forgotten, the hostId kept.
  expect(resetRunnerGen(stateDir, "lab")).toBe(true);
  expect(readRunnerRows(stateDir).find((r) => r.label === "lab")).toMatchObject({ hostId: "host-b", maxGen: 0 });
  expect(resetRunnerGen(stateDir, "nobody")).toBe(false);

  // dori runner rotate / revoke go through the queue the supervisor's runners task drains.
  const before = handle.auth.key("lab")?.pubKey;
  const rotated = logs.when((line) => line.startsWith("RUNNER_KEY_ROTATED runner=lab"));
  const rotateId = queueRunnerAdmin(stateDir, "rotate", "lab", clock.now());
  expect(runnerAdminResult(stateDir, rotateId)).toBeUndefined();
  expect(drainRunnerAdmin(stateDir, handle.accept, clock.now())).toEqual([`RUNNER_ADMIN op=rotate runner=lab result=sent cmdId=rotate:lab:3`]);
  await rotated;
  expect(handle.auth.key("lab")?.pubKey).not.toBe(before);
  expect(runnerAdminResult(stateDir, rotateId)).toBe("sent cmdId=rotate:lab:3");

  const gone = logs.when((line) => line === "RUNNER_DISCONNECTED runner=lab");
  queueRunnerAdmin(stateDir, "revoke", "lab", clock.now());
  expect(drainRunnerAdmin(stateDir, handle.accept, clock.now())).toEqual(["RUNNER_ADMIN op=revoke runner=lab result=revoked"]);
  await gone;
  expect(await twin.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_REVOKED" });

  // A request nobody took in time is answered expired.
  const late = queueRunnerAdmin(stateDir, "rotate", "lab", clock.now());
  clock.at += 3 * 60_000;
  drainRunnerAdmin(stateDir, handle.accept, clock.now());
  expect(runnerAdminResult(stateDir, late)).toBe("expired");
});

test("a runner over WebSocket on 127.0.0.1 enrolls, connects and shows in readRunnerRows", async () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const stateDir = join(tmp.dir, "state");
  const clock = fakeClock(Date.parse("2026-11-05T00:00:00Z"));
  const lines: string[] = [];
  const handle = openRunnerHub(stateDir, join(tmp.dir, "runner"), clock.now, clock.now, (line) => { lines.push(line); }, {
    hostId: "host-a", listen: "127.0.0.1:0",
  });
  cleanups.push(() => handle.close());
  const port = handle.network?.port;
  expect(port).toBeGreaterThan(0);
  expect(lines.some((line) => line.startsWith("RUNNER_HUB_READY ") && line.endsWith(` listen=127.0.0.1:${port}`))).toBe(true);

  const connect = connectWs(`ws://127.0.0.1:${port}`);
  const remote = runnerAt(join(tmp.dir, "remote"), "remote", "host-r", connect, clock);
  // Not enrolled yet: the network listener refuses it as the local socket does.
  expect(await remote.client.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_AUTH_FAILED" });
  const { code } = handle.auth.issueCode("remote");
  expect(await enrollRunner({ auth: remote.auth, connect, code, label: "remote", hostId: "host-r", expectedFingerprint: handle.auth.fingerprint }))
    .toMatchObject({ ok: true });
  expect(await remote.client.connectOnce()).toMatchObject({ ok: true });
  expect(readRunnerRows(stateDir).find((row) => row.label === "remote")).toMatchObject({ hostId: "host-r", maxGen: 1 });
});

test("the dispatcher answers a schema failure and a stale epoch, and runs nothing twice", () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const clock = fakeClock(1_000);
  const dir = join(tmp.dir, "r");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = new RunnerState(dir, { now: clock.now });
  cleanups.push(() => state.close());
  const published: RunnerEventBodies["cmd.result"][] = [];
  const logs: string[] = [];
  const dispatch = commandDispatcher({ state, policy: DEFAULT_POLICY, realpath: (p) => p, log: (l) => { logs.push(l); }, publish: (b) => { published.push(b); } });
  const head = { v: 1, runner: "r", gen: 1 };

  dispatch({ ...head, epoch: 4, cmdSeq: 1, type: "lane.observe", body: { cmdId: "a", key: "k", extra: true } });
  state.observeEpoch(5);
  dispatch({ ...head, epoch: 4, cmdSeq: 2, type: "lane.observe", body: { cmdId: "b", key: "k" } });
  dispatch({ ...head, epoch: 4, cmdSeq: 2, type: "lane.observe", body: { cmdId: "b", key: "k" } });
  dispatch({ ...head, epoch: 4, type: "lane.observe", body: { key: "k" } });

  expect(published.map((p) => [p.cmdId, p.state, p.detail.split(" ").slice(0, 2).join(" ")])).toEqual([
    ["a", "failed", "RUNNER_CMD_REJECTED unknown-field"],
    ["b", "failed", "RUNNER_CMD_REJECTED stale-epoch"],
  ]);
  expect(state.cmdAck()).toBe(2);
  expect(logs).toContain("RUNNER_CMD_DROPPED type=lane.observe no cmdId or cmdSeq to answer");
});
