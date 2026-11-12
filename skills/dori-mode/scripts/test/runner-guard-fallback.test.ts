import { afterEach, expect, test } from "bun:test";
import { GUARD_SAMPLE_FRESH_MS } from "../src/runner/guard.ts";
import { guardWorld, runnerSample } from "./runner-guard-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const hot = { load1: 300, memFreePct: 60, diskFreeGb: 120, swapFreeGb: 2.5 };

test("while the runner is quiet the machine is skipped, never sampled over ssh; a fresh sample is judged again", async () => {
  const w = guardWorld(cleanups);
  w.board.event("mac", runnerSample({ ...hot, load1: 3 }, w.clock.now()));
  expect(await w.tick()).toEqual([]);
  // Stale: skipped, so the hot reading below is the first one judged.
  w.clock.at += GUARD_SAMPLE_FRESH_MS + 1_000;
  expect(await w.tick()).toEqual([]);
  expect(w.sshCalls()).toBe(0);
  w.board.event("mac", runnerSample(hot, w.clock.now()));
  expect(await w.tick()).toEqual(["HOST_GUARD ALERT machine=mac load 300 > 150"]);
  expect(w.sshCalls()).toBe(0);
});
