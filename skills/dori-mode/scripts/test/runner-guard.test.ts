import { afterEach, expect, test } from "bun:test";
import { RunnerGuardBoard } from "../src/runner/guard.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { guardWorld as world, type Reading, runnerSample } from "./runner-guard-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const guardWorld = () => world(cleanups);

const READINGS: readonly Reading[] = [
  { load1: 200, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 2 },
  { load1: 200, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 2 },
  { load1: 3, memFreePct: 60, diskFreeGb: 120, swapFreeGb: 2.5 },
];

test("HOST_GUARD ALERT and CLEAR lines come from the runner's samples", async () => {
  const w = guardWorld();
  const lines: string[] = [];
  for (const r of READINGS) {
    w.board.event("mac", runnerSample(r, w.clock.now()));
    lines.push(...await w.tick());
    w.clock.at += 30_000;
  }
  expect(lines).toEqual([
    "HOST_GUARD ALERT machine=mac load 200 > 150",
    "HOST_GUARD CLEAR machine=mac load 3, memory free 60%, disk free 120 GB, swap free 2.5 GB",
  ]);
  expect(w.sshCalls()).toBe(0);
});

test("a runner's own kill becomes the HOST_GUARD CRITICAL line, with nothing killed over ssh", async () => {
  const w = guardWorld();
  const crit = { load1: 4, memFreePct: 3, diskFreeGb: 100, swapFreeGb: 1 };
  w.board.event("mac", runnerSample(crit, w.clock.now()));
  w.board.event("mac", {
    v: 1, runner: "mac", gen: 1, epoch: 1, seq: 2, type: "guard.critical",
    body: { killed: [11], paused: [], reasons: ["memory free 3% < 5%"], rssKb: [4_000_000], cmds: ["qemu-system-x86"] },
  } as unknown as Parameters<typeof w.board.event>[1]);
  const lines = await w.tick();
  expect(lines).toContain("HOST_GUARD CRITICAL machine=mac memory free 3% < 5%; killed qemu-system-x86 3.8 GB (pid 11) - tell the owner");
  expect(w.sshCalls()).toBe(0);
});

test("the board hands out a runner sample's pane count and per-lane memory with the sample", () => {
  let now = 1_000;
  const board = new RunnerGuardBoard(() => now);
  const lanes = [{ key: "lane-a", rssKb: 900, top: [{ comm: "node", rssKb: 900, count: 2 }] }];
  board.event("local", {
    v: 1, runner: "local", gen: 1, epoch: 1, seq: 1, type: "guard.sample",
    body: { level: "ok", reasons: [], sampledAt: now, load1: 1, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 1, swapTotalGb: 2, os: "linux", panes: 4, lanes },
  } as unknown as AnyRunnerEvent);
  expect(board.sampleFor("local")).toEqual({
    ok: true, sample: { os: "linux", load1: 1, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 1, swapTotalGb: 2 }, panes: 4, lanes,
  });
  now += 100_000;
  expect(board.sampleFor("local")).toBeUndefined();
});
