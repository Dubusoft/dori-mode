import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { UNRESOLVED_FILE } from "../src/decision-obligations.ts";
import { DECISIONS_FILE } from "../src/decision-store.ts";
import { eventClass } from "../src/event-policy.ts";
import { UNREPORTED_FILE } from "../src/lane-outcomes.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { staleBlocker } from "../src/update-blocker.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); withSqliteStore(state.dir); });
afterEach(() => { state.done(); });

const SINCE = 1_000;
/** The fake World's lane worktree (fakes.ts WT) is found by this key. */
const KEY = "demo-lane";
const BINDING_FIELDS = "state,headRefName,headRefOid,baseRefName,isCrossRepository";

/** A not-done lane whose runner reported its agent dead on its pane, PR merged, worktrees clean, nothing open: every condition holds. */
const check = async (patch: Partial<Lane> = {}, world: Partial<World> = {}, files: Record<string, unknown> = {}) => {
  for (const [name, value] of Object.entries(files)) writeFileSync(join(state.dir, name), JSON.stringify(value));
  const w = { ...newWorld(), ...world };
  const base = depsFor(w, fakeClock(SINCE + 7 * 60 * 60_000), state.dir);
  // The `merged` Done signal's PR as readBindings reads it: merged from the lane's branch into dev while w.prState says so.
  const run: Runner = async (argv, opts) => argv[1] === "pr" && argv[2] === "view" && argv.includes(BINDING_FIELDS)
    ? { code: 0, out: JSON.stringify({ state: w.prState, headRefName: KEY, headRefOid: "a".repeat(40), baseRefName: "dev", isCrossRepository: false }), err: "" }
    : base.run(argv, opts);
  const deps = { ...base, run };
  const lane: Lane = {
    key: KEY, title: "t", thread: "chat:1", brief: "/b.md", cwd: state.dir, pane: "p1", deadAlertPane: "p1", status: "not-done",
    done: "merged a/b#1", openedAt: new Date(0).toISOString(), ...patch,
  };
  await deps.registry.write(lane);
  const events: [string, string][] = [];
  const verdict = await staleBlocker(deps, KEY, SINCE, async (line, id) => { events.push([id, line]); });
  return { verdict, events, after: await deps.registry.read(KEY) };
};

test("a dead lane with nothing open, clean worktrees and its PR merged is closed through the normal close", async () => {
  const { verdict, events, after } = await check();
  expect(verdict).toEqual({ closed: true });
  expect(after && statusOf(after)).toBe("closed");
  expect(events[0]?.[0]).toBe(`update-blocker-closed:${KEY}:${SINCE}`);
  expect(events[0]?.[1]).toStartWith(`LANE_CLOSED ${KEY} closed`);
  expect(events[0]?.[1]).toEndWith(" stale-update-blocker");
  expect(eventClass(events[0]![1])).toBe("lead-urgent");
});

test.each([
  { name: "no dead report (age alone)", patch: { deadAlertPane: undefined }, reason: "its runner has not reported its agent dead" },
  { name: "a dead report about an older pane", patch: { deadAlertPane: "p0" }, reason: "its runner has not reported its agent dead" },
  { name: "a recovery under way", patch: { recoveryPending: true }, reason: "a recovery is under way" },
  { name: "uncommitted work", world: { dirty: " M src/x.ts" }, reason: "unpushed work in" },
  { name: "unpushed commits", world: { aheadCount: "2" }, reason: "unpushed work in" },
  { name: "a PR not merged", world: { prState: "OPEN" }, reason: "no PR of it is confirmed merged" },
  { name: "a remote lane", patch: { machine: "m1" }, reason: "a remote lane (m1)" },
  { name: "an open decision obligation", files: { [UNRESOLVED_FILE]: [{ id: "ev-7", since: 1, line: `LANE_NOT_DONE ${KEY} checks failed` }] }, reason: "open decisions: ev-7" },
  { name: "an open owner decision", files: { [DECISIONS_FILE]: { nextSeq: 2, decisions: [{ id: "d1", state: "open", lane: KEY, source: "lane", channel: "c", question: "q", options: [], openedAt: 1 }] } }, reason: "open decisions: d1" },
  { name: "an unreported outcome", files: { [UNREPORTED_FILE]: [{ lane: KEY, since: 1 }] }, reason: "an outcome of it is not reported" },
] as { name: string; patch?: Partial<Lane>; world?: Partial<World>; files?: Record<string, unknown>; reason: string }[])(
  "$name keeps the lane open and gives the lead its state instead", async ({ patch, world, files, reason }) => {
    const { verdict, events, after } = await check(patch, world, files);
    expect(after && statusOf(after)).toBe("not-done");
    expect(events).toEqual([]);
    if (verdict.closed) throw new Error("closed");
    expect(verdict.line).toStartWith(`AUTO_UPDATE_BLOCKER_STALE ${KEY} status=not-done holds the automatic update back since ${new Date(SINCE).toISOString()}; last report none; decisions `);
    expect(verdict.line).toContain("; branch ");
    expect(verdict.line).toContain(reason);
  },
);
