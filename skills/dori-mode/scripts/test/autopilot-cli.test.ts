import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTOPILOT_LANE, DEFAULT_AUTOPILOT, type HostSummary, SHADOW_ACTION, type ToodoTask } from "../src/autopilot.ts";
import { type AutopilotDeps, autopilotMain, RECONCILE_JOB } from "../src/autopilot-cli.ts";
import { JsonOperations } from "../src/operations.ts";
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
const harness = (tasks: readonly ToodoTask[] | "unreadable", host: HostSummary = { ok: true }, now = T0 + 60_000) => {
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
    openLanes: async () => new Set(),
    quota: async () => { probes.quota++; return { readable: true, maxUsedPct: 10 }; },
    host: async () => { probes.host++; return host; },
    schedules: () => { throw new Error("candidates never touches schedules"); },
    cliArgv: ["bun", "/x/cli.ts"], now: () => now, out: (l) => { out.push(l); }, err: (l) => { err.push(l); },
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

// other subcommands

test("schedule adds the reconcile job once", async () => {
  const added: unknown[] = [];
  const out: string[] = [];
  const deps = (): AutopilotDeps => ({
    config: DEFAULT_AUTOPILOT, store, toodo: () => { throw new Error("unused"); }, openLanes: async () => new Set(),
    quota: async () => ({ readable: false }), host: async () => ({ ok: true }),
    schedules: () => ({ list: () => added as { name: string }[], add: (raw) => { added.push(raw); return raw; } }),
    cliArgv: ["/usr/bin/bun", "/abs/cli.ts"], now: () => T0, out: (l) => { out.push(l); }, err: () => {},
  });
  expect(await autopilotMain(["schedule"], deps())).toBe(0);
  expect(await autopilotMain(["schedule"], deps())).toBe(0);
  expect(out.map((l) => l.split(" ")[0])).toEqual(["AUTOPILOT_SCHEDULE_ADDED", "AUTOPILOT_SCHEDULE_EXISTS"]);
  expect(added).toEqual([{
    name: RECONCILE_JOB, type: "schedule", kind: "AUTOPILOT_RECONCILE", cron: "0 * * * *", catchUp: "once",
    command: ["/usr/bin/bun", "/abs/cli.ts", "autopilot", "candidates", "--record"], since: T0,
  }]);
});

test("usage errors exit 2 with the usage; the removed bundle subcommands are unknown", async () => {
  const h = harness([]);
  for (const args of [[], ["nope"], ["approve", "b1"], ["revoke", "b1"], ["bundles"], ["candidates", "--tasks", "x"], ["candidates", "extra"], ["schedule", "--json"], ["candidates", "--bogus"]]) {
    const r = await h.run(...args);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("usage: dori autopilot candidates");
  }
  expect(h.reads).toEqual([]);
});
