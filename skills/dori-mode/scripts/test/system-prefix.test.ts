import { expect, test } from "bun:test";
import { defaultConfig, type DoriConfig } from "../src/config.ts";
import { SYSTEM_PREFIX, systemText } from "../src/supervise-loop.ts";

test("systemText prefixes once and never doubles", () => {
  expect(SYSTEM_PREFIX).toBe("[System] ");
  expect(systemText("Dori warning: x")).toBe("[System] Dori warning: x");
  expect(systemText(systemText("hi"))).toBe("[System] hi");
});

test("owner notice text carries the System prefix when posted", () => {
  const config: DoriConfig = defaultConfig();
  for (const notice of [config.ownerDelayNotice, config.ackMissingNotice, config.unhandledNotice, "Lead restart queued"]) {
    expect(systemText(notice)).toStartWith(SYSTEM_PREFIX);
  }
});
