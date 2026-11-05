import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerHub, formatRunnerStatus, readRunnerRows, type CommitFn } from "../src/runner/hub.ts";
import { RunnerClient, backoffMs } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { RunnerState } from "../src/runner/state.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import { journalId, runnerControl, runnerEvent, type RunnerFrame } from "../src/runner/protocol.ts";
import { decodeFrame, encodeFrame } from "../src/runner/protocol.ts";
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

  let dropping = false;
  // Drops the first transmission of events 41..60 while `dropping` is on.
  const net = memoryNetwork({
    drop: (line, direction) => {
      if (!dropping || direction !== "to-supervisor") return false;
      const frame = JSON.parse(line) as { seq?: number };
      return frame.seq !== undefined && frame.seq >= 41 && frame.seq <= 60;
    },
  });
  net.listener.onConnection((transport) => {
    transport.onLine((line) => {
      const reply = hub.handle(decodeFrame(line, "runner") as RunnerFrame);
      if (reply) transport.send(encodeFrame(reply));
    });
    transport.onClose(() => hub.disconnected(LABEL));
  });

  const client = new RunnerClient({ label: LABEL, hostId: "host-1", version: "t1" }, { connect: net.connect, outbox, state, clock });
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
    close: () => { hub.close(); outbox.close(); state.close(); },
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

      // 1..40 committed; 61..100 arrived past the gap and were not committed; the cursor sits at 40.
      expect(r.committed).toEqual(Array.from({ length: 40 }, (_, i) => journalId(LABEL, i + 1)));
      expect(r.hub.runner(LABEL)?.eventAck).toBe(40);
      expect(r.client.eventAck).toBe(40);
      expect(r.outbox.stats().unacked).toBe(60);

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
  const hello = (hub: RunnerHub) => hub.hello(runnerControl(HEAD, "hello", { proto: 1, gen: 1, label: LABEL, hostId: "h", cmdAck: 0, version: "v" }));

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
      expect(reply.ok && reply.reply.body).toEqual({ proto: 1, epoch: 1, eventAck: 1 });
    } finally {
      hub.close();
    }
  });

  test("hello rules: proto mismatch, host conflict, lower gen; status line", () => {
    let mono = 0;
    const hub = new RunnerHub({ stateDir: join(tmp.dir, "sup"), now: () => 5, monotonic: () => mono, epoch: 1, commit: () => true });
    try {
      const body = { proto: 1, gen: 2, label: LABEL, hostId: "h", cmdAck: 0 };
      const rejectCode = (b: typeof body) => {
        const out = hub.hello(runnerControl(HEAD, "hello", b));
        return out.ok ? "ok" : out.reply.body.code;
      };
      expect(rejectCode({ ...body, proto: 9 })).toBe("RUNNER_PROTO_MISMATCH");
      expect(rejectCode(body)).toBe("ok");
      expect(rejectCode({ ...body, hostId: "other" })).toBe("RUNNER_CONFLICT");
      expect(rejectCode({ ...body, gen: 1 })).toBe("RUNNER_CONFLICT");
      expect(formatRunnerStatus(hub.status()[0] as never)).toBe("RUNNER r1 connected proto=1 version=- gen=2 hb=- outbox=-");
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
