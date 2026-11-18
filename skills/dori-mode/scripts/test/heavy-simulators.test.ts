import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SIMULATORS_FILE, watchSimulators, type SimulatorDeps } from "../src/heavy-simulators.ts";
import type { Runner } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A heavy dir with a held slot, and an xcrun that boots and shuts down simulators in `booted`. */
const setup = (booted: Set<string>, platform = "darwin") => {
  const dir = mkdtempSync(join(tmpdir(), "heavy-sims-"));
  dirs.push(dir);
  const calls: string[] = [];
  const run: Runner = async (argv) => {
    calls.push(argv.join(" "));
    if (argv.join(" ") === "xcrun simctl list --json devices booted") {
      return { code: 0, out: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [...booted].map((udid) => ({ udid, state: "Booted" })) } }), err: "" };
    }
    if (argv[2] === "shutdown") { booted.delete(argv[3]!); return { code: 0, out: "", err: "" }; }
    return { code: 1, out: "", err: "unexpected" };
  };
  const hold = (n: number, pid: number): string => {
    const slot = join(dir, `slot.${n}`);
    mkdirSync(slot);
    writeFileSync(join(slot, "owner"), `${pid} lane:build ${new Date().toISOString()}`);
    return slot;
  };
  const err: string[] = [];
  const deps: SimulatorDeps = { run, dir, platform, alive: (pid) => pid !== 0, now: () => Date.now(), pid: 4242, err: (l) => err.push(l) };
  return { dir, calls, deps, hold, err, shutdowns: () => calls.filter((c) => c.includes(" shutdown ")) };
};

test("a heavy run shuts down only the simulators booted while its command ran", async () => {
  const booted = new Set(["OWNER-SIM"]);
  const f = setup(booted);
  const slot = f.hold(1, 100);
  const finish = await watchSimulators(f.deps, slot);
  booted.add("BUILD-SIM");
  await finish();
  expect(f.shutdowns()).toEqual(["xcrun simctl shutdown BUILD-SIM"]);
  expect([...booted]).toEqual(["OWNER-SIM"]);
  expect(existsSync(slot)).toBe(false);
  expect(existsSync(join(f.dir, SIMULATORS_FILE))).toBe(false);
});

test("while another heavy holds a slot its simulators wait, and the last heavy to end shuts them down", async () => {
  const booted = new Set<string>();
  const f = setup(booted);
  const first = await watchSimulators(f.deps, f.hold(1, 100));
  const second = await watchSimulators(f.deps, f.hold(2, 200));
  booted.add("SIM-A");
  await first();
  // slot.2 is still held: SIM-A may be the second command's, so nothing is shut down yet.
  expect(f.shutdowns()).toEqual([]);
  expect(readFileSync(join(f.dir, SIMULATORS_FILE), "utf8")).toBe("SIM-A\n");
  booted.add("SIM-B");
  await second();
  expect(f.shutdowns().sort()).toEqual(["xcrun simctl shutdown SIM-A", "xcrun simctl shutdown SIM-B"]);
  expect(booted.size).toBe(0);
});

test("off macOS a heavy run only frees its slot", async () => {
  const f = setup(new Set(["SIM"]), "linux");
  const slot = f.hold(1, 100);
  await (await watchSimulators(f.deps, slot))();
  expect(f.calls).toEqual([]);
  expect(existsSync(slot)).toBe(false);
});
