import { afterEach, expect, test } from "bun:test";

import { languageInstruction } from "../src/config.ts";
import { freshnessTick } from "../src/freshness.ts";
import { footer } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent as sentTexts, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const lane = (over: Partial<Lane> = {}): Lane => ({
  key: "lang-lane", title: "t", thread: "chat:team/9", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0, reportVia: "cli", ...over,
});

test("languageInstruction is empty when the language is unset or blank", () => {
  expect(languageInstruction(undefined)).toBe("");
  expect(languageInstruction("  ")).toBe("");
  expect(languageInstruction(" Korean ")).toContain("in Korean;");
});

test("footer carries the language line only when ownerLanguage is set, for every report mode", () => {
  for (const l of [lane(), lane({ reportVia: undefined }), lane({ machine: "m1" })]) {
    const without = footer(l);
    expect(without).not.toContain("every todo item");
    expect(footer(l, "")).toBe(without);
    const set = footer(l, "Korean");
    expect(set).toContain("- Write every dori report text and every todo item in Korean; code, commands, commit messages and PR text follow the repo convention.");
    expect(set.replace(/- Write every dori report[^\n]*\n/, "")).toBe(without);
  }
});

const nudgeText = async (ownerLanguage: string | undefined): Promise<string> => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  const deps = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir, ownerLanguage ? { ownerLanguage } : {});
  await deps.registry.write(lane());
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  const sent = sentTexts(world).find((c) => c.includes("[LEAD] your work thread has had no update"));
  expect(sent).toBeDefined();
  return sent ?? "";
};

test("the freshness nudge repeats the language instruction only when ownerLanguage is set", async () => {
  expect(await nudgeText(undefined)).not.toContain("every todo item");
  expect(await nudgeText("Korean")).toContain("Write every dori report text and every todo item in Korean;");
});
