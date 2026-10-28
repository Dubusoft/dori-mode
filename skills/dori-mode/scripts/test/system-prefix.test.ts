import { expect, test } from "bun:test";
import { SYSTEM_PREFIX, systemText } from "../src/supervise-loop.ts";

test("systemText prefixes once and never doubles", () => {
  expect(SYSTEM_PREFIX).toBe("[System] ");
  expect(systemText("Dori warning: x")).toBe("[System] Dori warning: x");
  expect(systemText(systemText("hi"))).toBe("[System] hi");
});
