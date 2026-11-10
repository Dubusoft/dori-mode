import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTOPILOT_LANE, buildBundle, DEFAULT_AUTOPILOT, saveBundle, SHADOW_ACTION, type ToodoTask } from "../src/autopilot.ts";
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
  id, workspaceId: WS, title: `task ${id}`, description: `do ${id}`, status: "planned", resolution: null, dependsOn: [], refs: [],
  criteria: [{ text: "tests pass", kind: "manual" }], wait: null, ...over,
});

/** toodo-server's JSON for a task: extra fields, criteria with a null target. */
const wire = (t: ToodoTask) => ({
  ...t, taskType: "feature", labels: [], notes: [], timeline: [],
  criteria: t.criteria.map((c, i) => ({ id: i + 1, text: c.text, kind: c.kind, target: c.target ?? null, state: "unchecked" })),
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// toodo client

test("list_tasks posts the ids with the bearer token and returns the predicate's task fields", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: ToodoFetch = async (url, init) => { calls.push({ url, init }); return json(200, [wire(task(12, { dependsOn: [3] }))]); };
  const client = new ToodoClient({ url: "http://toodo.test/", tokenFile }, { fetch });
  expect(await client.tasksByIds([12, 12, 3])).toEqual([task(12, { dependsOn: [3] })]);
  expect(calls.map((c) => [c.url, c.init.method, (c.init.headers as Record<string, string>).authorization, c.init.body])).toEqual([
    ["http://toodo.test/api/rpc/list_tasks", "POST", "Bearer tok-1", JSON.stringify({ filter: { ids: [12, 3] } })],
  ]);
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

const harness = (tasks: readonly ToodoTask[] | "unreadable", now = T0 + 60_000) => {
  const reads: number[][] = [];
  const deps = (out: string[], err: string[]): AutopilotDeps => ({
    config: { ...DEFAULT_AUTOPILOT, workspaces: [WS] }, store,
    toodo: () => ({
      tasksByIds: async (ids) => {
        reads.push([...ids]);
        if (tasks === "unreadable") throw new ToodoUnreadable("toodo-server list_tasks answered HTTP 401");
        return tasks.filter((t) => ids.includes(t.id));
      },
    }),
    openLanes: async () => new Set(), quota: async () => ({ readable: true, maxUsedPct: 10 }), host: async () => ({ ok: true }),
    schedules: () => { throw new Error("candidates never touches schedules"); },
    cliArgv: ["bun", "/x/cli.ts"], now: () => now, out: (l) => { out.push(l); }, err: (l) => { err.push(l); },
  });
  const run = async (...args: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    return { code: await autopilotMain(args, deps(out, err)), out, err };
  };
  return { run, reads };
};

const approveRow = (tasks: readonly ToodoTask[]) =>
  saveBundle(store, T0, buildBundle({ bundleId: "b1", ownerRef: "discord:c/m", now: T0, tasks, expiresDays: 7, attemptBudget: 2 }));

test("no bundle prints AUTOPILOT_NO_BUNDLES and reads nothing from toodo", async () => {
  const h = harness([]);
  expect(await h.run("candidates")).toEqual({ code: 0, out: ["AUTOPILOT_NO_BUNDLES"], err: [] });
  expect(h.reads).toEqual([]);
});

test("toodo unreadable: every member holds with toodo-unreadable only, exit 0", async () => {
  approveRow([task(12), task(13)]);
  const r = await harness("unreadable").run("candidates");
  expect(r.code).toBe(0);
  expect(r.out).toEqual([
    "AUTOPILOT mode=shadow record-only: nothing launches wip=0/1 bundles=1",
    "AUTOPILOT_CANDIDATE #12 HOLD bundle=b1 toodo-unreadable",
    "AUTOPILOT_CANDIDATE #13 HOLD bundle=b1 toodo-unreadable",
  ]);
  expect(r.err[0]).toStartWith("AUTOPILOT_TOODO_UNREADABLE ");
});

test("one approved planned task judges LAUNCH; members and dependencies are read in one call", async () => {
  const dep = task(3, { status: "done", resolution: "merged" });
  const t = task(12, { dependsOn: [3] });
  approveRow([t]);
  const h = harness([t, dep]);
  const r = await h.run("candidates");
  expect(r.out).toEqual(["AUTOPILOT mode=shadow record-only: nothing launches wip=0/1 bundles=1", "AUTOPILOT_CANDIDATE #12 LAUNCH bundle=b1 would-launch"]);
  expect(h.reads).toEqual([[12, 3]]);
  const j = await h.run("candidates", "--json");
  expect(JSON.parse(j.out.join("\n"))).toEqual({ mode: "shadow", wip: { inUse: 0, limit: 1 }, candidates: [{ taskId: 12, bundleId: "b1", verdict: "LAUNCH", reasons: [] }] });
});

test("--record writes one shadow row per task, and a second run in the same hour adds none", async () => {
  approveRow([task(12), task(13, { wait: { until: T0 / 1000 + 3600, status: "planned" } })]);
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

test("approve stores hashes from toodo; it refuses unreadable toodo, a missing task and a workspace outside the list", async () => {
  const ok = await harness([task(12), task(13)]).run("approve", "b2", "--tasks", "12,13", "--owner-ref", "discord:c/m");
  expect(ok.code).toBe(0);
  expect(ok.out[0]).toStartWith("AUTOPILOT_BUNDLE_APPROVED b2 tasks=12,13 expires=2026-01-08T12:01:00.000Z attempts=2");
  expect((await harness([task(12)]).run("bundles")).out).toEqual([
    "AUTOPILOT_BUNDLE b2 in-force tasks=12,13 expires=2026-01-08T12:01:00.000Z attempts=2 owner=discord:c/m",
  ]);
  const refused = async (tasks: readonly ToodoTask[] | "unreadable") =>
    (await harness(tasks).run("approve", "b3", "--tasks", "12", "--owner-ref", "r")).err[0]?.split(" ")[0];
  expect(await refused("unreadable")).toBe("AUTOPILOT_APPROVE_REFUSED");
  expect(await refused([])).toBe("AUTOPILOT_APPROVE_REFUSED");
  expect(await refused([task(12, { workspaceId: 99 })])).toBe("AUTOPILOT_APPROVE_REFUSED");
  expect(store.list({ lane: AUTOPILOT_LANE }).map((op) => op.target)).toEqual(["b2"]);
});

test("revoke a member then the bundle; an unknown bundle exits 1", async () => {
  approveRow([task(12), task(13)]);
  const h = harness([task(12), task(13)]);
  expect((await h.run("revoke", "b1", "--task", "13")).out).toEqual(["AUTOPILOT_MEMBER_REVOKED b1 #13"]);
  expect((await h.run("candidates")).out.slice(1)).toEqual(["AUTOPILOT_CANDIDATE #12 LAUNCH bundle=b1 would-launch", "AUTOPILOT_CANDIDATE #13 REFUSE bundle=b1 member-revoked"]);
  expect((await h.run("revoke", "b1")).out).toEqual(["AUTOPILOT_BUNDLE_REVOKED b1"]);
  expect((await h.run("candidates")).out).toEqual(["AUTOPILOT_NO_BUNDLES"]);
  expect((await h.run("revoke", "nope")).code).toBe(1);
});

test("schedule adds the reconcile job once", async () => {
  const added: unknown[] = [];
  const base = harness([]);
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
  expect(base.reads).toEqual([]);
});

test("usage errors exit 2 with the usage", async () => {
  const h = harness([]);
  for (const args of [[], ["nope"], ["candidates", "--tasks", "1"], ["approve"], ["approve", "b1", "--tasks", "x", "--owner-ref", "r"], ["candidates", "--bogus"]]) {
    const r = await h.run(...args);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("usage: dori autopilot candidates");
  }
});
