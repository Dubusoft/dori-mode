import { expect, test } from "bun:test";
import { SYSTEM_PREFIX, systemText } from "../src/supervise-loop.ts";
import { BUILT_IN } from "../src/tunables.ts";

test("systemText prefixes once and never doubles", () => {
  expect(SYSTEM_PREFIX).toBe("[System] ");
  expect(systemText("Dori warning: x")).toBe("[System] Dori warning: x");
  expect(systemText(systemText("hi"))).toBe("[System] hi");
});

test("owner notice text carries the System prefix when posted", () => {
  for (const notice of [BUILT_IN.ownerDelayNotice, BUILT_IN.ackMissingNotice, BUILT_IN.unhandledNotice, "Lead restart queued"]) {
    expect(systemText(notice)).toStartWith(SYSTEM_PREFIX);
  }
});
