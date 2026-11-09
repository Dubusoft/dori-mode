import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { enrollRunner, RunnerAuth } from "../src/runner/auth.ts";
import { CALL_TIMEOUT_MS, COMMAND_TIMEOUTS, NEEDS_PROTO, newCmdId, QUERY_TIMEOUT_MS, RunnerUnavailable } from "../src/runner/call.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { readRunnerRows, resetRunnerGen } from "../src/runner/hub.ts";
import { writeRunnerEndpoint } from "../src/runner/endpoints.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import type { AnyRunnerEvent, RunnerEventBodies } from "../src/runner/protocol.ts";
import {
  commandDispatcher, drainRunnerAdmin, parseEnrollInput, queueRunnerAdmin, runnerAdminResult,
} from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";
import { connectUnix, controlSocketPath } from "../src/runner/unix-transport.ts";
import { acceptWs } from "../src/runner/ws-transport.ts";
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
  const revoked: string[] = [];
  expect(drainRunnerAdmin(stateDir, handle.accept, clock.now(), (label) => { revoked.push(label); })).toEqual(["RUNNER_ADMIN op=revoke runner=lab result=revoked"]);
  expect(revoked).toEqual(["lab"]);
  await gone;
  expect(await twin.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_REVOKED" });

  // A request nobody took in time is answered expired.
  const late = queueRunnerAdmin(stateDir, "rotate", "lab", clock.now());
  clock.at += 3 * 60_000;
  drainRunnerAdmin(stateDir, handle.accept, clock.now(), (label) => { revoked.push(label); });
  expect(runnerAdminResult(stateDir, late)).toBe("expired");
  expect(revoked).toEqual(["lab"]);
});

test("the supervisor discovers a listening worker, authenticates its real WebSocket hello and redials after a drop", async () => {
  const tmp = withState();
  cleanups.push(tmp.done);
  const stateDir = join(tmp.dir, "state");
  const clock = fakeClock(Date.parse("2026-11-05T00:00:00Z"));
  const lines: string[] = [];
  const worker = acceptWs("127.0.0.1:0");
  cleanups.push(() => worker.close());
  const scheduled: { fn: () => void; ms: number }[] = [];
  let retryReady: ((fn: () => void) => void) | undefined;
  const retry = (): Promise<() => void> => {
    const index = scheduled.findIndex((t) => t.ms === 1000);
    if (index >= 0) return Promise.resolve(scheduled.splice(index, 1)[0]!.fn);
    return new Promise((resolve) => { retryReady = resolve; });
  };
  const handle = openRunnerHub(stateDir, join(tmp.dir, "runner"), clock.now, clock.now, (line) => { lines.push(line); }, {
    hostId: "host-a", network: {
      random: () => 0.5, refreshMs: 60_000,
      timers: {
        set(fn, ms) {
          const timer = { fn, ms };
          if (ms === 1000 && retryReady) { const resolve = retryReady; retryReady = undefined; resolve(fn); }
          else scheduled.push(timer);
          return timer;
        },
        clear(timer) { const index = scheduled.indexOf(timer as typeof scheduled[number]); if (index >= 0) scheduled.splice(index, 1); },
      },
    },
  });
  cleanups.push(() => handle.close());
  expect(worker.port).toBeGreaterThan(0);
  expect(lines.some((line) => line.startsWith("RUNNER_HUB_READY ") && line.endsWith(" network=dial"))).toBe(true);

  let link: Transport | undefined;
  const connect: Connector = async () => (link = await worker.connect());
  const remote = runnerAt(join(tmp.dir, "remote"), "remote", "host-r", connect, clock);
  writeRunnerEndpoint(stateDir, "remote", `127.0.0.1:${worker.port}`);
  // The discovery timer sees an install recorded after the hub opened, without a restart.
  scheduled.shift()!.fn();
  expect(await remote.client.connectOnce()).toMatchObject({ ok: false, code: "RUNNER_AUTH_FAILED" });
  const { code } = handle.auth.issueCode("remote");
  (await retry())();
  const enrolled = await enrollRunner({ auth: remote.auth, connect, code, label: "remote", hostId: "host-r", expectedFingerprint: handle.auth.fingerprint });
  expect(enrolled).toMatchObject({ ok: true });
  (await retry())();
  expect(await remote.client.connectOnce()).toMatchObject({ ok: true });
  expect(readRunnerRows(stateDir).find((row) => row.label === "remote")).toMatchObject({ hostId: "host-r", maxGen: 1 });
  link!.close("drop");
  (await retry())();
  expect(await remote.client.connectOnce()).toMatchObject({ ok: true });
  expect(lines.filter((line) => line.startsWith("RUNNER_CONNECTED runner=remote"))).toHaveLength(2);
});

test("the dispatcher answers a schema failure and a stale epoch, runs nothing twice, and answers a resent final cmdId again", () => {
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

  // The second "b" is not judged or run again; its stored final record is answered once more.
  expect(published.map((p) => [p.cmdId, p.cmdSeq, p.state, p.detail.split(" ").slice(0, 2).join(" ")])).toEqual([
    ["a", 1, "failed", "RUNNER_CMD_REJECTED unknown-field"],
    ["b", 2, "failed", "RUNNER_CMD_REJECTED stale-epoch"],
    ["b", 2, "failed", "RUNNER_CMD_REJECTED stale-epoch"],
  ]);
  expect(logs).toContain("RUNNER_CMD_REPLAYED cmdId=b type=lane.observe state=failed");
  expect(state.cmdAck()).toBe(2);
  expect(logs).toContain("RUNNER_CMD_DROPPED type=lane.observe no cmdId or cmdSeq to answer");
});

test("call.ts: cmdId shapes lanes-hub parses, the fail-closed error, and the proto each new type needs", () => {
  expect(newCmdId("lane.start", "lane-a", 1_700, 0)).toBe("lane-start:lane-a:1700");
  expect(newCmdId("lane.recover", "lane-a", 1_700, 4)).toBe("recover:lane-a:1700");
  expect(newCmdId("lane.close", "lane-a", 1_700, 2)).toBe("lane.close:lane-a:1700:2");
  expect(newCmdId("guard.kill", undefined, 1_700, 0)).toBe("guard.kill:-:1700:0");
  const error = new RunnerUnavailable("lab", "outdated", "proto 2 has no lane.pause");
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: "RUNNER_UNAVAILABLE", label: "lab", why: "outdated" });
  expect(error.message).toBe("RUNNER_UNAVAILABLE runner=lab outdated: proto 2 has no lane.pause");
  expect([CALL_TIMEOUT_MS, QUERY_TIMEOUT_MS, COMMAND_TIMEOUTS["lane.start"], COMMAND_TIMEOUTS["lane.send"]]).toEqual([30_000, 15_000, 90_000, undefined]);
  expect(NEEDS_PROTO["q.panes"]).toBe(3);
  expect(NEEDS_PROTO["lane.pause"]).toBe(3);
  expect(NEEDS_PROTO["lane.close"]).toBeUndefined();
});
