import { expect, test } from "bun:test";

import { resolveTarget } from "../src/messenger/target.ts";

test("discord: a lane ref resolves to its thread id, plain ids pass through", () => {
  expect(resolveTarget("discord", "discord:1100000000000000259/1200000000000000866")).toEqual({ to: "1200000000000000866" });
  expect(resolveTarget("discord", "discord:1100000000000000259")).toEqual({ to: "1100000000000000259" });
  expect(resolveTarget("discord", "1100000000000000259")).toEqual({ to: "1100000000000000259" });
  expect(resolveTarget("discord", "discord:1/2", "9")).toEqual({ to: "9" });
});

test("discord: a plain channel id with --thread posts to the thread, not the parent channel", () => {
  expect(resolveTarget("discord", "1100000000000000259", "1200000000000000866")).toEqual({ to: "1200000000000000866" });
});

test("a ref without the discord prefix is left alone, an empty ref throws", () => {
  expect(resolveTarget("discord", "other:C1/2")).toEqual({ to: "other:C1/2" });
  expect(() => resolveTarget("discord", "discord:")).toThrow();
});
