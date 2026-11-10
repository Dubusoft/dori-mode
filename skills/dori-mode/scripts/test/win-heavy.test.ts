import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pidAlive, trySlot, type SlotDeps } from "../src/heavy-slot.ts";
import { heavyLoad, retryable } from "../src/runner/lane-cli.ts";
import type { Runner } from "../src/run.ts";

const T0 = Date.UTC(2026, 10, 7, 8, 0, 0, 789);
const clock = { now: () => T0, sleep: async () => {} };
const dir = (): string => mkdtempSync(join(tmpdir(), "win-heavy-"));
const deps = (over: Partial<SlotDeps>): SlotDeps => ({
  dir: dir(), slots: 1, maxLoad: Infinity, clock, load: async () => 0, alive: () => true, pid: 4242, platform: "win32", ...over,
});

test("win32 claim takes an existing empty slot directory with a wx owner write", async () => {
  const d = deps({});
  mkdirSync(join(d.dir, "slot.1"));
  expect(await trySlot(d, "lane:build")).toBe(join(d.dir, "slot.1"));
});

test("win32 claim never overwrites an owner the legacy agent wrote first", async () => {
  const d = deps({});
  const owner = join(d.dir, "slot.1", "owner");
  mkdirSync(join(d.dir, "slot.1"));
  writeFileSync(owner, "999 legacy 2026-11-07T08:00:00Z");
  expect(await trySlot(d, "lane:build")).toBeNull();
  expect(readFileSync(owner, "utf8")).toBe("999 legacy 2026-11-07T08:00:00Z");
});

test("win32 owner stamp has seconds precision (yyyy-MM-ddTHH:mm:ssZ)", async () => {
  const d = deps({});
  const slot = await trySlot(d, "lane:build");
  const owner = readFileSync(join(slot ?? "", "owner"), "utf8");
  expect(owner).toBe("4242 lane:build 2026-11-07T08:00:00Z");
  expect(owner.split(" ").pop()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("posix owner stamp keeps milliseconds", async () => {
  const d = deps({ platform: "linux" });
  const slot = await trySlot(d, "x");
  expect(readFileSync(join(slot ?? "", "owner"), "utf8")).toBe("4242 x 2026-11-07T08:00:00.789Z");
});

test("win32 reclaim passes the slot stamp to alive", async () => {
  const d0 = deps({});
  mkdirSync(join(d0.dir, "slot.1"));
  writeFileSync(join(d0.dir, "slot.1", "owner"), "777 legacy 2026-11-07T07:00:00Z");
  const seen: unknown[][] = [];
  const d = { ...d0, alive: (pid: number, since?: number) => { seen.push([pid, since]); return false; } };
  expect(await trySlot(d, "lane:next")).toBe(join(d.dir, "slot.1"));
  expect(seen).toEqual([[777, Date.UTC(2026, 10, 7, 7, 0, 0)]]);
  expect(readFileSync(join(d.dir, "slot.1", "owner"), "utf8")).toBe("4242 lane:next 2026-11-07T08:00:00Z");
});

test("alive on win32 compares the injected creation time with the stamp plus one second", () => {
  const since = Date.UTC(2026, 10, 7, 8, 0, 0);
  const at = (created: number | undefined) => pidAlive(process.pid, since, { platform: "win32", createdMs: () => created });
  expect(at(since - 5_000)).toBe(true);
  expect(at(since + 1_000)).toBe(true);
  expect(at(since + 1_001)).toBe(false);
  expect(at(undefined)).toBe(true);
  expect(pidAlive(process.pid, undefined, { platform: "win32", createdMs: () => since + 60_000 })).toBe(true);
  expect(pidAlive(2_147_483_647, since, { platform: "win32", createdMs: () => 0 })).toBe(false);
  expect(pidAlive(0, since, { platform: "win32" })).toBe(false);
});

test("retryable accepts the Windows not-there and refused codes", () => {
  for (const code of ["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"]) {
    expect(retryable(Object.assign(new Error("x"), { code }))).toBe(true);
  }
  expect(retryable(new Error("connect EPIPE"))).toBe(true);
  expect(retryable(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
});

test("heavy admission reads the sampler's load1 on win32 and loadavg elsewhere", async () => {
  const seen: string[][] = [];
  const run: Runner = async (argv) => { seen.push([...argv]); return { code: 0, out: JSON.stringify({ load1: 6.5, procs: [] }), err: "" }; };
  expect(await heavyLoad("win32", run, "C:\\r")()).toBe(6.5);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.[0]).toBe("powershell.exe");
  expect(typeof await heavyLoad("linux", run)()).toBe("number");
  expect(seen).toHaveLength(1);
});
