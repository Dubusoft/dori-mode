import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEALTH_DEAD_MS, HEALTH_FRESH_MS, healthPath, probe, probeHerdr, readHealth, startHealth, writeHealth } from "../src/runner/health.ts";
import type { Ran } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const runnerDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "runner-health-"));
  dirs.push(root);
  const dir = join(root, "runner");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const NOW = 1_800_000_000_000;
const aged = (dir: string, ageMs: number): void => {
  const at = (NOW - ageMs) / 1000;
  utimesSync(healthPath(dir), at, at);
};

test("the health file is 0600, replaced atomically, and holds the latest write", () => {
  const dir = runnerDir();
  writeHealth(dir, { pid: 11, gen: 1, monotonicMs: 5, wallAt: NOW });
  writeHealth(dir, { pid: 11, gen: 2, monotonicMs: 6, wallAt: NOW + 15_000 });
  expect(statSync(healthPath(dir)).mode & 0o777).toBe(0o600);
  expect(readHealth(dir)?.health).toEqual({ pid: 11, gen: 2, monotonicMs: 6, wallAt: NOW + 15_000 });
  expect(readdirSync(dir)).toEqual(["health"]);
});

test("startHealth writes at once and on every tick until stopped", () => {
  const dir = runnerDir();
  let tick: (() => void) | undefined;
  let stopped = false;
  let mono = 0;
  const stop = startHealth({
    runnerDir: dir, pid: 7, gen: 3, now: () => NOW, monotonic: () => ++mono,
    every: (ms, fn) => { expect(ms).toBe(15_000); tick = fn; return () => { stopped = true; }; },
  });
  expect(readHealth(dir)?.health.monotonicMs).toBe(1);
  tick?.();
  expect(readHealth(dir)?.health.monotonicMs).toBe(2);
  stop();
  expect(stopped).toBe(true);
});

test("probe verdicts at each boundary", () => {
  const dir = runnerDir();
  writeHealth(dir, { pid: 42, gen: 4, monotonicMs: 1, wallAt: NOW });
  const at = (ageMs: number, alive = true) => { aged(dir, ageMs); return probe({ runnerDir: dir, now: () => NOW, isAlive: () => alive }); };
  expect(at(HEALTH_FRESH_MS - 1_000)).toEqual({ process: "alive", verdict: "healthy", pid: 42, gen: 4, healthAgeMs: 59_000 });
  expect(at(HEALTH_FRESH_MS + 1_000).verdict).toBe("stalled");
  expect(at(HEALTH_DEAD_MS + 1_000).verdict).toBe("dead");
  expect(at(10_000, false)).toEqual({ process: "dead", verdict: "dead", pid: 42, gen: 4, healthAgeMs: 10_000 });
});

test("no health file means dead", () => {
  expect(probe({ runnerDir: runnerDir(), now: () => NOW, isAlive: () => true })).toEqual({ process: "dead", verdict: "dead" });
});

test("probeHerdr: herdr answering is up; otherwise a herdr server process means hung, none down, a failed pgrep unknown", async () => {
  const reading = async (workspace: number, pgrep: number) => {
    const calls: string[] = [];
    const state = await probeHerdr(async (argv) => {
      calls.push(argv.join(" "));
      return { code: argv[0] === "herdr" ? workspace : pgrep, out: "", err: "" } as Ran;
    });
    return { state, calls };
  };
  expect(await reading(0, 1)).toEqual({ state: "up", calls: ["herdr workspace list"] });
  expect((await reading(1, 1)).state).toBe("down");
  expect(await reading(1, 0)).toEqual({ state: "hung", calls: ["herdr workspace list", "pgrep -f herdr server"] });
  expect((await reading(124, 0)).state).toBe("hung");
  expect((await reading(1, 127)).state).toBe("unknown");
});
