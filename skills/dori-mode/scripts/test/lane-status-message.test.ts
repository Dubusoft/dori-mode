import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { discordStatusTransport, JsonLaneReports, type LaneStatusTransport, type LaterMessage, routeReports } from "../src/lane-reports.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { readOwnerClosed, recordOwnerClosed } from "../src/thread-followup.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const stateDir = (): string => {
  const state = withState();
  cleanups.push(state.done);
  return state.dir;
};

const lane = (dir: string, patch: Partial<Lane> = {}): Lane => ({
  key: "local-lane", title: "t", thread: "discord:1/2", pane: "w:p7", brief: join(dir, "brief.md"), done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(), ...patch,
});

type Call = readonly ["post" | "edit" | "delete", ...string[]];
type ThreadView = { archived: boolean; parent?: string; lastMessageId?: string; later?: LaterMessage[]; failDelete?: boolean };
/** A silent post is recorded with a trailing "silent"; the thread's last message and later messages come from `thread`. */
const fakeTransport = (failEdit = false, failPost = false, thread: ThreadView = { archived: false }): { transport: LaneStatusTransport; calls: Call[] } => {
  const calls: Call[] = [];
  let n = 0;
  return {
    calls,
    transport: {
      post: async (channel, text, _id, silent) => {
        calls.push(silent ? ["post", channel, text, "silent"] : ["post", channel, text]);
        if (failPost) throw new Error("discord POST: 403 missing access");
        return `m${++n}`;
      },
      edit: async (channel, id, text) => {
        calls.push(["edit", channel, id, text]);
        if (failEdit) throw new Error("discord PATCH: 404 Unknown Message");
      },
      remove: async (channel, id) => {
        calls.push(["delete", channel, id]);
        if (thread.failDelete) throw new Error("discord DELETE: 403 missing access");
      },
      threadState: async () => ({ archived: thread.archived, parent: thread.parent, lastMessageId: thread.lastMessageId }),
      laterMessages: async () => ({ messages: thread.later ?? [], more: false }),
    },
  };
};

const statusOf = (key: string): LaterMessage => ({ own: true, type: 0, content: `[System] 레인 ${key} 상태, 진행 5분 (갱신 2026-01-01 12:00 UTC)\n마지막 마일스톤: 아직 없음` });

const quietErrors = (): string[] => {
  const errors: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  cleanups.push(() => { console.error = real; });
  return errors;
};

test("status message: the first progress posts it, later progress and milestones edit it in place; milestone still reaches the lead", async () => {
  const dir = stateDir();
  const world = newWorld();
  const clock = fakeClock(T0 + 65 * MIN);
  const base = depsFor(world, clock, dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await base.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport();
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };

  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "parser done in /home/test/repo; next the CLI", at: T0 + 60 * MIN });
  expect(await routeReports(base, store, enqueue, "/home/test", transport)).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 progress thread"]);
  expect(calls).toEqual([["post", "2", [
    "[System] 레인 local-lane 상태, 진행 1시간 5분 (갱신 2026-01-01 13:05 UTC)",
    "마지막 마일스톤: 아직 없음",
    "마지막 진행 (2026-01-01 13:00 UTC): parser done in ~/repo; next the CLI",
  ].join("\n")]]);
  expect((await base.registry.read("local-lane"))?.statusMessageId).toBe("m1");

  store.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "CLI works end to end; Done needs the PR merged; scope unchanged", at: T0 + 70 * MIN });
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "opened PR #9; next CI", at: T0 + 80 * MIN });
  expect(await routeReports(base, store, enqueue, "/home/test", transport)).toEqual([
    "LANE_REPORT_ROUTED local-lane:0:2 milestone journal", "LANE_REPORT_ROUTED local-lane:0:3 progress thread",
  ]);
  expect(journal).toEqual([["lane-report:local-lane:0:2", "LANE_REPORT local-lane milestone CLI works end to end; Done needs the PR merged; scope unchanged"]]);
  expect(calls.slice(1).map((c) => c.slice(0, 3))).toEqual([["edit", "2", "m1"], ["edit", "2", "m1"]]);
  expect(calls.at(-1)?.[3]).toBe([
    "[System] 레인 local-lane 상태, 진행 1시간 5분 (갱신 2026-01-01 13:05 UTC)",
    "마지막 마일스톤 (2026-01-01 13:10 UTC): CLI works end to end; Done needs the PR merged; scope unchanged",
    "마지막 진행 (2026-01-01 13:20 UTC): opened PR #9; next CI",
  ].join("\n"));
  // The thread hook is not used while the status message works: no new thread post per report.
  expect(world.calls.filter((c) => c[0] === "notify")).toEqual([]);
});

test("status message: every time is shown in displayTimeZone, labelled with that zone", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0 + 65 * MIN), dir, { displayTimeZone: "Asia/Seoul" });
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport();
  store.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "parser done", at: T0 + 60 * MIN });
  await routeReports(deps, store, () => {}, "/home/test", transport);
  expect(calls.at(-1)?.[2]).toBe([
    "[System] 레인 local-lane 상태, 진행 1시간 5분 (갱신 2026-01-01 22:05 KST)",
    "마지막 마일스톤 (2026-01-01 22:00 KST): parser done",
    "마지막 진행: 아직 없음",
  ].join("\n"));
});

test("status message: a failed edit (message deleted) posts a new one and stores its id", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { statusMessageId: "gone" }));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(true);
  const errors = quietErrors();
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  expect(await routeReports(deps, store, () => {}, "/home/test", transport)).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 progress thread"]);
  expect(calls.map((c) => c.slice(0, 3))).toEqual([["edit", "2", "gone"], ["post", "2", calls[1]?.[2] ?? ""]]);
  expect((await deps.registry.read("local-lane"))?.statusMessageId).toBe("m1");
  expect(errors).toEqual(["LANE_STATUS_EDIT_FAILED local-lane gone discord PATCH: 404 Unknown Message; posting a new status message"]);
});

test("status message: a thread the owner closed is neither edited nor posted into; one line linking it goes to its parent channel", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir, { discordChannels: ["main-1"] });
  await deps.registry.write(lane(dir, { statusMessageId: "s1" }));
  recordOwnerClosed(dir, "2", T0 - MIN);
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(false, false, { archived: true, parent: "1" });
  const errors = quietErrors();
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way in /home/test/repo", at: T0 });
  expect(await routeReports(deps, store, () => {}, "/home/test", transport)).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 progress thread"]);
  expect(calls).toEqual([["post", "1", "<#2> [System] 레인 local-lane 전달: half way in ~/repo"]]);
  expect((await deps.registry.read("local-lane"))?.statusMessageId).toBe("s1");
  expect(errors).toEqual(["LANE_STATUS_REDIRECTED local-lane local-lane:0:1: thread 2 was closed by the owner, so one line went to 1"]);

  // Discord naming no parent: the owner channel gets the line.
  const orphan = fakeTransport(false, false, { archived: true });
  store.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "landed", at: T0 + 1 });
  await routeReports(deps, store, () => {}, "/home/test", orphan.transport);
  expect(orphan.calls).toEqual([["post", "main-1", "<#2> [System] 레인 local-lane 전달: landed"]]);
});

test("status message: a recorded thread Discord reports open again is edited in place and its close record dropped", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { statusMessageId: "s1" }));
  recordOwnerClosed(dir, "2", T0 - MIN);
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(false, false, { archived: false, parent: "1" });
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  await routeReports(deps, store, () => {}, "/home/test", transport);
  expect(calls.map((c) => c.slice(0, 3))).toEqual([["edit", "2", "s1"]]);
  expect(readOwnerClosed(dir)).toEqual({});
});

test("status message: without a transport, a thread the owner closed gets no hook post; progress reaches the lead as a digest", async () => {
  const dir = stateDir();
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps.registry.write(lane(dir));
  recordOwnerClosed(dir, "2", T0 - MIN);
  const store = new JsonLaneReports(dir);
  const journal: [string, string][] = [];
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  expect(await routeReports(deps, store, (id, line) => { journal.push([id, line]); }, "/home/test", null)).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 progress journal"]);
  expect(world.calls.filter((c) => c[0] === "notify")).toEqual([]);
  expect(journal).toEqual([["lane-report:local-lane:0:1", "LANE_REPORT local-lane progress half way"]]);
});

test("status message: the id survives a supervisor restart through the registry, so the next report edits the same message", async () => {
  const dir = stateDir();
  const first = depsFor(newWorld(), fakeClock(T0), dir);
  await first.registry.write(lane(dir));
  new JsonLaneReports(dir).append({ lane: "local-lane", generation: 0, kind: "progress", text: "step 1", at: T0 });
  const before = fakeTransport();
  await routeReports(first, new JsonLaneReports(dir), () => {}, "/home/test", before.transport);
  expect(before.calls.map((c) => c[0])).toEqual(["post"]);

  // A new process: fresh registry, store and transport over the same state directory.
  const second = { ...depsFor(newWorld(), fakeClock(T0 + MIN), dir), registry: new Registry(dir) };
  new JsonLaneReports(dir).append({ lane: "local-lane", generation: 0, kind: "milestone", text: "step 1 landed; scope unchanged", at: T0 + MIN });
  const after = fakeTransport();
  await routeReports(second, new JsonLaneReports(dir), () => {}, "/home/test", after.transport);
  expect(after.calls.map((c) => c.slice(0, 3))).toEqual([["edit", "2", "m1"]]);
});

test("status message: no thread, no transport and no hook, or a failed post, keep progress reaching the lead as a digest LANE_REPORT", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { thread: "none" }));
  await deps.registry.write(lane(dir, { key: "bare-lane" }));
  await deps.registry.write(lane(dir, { key: "denied-lane" }));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "no thread", at: T0 });
  store.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "landed", at: T0 + 1 });
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };
  const { transport, calls } = fakeTransport();
  await routeReports(deps, store, enqueue, "/home/test", transport);
  expect(calls).toEqual([]);

  store.append({ lane: "bare-lane", generation: 0, kind: "progress", text: "no transport", at: T0 + 2 });
  await routeReports(deps, store, enqueue, "/home/test", null);

  store.append({ lane: "denied-lane", generation: 0, kind: "progress", text: "post refused", at: T0 + 3 });
  await routeReports(deps, store, enqueue, "/home/test", fakeTransport(false, true).transport);
  expect(journal).toEqual([
    ["lane-report:local-lane:0:1", "LANE_REPORT local-lane progress no thread"],
    ["lane-report:local-lane:0:2", "LANE_REPORT local-lane milestone landed"],
    ["lane-report:bare-lane:0:1", "LANE_REPORT bare-lane progress no transport"],
    ["lane-report:denied-lane:0:1", "LANE_REPORT denied-lane progress post refused (status message failed: discord POST: 403 missing access)"],
  ]);
  expect((await deps.registry.read("denied-lane"))?.statusMessageId).toBeUndefined();
});

test("status message: a milestone whose status update fails still reaches the lead and is only logged", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "landed", at: T0 });
  const errors = quietErrors();
  const journal: string[] = [];
  expect(await routeReports(deps, store, (_id, line) => { journal.push(line); }, "/home/test", fakeTransport(false, true).transport))
    .toEqual(["LANE_REPORT_ROUTED local-lane:0:1 milestone journal"]);
  expect(journal).toEqual(["LANE_REPORT local-lane milestone landed"]);
  expect(errors).toEqual(["LANE_STATUS_ERROR local-lane local-lane:0:1 discord POST: 403 missing access"]);
});

test("status message: still the thread's last message, it is edited in place", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { statusMessageId: "s1" }));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(false, false, { archived: false, lastMessageId: "s1", later: [{ own: false, type: 0, content: "never read" }] });
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  await routeReports(deps, store, () => {}, "/home/test", transport);
  expect(calls.map((c) => c.slice(0, 3))).toEqual([["edit", "2", "s1"]]);
  expect((await deps.registry.read("local-lane"))?.statusMessageId).toBe("s1");
});

test("status message: an owner message after it re-posts it silently at the bottom, stores the new id, then deletes the old one", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { statusMessageId: "s1" }));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(false, false, { archived: false, lastMessageId: "o9", later: [statusOf("other-lane"), { own: false, type: 0, content: "how is it going?" }] });
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  expect(await routeReports(deps, store, () => {}, "/home/test", transport)).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 progress thread"]);
  expect(calls.map((c) => [c[0], c[1], c[0] === "post" ? c[3] : c[2]])).toEqual([["post", "2", "silent"], ["delete", "2", "s1"]]);
  expect(calls[0]?.[2]).toContain("마지막 진행 (2026-01-01 12:00 UTC): half way");
  expect((await deps.registry.read("local-lane"))?.statusMessageId).toBe("m1");

  // A thread system message (a rename, here) or a Discord-archived thread counts as not latest too.
  for (const view of [{ archived: false, lastMessageId: "x", later: [{ ...statusOf("other-lane"), type: 4 }] }, { archived: true, lastMessageId: "m1" }]) {
    const next = fakeTransport(false, false, view);
    store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "more", at: T0 + 1 });
    await routeReports({ ...deps, registry: new Registry(dir) }, store, () => {}, "/home/test", next.transport);
    expect(next.calls.map((c) => c[0])).toEqual(["post", "delete"]);
  }
});

test("status message: only other lanes' status messages after it keep it latest, so lanes sharing a thread edit in place", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { statusMessageId: "s1" }));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(false, false, { archived: false, lastMessageId: "s3", later: [statusOf("lane-b"), statusOf("lane-c")] });
  store.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "landed", at: T0 });
  await routeReports(deps, store, () => {}, "/home/test", transport);
  expect(calls.map((c) => c.slice(0, 3))).toEqual([["edit", "2", "s1"]]);

  // The same text from someone else is not the bot's own status message.
  const forged = fakeTransport(false, false, { archived: false, lastMessageId: "s3", later: [{ ...statusOf("lane-b"), own: false }] });
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "next", at: T0 + 1 });
  await routeReports(deps, store, () => {}, "/home/test", forged.transport);
  expect(forged.calls.map((c) => c[0])).toEqual(["post", "delete"]);
});

test("status message: a failed delete of the old message is logged and the re-post still counts", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { statusMessageId: "s1" }));
  const store = new JsonLaneReports(dir);
  const { transport, calls } = fakeTransport(false, false, { archived: false, lastMessageId: "o9", later: [{ own: false, type: 0, content: "hi" }], failDelete: true });
  const errors = quietErrors();
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  expect(await routeReports(deps, store, () => {}, "/home/test", transport)).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 progress thread"]);
  expect(calls.map((c) => c[0])).toEqual(["post", "delete"]);
  expect((await deps.registry.read("local-lane"))?.statusMessageId).toBe("m1");
  expect(errors).toEqual(["LANE_STATUS_DELETE_FAILED local-lane s1 discord DELETE: 403 missing access"]);
});

test("the default Discord transport needs DORI_DISCORD_TOKEN in the environment", () => {
  expect(discordStatusTransport(fakeClock(T0), {})).toBeUndefined();
  expect(discordStatusTransport(fakeClock(T0), { DORI_DISCORD_TOKEN: " " })).toBeUndefined();
  expect(discordStatusTransport(fakeClock(T0), { DORI_DISCORD_TOKEN: "t" })).toBeDefined();
});
