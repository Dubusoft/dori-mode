import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, loadConfig } from "../src/config.ts";
import { githubSummary } from "../src/github-events.ts";
import { openLaneMessages } from "../src/lane-messages.ts";
import { openLaneReports } from "../src/lane-report-store.ts";
import { openOperations } from "../src/operations.ts";
import { Registry } from "../src/registry.ts";
import { PRE_SQLITE_FILE, SQLITE_FILE, SqliteStore, openStore } from "../src/store.ts";
import { convertJsonState } from "../src/store-convert.ts";
import { acquireSupervisor } from "../src/supervise-loop.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const baseLane = { title: "t", thread: "discord:1", brief: "b", done: "d", openedAt: "2026-01-01T00:00:00.000Z" };

/** A state dir with its store; lanes are JSON files under lanes/. */
const stateFor = (): string => {
  const state = withState();
  cleanups.push(state.done);
  new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  mkdirSync(join(state.dir, "lanes"), { recursive: true });
  return state.dir;
};

test("a lane file without any runner field reads and writes", async () => {
  const dir = stateFor();
  writeFileSync(join(dir, "lanes", "plain.json"), JSON.stringify({ key: "plain", ...baseLane }));
  const registry = new Registry(dir);
  const lane = await registry.read("plain");
  expect(lane?.runner).toBeUndefined();
  expect(lane?.runnerAdoptedAt).toBeUndefined();
  expect(lane?.runnerStaleSince).toBeUndefined();
  expect(lane?.lastRunnerReportAt).toBeUndefined();
  expect((await registry.list()).map((l) => l.key)).toEqual(["plain"]);
  await registry.patch("plain", { title: "renamed" });
  const written = JSON.parse(readFileSync(registry.path("plain"), "utf8"));
  expect(written.title).toBe("renamed");
  expect("runner" in written).toBe(false);
});

test("a lane file with removed and unknown fields reads and writes, keeping them", async () => {
  const dir = stateFor();
  writeFileSync(join(dir, "lanes", "old.json"), JSON.stringify({
    key: "old", ...baseLane,
    lastRemoteReport: "[REPORT] x", remoteReportsSeen: [{ hash: "h", at: "2026-01-01T00:00:00.000Z" }], futureField: { a: 1 },
  }));
  const registry = new Registry(dir);
  expect((await registry.read("old"))?.lastRemoteReport).toBe("[REPORT] x");
  await registry.patch("old", { title: "again" });
  const written = JSON.parse(readFileSync(registry.path("old"), "utf8"));
  expect(written).toMatchObject({ title: "again", lastRemoteReport: "[REPORT] x", futureField: { a: 1 } });
  expect(written.remoteReportsSeen).toHaveLength(1);
});

test("runner fields round-trip", async () => {
  const dir = stateFor();
  const registry = new Registry(dir);
  await registry.write({ key: "owned", ...baseLane, runner: "mini", runnerAdoptedAt: 5, runnerStaleSince: 6, lastRunnerReportAt: 7 });
  expect(await registry.read("owned")).toMatchObject({ runner: "mini", runnerAdoptedAt: 5, runnerStaleSince: 6, lastRunnerReportAt: 7 });
});

test("a config with a runners section or progressTemplate loads with both ignored, valid or malformed", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  for (const runners of [{ listen: "100.64.0.1:7411", mode: { mini: "shadow" }, restartCircuit: { max: 3 } }, { listen: "0.0.0.0:7411" }, [], { restartCircuit: "x" }]) {
    await Bun.write(path, JSON.stringify({ runners, progressTemplate: "x", store: "json" }));
    const config = await loadConfig(path, "/home/ana");
    expect("runners" in config).toBe(false);
    expect("progressTemplate" in config).toBe(false);
  }
  expect("runners" in defaultConfig("/home/ana")).toBe(false);
});

test("pre-sqlite marker with no journal and no database: openStore stops with STORE_MISSING", () => {
  const state = withState();
  cleanups.push(state.done);
  writeFileSync(join(state.dir, PRE_SQLITE_FILE), "{}");
  expect(() => openStore(state.dir)).toThrow("STORE_MISSING");
  expect(existsSync(join(state.dir, SQLITE_FILE))).toBe(false);
});

test("a state dir still on the json store is converted once at the CLI entry, not by loading its config, every row readable afterwards", async () => {
  const state = withState();
  cleanups.push(state.done);
  const dir = join(state.dir, "state");
  mkdirSync(dir);
  const T0 = 1_800_000_000_000;
  // Given the files a json supervisor and its CLI left behind.
  const journal = { events: [{ id: "e1", line: "INBOUND 1 2 hi", at: T0 }], awaitingAck: [{ id: "e1", since: T0 }] };
  const op = { id: "lane/close/1", lane: "lane", action: "close", target: "1", state: "verified", detail: "closed", attempts: 1, at: T0, updatedAt: T0 + 1 } as const;
  const report = { id: "lane:0:1", lane: "lane", generation: 0, seq: 1, kind: "progress", text: "step 1", at: T0 } as const;
  const message = { id: "ci-1", lane: "lane", subject: "o/r#1@abc", text: "fix CI", state: "queued", at: T0, updatedAt: T0 } as const;
  const files: Record<string, unknown> = {
    "supervisor.json": journal,
    "operations.json": { ops: { [op.id]: op } },
    "lane-reports.json": { reports: [report] },
    "lane-messages.json": { messages: { [message.id]: message } },
    "github-events.json": { repos: {}, failures: { "o/r": T0 }, polledAt: T0 },
  };
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(body));
  writeFileSync(join(dir, "lead-events.log"), `${JSON.stringify({ id: "e1", line: "INBOUND 1 2 hi" })}\n`);
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ stateDir: dir }));
  // Loading the config alone converts nothing.
  const config = await loadConfig(path, "/home/ana");
  expect(existsSync(join(dir, "supervisor.json"))).toBe(true);
  expect(existsSync(join(dir, SQLITE_FILE))).toBe(false);
  // While a supervisor holds the lock nothing moves.
  const release = acquireSupervisor(dir);
  try { await convertJsonState(config.stateDir); } finally { release(); }
  expect(existsSync(join(dir, "supervisor.json"))).toBe(true);
  expect(existsSync(join(dir, SQLITE_FILE))).toBe(false);
  // When the CLI entry converts with no supervisor running.
  await convertJsonState(config.stateDir);
  // Then every json file is retired read-only and the store holds what they held.
  for (const file of Object.keys(files)) {
    expect(existsSync(join(dir, file))).toBe(false);
    expect(statSync(join(dir, `${file}.pre-sqlite`)).mode & 0o777).toBe(0o400);
  }
  const store = openStore(dir);
  try {
    expect(store.load()).toMatchObject({ events: [{ id: "e1", line: "INBOUND 1 2 hi", at: T0 }], awaitingAck: [{ id: "e1", since: T0 }] });
    expect([...store.deliveredIds()!]).toEqual(["e1"]);
  } finally { store.close(); }
  const ops = openOperations(config);
  try { expect(ops.list()).toEqual([op]); } finally { ops.close(); }
  const reports = openLaneReports(config);
  try { expect(reports.list()).toEqual([report]); } finally { reports.close(); }
  const messages = openLaneMessages(config);
  try { expect(messages.get(message.id)).toEqual(message); } finally { messages.close(); }
  expect(githubSummary(dir)).toEqual({ polledAt: T0, failures: { "o/r": T0 }, issueRepos: [] });
  // And a later conversion leaves the converted state dir as it is.
  const before = readFileSync(join(dir, SQLITE_FILE));
  await convertJsonState(config.stateDir);
  expect(readFileSync(join(dir, SQLITE_FILE))).toEqual(before);
});

/** A supervisor.json carrying every field a long-running json supervisor left behind, with synthetic values. */
const legacyJournal = (T0: number) => ({
  events: [{ id: "e1", line: "INBOUND 1 2 hi", at: T0, meta: { lane: "lane-a", thread: "discord:1", cwd: "/work/a" } }, { id: "e2", line: "LANE_REPORT lane-a", at: T0 + 1 }],
  awaitingAck: [
    { id: "e1", since: T0, tasks: 1, lanes: ["lane-a"], reply: true, ackedAt: T0 + 2, handledAt: T0 + 3 },
    { id: "e3", since: T0, tasks: 0, lanes: [], reply: false, ackedAt: T0 + 2, awaitingOwnerAt: T0 + 4, awaitingNote: "owner to pick" },
  ],
  notifications: { "delay:discord:11:1": { attempts: 2, sent: true }, "delay:discord:11:2": { attempts: 1 } },
  models: [{ model: "test/model", thinking: "medium" }],
  closedOwners: ["old-1", "old-2"],
  outbox: [],
  inbox: { takenOffset: 12, mode: "push+tail", sessionSince: T0 },
  outcomes: [
    { lane: "lane-a", since: T0, line: "LANE_REPORT lane-a", events: ["e2"], claimed: true, woke: true, deliveredAt: T0 + 1, deliveredWorking: false,
      reportedAt: T0 + 5, thread: "discord:1", lastReportAt: T0 + 5, heads: ["abc1234"], quiet: ["x", "y"], reminders: 1, remindedAt: T0 + 6, pushedAt: T0 + 7, note: "n", claim: "done" },
  ],
  pending: [{ id: "d1", since: T0, line: "DECISION d1", resolvedAt: T0 + 8, note: "resolved" }],
  // Fields of the removed lead model fallback chain: the store never kept them and the conversion drops them.
  leadModel: 0, primaryRetryAt: T0, primaryClearChecks: 2, quotaExhausted: { at: T0 }, quotaStallSince: T0, emergencyEpisode: 1,
});

test("a json state dir with every field real data carried converts at the CLI entry, the removed lead-chain fields dropped and the rest read back", async () => {
  const state = withState();
  cleanups.push(state.done);
  const dir = join(state.dir, "state");
  mkdirSync(dir);
  const T0 = 1_800_000_000_000;
  const journal = legacyJournal(T0);
  const ops = Object.fromEntries([1, 2].map((n) => [`lane-a/launch/${n}`, {
    id: `lane-a/launch/${n}`, lane: "lane-a", action: "launch", target: String(n), ...(n === 1 ? { data: '{"machine":"m"}' } : {}), state: "verified" as const, detail: "ok", attempts: 1, at: T0 + n, updatedAt: T0 + n,
  }]));
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify(journal));
  writeFileSync(join(dir, "operations.json"), JSON.stringify({ ops }));
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ stateDir: dir }));
  const config = await loadConfig(path, "/home/ana");
  await convertJsonState(config.stateDir);
  expect(existsSync(join(dir, PRE_SQLITE_FILE))).toBe(true);
  expect(existsSync(join(dir, "supervisor.json"))).toBe(false);
  const store = openStore(dir);
  try {
    const { leadModel, primaryRetryAt, primaryClearChecks, quotaExhausted, quotaStallSince, emergencyEpisode, ...kept } = journal;
    expect([leadModel, primaryRetryAt, primaryClearChecks, quotaExhausted, quotaStallSince, emergencyEpisode]).toHaveLength(6);
    expect(store.load()).toMatchObject(kept);
  } finally { store.close(); }
  const opStore = openOperations(config);
  try { expect(opStore.list()).toEqual(Object.values(ops)); } finally { opStore.close(); }
});

test("a json journal with a field no table keeps is refused with one line, nothing moves, and dori status exits 1 with that line and no stack", async () => {
  const state = withState();
  cleanups.push(state.done);
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [], futureField: 1 }));
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "status"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir, DORI_CONFIG: join(state.dir, "none.json") },
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(1);
  expect(err).toContain("STORE_CONVERT_FAILED");
  expect(err).toContain("STORE_IMPORT_UNKNOWN_FIELD");
  expect(err).toContain("STORE_MISSING");
  expect(err).not.toContain("    at ");
  expect(existsSync(join(state.dir, "supervisor.json"))).toBe(true);
  expect(existsSync(join(state.dir, SQLITE_FILE))).toBe(false);
});
