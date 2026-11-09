import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEffectEpoch, decideHello, recordHello, resetGen, type StoredRunner } from "../src/runner/fencing.ts";
import { RunnerState } from "../src/runner/state.ts";

let dir: string;
let state: RunnerState;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fencing-"));
  state = new RunnerState(dir, { now: () => 1000 });
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("effect epoch fence", () => {
  test("a command accepted at epoch 7 is rejected right before its effect once maxEpoch is 8", () => {
    state.observeEpoch(7);
    expect(checkEffectEpoch(7, state.maxEpoch()).ok).toBe(true); // accepted on arrival

    state.observeEpoch(8); // a newer supervisor's hello lands before the effect runs
    let effects = 0;
    const effect = () => { effects += 1; };
    const verdict = checkEffectEpoch(7, state.maxEpoch());
    if (verdict.ok) effect();

    expect(verdict).toMatchObject({ ok: false, code: "RUNNER_CMD_REJECTED", rule: "stale-epoch" });
    expect(effects).toBe(0);
    expect(checkEffectEpoch(8, state.maxEpoch()).ok).toBe(true);
  });
});

describe("hello fencing", () => {
  const hello = (gen: number, hostId = "host-a") => ({ label: "box", hostId, gen });

  test("gen regression on the same hostId is RUNNER_CONFLICT", () => {
    const stored: StoredRunner = recordHello(undefined, hello(5));
    expect(decideHello(stored, hello(4))).toMatchObject({ action: "conflict", code: "RUNNER_CONFLICT", reason: "gen-regressed" });
    // equal gen while a live connection holds it
    expect(decideHello(stored, hello(5), 5)).toMatchObject({ action: "conflict", reason: "gen-regressed" });
    // equal gen with no live connection is a reconnect; higher gen replaces
    expect(decideHello(stored, hello(5))).toEqual({ action: "accept" });
    expect(decideHello(stored, hello(6), 5)).toEqual({ action: "replace" });
  });

  test("same label with a different hostId is RUNNER_CONFLICT", () => {
    const stored = recordHello(undefined, hello(5));
    expect(decideHello(stored, hello(9, "host-b"))).toMatchObject({ action: "conflict", code: "RUNNER_CONFLICT", reason: "host-mismatch" });
  });

  test("a first hello is accepted, and reset-gen makes a regressed hello acceptable", () => {
    expect(decideHello(undefined, hello(1))).toEqual({ action: "accept" });
    const stored = recordHello(undefined, hello(5));
    expect(decideHello(stored, hello(2)).action).toBe("conflict");
    const cleared = resetGen(stored);
    expect(cleared.maxGen).toBeUndefined();
    expect(decideHello(cleared, hello(2))).toEqual({ action: "accept" });
    expect(decideHello(cleared, hello(2, "host-b")).action).toBe("conflict");
  });
});
