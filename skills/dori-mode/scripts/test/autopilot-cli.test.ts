import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTOPILOT_LANE, DEFAULT_AUTOPILOT, type HostSummary, ledgerRows, SHADOW_ACTION, type ToodoTask } from "../src/autopilot.ts";
import { type AutopilotDeps, autopilotMain } from "../src/autopilot-cli.ts";
import { JsonOperations } from "../src/operations.ts";
import { acquireStateLock } from "../src/state-lock.ts";
import { ToodoClient, type ToodoFetch, ToodoUnreadable } from "../src/toodo-client.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const WS = 7;

let dir: string;
let store: JsonOperations;
let tokenFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-autopilot-cli-"));
  store = new JsonOperations(dir);
  tokenFile = join(dir, "web-token");
  writeFileSync(tokenFile, "tok-1\n");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const task = (id: number, over: Partial<ToodoTask> = {}): ToodoTask => ({
  id, workspaceId: WS, title: `task ${id}`, description: `do ${id}`, status: "planned", resolution: null, dependsOn: [],
  refs: ["owner:discord:c/m"], criteria: [{ text: "tests pass", kind: "manual" }], wait: null, autopilot: true, dueDate: null, ...over,
});

/** toodo-server's JSON for a task: extra fields, criteria with a null target. */
const wire = (t: ToodoTask) => ({
  ...t, taskType: "feature", labels: [], notes: [], timeline: [], autopilotAt: t.autopilot ? 1_700_000_000 : null,
  criteria: t.criteria.map((c, i) => ({ id: i + 1, text: c.text, kind: c.kind, target: c.target ?? null, state: "unchecked" })),
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// toodo client

test("list_tasks posts the ids with the bearer token and returns the predicate's task fields", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: ToodoFetch = async (url, init) => { calls.push({ url, init }); return json(200, [wire(task(12, { dependsOn: [3], dueDate: "2026-02-01" }))]); };
  const client = new ToodoClient({ url: "http://toodo.test/", tokenFile }, { fetch });
  expect(await client.tasksByIds([12, 12, 3])).toEqual([task(12, { dependsOn: [3], dueDate: "2026-02-01" })]);
  expect(calls.map((c) => [c.url, c.init.method, (c.init.headers as Record<string, string>).authorization, c.init.body])).toEqual([
    ["http://toodo.test/api/rpc/list_tasks", "POST", "Bearer tok-1", JSON.stringify({ filter: { ids: [12, 3] } })],
  ]);
});

test("flaggedTasks reads every planned task of every workspace and keeps the marked ones; an old server reads unmarked", async () => {
  const bodies: unknown[] = [];
  const old = { ...wire(task(14)) } as Record<string, unknown>;
  delete old.autopilot;
  delete old.dueDate;
  const fetch: ToodoFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body as string));
    return json(200, [wire(task(12)), wire(task(13, { autopilot: false, workspaceId: 9 })), old, wire(task(15, { workspaceId: 9 }))]);
  };
  const client = new ToodoClient({ url: "http://toodo.test", tokenFile }, { fetch });
  expect((await client.flaggedTasks()).map((t) => [t.id, t.workspaceId])).toEqual([[12, WS], [15, 9]]);
  expect(bodies).toEqual([{ filter: { statuses: ["planned"] } }]);
});

test("a non-boolean autopilot or a non-string dueDate is ToodoUnreadable", async () => {
  for (const bad of [{ autopilot: "yes" }, { dueDate: 20260201 }]) {
    const client = new ToodoClient({ url: "http://toodo.test", tokenFile }, { fetch: async () => json(200, [{ ...wire(task(12)), ...bad }]) });
    expect(await client.flaggedTasks().catch((e: unknown) => e)).toBeInstanceOf(ToodoUnreadable);
  }
});

test("get_task returns undefined on 404", async () => {
  const client = new ToodoClient({ url: "http://toodo.test", tokenFile }, { fetch: async () => json(404, { error: "not found" }) });
  expect(await client.task(99)).toBeUndefined();
});

test("401, a network error and a missing token file are all ToodoUnreadable", async () => {
  const refused = new ToodoClient({ url: "http://toodo.test", tokenFile }, { fetch: async () => json(401, { error: "unauthorized" }) });
  const e401 = await refused.tasksByIds([1]).catch((e: unknown) => e);
  expect(e401).toBeInstanceOf(ToodoUnreadable);
  expect((e401 as ToodoUnreadable).status).toBe(401);
  const down = new ToodoClient({ url: "http://toodo.test", tokenFile }, { fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } });
  expect(await down.tasksByIds([1]).catch((e: unknown) => e)).toBeInstanceOf(ToodoUnreadable);
  const noToken = new ToodoClient({ url: "http://toodo.test", tokenFile: join(dir, "absent") }, { fetch: async () => json(200, []) });
  expect(await noToken.tasksByIds([1]).catch((e: unknown) => e)).toBeInstanceOf(ToodoUnreadable);
});

// candidates end to end

type Run = { code: number; out: string[]; err: string[] };

/** `tasks` is toodo's whole task set; flaggedTasks returns its marked planned ones, as the real client does. */
const harness = (tasks: readonly ToodoTask[] | "unreadable", host: HostSummary = { ok: true }, now = T0 + 60_000, openLanes: ReadonlySet<string> = new Set()) => {
  const reads: (number[] | "flagged")[] = [];
  const probes = { quota: 0, host: 0 };
  const unreadable = () => { throw new ToodoUnreadable("toodo-server list_tasks answered HTTP 401"); };
  const deps = (out: string[], err: string[]): AutopilotDeps => ({
    config: DEFAULT_AUTOPILOT, store,
    toodo: () => ({
      flaggedTasks: async () => {
        reads.push("flagged");
        return tasks === "unreadable" ? unreadable() : tasks.filter((t) => t.autopilot && t.status === "planned");
      },
      tasksByIds: async (ids) => {
        reads.push([...ids]);
        return tasks === "unreadable" ? unreadable() : tasks.filter((t) => ids.includes(t.id));
      },
    }),
    openLanes: async () => openLanes,
    quota: async () => { probes.quota++; return { readable: true, maxUsedPct: 10 }; },
    host: async () => { probes.host++; return host; },
    lock: () => acquireStateLock(join(dir, "autopilot-launch.lock.sqlite")),
    now: () => now, out: (l) => { out.push(l); }, err: (l) => { err.push(l); },
  });
  const run = async (...args: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    return { code: await autopilotMain(args, deps(out, err)), out, err };
  };
  return { run, reads, probes };
};

test("no marked task prints AUTOPILOT_NO_CANDIDATES and probes neither quota nor host", async () => {
  const h = harness([task(12, { autopilot: false })]);
  expect(await h.run("candidates")).toEqual({ code: 0, out: ["AUTOPILOT_NO_CANDIDATES"], err: [] });
  expect(h.reads).toEqual(["flagged"]);
  expect(h.probes).toEqual({ quota: 0, host: 0 });
});

test("toodo unreadable prints AUTOPILOT_TOODO_UNREADABLE and exits 1", async () => {
  const r = await harness("unreadable").run("candidates");
  expect([r.code, r.out]).toEqual([1, []]);
  expect(r.err[0]).toStartWith("AUTOPILOT_TOODO_UNREADABLE ");
});

test("marked tasks of every workspace are judged; their prerequisites are read in one more call", async () => {
  const dep = task(3, { status: "done", resolution: "merged", autopilot: false });
  const h = harness([task(12, { dependsOn: [3] }), task(20, { workspaceId: 99, criteria: [] }), dep, task(30, { autopilot: false })]);
  const r = await h.run("candidates");
  expect(r.out).toEqual([
    "AUTOPILOT mode=shadow record-only: nothing launches slots=unlimited candidates=2",
    "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch",
    "AUTOPILOT_CANDIDATE #20 REFUSE criteria-missing",
  ]);
  expect(h.reads).toEqual(["flagged", [3]]);
  const j = await h.run("candidates", "--json");
  expect(JSON.parse(j.out.join("\n"))).toEqual({
    mode: "shadow", slots: null,
    candidates: [{ taskId: 12, verdict: "LAUNCH", reasons: [] }, { taskId: 20, verdict: "REFUSE", reasons: ["criteria-missing"] }],
  });
});

test("--tasks adds unmarked or missing tasks, which refuse with their reasons", async () => {
  const r = await harness([task(12), task(30, { autopilot: false, refs: [] })]).run("candidates", "--tasks", "30,31");
  expect(r.out.slice(1)).toEqual([
    "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch",
    "AUTOPILOT_CANDIDATE #30 REFUSE not-flagged, owner-ref-missing",
    "AUTOPILOT_CANDIDATE #31 REFUSE task-missing",
  ]);
});

test("the host's free slots cap LAUNCH; a held host gives slots=0 and holds every task", async () => {
  const tasks = [task(12), task(13), task(14, { dueDate: "2026-01-10" })];
  const one = await harness(tasks, { ok: true, slots: 1 }).run("candidates");
  expect(one.out).toEqual([
    "AUTOPILOT mode=shadow record-only: nothing launches slots=1 candidates=3",
    "AUTOPILOT_CANDIDATE #12 HOLD no-slot",
    "AUTOPILOT_CANDIDATE #13 HOLD no-slot",
    "AUTOPILOT_CANDIDATE #14 LAUNCH would-launch",
  ]);
  const held = await harness(tasks, { ok: false, reason: "panes 20 >= 20", slots: 0 }).run("candidates");
  expect(held.out[0]).toBe("AUTOPILOT mode=shadow record-only: nothing launches slots=0 candidates=3");
  expect(held.out.slice(1).every((l) => l.endsWith("HOLD host-hold"))).toBe(true);
});

test("--record writes one shadow row per task, and a second run in the same hour adds none", async () => {
  const h = harness([task(12), task(13, { wait: { until: T0 / 1000 + 3600, status: "planned" } })]);
  const shadows = () => store.list({ lane: AUTOPILOT_LANE }).filter((op) => op.action === SHADOW_ACTION).map((op) => [op.target, op.state, op.detail]);
  expect((await h.run("candidates", "--record")).code).toBe(0);
  const first = shadows();
  expect(first).toEqual([["12@2026-01-01T12:00:00.000Z", "verified", "LAUNCH"], ["13@2026-01-01T12:00:00.000Z", "verified", "HOLD waiting"]]);
  await h.run("candidates", "--record");
  expect(shadows()).toEqual(first);
  await h.run("candidates");
  expect(shadows()).toEqual(first);
});

// launch

const rows = () => ledgerRows(store).map((op) => [op.id, op.state, op.data, op.detail]);

test("launch reserves attempt 1 as a planned row with a deterministic lane key; a second reserve holds lane-live", async () => {
  const h = harness([task(12)]);
  expect(await h.run("launch", "12")).toEqual({ code: 0, out: ["AUTOPILOT_RESERVED #12 lane=ap-12-1 attempt=1"], err: [] });
  expect(rows()).toEqual([["toodo:12/autopilot-launch/1", "planned", JSON.stringify({ laneKey: "ap-12-1" }), "planned"]]);
  expect(await h.run("launch", "12")).toEqual({ code: 1, out: [], err: ["AUTOPILOT_LAUNCH_REFUSED #12 HOLD lane-live"] });
  expect(rows().length).toBe(1);
});

test("two reserves at once under the lock: exactly one reserves", async () => {
  const h = harness([task(12)]);
  const both = await Promise.all([h.run("launch", "12"), h.run("launch", "12")]);
  expect(both.map((r) => r.code).sort()).toEqual([0, 1]);
  expect(rows().map((r) => r[0])).toEqual(["toodo:12/autopilot-launch/1"]);
});

test("--launched verifies the reservation; the running lane holds, the closed one refuses already-attempted", async () => {
  await harness([task(12)]).run("launch", "12");
  const mismatch = await harness([task(12)]).run("launch", "12", "--launched", "ap-12-2");
  expect([mismatch.code, mismatch.err]).toEqual([1, ["AUTOPILOT_LANE_MISMATCH #12 reserved=ap-12-1 given=ap-12-2"]]);
  expect(rows()[0]![1]).toBe("planned");
  const done = await harness([task(12)]).run("launch", "12", "--launched", "ap-12-1");
  expect(done).toEqual({ code: 0, out: ["AUTOPILOT_SETTLED #12 attempt=1 verified lane=ap-12-1"], err: [] });
  expect(rows()[0]!.slice(1)).toEqual(["verified", JSON.stringify({ laneKey: "ap-12-1" }), "launched ap-12-1"]);
  expect((await harness([task(12)], { ok: true }, T0, new Set(["ap-12-1"])).run("launch", "12")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #12 HOLD lane-live"]);
  expect((await harness([task(12)]).run("launch", "12")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #12 REFUSE already-attempted"]);
});

test("--failed and --ambiguous settle with the note and are never retried by itself", async () => {
  await harness([task(12), task(13)]).run("launch", "12");
  await harness([task(12), task(13)]).run("launch", "13");
  expect((await harness([task(12), task(13)]).run("launch", "12", "--failed", "--note", "pane did not start")).out)
    .toEqual(["AUTOPILOT_SETTLED #12 attempt=1 failed lane=ap-12-1"]);
  expect((await harness([task(12), task(13)]).run("launch", "13", "--ambiguous")).code).toBe(0);
  expect(rows().map((r) => [r[0], r[1], r[3]])).toEqual([
    ["toodo:12/autopilot-launch/1", "failed", "launch failed: pane did not start"],
    ["toodo:13/autopilot-launch/1", "ambiguous", "launch outcome unknown"],
  ]);
  const h = harness([task(12), task(13)]);
  expect((await h.run("launch", "12")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #12 REFUSE already-attempted"]);
  expect((await h.run("launch", "13")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #13 REFUSE already-attempted, ledger-ambiguous"]);
  expect(await h.run("launch", "12", "--failed")).toEqual({ code: 1, out: [], err: ["AUTOPILOT_NO_RESERVATION #12"] });
});

test("another task's pending reservation takes a host slot; launch order and a held host refuse too", async () => {
  const tasks = [task(12), task(13), task(14, { autopilot: false })];
  // 12 comes first in launch order, so with one slot 13 waits.
  expect((await harness(tasks, { ok: true, slots: 1 }).run("launch", "13")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #13 HOLD no-slot"]);
  expect((await harness(tasks, { ok: true, slots: 2 }).run("launch", "12")).code).toBe(0);
  // 12 is reserved but has no pane yet: the host still reports 1 free slot, and 12's reservation takes it.
  expect((await harness(tasks, { ok: true, slots: 1 }).run("launch", "13")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #13 HOLD no-slot"]);
  // Once 12's lane runs, its pane is counted by the host instead, so the free slot goes to 13.
  expect((await harness(tasks, { ok: true, slots: 1 }, T0 + 60_000, new Set(["ap-12-1"])).run("launch", "13")).out)
    .toEqual(["AUTOPILOT_RESERVED #13 lane=ap-13-1 attempt=1"]);
  expect((await harness(tasks, { ok: true, slots: 5 }).run("launch", "14")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #14 REFUSE not-flagged"]);
  expect((await harness([task(15)], { ok: false, reason: "panes 20 >= 20", slots: 0 }).run("launch", "15")).err)
    .toEqual(["AUTOPILOT_LAUNCH_REFUSED #15 HOLD host-hold"]);
  const unreadable = await harness("unreadable").run("launch", "15");
  expect([unreadable.code, unreadable.err[0]?.split(" ")[0]]).toEqual([1, "AUTOPILOT_TOODO_UNREADABLE"]);
  expect(rows().map((r) => r[0])).toEqual(["toodo:12/autopilot-launch/1", "toodo:13/autopilot-launch/1"]);
});

test("launch usage errors exit 2 and write nothing", async () => {
  const h = harness([task(12)]);
  for (const args of [["launch"], ["launch", "12", "13"], ["launch", "x"], ["launch", "12", "--failed", "--ambiguous"],
    ["launch", "12", "--launched", "ap-12-1", "--failed"], ["launch", "12", "--note", "why"], ["launch", "12", "--json"]]) {
    const r = await h.run(...args);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("dori autopilot launch <taskId>");
  }
  expect([h.reads, rows()]).toEqual([[], []]);
});

// other subcommands

test("usage errors exit 2 with the usage; the removed bundle and schedule subcommands are unknown", async () => {
  const h = harness([]);
  for (const args of [[], ["nope"], ["approve", "b1"], ["revoke", "b1"], ["bundles"], ["candidates", "--tasks", "x"], ["candidates", "extra"], ["schedule"], ["candidates", "--bogus"]]) {
    const r = await h.run(...args);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("usage: dori autopilot candidates");
  }
  expect(h.reads).toEqual([]);
});
