import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_RETENTION_MS, RunnerState, STATE_FILE, type CommandIntent } from "../src/runner/state.ts";
import { withState } from "./fakes.ts";

let sandbox: ReturnType<typeof withState>;
let clock: { t: number };
let open: RunnerState[];

const make = (): RunnerState => {
  const s = new RunnerState(sandbox.dir, { now: () => clock.t });
  open.push(s);
  return s;
};

const intent = (seq: number, patch: Partial<CommandIntent> = {}): CommandIntent => ({
  cmdId: `op-${seq}`,
  cmdSeq: seq,
  type: "lane.start",
  key: `lane-${seq}`,
  epoch: 1,
  ...patch,
});

beforeEach(() => {
  sandbox = withState();
  clock = { t: 1_000_000 };
  open = [];
});

afterEach(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      // already closed by the test
    }
  }
  sandbox.done();
});

describe("gen", () => {
  test("starts at 0 and increases by exactly 1 per boot, surviving reopen", () => {
    const a = make();
    expect(a.gen()).toBe(0);
    expect(a.boot()).toBe(1);
    expect(a.gen()).toBe(1);
    expect(a.boot()).toBe(2);
    a.close();
    const b = make();
    expect(b.gen()).toBe(2);
    expect(b.boot()).toBe(3);
  });

  test("the bumped gen is already committed when boot returns", () => {
    const a = make();
    const gen = a.boot();
    const other = make();
    expect(other.gen()).toBe(gen);
  });
});

describe("maxEpoch", () => {
  test("only grows and is persisted", () => {
    const a = make();
    expect(a.maxEpoch()).toBe(0);
    expect(a.observeEpoch(5)).toBe(5);
    expect(a.observeEpoch(3)).toBe(5);
    expect(a.observeEpoch(5)).toBe(5);
    expect(a.observeEpoch(7)).toBe(7);
    a.close();
    expect(make().maxEpoch()).toBe(7);
  });

  test("isStale fences epochs below maxEpoch only", () => {
    const a = make();
    a.observeEpoch(4);
    expect(a.isStale(3)).toBe(true);
    expect(a.isStale(4)).toBe(false);
    expect(a.isStale(5)).toBe(false);
  });
});

describe("commands", () => {
  test("intent is recorded before the result and is visible after reopen", () => {
    const a = make();
    expect(a.recordIntent(intent(1))).toEqual({ fresh: true });
    expect(a.command("op-1")).toMatchObject({ cmdSeq: 1, state: "intent", key: "lane-1", epoch: 1, at: 1_000_000 });
    expect(a.cmdAck()).toBe(0);
    expect(a.pendingIntents().map((r) => r.cmdId)).toEqual(["op-1"]);
    a.close();

    const b = make();
    expect(b.pendingIntents().map((r) => r.cmdId)).toEqual(["op-1"]);
    clock.t += 50;
    b.recordResult("op-1", "verified", "ok");
    expect(b.command("op-1")).toMatchObject({ state: "verified", result: "ok", at: 1_000_000, updatedAt: 1_000_050 });
    expect(b.pendingIntents()).toEqual([]);
    expect(b.cmdAck()).toBe(1);
  });

  test("a repeated cmdId reports the existing row and does not insert", () => {
    const a = make();
    a.recordIntent(intent(1));
    a.recordResult("op-1", "failed", "boom");
    const again = a.recordIntent(intent(1));
    expect(again.fresh).toBe(false);
    if (!again.fresh) expect(again.existing).toMatchObject({ state: "failed", result: "boom" });
  });

  test("a lane-less command has no key", () => {
    const a = make();
    a.recordIntent(intent(1, { cmdId: "g", type: "guard.kill", key: undefined }));
    expect(a.command("g")?.key).toBeUndefined();
  });

  test("a result for an unknown command is refused", () => {
    expect(() => make().recordResult("nope", "verified", "x")).toThrow();
  });
});

describe("cmdAck", () => {
  test("is the max contiguous cmdSeq with a final row; a gap stops it", () => {
    const a = make();
    for (const seq of [1, 2, 3, 5]) a.recordIntent(intent(seq));
    a.recordResult("op-1", "verified", "");
    a.recordResult("op-2", "failed", "");
    expect(a.cmdAck()).toBe(2);
    // 5 is final but 3 (intent) and 4 (never seen) are in the way
    a.recordResult("op-5", "ambiguous", "");
    expect(a.cmdAck()).toBe(2);
    a.recordResult("op-3", "verified", "");
    expect(a.cmdAck()).toBe(3);
    a.recordIntent(intent(4));
    expect(a.cmdAck()).toBe(3);
    a.recordResult("op-4", "verified", "");
    expect(a.cmdAck()).toBe(5);
  });

  test("an intent without a result does not advance it, even when later seqs are final", () => {
    const a = make();
    a.recordIntent(intent(1));
    a.recordIntent(intent(2));
    a.recordResult("op-2", "verified", "");
    expect(a.cmdAck()).toBe(0);
  });
});

describe("retention", () => {
  test("final rows older than the cutoff are pruned at 30 days; intents and fresh rows stay", () => {
    const a = make();
    a.recordIntent(intent(1));
    a.recordResult("op-1", "verified", "");
    a.recordIntent(intent(2));
    a.recordResult("op-2", "verified", "");
    a.recordIntent(intent(3)); // stays an intent
    const t0 = clock.t;

    clock.t = t0 + COMMAND_RETENTION_MS - 1;
    expect(a.pruneCommands(clock.t - COMMAND_RETENTION_MS)).toBe(0);

    clock.t = t0 + COMMAND_RETENTION_MS + 1;
    a.recordIntent(intent(4));
    a.recordResult("op-4", "verified", "");
    expect(a.pruneCommands(clock.t - COMMAND_RETENTION_MS)).toBe(2);
    expect(a.command("op-1")).toBeUndefined();
    expect(a.command("op-2")).toBeUndefined();
    expect(a.command("op-3")?.state).toBe("intent");
    expect(a.command("op-4")?.state).toBe("verified");
  });

  test("pruning never lowers cmdAck", () => {
    const a = make();
    for (const seq of [1, 2]) {
      a.recordIntent(intent(seq));
      a.recordResult(`op-${seq}`, "verified", "");
    }
    clock.t += COMMAND_RETENTION_MS + 1;
    expect(a.pruneCommands(clock.t - COMMAND_RETENTION_MS)).toBe(2);
    expect(a.cmdAck()).toBe(2);
    a.recordIntent(intent(3));
    a.recordResult("op-3", "verified", "");
    expect(a.cmdAck()).toBe(3);
    a.close();
    expect(make().cmdAck()).toBe(3);
  });
});

describe("structured results", () => {
  test("a result value is stored with the final state and read back after reopen; a detail-only result has none", () => {
    const a = make();
    a.recordIntent(intent(1));
    a.recordResult("op-1", "verified", "started p7", { pane: "p7", tab: "t7", startup: { verdict: "ok", detail: "working" } });
    a.recordIntent(intent(2));
    a.recordResult("op-2", "failed", "boom");
    a.close();
    const b = make();
    expect(b.command("op-1")).toMatchObject({ state: "verified", result: "started p7", resultValue: { pane: "p7", tab: "t7", startup: { verdict: "ok", detail: "working" } } });
    expect(b.command("op-2")).toMatchObject({ state: "failed", result: "boom" });
    expect(b.command("op-2")?.resultValue).toBeUndefined();
    expect(b.cmdAck()).toBe(2);
  });

  test("a state file from before result_json opens, keeps its rows, and gains the column", () => {
    const legacy = new Database(join(sandbox.dir, STATE_FILE), { create: true });
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE commands (cmdId TEXT PRIMARY KEY, cmdSeq INTEGER NOT NULL UNIQUE, type TEXT NOT NULL, key TEXT, epoch INTEGER NOT NULL,
        state TEXT NOT NULL, result TEXT, at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO meta VALUES ('gen', 4);
      INSERT INTO commands VALUES ('old-1', 1, 'lane.close', 'lane-a', 1, 'verified', 'closed', 10, 20);
      INSERT INTO commands VALUES ('old-2', 2, 'lane.start', 'lane-b', 1, 'intent', NULL, 30, 30);
    `);
    legacy.close();
    const a = make();
    expect(a.gen()).toBe(4);
    expect(a.command("old-1")).toEqual({ cmdId: "old-1", cmdSeq: 1, type: "lane.close", key: "lane-a", epoch: 1, state: "verified", result: "closed", at: 10, updatedAt: 20 });
    expect(a.pendingIntents().map((r) => r.cmdId)).toEqual(["old-2"]);
    a.recordResult("old-2", "verified", "started", { pane: "p1", tab: "t1", startup: { verdict: "unconfirmed", detail: "idle" } });
    expect(a.command("old-2")?.resultValue).toEqual({ pane: "p1", tab: "t1", startup: { verdict: "unconfirmed", detail: "idle" } });
    a.close();
    // Opening again does not try to add the column twice.
    expect(make().cmdAck()).toBe(2);
  });

  test("a stored result that does not parse reads as absent instead of breaking the record", () => {
    const a = make();
    a.recordIntent(intent(1));
    a.recordResult("op-1", "verified", "ok", { gone: true });
    a.close();
    const raw = new Database(join(sandbox.dir, STATE_FILE));
    raw.query("UPDATE commands SET result_json = '{not json' WHERE cmdId = 'op-1'").run();
    raw.close();
    const b = make();
    expect(b.command("op-1")).toMatchObject({ state: "verified", result: "ok" });
    expect(b.command("op-1")?.resultValue).toBeUndefined();
  });
});

describe("file mode", () => {
  test("state.sqlite and its sidecars are 0600", () => {
    const a = make();
    a.boot();
    a.recordIntent(intent(1));
    const base = join(sandbox.dir, STATE_FILE);
    for (const file of [base, `${base}-wal`, `${base}-shm`]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
