import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { treeDigest } from "../src/runner/lane-files.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { RunnerState } from "../src/runner/state.ts";
import { memoryPair } from "../src/runner/transport.ts";
import { encodeFrame, supervisorControl } from "../src/runner/protocol.ts";
import { join } from "node:path";
import {
  Outbox, OUTBOX_ACKED_RETENTION_MS, OUTBOX_BODY_CAP, OUTBOX_EVENT_MAX, OUTBOX_FILE, OUTBOX_INLINE_MAX, OutboxEventTooLarge, TRUNCATION_MARKER,
  bodyRefFor, outboxLargeLine, outboxMaintenance,
} from "../src/runner/outbox.ts";
import { fakeClock, withState } from "./fakes.ts";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("runner outbox", () => {
  let dir: string;
  let done: () => void;
  let at: number;
  let box: Outbox;
  beforeEach(() => {
    ({ dir, done } = withState());
    at = 1_000_000;
    box = new Outbox(dir, { now: () => at, largeRows: 3, largeAgeMs: 5_000 });
  });
  afterEach(() => { box.close(); done(); });

  const report = (text: string) => ({ key: "k", kind: "progress" as const, text });

  const managed = (text = "done") => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const tree = { directories: ["empty"], files: [{ path: "report.bin", bytes: data.length, base64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") }] };
    return { key: "lane-a", kind: "done" as const, text, evidence: "\u0000evidence", files: {
      run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: true }, revision: 1, sha256: treeDigest(tree), tree,
    } };
  };

  test("managed done bytes, text and evidence survive source removal, reopen, hydration and ack", () => {
    const body = managed("é".repeat(32768));
    const output = join(dir, "briefs/lane-a.out");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "report.bin"), Buffer.from(body.files.tree.files[0]!.base64, "base64"));
    const row = box.append("lane.report", body);
    expect(row.body).toEqual({ ...body, bodyRef: bodyRefFor(body.text, false) });
    expect(row.body.bodyRef?.truncated).toBe(false);
    rmSync(output, { recursive: true });
    box.close();
    box = new Outbox(dir, { now: () => at });
    expect(box.unacked(0)[0]?.body).toEqual(row.body);
    expect(box.unacked(0)[0]?.body).toEqual(row.body);
    expect(box.ack(row.seq)).toBe(1);
    expect(box.unacked(0)).toEqual([]);
  });

  test("managed event refusal allocates no sequence and never invokes the string fitter", () => {
    const body = managed();
    expect(() => box.append("lane.report", { ...body, text: "x".repeat(65537) })).toThrow("LANE_REPORT_LIMIT");
    expect(() => box.append("lane.report", { ...body, evidence: "x".repeat(16385) })).toThrow("LANE_REPORT_LIMIT");
    expect(() => box.append("lane.report", { ...body, files: { ...body.files, tree: { directories: [], files: [{ ...body.files.tree.files[0]!, base64: "x".repeat(500000) }] } } })).toThrow("(base64)");
    // Escaping can exceed the wire cap while every decoded limit passes.
    const data = Buffer.alloc(262144), more = Buffer.alloc(131072);
    const tree = { directories: [], files: [data, more].map((buf, i) => ({ path: `p${i}`, bytes: buf.length, base64: buf.toString("base64"), sha256: createHash("sha256").update(buf).digest("hex") })) };
    expect(() => box.append("lane.report", { ...body, text: "\u0001".repeat(65536), files: { ...body.files, tree, sha256: treeDigest(tree) } })).toThrow("LANE_FILES_FRAME_TOO_LARGE");
    expect(box.stats().lastSeq).toBe(0);
    expect(box.append("lane.report", body).seq).toBe(1);
  });

  test("RunnerClient propagates managed append refusal and offline durable success returns its sequence", () => {
    const state = new RunnerState(dir, { now: () => at });
    try {
      const client = new RunnerClient({ label: "local", hostId: "host" }, {
        outbox: box, state, clock: fakeClock(at), connect: async () => { throw new Error("offline"); },
      });
      expect(() => client.publish("lane.report", managed("x".repeat(65537)))).toThrow("LANE_REPORT_LIMIT");
      expect(box.stats().lastSeq).toBe(0);
      expect(client.publish("lane.report", managed())).toBe(1);
      expect(box.unacked(0)[0]?.body).toEqual(managed());
    } finally { state.close(); }
  });

  test("a failed live send after managed append remains durable success with immutable replay bytes", async () => {
    const state = new RunnerState(dir, { now: () => at });
    state.boot();
    const pair = memoryPair(), logs: string[] = [];
    let fail = false;
    pair.supervisor.onLine((line) => {
      if (JSON.parse(line).type === "hello") pair.supervisor.send(encodeFrame(supervisorControl({ runner: "local", gen: 1, epoch: 1 }, "hello.ok", { proto: 5, epoch: 1, eventAck: 0 })));
    });
    const client = new RunnerClient({ label: "local", hostId: "host" }, { state, outbox: box, clock: fakeClock(at), log: (line) => logs.push(line),
      connect: async () => ({ ...pair.runner, send: (line) => { if (fail) throw new Error("send failed"); pair.runner.send(line); } }),
    });
    try {
      const connected = client.connectOnce();
      await Promise.resolve();
      pair.pump();
      expect(await connected).toMatchObject({ ok: true });
      fail = true;
      expect(client.publish("lane.report", managed())).toBe(1);
      expect(logs.at(-1)).toBe("RUNNER_SEND_FAILED seq=1 send failed");
      expect(box.unacked(0)[0]?.body).toEqual(managed());
    } finally { pair.sever(); state.close(); }
  });

  test("seq is durable, increasing and never reused after prune", () => {
    expect(box.append("lane.state", { key: "a", status: "idle" }).seq).toBe(1);
    expect(box.append("lane.state", { key: "a", status: "working" }).seq).toBe(2);
    box.ack(2);
    at += OUTBOX_ACKED_RETENTION_MS + 1;
    expect(box.prune(at)).toBe(2);
    box.close();
    box = new Outbox(dir, { now: () => at });
    expect(box.append("lane.state", { key: "a", status: "idle" }).seq).toBe(3);
  });

  test("acked rows are never replayed", () => {
    for (let i = 0; i < 5; i++) box.append("lane.asking", { key: "a", text: String(i) });
    expect(box.ack(3)).toBe(3);
    expect(box.unacked(0).map((r) => r.seq)).toEqual([4, 5]);
    expect(box.ack(2)).toBe(0);
    expect(box.unacked(4).map((r) => r.seq)).toEqual([5]);
    box.close();
    box = new Outbox(dir, { now: () => at });
    expect(box.unacked(0).map((r) => r.seq)).toEqual([4, 5]);
  });

  test("small texts stay inline", () => {
    const row = box.append("lane.report", report("x".repeat(OUTBOX_INLINE_MAX)));
    expect(row.body.bodyRef).toBeUndefined();
    expect(readdirSync(join(dir, "bodies"))).toEqual([]);
  });

  test("texts over 8KB move to bodies/ with path-backed sha256 and read back", () => {
    const text = "é".repeat(OUTBOX_INLINE_MAX);
    const row = box.append("lane.report", report(text));
    expect(row.body.text).toBe(text);
    expect(row.body.bodyRef).toEqual(bodyRefFor(text, false));
    const file = join(dir, "bodies", "1.body");
    expect(mode(file)).toBe(0o600);
    expect(mode(join(dir, "bodies"))).toBe(0o700);
    const job = box.append("job.result", { opKey: "o", state: "verified", exitCode: 0, output: "o".repeat(OUTBOX_INLINE_MAX + 1) });
    expect(job.body.output.length).toBe(OUTBOX_INLINE_MAX + 1);
    expect(box.unacked(0)[0]!.body).toEqual(row.body);
  });

  test("texts over 256KB are cut with the marker", () => {
    const row = box.append("lane.report", report("a".repeat(OUTBOX_BODY_CAP + 50)));
    expect(row.body.text).toBe("a".repeat(OUTBOX_BODY_CAP) + TRUNCATION_MARKER);
    expect(row.body.bodyRef?.truncated).toBe(true);
    expect(row.body.bodyRef?.bytes).toBe(OUTBOX_BODY_CAP + Buffer.byteLength(TRUNCATION_MARKER));
  });

  test("a cut never splits a multibyte character", () => {
    const row = box.append("lane.report", report("é".repeat(OUTBOX_BODY_CAP)));
    expect(row.body.text.endsWith("é" + TRUNCATION_MARKER)).toBe(true);
    expect(row.body.text).not.toContain("\uFFFD");
  });

  test("database, WAL, shm and body files are 0600", () => {
    box.append("lane.report", report("b".repeat(OUTBOX_INLINE_MAX + 1)));
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(dir, OUTBOX_FILE + suffix);
      expect(existsSync(path)).toBe(true);
      expect(mode(path)).toBe(0o600);
    }
    expect(mode(join(dir, "bodies", "1.body"))).toBe(0o600);
  });

  test("acked rows older than 7 days are pruned with their bodies", () => {
    box.append("lane.report", report("c".repeat(OUTBOX_INLINE_MAX + 1)));
    box.append("lane.state", { key: "a", status: "idle" });
    box.ack(1);
    at += OUTBOX_ACKED_RETENTION_MS - 1;
    expect(box.prune(at)).toBe(0);
    at += 2;
    expect(box.prune(at)).toBe(1);
    expect(existsSync(join(dir, "bodies", "1.body"))).toBe(false);
    expect(box.unacked(0).map((r) => r.seq)).toEqual([2]);
    expect(box.prune(at + OUTBOX_ACKED_RETENTION_MS * 2)).toBe(0);
  });

  test("RUNNER_OUTBOX_LARGE by row count and by age", () => {
    expect(box.large(at)).toBeUndefined();
    for (let i = 0; i < 3; i++) box.append("lane.asking", { key: "a", text: "q" });
    expect(box.large(at)).toBeUndefined();
    box.append("lane.asking", { key: "a", text: "q" });
    const big = box.large(at + 10);
    expect(big).toEqual({ unacked: 4, oldestAgeMs: 10 });
    expect(outboxLargeLine(big!)).toBe("RUNNER_OUTBOX_LARGE unacked=4 oldestAgeMs=10");
    box.ack(4);
    expect(box.large(at + 99_999)).toBeUndefined();
    box.append("lane.asking", { key: "a", text: "q" });
    expect(box.large(at + 5_000)).toBeUndefined();
    expect(box.large(at + 5_001)).toEqual({ unacked: 1, oldestAgeMs: 5_001 });
  });

  test("an event over the frame budget is cut at append, longest string first, and still gets its seq", () => {
    const row = box.append("lane.report", { ...report("short"), evidence: "\u0001".repeat(300_000) });
    expect(row.seq).toBe(1);
    expect(row.body.text).toBe("short");
    expect(row.body.evidence?.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(OUTBOX_EVENT_MAX);
    expect(box.unacked(0)[0]!.body).toEqual(row.body);
  });

  test("an event that cannot be cut to fit is refused without taking a seq", () => {
    const keys = Array.from({ length: 200_000 }, (_, i) => i);
    expect(() => box.append("lane.state", { key: "a", status: "idle", keys } as never)).toThrow(OutboxEventTooLarge);
    expect(box.append("lane.state", { key: "a", status: "idle" }).seq).toBe(1);
  });

  test("maintenance prunes acked rows and logs RUNNER_OUTBOX_LARGE once per transition", () => {
    const lines: string[] = [];
    const tick = outboxMaintenance(box, () => at, (line) => lines.push(line));
    box.append("lane.asking", { key: "a", text: "q" });
    box.ack(1);
    at += OUTBOX_ACKED_RETENTION_MS + 1;
    for (let i = 0; i < 4; i++) box.append("lane.asking", { key: "a", text: "q" });
    tick();
    tick();
    expect(lines).toEqual(["RUNNER_OUTBOX_PRUNED 1 acked rows past retention", "RUNNER_OUTBOX_LARGE unacked=4 oldestAgeMs=0"]);
    box.ack(5);
    tick();
    tick();
    expect(lines.slice(2)).toEqual(["RUNNER_OUTBOX_OK unacked=0"]);
  });

  test("stats", () => {
    expect(box.stats()).toEqual({ unacked: 0, lastSeq: 0 });
    box.append("lane.asking", { key: "a", text: "q" });
    expect(box.stats()).toEqual({ unacked: 1, oldestUnackedAt: at, lastSeq: 1 });
  });
});
