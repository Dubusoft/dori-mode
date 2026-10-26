import { expect, test } from "bun:test";

import { eventPriority } from "../src/supervise.ts";

test("lane-recovery and wait-failure events are urgent", () => {
  for (const line of [
    "LANE_RECOVERY_EXHAUSTED k w:p1 dead after 3 recovery attempts",
    "WAIT_FAILED release ci green (30 checks in a row failed; no --timeout set)",
    "WAITS_CORRUPT waits.json did not parse and was moved to /x; every wait in it is dropped, register them again",
  ]) expect(eventPriority(line)).toBe("urgent");
});
