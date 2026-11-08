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
import { markHerdr } from "./herdr-world.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOW = 1_800_000_000_000;

const setup = (endpoint?: string) => {
  const stateDir = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  dirs.push(stateDir);
  mkdirSync(join(stateDir, ".dori", "runner"), { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, ".dori"), 0o700);
  chmodSync(join(stateDir, ".dori", "runner"), 0o700);
  const config = { ...defaultConfig(), stateDir, store: "json" as const };
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
  addRunner(s.stateDir, "worker-a", 3);
  const checks = runnerChecks(s.deps);
  expect(checks.find((c) => c.id === "runner endpoints")?.level).toBe("WARN");
  expect(checks.find((c) => c.id === "runner worker-a")).toMatchObject({ level: "OK", detail: "proto 3, gen 4, restarts1h 0" });
});

test("a protocol two versions apart and an open restart circuit warn", () => {
  const s = setup("100.101.1.2:7411");
  addRunner(s.stateDir, "worker-a", 6);
  const ops = openOperations(s.config);
  for (const n of [1, 2, 3]) plan(ops, NOW - n * 60_000, { lane: "runner:worker-a", action: "restart", target: `1-${n}` });
  plan(ops, NOW - 2 * 60 * 60_000, { lane: "runner:worker-a", action: "restart", target: "0-9" });
  ops.close();
  const checks = runnerChecks(s.deps);
  expect(checks.find((c) => c.id === "runner endpoints")).toMatchObject({ level: "OK", detail: "worker-a=100.101.1.2:7411" });
  const row = checks.find((c) => c.id === "runner worker-a");
  expect(row?.level).toBe("WARN");
  expect(row?.detail).toBe("proto 6 is not 4 or 3; restart circuit open (3 restarts in the last hour)");
});

test("a runner whose machine's herdr is down or hung is FAIL with the herdr command for that machine; up is OK", () => {
  const s = setup("100.101.1.2:7411");
  addRunner(s.stateDir, "worker-a", 4);
  addRunner(s.stateDir, "worker-b", 4);
  addRunner(s.stateDir, "worker-c", 3);
  addRunner(s.stateDir, "worker-d", 4);
  markHerdr(s.stateDir, "worker-a", "down", NOW - 60_000);
  markHerdr(s.stateDir, "worker-b", "hung", NOW - 60_000);
  markHerdr(s.stateDir, "worker-c", "down", NOW - 60_000);
  markHerdr(s.stateDir, "worker-d", "up", NOW - 60_000);
  const checks = runnerChecks(s.deps);
  const since = new Date(NOW - 60_000).toISOString();
  expect(checks.find((c) => c.id === "runner worker-a")).toEqual({
    id: "runner worker-a", level: "FAIL", detail: `herdr down since ${since} (no server process)`, fix: "dori runner herdr start --machine worker-a",
  });
  expect(checks.find((c) => c.id === "runner worker-b")).toMatchObject({
    level: "FAIL", detail: `herdr hung since ${since} (the server process runs but does not answer)`,
    fix: "dori runner herdr restart --machine worker-b --yes (ends every lane pane there; without --yes it lists them)",
  });
  expect(checks.find((c) => c.id === "runner worker-c")?.fix).toBe("dori runner install --machine worker-c to upgrade (proto 3 has no host.herdr), then dori runner herdr start --machine worker-c");
  expect(checks.find((c) => c.id === "runner worker-d")).toMatchObject({ level: "OK", detail: "proto 4, gen 4, restarts1h 0, herdr up" });
});
