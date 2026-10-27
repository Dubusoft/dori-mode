import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildTrace, loadTrace, traceText } from "../src/event-trace.ts";
import { EVENT_LOG, take, takeOutput, takesDir } from "../src/inbox.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, readJournal, TEST_STORE, withSqliteStore, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;
const META = { lane: "alpha", thread: "discord:42", cwd: "/repo/.wt/alpha" };

/** A supervisor on the suite's store with a busy lead, so every due event is appended to the log at once. */
const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  withSqliteStore(state.dir);
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "w", agent: "omo", agent_status: "working" });
  const open = () => {
    const supervisor = new Supervisor(depsFor(world, clock, state.dir));
    cleanups.unshift(() => supervisor.close());
    return supervisor;
  };
  return { dir: state.dir, clock, open };
};

test("enqueue meta is journaled, survives a restart, and rides in the log as an extra field take ignores", async () => {
  const f = fixture();
  const supervisor = f.open();
  supervisor.enqueue("report:a", "GH_PR acme/alpha#1 review", META);
  supervisor.enqueue("report:b", "GH_PR acme/beta#2 review");
  await supervisor.flush();
  supervisor.close();
  // The journal keeps meta on the event that had one, and none on the other.
  const events = readJournal(f.dir).events as { id: string; meta?: unknown }[];
  expect(events.find((e) => e.id === "report:a")?.meta).toEqual(META);
  expect(events.find((e) => e.id === "report:b")).not.toHaveProperty("meta");
  // The delivery log carries it as a third field; `dori inbox take` groups the lane's line under its header.
  const log = readFileSync(join(f.dir, EVENT_LOG), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  expect(log).toEqual([{ id: "report:a", line: "GH_PR acme/alpha#1 review", meta: META }, { id: "report:b", line: "GH_PR acme/beta#2 review" }]);
  expect(takeOutput(take(f.dir, { maxBytes: 16_384, now: T0, peek: true }))).toEqual([
    "## lane alpha  thread discord:42  cwd /repo/.wt/alpha", "report:a\tGH_PR acme/alpha#1 review", "## other", "report:b\tGH_PR acme/beta#2 review",
  ]);
  // A restart loads meta back from the store.
  f.open().close();
  expect((readJournal(f.dir).events as { id: string; meta?: unknown }[]).find((e) => e.id === "report:a")?.meta).toEqual(META);
});

test("a consumed take receipt records when and in which session the lead took each event, before the receipt goes", async () => {
  const f = fixture();
  const supervisor = f.open();
  supervisor.enqueue("discord:11:1", "INBOUND 11 1 owner hello", META);
  await supervisor.flush();
  expect(buildTrace("discord:11:1", loadTrace(f.dir, "discord:11:1") ?? { delivered: false })?.open).toEqual(["taken", "acked", "handled"]);
  f.clock.at = T0 + 5_000;
  take(f.dir, { maxBytes: 16_384, now: f.clock.now(), session: "sess-1" });
  supervisor.ackTick(60_000);
  const trace = buildTrace("discord:11:1", loadTrace(f.dir, "discord:11:1") ?? { delivered: false });
  // The json store records no delivery times; sqlite has the delivery row's.
  expect(trace).toEqual({
    id: "discord:11:1", line: "INBOUND 11 1 owner hello", meta: META,
    steps: [
      { step: "enqueued", at: T0 },
      { step: "delivered", ...(TEST_STORE === "sqlite" ? { at: T0 } : {}) },
      { step: "taken", at: T0 + 5_000, detail: "session sess-1" },
    ],
    open: ["acked", "handled"],
  });
  // A replayed receipt (a crash before it was dropped) keeps the first take.
  mkdirSync(takesDir(f.dir), { recursive: true });
  writeFileSync(join(takesDir(f.dir), `${T0 + 9_000}-replay.json`), JSON.stringify({ offset: 0, ids: ["discord:11:1"], at: T0 + 9_000, session: "sess-2" }));
  supervisor.ackTick(60_000);
  expect(loadTrace(f.dir, "discord:11:1")).toMatchObject({ takenAt: T0 + 5_000, takenSession: "sess-1" });
});

test("buildTrace: owner ack/handled, a reported lane outcome, a pruned event, and an unknown id", () => {
  const event = { id: "e", line: "LANE_CLOSED alpha", at: T0 };
  expect(buildTrace("e", { event, delivered: true, deliveredAt: T0 + 1, takenAt: T0 + 2, owner: { ackedAt: T0 + 3, handledAt: T0 + 4 } })?.steps.map((s) => s.step))
    .toEqual(["enqueued", "delivered", "taken", "acked", "handled"]);
  const reported = buildTrace("e", { event, delivered: true, takenAt: T0 + 2, outcome: { lane: "alpha", since: T0, events: ["e"], reportedAt: T0 + 9, note: "told" } });
  expect(reported?.steps.at(-1)).toEqual({ step: "reported", at: T0 + 9, detail: "lane alpha: told" });
  expect(reported?.open).toEqual([]);
  expect(buildTrace("e", { event, delivered: true, outcome: { lane: "alpha", since: T0, events: ["e"] } })?.open).toEqual(["taken", "reported"]);
  expect(buildTrace("e", { tombstoned: true, delivered: false })?.steps).toEqual([{ step: "pruned", detail: "body expired; dedupe tombstone kept" }]);
  expect(buildTrace("e", { delivered: false })).toBeUndefined();
  expect(traceText({ id: "e", line: "X", meta: { lane: "alpha" }, steps: [{ step: "enqueued", at: T0 }], open: ["delivered"] }))
    .toEqual(["EVENT e X", "META lane=alpha", `${new Date(T0).toISOString()}\tenqueued`, "OPEN delivered"]);
});

const cli = async (dir: string, args: string[]) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("dori event trace prints the timeline, --json the trace, and an unknown id is not found with a non-zero exit", async () => {
  const f = fixture();
  const supervisor = f.open();
  supervisor.enqueue("report:a", "GH_PR acme/alpha#1 review", META);
  await supervisor.flush();
  supervisor.close();
  const text = await cli(f.dir, ["event", "trace", "report:a"]);
  expect(text.code).toBe(0);
  expect(text.out.split("\n")[0]).toBe("EVENT report:a GH_PR acme/alpha#1 review");
  expect(text.out).toContain("OPEN taken");
  const json = await cli(f.dir, ["event", "trace", "report:a", "--json"]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.out)).toMatchObject({ id: "report:a", meta: META, open: ["taken"] });
  const unknown = await cli(f.dir, ["event", "trace", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("EVENT_NOT_FOUND nope");
}, 30_000);
