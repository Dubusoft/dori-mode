import { expect, test } from "bun:test";

import { discordThreadOf, normalizeThreadRef, resolveTarget, withThreadParent } from "../src/messenger/target.ts";

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

test("a bare thread id reads as a discord ref; refs, none and other values are kept", () => {
  expect(normalizeThreadRef("1200000000000000866")).toBe("discord:1200000000000000866");
  expect(normalizeThreadRef("discord:1/2")).toBe("discord:1/2");
  expect(normalizeThreadRef("none")).toBe("none");
});

test("discordThreadOf: a channel/thread ref, a thread ref and a bare id name a thread; a configured channel does not", () => {
  expect(discordThreadOf("discord:1/2", ["1"])).toBe("2");
  expect(discordThreadOf("discord:2", ["1"])).toBe("2");
  expect(discordThreadOf("2", ["1"])).toBe("2");
  expect(discordThreadOf("discord:1", ["1"])).toBeUndefined();
  expect(discordThreadOf("other:1/2", [])).toBeUndefined();
});

test("withThreadParent stores discord:<channel>/<thread> when the parent is known, else the ref form", async () => {
  const parents: Record<string, string> = { "2": "1" };
  const parentOf = async (id: string) => parents[id];
  expect(await withThreadParent("2", ["1"], parentOf)).toBe("discord:1/2");
  expect(await withThreadParent("discord:2", ["1"], parentOf)).toBe("discord:1/2");
  expect(await withThreadParent("discord:3", ["1"], parentOf)).toBe("discord:3");
  expect(await withThreadParent("discord:9/2", ["1"], async () => { throw new Error("not asked"); })).toBe("discord:9/2");
  expect(await withThreadParent("discord:1", ["1"], async () => { throw new Error("not asked"); })).toBe("discord:1");
});
