import { afterEach, expect, test } from "bun:test";
import { agentLine, guardWorld as world, type Reading, runnerSample } from "./runner-guard-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const guardWorld = (withBoard: boolean) => world(withBoard, cleanups);

const READINGS: readonly Reading[] = [
  { load1: 200, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 2 },
  { load1: 200, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 2 },
  { load1: 3, memFreePct: 60, diskFreeGb: 120, swapFreeGb: 2.5 },
];

test("HOST_GUARD lines built from runner samples are the lines the ssh path writes", async () => {
  const legacy = guardWorld(false);
  const viaRunner = guardWorld(true);
  const legacyLines: string[] = [];
  const runnerLines: string[] = [];
  for (const r of READINGS) {
    legacy.setSsh(() => agentLine(r));
    legacyLines.push(...await legacy.tick());
    viaRunner.board.event("mac", runnerSample(r, viaRunner.clock.now()));
    runnerLines.push(...await viaRunner.tick());
    legacy.clock.at += 30_000;
    viaRunner.clock.at += 30_000;
  }
  expect(runnerLines).toEqual(legacyLines);
  expect(runnerLines).toEqual([
    "HOST_GUARD ALERT machine=mac load 200 > 150",
    "HOST_GUARD CLEAR machine=mac load 3, memory free 60%, disk free 120 GB, swap free 2.5 GB",
  ]);
  expect(viaRunner.sshCalls()).toBe(0);
});

test("a runner's own kill becomes the HOST_GUARD CRITICAL line, with nothing killed over ssh", async () => {
  const w = guardWorld(true);
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

test("OFFLINE and ONLINE read the same when the runner goes quiet and comes back", async () => {
  const legacy = guardWorld(false);
  const viaRunner = guardWorld(true);
  const lines = { legacy: [] as string[], runner: [] as string[] };
  for (const w of [legacy, viaRunner]) w.setSsh(() => ({ code: 255, out: "", err: "ssh: connect to host mac port 22: No route to host" }));
  for (let i = 0; i < 2; i++) {
    lines.legacy.push(...await legacy.tick());
    lines.runner.push(...await viaRunner.tick());
    legacy.clock.at += 120_000;
    viaRunner.clock.at += 120_000;
  }
  // Past the 4 min backoff that the second failure set.
  legacy.clock.at += 240_000;
  viaRunner.clock.at += 240_000;
  const back = READINGS[2] as Reading;
  legacy.setSsh(() => agentLine(back));
  lines.legacy.push(...await legacy.tick());
  viaRunner.board.event("mac", runnerSample(back, viaRunner.clock.now()));
  lines.runner.push(...await viaRunner.tick());
  expect(lines.runner).toEqual(lines.legacy);
  expect(lines.runner).toEqual([
    "HOST_GUARD OFFLINE machine=mac unreachable: ssh: connect to host mac port 22: No route to host",
    "HOST_GUARD ONLINE machine=mac",
  ]);
});
