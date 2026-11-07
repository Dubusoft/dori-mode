import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Outbox, OUTBOX_ACKED_RETENTION_MS, OUTBOX_BODY_CAP, OUTBOX_EVENT_MAX, OUTBOX_FILE, OUTBOX_INLINE_MAX, OutboxEventTooLarge, TRUNCATION_MARKER,
  bodyRefFor, outboxLargeLine, outboxMaintenance,
} from "../src/runner/outbox.ts";
import { withState } from "./fakes.ts";

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
