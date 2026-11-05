import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { RunnerHub, formatRunnerStatus, readRunnerRows, type CommitFn } from "../src/runner/hub.ts";
import { acceptRunners } from "../src/runner/serve.ts";
import { RunnerClient, backoffMs } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { RunnerState } from "../src/runner/state.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import { journalId, runnerControl, runnerEvent } from "../src/runner/protocol.ts";
import { fakeClock, withState } from "./fakes.ts";

const LABEL = "r1";
const HEAD = { runner: LABEL, gen: 1, epoch: 0 };

let tmp: ReturnType<typeof withState>;
beforeEach(() => { tmp = withState(); });
afterEach(() => { tmp.done(); });

const stateBody = { key: "lane-a", status: "working" } as const;

type Rig = {
  hub: RunnerHub;
  client: RunnerClient;
  outbox: Outbox;
  net: ReturnType<typeof memoryNetwork>;
  committed: string[];
  setDropping: (on: boolean) => void;
  /** Starts a connection attempt, delivers the hello exchange and returns the outcome. */
  reconnect: () => ReturnType<RunnerClient["connectOnce"]>;
  close: () => void;
  clock: { at: number };
};

const rig = (commitOverride?: (hub: () => RunnerHub, committed: string[]) => CommitFn): Rig => {
  const runnerDir = join(tmp.dir, "runner");
  mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
  const clock = fakeClock(1_000);
  const outbox = new Outbox(runnerDir, { now: clock.now });
  const state = new RunnerState(runnerDir, { now: clock.now });
  state.boot();
  const committed: string[] = [];
  let hubRef: RunnerHub | undefined;
  const commit: CommitFn = commitOverride
    ? commitOverride(() => hubRef as RunnerHub, committed)
    : (id) => { committed.push(id); return true; };
  const hub = new RunnerHub({ stateDir: join(tmp.dir, "sup"), commit, now: clock.now, monotonic: clock.now, epoch: 3 });
  hubRef = hub;

  // Enrolled up front, so every connection below runs the signed handshake and every frame carries a MAC.
  const supervisorAuth = new SupervisorAuth(join(tmp.dir, "sup"), { now: clock.now });
  const runnerAuth = new RunnerAuth(runnerDir);
  const code = supervisorAuth.issueCode(LABEL).code;
  const request = runnerAuth.enrollRequest(code, LABEL, "host-1");
  const enrolled = supervisorAuth.enroll(request);
  if (!enrolled.ok) throw new Error(enrolled.detail);
  runnerAuth.pinSupervisor(code, request, enrolled.reply, supervisorAuth.fingerprint);

  let dropping = false;
  // Drops the first transmission of events 41..60 while `dropping` is on.
  const net = memoryNetwork({
    drop: (line, direction) => {
      if (!dropping || direction !== "to-supervisor") return false;
      const frame = JSON.parse(line) as { seq?: number };
      return frame.seq !== undefined && frame.seq >= 41 && frame.seq <= 60;
    },
  });
  const authFailures: string[] = [];
  const stop = acceptRunners(hub, net.listener, {
    auth: supervisorAuth,
    log: (line) => { if (line.startsWith("RUNNER_AUTH_FAILED")) authFailures.push(line); },
  });

  const client = new RunnerClient({ label: LABEL, hostId: "host-1", version: "t1" }, {
    connect: net.connect, outbox, state, clock, auth: runnerAuth, log: (line) => { authFailures.push(line); },
  });
  const reconnect = async () => {
    const before = net.pairs.length;
    const attempt = client.connectOnce();
    // The connector resolves on a microtask; wait for the hello to be queued on the new pair.
    for (let i = 0; i < 20 && !(net.pairs.length > before && (net.pairs.at(-1)?.queued() ?? 0) > 0); i += 1) await Promise.resolve();
    expect(net.pairs.length).toBe(before + 1);
    net.pairs.at(-1)?.pump();
    return attempt;
  };
  return {
    hub, client, outbox, net, committed, reconnect, clock,
    setDropping: (on) => { dropping = on; },
    close: () => {
      expect(authFailures).toEqual([]);
      stop(); hub.close(); supervisorAuth.close(); outbox.close(); state.close();
    },
  };
};

test("50 reports queued during a 10-minute disconnect are journaled once each, in order, after the reconnect", async () => {
  const r = rig();
  try {
    expect((await r.reconnect()).ok).toBe(true);
    r.net.pairs.at(-1)?.sever("network down");
    r.clock.at += 10 * 60_000;
    for (let i = 1; i <= 50; i += 1) r.client.publish("lane.report", { key: "lane-a", kind: "milestone", text: `step ${i}` });
    expect(r.committed).toEqual([]);
    expect((await r.reconnect()).ok).toBe(true);
    while ((r.net.pairs.at(-1)?.pump() ?? 0) > 0) { /* deliver replay and acks */ }
    const want = Array.from({ length: 50 }, (_, i) => journalId(LABEL, i + 1));
    expect(r.committed).toEqual(want);
    r.net.pairs.at(-1)?.sever("network down again");
    expect((await r.reconnect()).ok).toBe(true);
    while ((r.net.pairs.at(-1)?.pump() ?? 0) > 0) { /* nothing left to replay */ }
    expect(r.committed).toEqual(want);
  } finally {
    r.close();
  }
});
