import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AutopilotConfig, DEFAULT_AUTOPILOT, type HostSummary, ledgerRows, type QuotaSummary, type ToodoTask } from "../src/autopilot.ts";
import { type AutopilotDeps, autopilotMain, EXECUTE_ACTION, judgeCandidates, liveJudgeDeps, quotaSummary, type TaskHosts } from "../src/autopilot-cli.ts";
import { defaultConfig } from "../src/config.ts";
import type { HostSample } from "../src/host-guard.ts";
import type { LaneOps } from "../src/lane-ops.ts";
import type { MachineObservation } from "../src/runner/protocol.ts";
import { quotaProvidersFor, type QuotaResult, readUsage } from "../src/claude-quota.ts";
import { JsonOperations, plan } from "../src/operations.ts";
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
const harness = (
  tasks: readonly ToodoTask[] | "unreadable", host: HostSummary = { ok: true }, now = T0 + 60_000, openLanes: ReadonlySet<string> = new Set(),
  quota: QuotaSummary = { readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] },
  machines?: (ids: readonly number[]) => TaskHosts, config: AutopilotConfig = DEFAULT_AUTOPILOT,
) => {
  const reads: (number[] | "flagged")[] = [];
  const probes = { quota: 0, host: 0 };
  const unreadable = () => { throw new ToodoUnreadable("toodo-server list_tasks answered HTTP 401"); };
  const deps = (out: string[], err: string[]): AutopilotDeps => ({
    config, store, pauseFile: join(dir, "autopilot-pause.json"),
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
    quota: async () => { probes.quota++; return quota; },
    hosts: async (ids) => { probes.host++; return machines ? machines(ids) : { defaultMachine: "local", machines: new Map([["local", host]]), targets: new Map() }; },
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

test("an expired Claude account is skipped and named; the readable one decides, and none readable still holds", async () => {
  const expired: QuotaResult = { kind: "unavailable", provider: "claude-sdk-oauth", account: "default", reason: "token-expired" };
  const readable: QuotaResult = { kind: "success", provider: "claude-sdk-oauth", account: "account-2", windows: [{ label: "Weekly", remainingPercent: 45 }] };
  const failed: QuotaResult = { kind: "failure", provider: "claude-sdk-oauth", account: "account-2", reason: { type: "http-error", status: 429 } };
  const summaryOf = async (...results: QuotaResult[]) => {
    const read = await readUsage(async () => ({ results, text: "" }), T0, AbortSignal.timeout(5_000));
    return quotaSummary(read.usage, read.skipped);
  };

  const one = await summaryOf({ kind: "unavailable", provider: "anthropic", reason: "oauth-not-configured" }, expired, readable);
  expect(one).toEqual({ readable: true, accounts: [{ name: "account-2", maxUsedPct: 55 }], skipped: ["default (token-expired)"] });
  const launch = await harness([task(12)], { ok: true }, T0 + 60_000, new Set(), one).run("candidates");
  expect(launch.out).toEqual(["AUTOPILOT slots=unlimited candidates=1 quota-skipped: default (token-expired)", "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch"]);

  const none = await summaryOf(expired, failed);
  expect(none).toEqual({ readable: false, skipped: ["default (token-expired)", "account-2 (http-error 429)"] });
  const hold = await harness([task(12)], { ok: true }, T0 + 60_000, new Set(), none).run("candidates", "--json");
  expect(JSON.parse(hold.out.join("\n"))).toEqual({
    paused: false, slots: null, candidates: [{ taskId: 12, verdict: "HOLD", reasons: ["quota-unreadable"] }],
    quotaSkipped: ["default (token-expired)", "account-2 (http-error 429)"],
  });
});

test("a spent account does not hold while another of the default model's provider has room; the header names both", async () => {
  const claude = (account: string, fiveHour: number | undefined, weekly: number): QuotaResult => ({
    kind: "success", provider: "claude-sdk-oauth", account,
    windows: [...(fiveHour === undefined ? [] : [{ label: "Five-hour", remainingPercent: 100 - fiveHour }]), { label: "Weekly", remainingPercent: 100 - weekly }],
  });
  const codex: QuotaResult = { kind: "success", provider: "openai-codex", account: "codex", windows: [{ label: "5h", remainingPercent: 90 }] };
  const summaryOf = async (...results: QuotaResult[]) => {
    const read = await readUsage(async () => ({ results, text: "" }), T0, AbortSignal.timeout(5_000), quotaProvidersFor("anthropic-subscription/claude-opus-5-5"));
    return quotaSummary(read.usage, read.skipped);
  };

  // The weekly-only account-2 has room; another provider's account never counts.
  const room = await summaryOf(claude("default", 20, 100), claude("account-2", undefined, 40), codex);
  expect(room).toEqual({ readable: true, accounts: [{ name: "default", maxUsedPct: 100 }, { name: "account-2", maxUsedPct: 40 }] });
  const launch = await harness([task(12)], { ok: true }, T0 + 60_000, new Set(), room).run("candidates");
  expect(launch.out).toEqual([
    "AUTOPILOT slots=unlimited candidates=1 quota-over: default (100%) quota-room: account-2 (40%)", "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch",
  ]);

  // A spent 5h window spends the account even with weekly room.
  const spent = await summaryOf(claude("default", 30, 100), claude("account-2", 100, 40), codex);
  const hold = await harness([task(12)], { ok: true }, T0 + 60_000, new Set(), spent).run("candidates", "--json");
  expect(JSON.parse(hold.out.join("\n"))).toEqual({
    paused: false, slots: null, candidates: [{ taskId: 12, verdict: "HOLD", reasons: ["quota-over-threshold"] }],
    quotaOver: ["default (100%)", "account-2 (100%)"], quotaRoom: [],
  });

  expect(await summaryOf(codex)).toEqual({ readable: false });
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
    "AUTOPILOT slots=unlimited candidates=2",
    "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch",
    "AUTOPILOT_CANDIDATE #20 REFUSE criteria-missing",
  ]);
  expect(h.reads).toEqual(["flagged", [3]]);
  const j = await h.run("candidates", "--json");
  expect(JSON.parse(j.out.join("\n"))).toEqual({
    paused: false, slots: null,
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
    "AUTOPILOT slots=1 candidates=3",
    "AUTOPILOT_CANDIDATE #12 HOLD no-slot",
    "AUTOPILOT_CANDIDATE #13 HOLD no-slot",
    "AUTOPILOT_CANDIDATE #14 LAUNCH would-launch",
  ]);
  const held = await harness(tasks, { ok: false, reason: "panes 20 >= 20", slots: 0 }).run("candidates");
  expect(held.out[0]).toBe("AUTOPILOT slots=0 candidates=3");
  expect(held.out.slice(1).every((l) => l.endsWith("HOLD host-hold"))).toBe(true);
});

test("candidates subtract another task's pending reservation from host slots", async () => {
  store.put({
    id: "toodo:99/autopilot-launch/1", lane: "toodo:99", action: "autopilot-launch", target: "1", state: "planned",
    detail: "planned", data: JSON.stringify({ laneKey: "ap-99-1" }), attempts: 1, at: T0, updatedAt: T0,
  });
  const r = await harness([task(12), task(13)], { ok: true, slots: 2 }).run("candidates");
  expect(r.out[0]).toBe("AUTOPILOT slots=1 candidates=2");
  expect(r.out.slice(1).filter((line) => line.includes(" LAUNCH "))).toHaveLength(1);
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

test("with autopilot.executor on, launch refuses to reserve before reading anything and writes no row", async () => {
  const h = harness([task(12)], { ok: true }, T0 + 60_000, new Set(), undefined, undefined, { ...DEFAULT_AUTOPILOT, executor: true });
  expect(await h.run("launch", "12")).toEqual({ code: 1, out: [], err: [
    "AUTOPILOT_LAUNCH_REFUSED #12 executor-on: the supervisor's executor reserves and launches marked tasks (autopilot.executor)",
  ] });
  expect([h.reads, h.probes, rows()]).toEqual([[], { quota: 0, host: 0 }, []]);
});

test("with autopilot.executor on, an executor-owned reservation refuses a settle; the lead's own earlier reservation still settles", async () => {
  const on = { ...DEFAULT_AUTOPILOT, executor: true };
  const tasks = [task(12), task(13)];
  // 12: the lead reserved it before the switch. 13: the executor opened its sequence, then reserved under the same lock.
  await harness(tasks).run("launch", "12");
  plan(store, T0, { lane: "toodo:13", action: EXECUTE_ACTION, target: "1", data: "{}" });
  await harness(tasks).run("launch", "13");
  const owned = await harness(tasks, { ok: true }, T0 + 60_000, new Set(), undefined, undefined, on).run("launch", "13", "--failed");
  expect(owned).toEqual({ code: 1, out: [], err: ["AUTOPILOT_LAUNCH_REFUSED #13 executor-owned: the supervisor's executor settles this reservation"] });
  expect((await harness(tasks, { ok: true }, T0 + 60_000, new Set(), undefined, undefined, on).run("launch", "12", "--launched", "ap-12-1")).out)
    .toEqual(["AUTOPILOT_SETTLED #12 attempt=1 verified lane=ap-12-1"]);
  expect(rows().map((r) => [r[0], r[1]])).toEqual([["toodo:12/autopilot-launch/1", "verified"], ["toodo:13/autopilot-launch/1", "planned"]]);
  // Switched off again, the stopped executor resumes nothing, so the lead settles what it left open.
  expect((await harness(tasks).run("launch", "13", "--failed")).out).toEqual(["AUTOPILOT_SETTLED #13 attempt=1 failed lane=ap-13-1"]);
});

// pause

test("pause stops reserves and shows in candidates until resume; pausing twice keeps the first", async () => {
  const h = harness([task(12)]);
  expect(await h.run("pause", "--reason", "deploy freeze")).toEqual({ code: 0, out: ["AUTOPILOT_PAUSED since 2026-01-01T12:01:00.000Z: deploy freeze"], err: [] });
  expect((await harness([task(12)], { ok: true }, T0 + 120_000).run("pause")).out)
    .toEqual(["AUTOPILOT_PAUSED since 2026-01-01T12:01:00.000Z: deploy freeze (already paused)"]);
  expect(await h.run("launch", "12")).toEqual({
    code: 1, out: [], err: ["AUTOPILOT_LAUNCH_REFUSED #12 paused since 2026-01-01T12:01:00.000Z: deploy freeze (dori autopilot resume lifts it)"],
  });
  expect((await h.run("candidates")).out[0]).toBe("AUTOPILOT paused: nothing launches slots=unlimited candidates=1");
  expect(JSON.parse((await h.run("candidates", "--json")).out.join("\n")).paused).toBe(true);
  expect(rows()).toEqual([]);
  expect(await h.run("resume")).toEqual({ code: 0, out: ["AUTOPILOT_RESUMED"], err: [] });
  expect(await h.run("resume")).toEqual({ code: 0, out: ["AUTOPILOT_NOT_PAUSED"], err: [] });
  expect((await h.run("candidates")).out[0]).toBe("AUTOPILOT slots=unlimited candidates=1");
  expect((await h.run("launch", "12")).out).toEqual(["AUTOPILOT_RESERVED #12 lane=ap-12-1 attempt=1"]);
});

test("an unparsable pause file still pauses", async () => {
  writeFileSync(join(dir, "autopilot-pause.json"), "{not json");
  expect((await harness([task(12)]).run("launch", "12")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #12 paused since ? (dori autopilot resume lifts it)"]);
});

// other subcommands

test("usage errors exit 2 with the usage; the removed bundle and schedule subcommands are unknown", async () => {
  const h = harness([]);
  for (const args of [[], ["nope"], ["approve", "b1"], ["revoke", "b1"], ["bundles"], ["candidates", "--tasks", "x"], ["candidates", "extra"], ["schedule"], ["candidates", "--bogus"], ["candidates", "--record"],
    ["pause", "now"], ["pause", "--json"], ["resume", "--reason", "x"]]) {
    const r = await h.run(...args);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("usage: dori autopilot candidates");
  }
  expect(h.reads).toEqual([]);
});

// slots per target machine

/** local and mac-mini with these summaries; every task targets `targets` (local first, then the fallback mac-mini). */
const twoMachines = (local: HostSummary, mini: HostSummary, targets: readonly string[] = ["local", "mac-mini"]) => (ids: readonly number[]): TaskHosts => ({
  defaultMachine: "local", machines: new Map([["local", local], ["mac-mini", mini]]), targets: new Map(ids.map((id) => [id, targets])),
});

test("a full local machine does not hold a task whose fallback mac-mini has room; the reservation names mac-mini and takes its slot", async () => {
  const machines = twoMachines({ ok: false, reason: "panes 4 >= 4", slots: 0 }, { ok: true, slots: 1 });
  const h = harness([task(12), task(13)], { ok: true }, T0 + 60_000, new Set(), undefined, machines);
  expect((await h.run("candidates")).out).toEqual([
    "AUTOPILOT slots=1 machines=local:hold,mac-mini:1 candidates=2",
    "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch machine=mac-mini",
    "AUTOPILOT_CANDIDATE #13 HOLD no-slot",
  ]);
  expect(JSON.parse((await h.run("candidates", "--json")).out.join("\n")).candidates[0]).toEqual({ taskId: 12, verdict: "LAUNCH", reasons: [], machine: "mac-mini" });
  expect(await h.run("launch", "12")).toEqual({ code: 0, out: ["AUTOPILOT_RESERVED #12 lane=ap-12-1 attempt=1 machine=mac-mini"], err: [] });
  expect(rows()).toEqual([["toodo:12/autopilot-launch/1", "planned", JSON.stringify({ laneKey: "ap-12-1", machine: "mac-mini" }), "planned"]]);
  // 12's reservation has no pane yet: it takes mac-mini's one slot, and local is still full.
  expect((await h.run("launch", "13")).err).toEqual(["AUTOPILOT_LAUNCH_REFUSED #13 HOLD no-slot"]);
  // Every target held: host-hold.
  const held = twoMachines({ ok: false, reason: "panes 4 >= 4", slots: 0 }, { ok: false, reason: "memory free 5% < 20%" });
  expect((await harness([task(14)], { ok: true }, T0, new Set(), undefined, held).run("candidates")).out)
    .toEqual(["AUTOPILOT slots=0 machines=local:hold,mac-mini:hold candidates=1", "AUTOPILOT_CANDIDATE #14 HOLD host-hold"]);
});

test("a reservation waiting on mac-mini takes no local slot; one that names no machine counts on the default machine", async () => {
  const pending = (id: number, data: Record<string, string>) => store.put({
    id: `toodo:${id}/autopilot-launch/1`, lane: `toodo:${id}`, action: "autopilot-launch", target: "1", state: "planned",
    detail: "planned", data: JSON.stringify(data), attempts: 1, at: T0, updatedAt: T0,
  });
  const machines = twoMachines({ ok: true, slots: 1 }, { ok: true, slots: 1 }, ["local"]);
  pending(98, { laneKey: "ap-98-1", machine: "mac-mini" });
  const h = harness([task(13)], { ok: true }, T0 + 60_000, new Set(), undefined, machines);
  expect((await h.run("candidates")).out).toEqual(["AUTOPILOT slots=1 machines=local:1,mac-mini:0 candidates=1", "AUTOPILOT_CANDIDATE #13 LAUNCH would-launch machine=local"]);
  pending(99, { laneKey: "ap-99-1" });
  expect((await h.run("candidates")).out).toEqual(["AUTOPILOT slots=0 machines=local:0,mac-mini:0 candidates=1", "AUTOPILOT_CANDIDATE #13 HOLD no-slot"]);
});

test("the live judge deps the CLI and the supervisor's tick share check every machine a task may be placed on", async () => {
  const sample = (panes: number): HostSample => ({ load1: 1, memFreePct: 60, diskFreeGb: 200, swapFreeGb: 4, swapTotalGb: 8, panes });
  const base = defaultConfig("/home/test");
  const max = base.guard.panesMax;
  const asked: (string | undefined)[] = [];
  const ops = { observeMachine: async (machine?: string): Promise<MachineObservation> => {
    asked.push(machine);
    const panes = machine === undefined ? max : 1;
    return { os: "linux", sampledAt: 0, sample: sample(panes), panes: Array.from({ length: panes }, (_, i) => ({ pane_id: `p${i}`, workspace_id: "w" })) };
  } } as unknown as LaneOps;
  const config = { ...base, stateDir: dir, placement: { defaultMachine: "local", fallback: ["mac-mini"] } };
  const flow = { ops, config, registry: { open: async () => [] }, tunables: { toodoEvents: { url: "http://toodo.test", tokenFile } }, clock: { now: () => T0 } };
  const live = liveJudgeDeps(flow as unknown as Parameters<typeof liveJudgeDeps>[0], store);
  const found = await live.hosts([12]);
  expect(asked.sort()).toEqual(["mac-mini", undefined]);
  expect([found.defaultMachine, found.targets.get(12), found.machines.get("local")?.ok, found.machines.get("mac-mini")]).toEqual(["local", ["local", "mac-mini"], false, { ok: true, slots: max - 2 }]);
  const toodo = { flaggedTasks: async () => [task(12)], tasksByIds: async () => [] };
  const report = await judgeCandidates({ ...live, pauseFile: join(dir, "autopilot-pause.json"), toodo: () => toodo, quota: async () => ({ readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] }) });
  expect(report.verdicts).toEqual([{ taskId: 12, verdict: "LAUNCH", reasons: [], machine: "mac-mini" }]);
});
