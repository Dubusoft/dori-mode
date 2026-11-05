import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { runnerChecks } from "../src/doctor.ts";
import { openOperations, plan } from "../src/operations.ts";
import { HUB_FILE, RunnerHub } from "../src/runner/hub.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOW = 1_800_000_000_000;

const setup = (runners: object | undefined) => {
  const stateDir = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  dirs.push(stateDir);
  const config = { ...defaultConfig(), stateDir, store: "json" as const, ...(runners ? { runners } : {}) };
  return { config, stateDir, deps: { config, clock: { now: () => NOW, sleep: async () => {} }, home: stateDir, exists: existsSync } };
};

const addRunner = (stateDir: string, label: string, proto: number): void => {
  new RunnerHub({ stateDir, commit: () => true, now: () => NOW, monotonic: () => 0, epoch: 1 }).close();
  const db = new Database(join(stateDir, HUB_FILE));
  db.query("INSERT INTO runners (label, eventAck, cmdSeq, maxGen, cmdAck, proto) VALUES (?, 0, 0, 4, 0, ?)").run(label, proto);
  db.close();
};

test("without a runners section doctor has no runner checks", () => {
  expect(runnerChecks(setup(undefined).deps)).toEqual([]);
});

test("a missing listen address warns; a healthy runner is OK", () => {
  const s = setup({ mode: { "worker-a": "shadow" } });
  addRunner(s.stateDir, "worker-a", 1);
  const checks = runnerChecks(s.deps);
  expect(checks.find((c) => c.id === "runner listen")?.level).toBe("WARN");
  expect(checks.find((c) => c.id === "runner worker-a")).toMatchObject({ level: "OK", detail: "proto 1, gen 4, restarts1h 0" });
});

test("a protocol two versions apart and an open restart circuit warn", () => {
  const s = setup({ listen: "100.101.1.2:7411" });
  addRunner(s.stateDir, "worker-a", 3);
  const ops = openOperations(s.config);
  for (const n of [1, 2, 3]) plan(ops, NOW - n * 60_000, { lane: "runner:worker-a", action: "restart", target: `1-${n}` });
  plan(ops, NOW - 2 * 60 * 60_000, { lane: "runner:worker-a", action: "restart", target: "0-9" });
  ops.close();
  const checks = runnerChecks(s.deps);
  expect(checks.find((c) => c.id === "runner listen")).toMatchObject({ level: "OK", detail: "100.101.1.2:7411 (private)" });
  const row = checks.find((c) => c.id === "runner worker-a");
  expect(row?.level).toBe("WARN");
  expect(row?.detail).toBe("proto 3 is not 1 or 0; restart circuit open (3 restarts in the last hour)");
});
