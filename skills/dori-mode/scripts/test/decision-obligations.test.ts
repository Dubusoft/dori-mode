import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, loadConfig } from "../src/config.ts";
import {
  DEFAULT_RESOLVE_KINDS, isDecision, pendingResolved, recordResolved, RESOLVED_DIR, takeDecisionReminders,
} from "../src/decision-obligations.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { take, takeOutput } from "../src/inbox.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { RETENTION, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const MIN = 60_000;
const T0 = 1_800_000_000_000;

/** Console output of `work`, kept off the test log. */
const logged = async (work: () => unknown): Promise<string[]> => {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await work(); } finally { console.log = log; console.error = error; }
  return lines;
};

const fixture = (patch: Record<string, unknown> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  const deps = depsFor(world, clock, state.dir, patch);
  const reminders = () => (readJournal(state.dir).events as { id: string; line: string }[]).filter((event) => event.line.startsWith("UNRESOLVED "));
  const open = () => {
    const supervisor = new Supervisor(deps);
    cleanups.unshift(() => supervisor.close());
    return supervisor;
  };
  return { state, clock, deps, world, reminders, open };
};

test("the default kinds table matches decision events like eventPolicy does, and nothing else", () => {
  const kinds = DEFAULT_RESOLVE_KINDS;
  for (const line of [
    "LANE_REPORT alpha question which db?", "LANE_REPORT alpha blocked no token", "LANE_REPORT_LATE alpha question x", "LANE_REPORT_LATE alpha blocked x",
    "LANE_REPORT_LATE alpha done x", "LANE_NOT_DONE alpha dirty tree", "WAIT_DONE ci green", "WAIT_TIMEOUT ci", "WAIT_FAILED ci", "DEAD_PANE w:p3",
  ]) expect(isDecision(line, kinds)).toBe(true);
  for (const line of ["LANE_REPORT alpha progress x", "LANE_REPORT alpha done x", "LANE_REPORT_LATE alpha milestone x", "LANE_CLOSED alpha", "WAIT_DONEX x", "INBOUND 1 1 hi"]) {
    expect(isDecision(line, kinds)).toBe(false);
  }
});

test("a decision event stays open: UNRESOLVED after resolveTimeoutMin, re-sent with backoff across restarts, closed by dori resolved", async () => {
  const f = fixture();
  const supervisor = f.open();
  supervisor.enqueue("wait:1", "WAIT_DONE ci green on acme/app#7");
  supervisor.enqueue("report:p", "LANE_REPORT alpha progress halfway");
  expect(readJournal(f.state.dir).pending).toEqual([{ id: "wait:1", since: T0, line: "WAIT_DONE ci green on acme/app#7" }]);
  f.clock.at = T0 + 15 * MIN - 1;
  supervisor.resolveTick();
  expect(f.reminders()).toEqual([]);
  f.clock.at = T0 + 15 * MIN;
  supervisor.resolveTick();
  expect(f.reminders()).toEqual([expect.objectContaining({ id: "unresolved:wait:1:1", line: "UNRESOLVED wait:1 WAIT_DONE ci green on acme/app#7" })]);
  // A restarted supervisor reads the obligation back from the store and keeps the count: next one window later, then twice that.
  supervisor.close();
  cleanups.shift();
  const restarted = f.open();
  f.clock.at += 15 * MIN;
  restarted.resolveTick();
  expect(f.reminders()).toHaveLength(2);
  f.clock.at += 30 * MIN - 1;
  restarted.resolveTick();
  expect(f.reminders()).toHaveLength(2);
  f.clock.at += 1;
  restarted.resolveTick();
  expect(f.reminders()).toHaveLength(3);
  expect(readJournal(f.state.dir).pending[0]).toMatchObject({ id: "wait:1", reminders: 3 });
  // The lead resolves it: the receipt is consumed and nothing more is sent.
  recordResolved(f.state.dir, "wait:1", f.clock.now(), "merged it");
  const lines = await logged(() => restarted.resolveTick());
  expect(lines).toContain("DECISION_RESOLVED wait:1");
  expect(readdirSync(join(f.state.dir, RESOLVED_DIR))).toEqual([]);
  expect(readJournal(f.state.dir).pending[0]).toMatchObject({ id: "wait:1", resolvedAt: f.clock.now(), note: "merged it" });
  f.clock.at += 240 * MIN;
  restarted.resolveTick();
  expect(f.reminders()).toHaveLength(3);
});

test("a receipt that arrives before its event closes it; an id no event ever had is kept and logged as unmatched", async () => {
  const f = fixture();
  const supervisor = f.open();
  recordResolved(f.state.dir, "dead:p3", f.clock.now());
  const lines = await logged(() => supervisor.resolveTick());
  expect(lines).toContain("DECISION_RESOLVED_UNMATCHED dead:p3");
  supervisor.enqueue("dead:p3", "DEAD_PANE w:p3");
  supervisor.enqueue("dead:p4", "DEAD_PANE w:p4");
  f.clock.at += 15 * MIN;
  supervisor.resolveTick();
  expect(f.reminders().map((event) => event.line)).toEqual(["UNRESOLVED dead:p4 DEAD_PANE w:p4"]);
  expect(readJournal(f.state.dir).pending.find((item: { id: string }) => item.id === "dead:p3")).toMatchObject({ resolvedAt: T0, line: "DEAD_PANE w:p3" });
});

test("decision events in the history at startup, and decision events that never reach the lead, open nothing", () => {
  const f = fixture({ eventPolicy: resolveEventPolicy({ kinds: { DEAD_PANE: "engine-only" } }) });
  writeJournal(f.state.dir, { events: [{ id: "wait:old", line: "WAIT_DONE old", at: T0 - 60 * MIN }] });
  const supervisor = f.open();
  supervisor.enqueue("dead:p1", "DEAD_PANE w:p1");
  f.clock.at += 60 * MIN;
  supervisor.resolveTick();
  expect(readJournal(f.state.dir).pending ?? []).toEqual([]);
  expect(f.reminders()).toEqual([]);
});

test("open decisions are listed for inbox take until resolved", () => {
  const f = fixture();
  const supervisor = f.open();
  expect(takeDecisionReminders(f.state.dir)).toEqual([]);
  supervisor.enqueue("report:q", "LANE_REPORT alpha question which db?");
  supervisor.resolveTick();
  expect(takeDecisionReminders(f.state.dir)).toEqual([
    `unresolved:report:q\tUNRESOLVED report:q since ${new Date(T0).toISOString()}: decide and act on it, then run dori resolved report:q`,
  ]);
  recordResolved(f.state.dir, "report:q", f.clock.now());
  supervisor.resolveTick();
  expect(takeDecisionReminders(f.state.dir)).toEqual([]);
});

test("retention keeps the body of an open decision event and prunes it once resolved", async () => {
  const f = fixture({ store: "sqlite" });
  f.world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const supervisor = new Supervisor({
    ...f.deps,
    run: async (argv) => {
      if (argv[0] === "herdr" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: f.world.panes } }), err: "" };
      if (argv[0] === "herdr" && argv[2] === "read") return { code: 0, out: "working", err: "" };
      throw new Error(`unexpected ${argv.join(" ")}`);
    },
  });
  cleanups.unshift(() => supervisor.close());
  supervisor.enqueue("wait:keep", "WAIT_DONE keep");
  supervisor.enqueue("wait:go", "WAIT_DONE go");
  await supervisor.flush();
  recordResolved(f.state.dir, "wait:go", f.clock.now());
  supervisor.resolveTick();
  f.clock.at += RETENTION.eventBodyMs + 60 * MIN;
  supervisor.ackTick(60_000);
  const store = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  cleanups.unshift(() => store.close());
  const ids = store.read(false).events.map((event) => event.id);
  expect(ids).toContain("wait:keep");
  expect(ids).not.toContain("wait:go");
});

test("a version 6 database is migrated to 7 and keeps decision obligations", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, SQLITE_FILE);
  new SqliteStore(path, { create: true }).close();
  const raw = new Database(path);
  raw.exec("ALTER TABLE lead_state DROP COLUMN pending; UPDATE meta SET value = '6' WHERE key = 'schema_version'");
  raw.close();
  const store = new SqliteStore(path);
  expect(store.meta("schema_version")).toBe("8");
  const pending = [{ id: "wait:1", since: T0, line: "WAIT_DONE x" }];
  store.save({ events: [], pending }, "full");
  store.close();
  const again = new SqliteStore(path);
  expect(again.load()?.pending).toEqual(pending);
  again.close();
});

test("config: resolveKinds and resolveTimeoutMin default, load from the file, and a malformed kind is refused", async () => {
  const state = withState();
  cleanups.push(state.done);
  expect(defaultConfig("/h").resolveKinds).toEqual(DEFAULT_RESOLVE_KINDS);
  expect(defaultConfig("/h").resolveTimeoutMin).toBe(15);
  const path = join(state.dir, "c.json");
  writeFileSync(path, JSON.stringify({ resolveKinds: ["WAIT_DONE", "GH_PR * review"], resolveTimeoutMin: 3 }));
  const c = await loadConfig(path, "/h");
  expect([c.resolveKinds, c.resolveTimeoutMin]).toEqual([["WAIT_DONE", "GH_PR * review"], 3]);
  for (const bad of ["WAIT_DONE", ["* x"], ["A  B"], [7]]) {
    writeFileSync(path, JSON.stringify({ resolveKinds: bad }));
    expect(loadConfig(path, "/h")).rejects.toThrow("resolveKinds");
  }
});

const cli = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("dori resolved is lead-only, takes several ids, names unmatched ones, and writes one receipt each", async () => {
  const f = fixture();
  const supervisor = f.open();
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  supervisor.resolveTick();
  const denied = await cli(f.state.dir, ["resolved", "wait:1"], { DORI_LANE_KEY: "alpha" });
  expect(denied.code).toBe(2);
  expect(denied.err).toStartWith("DORI_CLI_LANE_ONLY resolved:");
  const usage = await cli(f.state.dir, ["resolved"]);
  expect(usage.code).toBe(1);
  expect(existsSync(join(f.state.dir, RESOLVED_DIR))).toBe(false);
  const ok = await cli(f.state.dir, ["resolved", "wait:1", "typo:9", "--note", "merged"]);
  expect(ok.code).toBe(0);
  expect(ok.out.trim().split("\n")).toEqual(["RESOLVED_RECORDED wait:1", "RESOLVED_UNMATCHED typo:9: no open decision has this id; recorded anyway"]);
  expect(pendingResolved(f.state.dir).map(({ id, note }) => ({ id, note })).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual([{ id: "typo:9", note: "merged" }, { id: "wait:1", note: "merged" }]);
  const taken = await cli(f.state.dir, ["inbox", "take"]);
  expect(taken.out).toContain("unresolved:wait:1\tUNRESOLVED wait:1 since ");
});

/** A lead pane that is idle, with a fresh omo session, as push-delivery.test.ts sets it up. */
const pushFixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock: ReturnType<typeof fakeClock> = { at: T0, now: () => clock.at, sleep: async () => {} /* confirm waits inside sendVerified must not move the escalation clock: the "N min" in the handoff reason counts only the test's own steps */ };
  const world = newWorld();
  world.screen = `\u2500\u2500 \u2022 Working ${"\u2500".repeat(40)}\n\u276f \n${"\u2500".repeat(80)}\n/repo\n(\u{1F63A} OmO Native by Q Kim)`;
  const session = "11111111-1111-4111-8111-111111111111";
  const config = {
    sessionsDir: join(state.dir, "sessions"), defaultCwd: "/repo",
    delivery: { ...defaultConfig().delivery, tailMonitor: false },
    eventPolicy: resolveEventPolicy({ kinds: { UNRESOLVED: "lead-urgent" } }),
  };
  const dir = sessionDirFor(config.sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2027-01-15T08-00-00-000Z_${session}.jsonl`);
  writeFileSync(file, "{}\n");
  utimesSync(file, clock.now() / 1000, clock.now() / 1000);
  const pane = { pane_id: "lead:p1", workspace_id: "test", cwd: "/repo", agent: "omo", agent_status: "idle" };
  world.panes.push(pane);
  let active = session;
  let pid = 101;
  let prompt: string | undefined;
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const ok = (out = "") => ({ code: 0, out, err: "" });
    if (argv[0] === "ps" && argv[1] === "-A") return ok(pid ? `${pid} 10 /usr/bin/omo --session-id ${active}` : "");
    if (argv[0] === "ps" && argv[1] === "eww") return ok("PI_SESSION_ID=other");
    if (argv[0] === "herdr" && argv[2] === "list") return ok(JSON.stringify({ result: { panes: world.panes } }));
    if (argv[0] === "herdr" && argv[2] === "process-info") return ok(JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_processes: pid ? [{ pid, argv: ["omo", "--session-id", active] }] : [] } } }));
    if (argv[0] === "kill") {
      if (argv[2] === String(pid)) { pid = 0; pane.agent = ""; pane.agent_status = ""; }
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "run") {
      const path = /@([^'\s]+)/.exec(argv[4] ?? "")?.[1];
      prompt = path ? readFileSync(path, "utf8") : undefined;
      active = /--session-id ([\w-]+)/.exec(argv[4] ?? "")?.[1] ?? "";
      pid = 201;
      mkdirSync(join(dir, "session-holders", active), { recursive: true });
      writeFileSync(join(dir, "session-holders", active, `${pid}.json`), "{}");
      pane.agent = "omo";
      pane.agent_status = "idle";
      return ok();
    }
    if (argv[0] === "herdr" && ["wait", "send-text", "send-keys"].includes(argv[2] ?? "")) return ok();
    if (argv[0] === "herdr" && argv[2] === "read") return ok(world.screen);
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = { ...depsFor(world, clock, state.dir, config), run };
  return {
    state, deps, clock,
    texts: () => calls.filter((call) => call[0] === "herdr" && call[2] === "send-text").map((call) => call[4] ?? ""),
    launches: () => calls.filter((call) => call[0] === "herdr" && call[2] === "run"),
    prompt: () => prompt,
  };
};

test("a decision taken but not resolved keeps an idle lead pushed (UNRESOLVED in the pointer), escalates it into a handoff naming it; dori resolved ends it", async () => {
  const f = pushFixture();
  const supervisor = new Supervisor(f.deps);
  cleanups.unshift(() => supervisor.close());
  const flush = () => logged(() => supervisor.flush());
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush();
  expect(f.texts()).toHaveLength(1);
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual(["wait:1\tWAIT_DONE ci green"]);
  await flush();
  expect(f.texts()).toHaveLength(1);
  // Taken, yet past resolveTimeoutMin it is pushed again with nothing untaken in the log.
  f.clock.at += 15 * MIN;
  await flush();
  expect(f.texts()).toHaveLength(2);
  expect(f.texts()[1]).toStartWith("[dori] supervisor: 1 new event (urgent: UNRESOLVED).");
  for (let i = 0; i < 8 && !f.launches().length; i++) {
    f.clock.at += MIN;
    await flush();
  }
  expect(f.launches()).toHaveLength(1);
  const prompt = f.prompt() ?? "";
  expect(prompt).toContain("it did not take pushed events (1 decision(s) not resolved for 5 min)");
  // The prompt carries no obligation line: the new lead's take prints it as a reminder.
  expect(prompt).not.toContain("UNRESOLVED wait:1");
  expect(takeDecisionReminders(f.state.dir)).toEqual([expect.stringMatching(/^unresolved:wait:1\tUNRESOLVED wait:1 since /)]);
  recordResolved(f.state.dir, "wait:1", f.clock.now());
  supervisor.resolveTick();
  const pushed = f.texts().length;
  for (let i = 0; i < 12; i++) {
    f.clock.at += MIN;
    await flush();
  }
  expect(f.texts()).toHaveLength(pushed);
  expect(f.launches()).toHaveLength(1);
});
