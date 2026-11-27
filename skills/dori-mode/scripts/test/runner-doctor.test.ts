import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { runnerChecks } from "../src/doctor.ts";
import { openOperations, plan } from "../src/operations.ts";
import { HUB_FILE, RunnerHub } from "../src/runner/hub.ts";
import { writeRunnerEndpoint } from "../src/runner/endpoints.ts";
import { withSqliteStore } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOW = 1_800_000_000_000;

const setup = (endpoint?: string) => {
  const stateDir = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  dirs.push(stateDir);
  mkdirSync(join(stateDir, ".dori", "runner"), { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, ".dori"), 0o700);
  chmodSync(join(stateDir, ".dori", "runner"), 0o700);
  withSqliteStore(stateDir);
  const config = { ...defaultConfig(), stateDir };
  if (endpoint) writeRunnerEndpoint(stateDir, "worker-a", endpoint);
  return { config, stateDir, deps: { config, clock: { now: () => NOW, sleep: async () => {} }, home: stateDir, exists: existsSync } };
};

const addRunner = (stateDir: string, label: string, proto: number): void => {
  new RunnerHub({ stateDir, commit: () => true, now: () => NOW, monotonic: () => 0, epoch: 1 }).close();
  const db = new Database(join(stateDir, HUB_FILE));
  db.query("INSERT INTO runners (label, eventAck, cmdSeq, maxGen, cmdAck, proto) VALUES (?, 0, 0, 4, 0, ?)").run(label, proto);
  db.close();
};

test("without recorded endpoints doctor still checks local runner basics", () => {
  const checks = runnerChecks(setup(undefined).deps);
  expect(checks.find((c) => c.id === "runner endpoints")).toMatchObject({ level: "WARN" });
});

test("missing endpoints warn; a healthy runner is OK", () => {
  const s = setup();
  addRunner(s.stateDir, "worker-a", 10);
  addRunner(s.stateDir, "worker-b", 9);
  const checks = runnerChecks(s.deps);
  expect(checks.find((c) => c.id === "runner endpoints")?.level).toBe("WARN");
  expect(checks.find((c) => c.id === "runner worker-a")).toMatchObject({ level: "OK", detail: "proto 10, gen 4, restarts1h 0" });
  // A runner one proto behind still runs lanes and secrets but its lanes get no dori toodo reads until it is upgraded.
  expect(checks.find((c) => c.id === "runner worker-b")).toMatchObject({ level: "WARN", detail: "proto 9 gives its lanes no dori toodo reads (they need proto 10)", fix: expect.stringContaining("dori runner install --machine worker-b") });
});

test("a protocol two versions apart and an open restart circuit warn", () => {
  const s = setup("100.101.1.2:7411");
  addRunner(s.stateDir, "worker-a", 11);
  const ops = openOperations(s.config);
  for (const n of [1, 2, 3]) plan(ops, NOW - n * 60_000, { lane: "runner:worker-a", action: "restart", target: `1-${n}` });
  plan(ops, NOW - 2 * 60 * 60_000, { lane: "runner:worker-a", action: "restart", target: "0-9" });
  ops.close();
  const checks = runnerChecks(s.deps);
  expect(checks.find((c) => c.id === "runner endpoints")).toMatchObject({ level: "OK", detail: "worker-a=100.101.1.2:7411" });
  const row = checks.find((c) => c.id === "runner worker-a");
  expect(row?.level).toBe("WARN");
  expect(row?.detail).toBe("proto 11 is not 10 or 9; restart circuit open (3 restarts in the last hour)");
});
