import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { canLaunch, clearLaunchHold, enqueueLaunch, heldMachines, idleLaneFor, launchHeld, launchQueue, queueFor, recordLaunchVerdict } from "../src/routing.ts";
import { withState } from "./fakes.ts";

const t = defaultConfig("/home/test").guard;
const roomy = { load1: 200, memFreePct: 45, diskFreeGb: 300, swapFreeGb: 2, panes: 6 };

test("a busy CPU alone does not stop a launch; only memory, disk and pane count do", () => {
  expect(canLaunch(roomy, t)).toEqual({ ok: true, reasons: [] });
});

test("low memory, low disk or a full pane budget each hold the launch and say why", () => {
  expect(canLaunch({ ...roomy, memFreePct: 12 }, t).reasons).toEqual(["memory free 12% < 20%"]);
  expect(canLaunch({ ...roomy, diskFreeGb: 9 }, t).reasons).toEqual(["disk free 9 GB < 50 GB"]);
  const both = canLaunch({ ...roomy, panes: 20, diskFreeGb: 9 }, t);
  expect(both.ok).toBe(false);
  expect(both.reasons).toHaveLength(2);
});

test("an idle working lane on the same repo is preferred over opening a new one", () => {
  const lane = (key: string, cwd: string, pane: string, status?: Lane["status"]): Lane => ({ key, title: key, thread: "none", brief: "", done: "", cwd, pane, openedAt: "2026-01-01T00:00:00Z", ...(status ? { status } : {}) });
  const lanes = [lane("busy", "/repo/a", "w:p1"), lane("idle-other", "/repo/b", "w:p2"), lane("claimed", "/repo/a", "w:p3", "done-claimed"), lane("idle-same", "/repo/a", "w:p4")];
  const idle = new Set(["w:p2", "w:p3", "w:p4"]);
  expect(idleLaneFor(lanes, "/repo/a", idle)?.key).toBe("idle-same");
  expect(idleLaneFor(lanes, "/repo/c", idle)).toBeNull();
});

test("a corrupt hold file is moved aside and remains blocked with no queue", () => {
  const state = withState();
  try {
    const path = join(state.dir, "launch-hold.json");
    const original = "{not-json";
    writeFileSync(path, original);
    expect(launchHeld(state.dir)).toBe(true);
    const asideName = readdirSync(state.dir).find((name) => name.startsWith("launch-hold.json.corrupt-"));
    expect(asideName).toBeDefined();
    const aside = join(state.dir, asideName!);
    expect(existsSync(aside)).toBe(true);
    expect(readFileSync(aside, "utf8")).toBe(original);
    expect(launchQueue(state.dir)).toEqual([]);
    enqueueLaunch(state.dir, {
      key: "new", title: "new", done: "done", brief: "brief",
      queuedAt: "2026-01-01T00:00:00Z", reasons: ["held"],
    });
    expect(launchHeld(state.dir)).toBe(true);
    expect(launchQueue(state.dir).map((item) => item.key)).toEqual(["new"]);
  } finally {
    state.done();
  }
});

test("invalid queue entries are dropped while valid entries survive", () => {
  const state = withState();
  try {
    const path = join(state.dir, "launch-hold.json");
    const valid = {
      key: "kept", title: "kept", done: "done", brief: "brief",
      queuedAt: "2026-01-01T00:00:00Z", reasons: ["held"],
    };
    writeFileSync(path, JSON.stringify({ blocked: true, queue: [valid, { key: "bad" }] }));
    expect(launchQueue(state.dir)).toEqual([valid]);
    expect(launchHeld(state.dir)).toBe(true);
  } finally {
    state.done();
  }
});

test("a queue entry with a mode other than mass-ulw is dropped", () => {
  const state = withState();
  try {
    const base = { key: "k", title: "t", done: "d", brief: "b", queuedAt: "2026-01-01T00:00:00Z", reasons: ["held"] };
    const good = { ...base, key: "good", mode: "mass-ulw" as const };
    writeFileSync(join(state.dir, "launch-hold.json"), JSON.stringify({ blocked: true, queue: [good, { ...base, mode: 5 }] }));
    expect(launchQueue(state.dir)).toEqual([good]);
  } finally {
    state.done();
  }
});

const hold = (reason: string) => ({ ok: false, reasons: [reason] });
const item = (key: string, machine?: string) => ({
  key, title: key, done: "d", brief: "b", queuedAt: "2026-01-01T00:00:00Z", reasons: ["held"], ...(machine ? { machine } : {}),
});

test("a remote HOLD does not block the local host and vice versa", () => {
  const state = withState();
  try {
    recordLaunchVerdict(state.dir, hold("memory"), 1, "box");
    expect(launchHeld(state.dir, "box")).toBe(true);
    expect(launchHeld(state.dir)).toBe(false);
    expect(launchHeld(state.dir, "local")).toBe(false);
    recordLaunchVerdict(state.dir, hold("disk"), 2);
    recordLaunchVerdict(state.dir, { ok: true, reasons: [] }, 3, "box");
    expect(launchHeld(state.dir, "box")).toBe(false);
    expect(launchHeld(state.dir)).toBe(true);
  } finally {
    state.done();
  }
});

test("enqueueing a remote item raises only that machine", () => {
  const state = withState();
  try {
    enqueueLaunch(state.dir, item("r", "box"));
    expect(launchHeld(state.dir, "box")).toBe(true);
    expect(launchHeld(state.dir)).toBe(false);
    enqueueLaunch(state.dir, item("l"));
    expect(launchHeld(state.dir)).toBe(true);
    enqueueLaunch(state.dir, item("l2", "local"));
    expect(heldMachines(state.dir)).toEqual(["box"]);
  } finally {
    state.done();
  }
});

test("heldMachines lists blocked labels sorted", () => {
  const state = withState();
  try {
    expect(heldMachines(state.dir)).toEqual([]);
    recordLaunchVerdict(state.dir, hold("x"), 1, "zed");
    recordLaunchVerdict(state.dir, hold("x"), 1, "alpha");
    recordLaunchVerdict(state.dir, hold("x"), 1, "mid");
    recordLaunchVerdict(state.dir, { ok: true, reasons: [] }, 2, "mid");
    expect(heldMachines(state.dir)).toEqual(["alpha", "zed"]);
  } finally {
    state.done();
  }
});

test("clearLaunchHold for a machine respects the revision observed for that machine", () => {
  const state = withState();
  try {
    recordLaunchVerdict(state.dir, hold("x"), 1, "box");
    expect(launchHeld(state.dir, "box")).toBe(true);
    recordLaunchVerdict(state.dir, hold("y"), 2, "box");
    clearLaunchHold(state.dir, "box");
    expect(launchHeld(state.dir, "box")).toBe(true);
    clearLaunchHold(state.dir, "box");
    expect(launchHeld(state.dir, "box")).toBe(false);
    recordLaunchVerdict(state.dir, hold("z"), 3);
    expect(launchHeld(state.dir)).toBe(true);
    clearLaunchHold(state.dir, "box");
    expect(launchHeld(state.dir)).toBe(true);
  } finally {
    state.done();
  }
});

test("queueFor keeps only the entries of one machine", () => {
  const queue = [item("a"), item("b", "box"), item("c", "local"), item("d", "other")];
  expect(queueFor(queue).map((q) => q.key)).toEqual(["a", "c"]);
  expect(queueFor(queue, "local").map((q) => q.key)).toEqual(["a", "c"]);
  expect(queueFor(queue, "box").map((q) => q.key)).toEqual(["b"]);
  expect(queueFor(queue, "none")).toEqual([]);
});

test("a hold file without machines loads unchanged", () => {
  const state = withState();
  try {
    writeFileSync(join(state.dir, "launch-hold.json"), JSON.stringify({ blocked: true, reasons: ["old"] }));
    expect(launchHeld(state.dir)).toBe(true);
    expect(launchHeld(state.dir, "box")).toBe(false);
    expect(heldMachines(state.dir)).toEqual([]);
    expect(readdirSync(state.dir).some((name) => name.includes("corrupt"))).toBe(false);
  } finally {
    state.done();
  }
});

test("an invalid machines shape is treated as corrupt", () => {
  for (const machines of [[], "box", { box: { blocked: "yes" } }, { box: null }, { box: { blocked: true, reasons: [1] } }]) {
    const state = withState();
    try {
      writeFileSync(join(state.dir, "launch-hold.json"), JSON.stringify({ blocked: false, machines }));
      expect(launchHeld(state.dir)).toBe(true);
      expect(readdirSync(state.dir).some((name) => name.startsWith("launch-hold.json.corrupt-"))).toBe(true);
      expect(heldMachines(state.dir)).toEqual([]);
    } finally {
      state.done();
    }
  }
});
