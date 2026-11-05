import { afterEach, expect, test } from "bun:test";
import { GUARD_SAMPLE_FRESH_MS } from "../src/runner/guard.ts";
import { agentLine, guardWorld, runnerSample } from "./runner-guard-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const reading = { load1: 3, memFreePct: 60, diskFreeGb: 120, swapFreeGb: 2.5 };

test("while the runner is quiet the next machine-guard tick samples the machine over ssh again", async () => {
  const w = guardWorld(true, cleanups);
  w.setSsh(() => agentLine(reading));
  w.board.event("mac", runnerSample(reading, w.clock.now()));
  await w.tick();
  expect(w.sshCalls()).toBe(0);
  w.clock.at += GUARD_SAMPLE_FRESH_MS - 1_000;
  await w.tick();
  expect(w.sshCalls()).toBe(0);
  w.clock.at += 2_000;
  await w.tick();
  expect(w.sshCalls()).toBeGreaterThan(0);
  const after = w.sshCalls();
  w.board.event("mac", runnerSample(reading, w.clock.now()));
  await w.tick();
  expect(w.sshCalls()).toBe(after);
});
