import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { RunnerHub, formatRunnerStatus, readRunnerRows, type CommitFn } from "../src/runner/hub.ts";
import { acceptRunners } from "../src/runner/serve.ts";
import { RunnerClient, backoffMs } from "../src/runner/client.ts";
import { Outbox, OUTBOX_FILE, TRUNCATION_MARKER } from "../src/runner/outbox.ts";
import { RunnerState } from "../src/runner/state.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import {
  decodeFrame, encodeFrame, isQueryType, journalId, PROTO, QUERY_TYPES, runnerControl, runnerEvent, SUPERVISOR_CONTROL_TYPES, supervisorControl,
} from "../src/runner/protocol.ts";
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
    hub, client, outbox, net, committed, reconnect,
    setDropping: (on) => { dropping = on; },
    close: () => {
      expect(authFailures).toEqual([]);
      stop(); hub.close(); supervisorAuth.close(); outbox.close(); state.close();
    },
  };
};

describe("event cursor over a lossy in-memory link", () => {
  test("seq 1..100 with 41..60 dropped, then a reconnect: exactly 100 journal ids in seq order", async () => {
    const seenAck: number[] = [];
    const r = rig((hub, committed) => (id) => {
      // The hub must not have advanced eventAck for this event while the commit runs.
      const seq = Number(id.split(":")[2]);
      seenAck.push(hub().runner(LABEL)?.eventAck ?? -1);
      expect(hub().runner(LABEL)?.eventAck).toBe(seq - 1);
      committed.push(id);
      return true;
    });
    try {
      r.setDropping(true);
      const first = await r.reconnect();
      expect(first).toEqual({ ok: true, eventAck: 0, replayed: 0 });
      for (let n = 1; n <= 100; n += 1) expect(r.client.publish("lane.state", stateBody)).toBe(n);
      r.net.pairs[0]?.pump();

      // 1..40 committed; 61 arrived past the gap, was not committed and closed the link; the cursor sits at 40.
      expect(r.committed).toEqual(Array.from({ length: 40 }, (_, i) => journalId(LABEL, i + 1)));
      expect(r.hub.runner(LABEL)?.eventAck).toBe(40);
      // The close dropped the acks still queued for the runner; the next hello.ok carries eventAck 40.
      expect(r.client.eventAck).toBe(0);
      expect(r.client.connected).toBe(false);
      expect(r.outbox.stats().unacked).toBe(100);

      // Link breaks; the next hello's eventAck drives the replay.
      r.net.pairs[0]?.sever("link down");
      expect(r.client.connected).toBe(false);
      r.setDropping(false);
      const second = await r.reconnect();
      expect(second).toEqual({ ok: true, eventAck: 40, replayed: 60 });
      r.net.pairs[1]?.pump();

      expect(r.committed).toEqual(Array.from({ length: 100 }, (_, i) => `runner:${LABEL}:${i + 1}`));
      expect(new Set(r.committed).size).toBe(100);
      expect(r.hub.runner(LABEL)?.eventAck).toBe(100);
      expect(r.client.eventAck).toBe(100);
      expect(r.outbox.stats().unacked).toBe(0);
      expect(readRunnerRows(join(tmp.dir, "sup")).find((row) => row.label === LABEL)?.eventAck).toBe(100);
      expect(seenAck).toEqual(Array.from({ length: 100 }, (_, i) => i));
    } finally {
      r.close();
    }
  });

  test("a row another process appends to the shared outbox closes the link at the gap, and the reconnect delivers every later event", async () => {
    const r = rig();
    const other = new Outbox(join(tmp.dir, "runner"), { now: () => 1_000 });
    try {
      expect((await r.reconnect()).ok).toBe(true);
      r.net.pairs[0]?.pump();
      expect(r.client.publish("lane.state", stateBody)).toBe(1);
      // Seq 2 is written by a second runner process on the same directory and never sent on this connection.
      expect(other.append("lane.state", stateBody).seq).toBe(2);
      expect(r.client.publish("cmd.result", { cmdId: "c-1", cmdSeq: 1, state: "verified", detail: "started" })).toBe(3);
      r.net.pairs[0]?.pump();

      // Seq 3 is past the gap: not committed, and the supervisor drops the link instead of stalling on it.
      expect(r.committed).toEqual([journalId(LABEL, 1)]);
      expect(r.client.connected).toBe(false);

      expect(await r.reconnect()).toEqual({ ok: true, eventAck: 1, replayed: 2 });
      r.net.pairs[1]?.pump();
      expect(r.committed).toEqual([1, 2, 3].map((seq) => journalId(LABEL, seq)));
      expect(r.outbox.stats().unacked).toBe(0);
    } finally {
      other.close();
      r.close();
    }
  });

  test("oversized events between normal ones are cut to fit, and the replay delivers every event after them", async () => {
    const r = rig();
    try {
      expect(r.outbox.append("lane.state", stateBody).seq).toBe(1);
      const big = r.outbox.append("lane.report", { key: "lane-a", kind: "progress", text: "t".repeat(600_000), evidence: "e".repeat(2 * 1024 * 1024) });
      expect(big.body.evidence?.endsWith(TRUNCATION_MARKER)).toBe(true);
      // A row stored before append fitted bodies, written straight into the database: its JSON is about 2.4 MB.
      const db = new Database(join(tmp.dir, "runner", OUTBOX_FILE));
      db.query("INSERT INTO events (seq, type, body, at) VALUES (3, 'lane.report', ?, 1000)")
        .run(JSON.stringify({ key: "lane-a", kind: "progress", text: "x", evidence: "\u0001".repeat(400_000) }));
      db.run("UPDATE meta SET v = 4 WHERE k = 'next_seq'");
      db.close();
      expect(r.outbox.append("lane.state", { key: "lane-a", status: "idle" }).seq).toBe(4);

      expect(await r.reconnect()).toEqual({ ok: true, eventAck: 0, replayed: 4 });
      r.net.pairs[0]?.pump();
      expect(r.committed).toEqual([1, 2, 3, 4].map((seq) => journalId(LABEL, seq)));
      expect(r.client.connected).toBe(true);
      expect(r.outbox.stats().unacked).toBe(0);
    } finally {
      r.close();
    }
  });

  test("events published while connected after a replay stay in seq order", async () => {
    const r = rig();
    try {
      r.client.publish("lane.state", stateBody);
      r.client.publish("lane.state", stateBody);
      expect((await r.reconnect()).ok).toBe(true);
      r.net.pairs[0]?.pump();
      r.client.publish("lane.state", stateBody);
      r.net.pairs[0]?.pump();
      expect(r.committed).toEqual([journalId(LABEL, 1), journalId(LABEL, 2), journalId(LABEL, 3)]);
    } finally {
      r.close();
    }
  });
});

describe("hub commit-then-ack", () => {
  const hello = (hub: RunnerHub) => hub.hello(runnerControl(HEAD, "hello", { proto: 8, gen: 1, label: LABEL, hostId: "h", cmdAck: 0, version: "v" }));

  test("a throwing commit leaves eventAck unchanged and sends no ack; a retry commits", () => {
    let fail = true;
    const ids: string[] = [];
    const hub = new RunnerHub({
      stateDir: join(tmp.dir, "sup"), now: () => 1, monotonic: () => 1, epoch: 1,
      commit: (id) => { if (fail) throw new Error("journal busy"); ids.push(id); return true; },
    });
    try {
      expect(hello(hub).ok).toBe(true);
      const event = runnerEvent(HEAD, 1, "lane.state", stateBody);
      expect(() => hub.handle(event)).toThrow("journal busy");
      expect(hub.runner(LABEL)?.eventAck).toBe(0);
      expect(readRunnerRows(join(tmp.dir, "sup"))[0]?.eventAck).toBe(0);
      fail = false;
      const out = hub.receive(event);
      expect(out.result).toBe("committed");
      expect(out.reply.body).toEqual({ eventAck: 1 });
      expect(ids).toEqual([journalId(LABEL, 1)]);
    } finally {
      hub.close();
    }
  });

  test("a gap is not committed and keeps eventAck; a duplicate is acked without a commit", () => {
    const ids: string[] = [];
    const hub = new RunnerHub({
      stateDir: join(tmp.dir, "sup"), now: () => 1, monotonic: () => 1, epoch: 1,
      commit: (id) => { ids.push(id); return true; },
    });
    try {
      hello(hub);
      expect(hub.receive(runnerEvent(HEAD, 2, "lane.state", stateBody))).toMatchObject({ result: "gap", eventAck: 0 });
      expect(hub.receive(runnerEvent(HEAD, 1, "lane.state", stateBody))).toMatchObject({ result: "committed", eventAck: 1 });
      expect(hub.receive(runnerEvent(HEAD, 1, "lane.state", stateBody))).toMatchObject({ result: "duplicate", eventAck: 1 });
      expect(ids).toEqual([journalId(LABEL, 1)]);
      const reply = hello(hub);
      expect(reply.ok && reply.reply.body).toEqual({ proto: 9, epoch: 1, eventAck: 1 });
    } finally {
      hub.close();
    }
  });

  test("hello rules: proto mismatch, host conflict, lower gen; status line", () => {
    let mono = 0;
    const hub = new RunnerHub({ stateDir: join(tmp.dir, "sup"), now: () => 5, monotonic: () => mono, epoch: 1, commit: () => true });
    try {
      // The supervisor speaks proto 9 and accepts 9 and 8 (N and N-1).
      const body = { proto: 8, gen: 2, label: LABEL, hostId: "h", cmdAck: 0 };
      const rejectCode = (b: typeof body) => {
        const out = hub.hello(runnerControl(HEAD, "hello", b));
        return out.ok ? "ok" : out.reply.body.code;
      };
      expect(rejectCode({ ...body, proto: 11 })).toBe("RUNNER_PROTO_MISMATCH");
      expect(rejectCode({ ...body, proto: 10 })).toBe("RUNNER_PROTO_MISMATCH");
      expect(rejectCode({ ...body, proto: 7 })).toBe("RUNNER_PROTO_MISMATCH");
      expect(rejectCode({ ...body, proto: 1 })).toBe("RUNNER_PROTO_MISMATCH");
      const tooOld = hub.hello(runnerControl(HEAD, "hello", { ...body, proto: 7 }));
      expect(tooOld.ok ? undefined : tooOld.reply.body).toEqual({
        code: "RUNNER_PROTO_MISMATCH", detail: "runner proto 7 is too old for the supervisor (accepts 8..9); run dori runner update",
      });
      expect(rejectCode(body)).toBe("ok");
      expect(rejectCode({ ...body, hostId: "other" })).toBe("RUNNER_CONFLICT");
      expect(rejectCode({ ...body, gen: 1 })).toBe("RUNNER_CONFLICT");
      expect(formatRunnerStatus(hub.status()[0] as never)).toBe("RUNNER r1 connected proto=8 version=- gen=2 hb=- outbox=-");
      mono = 61_000;
      expect(hub.status()[0]?.state).toBe("stale");
      hub.disconnected(LABEL);
      expect(hub.status()[0]?.state).toBe("disconnected");
    } finally {
      hub.close();
    }
  });
});

describe("backoffMs", () => {
  test("doubles from 1s, caps at 60s, jitter within 20%", () => {
    expect(backoffMs(0, () => 0.5)).toBe(1_000);
    expect(backoffMs(3, () => 0.5)).toBe(8_000);
    expect(backoffMs(20, () => 0.5)).toBe(60_000);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(20, () => 0.999999)).toBeLessThanOrEqual(72_000);
  });
});

describe("proto 3 frames", () => {
  const roundTrip = (frame: Parameters<typeof encodeFrame>[0], from: "runner" | "supervisor") => decodeFrame(encodeFrame(frame), from);

  test("the new event fields and lane.ack validate; cmd.result.result takes any JSON value", () => {
    expect(PROTO).toBe(9);
    expect(roundTrip(runnerEvent(HEAD, 1, "lane.ack", { key: "lane-a", id: "m-1" }), "runner").type).toBe("lane.ack");
    expect(roundTrip(runnerEvent(HEAD, 2, "lane.state", { key: "lane-a", status: "dead", reason: "agent-gone" }), "runner").body)
      .toEqual({ key: "lane-a", status: "dead", reason: "agent-gone" });
    const sample = {
      level: "ok", reasons: [], sampledAt: 5, panes: 3, lanes: [{ key: "lane-a", rssKb: 900, top: [{ comm: "bun", rssKb: 800, count: 2 }] }],
    } as const;
    expect(roundTrip(runnerEvent(HEAD, 3, "guard.sample", sample), "runner").body).toEqual(sample);
    for (const result of [null, true, 3.5, "x", [1, "a", null], { pane: "p7", startup: { verdict: "ok", detail: "" } }]) {
      const body = { cmdId: "c", cmdSeq: 1, state: "verified" as const, detail: "d", result };
      expect(roundTrip(runnerEvent(HEAD, 4, "cmd.result", body), "runner").body).toEqual(body);
    }
    expect(() => decodeFrame(encodeFrame(runnerEvent(HEAD, 5, "lane.state", { key: "a", status: "dead", reason: "boom" as never })), "runner"))
      .toThrow("RUNNER_FRAME_INVALID field-type body.reason");
    expect(() => decodeFrame(encodeFrame(runnerEvent(HEAD, 6, "guard.sample", { ...sample, lanes: [{ key: "a", rssKb: 1 } as never] })), "runner"))
      .toThrow("RUNNER_FRAME_INVALID missing-field body.lanes[0].top");
    // A runner that could not read herdr sends panes -1 (the supervisor's herdr-down signal); nothing lower decodes.
    expect(roundTrip(runnerEvent(HEAD, 7, "guard.sample", { ...sample, panes: -1 }), "runner").body).toEqual({ ...sample, panes: -1 });
    expect(() => decodeFrame(encodeFrame(runnerEvent(HEAD, 8, "guard.sample", { ...sample, panes: -2 })), "runner"))
      .toThrow("RUNNER_FRAME_INVALID field-type body.panes must be a non-negative integer or -1");
  });

  test("queries are supervisor control frames without cmdSeq, answered by the runner's q.result", () => {
    expect(QUERY_TYPES).toEqual(["q.panes", "q.screen", "q.process", "q.stat", "q.lane.inspect", "q.machine.observe", "q.lane.files"]);
    for (const type of QUERY_TYPES) expect(SUPERVISOR_CONTROL_TYPES).toContain(type);
    expect(isQueryType("q.panes")).toBe(true);
    expect(isQueryType("ack")).toBe(false);
    const query = roundTrip(supervisorControl(HEAD, "q.screen", { qid: "q1", pane: "w1:p2", lines: 200, source: "recent" }), "supervisor");
    expect("cmdSeq" in query).toBe(false);
    expect(() => decodeFrame(encodeFrame(supervisorControl(HEAD, "q.panes", { qid: "q1" })), "runner")).toThrow("wrong-direction");
    expect(() => decodeFrame(JSON.stringify({ ...supervisorControl(HEAD, "q.panes", { qid: "q1" }), cmdSeq: 1 }), "supervisor")).toThrow("sequence");
    expect(() => decodeFrame(encodeFrame(supervisorControl(HEAD, "q.panes", {} as never)), "supervisor")).toThrow("missing-field body.qid");
    const answer = { qid: "q1", ok: true, detail: "ok", result: { panes: [{ pane_id: "w1:p2" }] } };
    expect(roundTrip(runnerControl(HEAD, "q.result", answer), "runner").body).toEqual(answer);
    expect(roundTrip(runnerControl(HEAD, "q.result", { qid: "q2", ok: false, detail: "herdr down" }), "runner").body).toEqual({ qid: "q2", ok: false, detail: "herdr down" });
    expect(() => decodeFrame(encodeFrame(runnerControl(HEAD, "q.result", answer)), "supervisor")).toThrow("wrong-direction");
  });
});
