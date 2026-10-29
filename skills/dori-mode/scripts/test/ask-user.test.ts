import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { askUserTick, screenQuestion } from "../src/ask-user.ts";
import { DEFAULT_RESOLVE_KINDS, isDecision } from "../src/decision-obligations.ts";
import { eventClass } from "../src/event-policy.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
// Real omo screens: a blocking question (waitForAnswer true) and the collapsed widget of an async one.
const DIALOG = fixture("omo-ask-user-dialog.txt");
const WIDGET = fixture("omo-ask-user-widget.txt");
const IDLE = " Done, PR open.\n─────\n❯\n─────\n~/repo • $0.000\n(😺 OmO Native by Q Kim)";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => { state = withState(); world = newWorld(); });
afterEach(() => state.done());

const lane: Lane = { key: "ask-lane", title: "ask", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString() };

const tick = async (screen: string): Promise<{ line: string; meta: unknown }[]> => {
  world.screen = screen;
  const lines: { line: string; meta: unknown }[] = [];
  await askUserTick(depsFor(world, fakeClock(T0), state.dir), async (line, _id, meta) => { lines.push({ line, meta }); });
  return lines;
};

test("the blocking question dialog is read with its header, question and options", () => {
  expect(screenQuestion(DIALOG)).toEqual({ header: "Deploy", question: "QA442 which target should I deploy to?", options: ["staging", "production"], pending: 1 });
});

test("the async question widget is read with its option chips and pending count", () => {
  expect(screenQuestion(WIDGET)).toEqual({ header: "Region", question: "QA442B which region?", options: ["seoul", "tokyo"], pending: 2 });
});

test("a wrapped widget question retains its chips", () => {
  expect(screenQuestion("? Question pending (1 unanswered) · 30m\n Deploy - which target should I use for\n this environment?\n [ staging ]  [ production ]"))
    .toEqual({ header: "Deploy", question: "which target should I use for this environment?", options: ["staging", "production"], pending: 1 });
});

test("a question left in scrollback, or only quoted by the transcript, is no prompt", () => {
  expect(screenQuestion(IDLE)).toBeNull();
  expect(screenQuestion(`${DIALOG}\n${Array.from({ length: 12 }, (_, i) => ` line ${i}`).join("\n")}`)).toBeNull();
  expect(screenQuestion(` grep found: ? Question pending (1 unanswered)\n ? Question pending (1 unanswered) · 30m\n   Deploy - which target?\n${IDLE}`)).toBeNull();
});

test("one urgent LANE_ASKING per question, with its text and options, raised again after it is resolved", async () => {
  await depsFor(world, fakeClock(T0), state.dir).registry.write(lane);
  const first = await tick(DIALOG);
  expect(first.map((e) => e.line)).toEqual(["LANE_ASKING ask-lane waits on an on-screen question, not dori report: [Deploy] QA442 which target should I deploy to? | options: staging / production"]);
  expect(first[0]?.meta).toMatchObject({ lane: "ask-lane", thread: "chat:team/9" });
  expect(eventClass(first[0]?.line ?? "")).toBe("lead-urgent");
  expect(isDecision(first[0]?.line ?? "", DEFAULT_RESOLVE_KINDS)).toBe(true);
  expect(await tick(DIALOG)).toEqual([]);
  expect(await tick(IDLE)).toEqual([]);
  expect((await tick(DIALOG)).length).toBe(1);
  const next = await tick(WIDGET);
  expect(next.map((e) => e.line)).toEqual(["LANE_ASKING ask-lane waits on an on-screen question, not dori report: [Region] QA442B which region? | options: seoul / tokyo | 2 questions pending"]);
});

test("switching tabs in one dialog does not raise another prompt", async () => {
  const registry = depsFor(world, fakeClock(T0), state.dir).registry;
  await registry.write(lane);
  const dialog = DIALOG.replace("→ Deploy    Submit", "→ Deploy    Review    Submit");
  const tab = (current: string, question: string) => dialog.replace("→ Deploy    Review", `${current === "Deploy" ? "→ Deploy" : "  Deploy"}    ${current === "Review" ? "→ Review" : "  Review"}`).replace("QA442 which target should I deploy to?", question);
  const first = await tick(tab("Review", "which target should I deploy to?"));
  const second = await tick(tab("Deploy", "is the plan ready?"));
  expect(first).toHaveLength(1);
  expect(second).toEqual([]);
});

test("a patch failure does not prevent processing later lanes", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  await deps.registry.write({ ...lane, key: "ask-lane-2", pane: "w:p8" });
  const patch = deps.registry.patch.bind(deps.registry);
  deps.registry.patch = async (key, value) => {
    if (key === lane.key) throw new Error("patch failed");
    return patch(key, value);
  };
  const emitted: string[] = [];
  world.screens = [DIALOG, DIALOG];
  await expect(askUserTick(deps, async (line) => { emitted.push(line); })).rejects.toThrow("patch failed");
  expect(emitted).toHaveLength(2);
  expect((await deps.registry.open()).find((item) => item.key === "ask-lane-2")?.lastAskPrompt).toBeTruthy();
});

test("a paused lane's question is not raised", async () => {
  await depsFor(world, fakeClock(T0), state.dir).registry.write({ ...lane, status: "paused" });
  expect(await tick(DIALOG)).toEqual([]);
});

test("an empty screen read preserves the remembered question without emitting or patching", async () => {
  const registry = depsFor(world, fakeClock(T0), state.dir).registry;
  await registry.write({ ...lane, lastAskPrompt: "remembered-question" });
  const patch = registry.patch.bind(registry);
  let patches = 0;
  registry.patch = async (...args) => { patches++; return patch(...args); };
  expect(await tick("")).toEqual([]);
  expect(patches).toBe(0);
  expect((await registry.open())[0]?.lastAskPrompt).toBe("remembered-question");
});
