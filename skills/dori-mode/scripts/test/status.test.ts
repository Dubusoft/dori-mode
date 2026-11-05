import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { writeGatewayStatus } from "../src/gateway-status.ts";
import { pendingLeadRestart } from "../src/lead-restart.ts";
import { Registry } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { quotaMessage } from "../src/messenger/discord-commands.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { JsonLaneReports, type LaneReportStore, SqliteLaneReports } from "../src/lane-reports.ts";
import { JOURNAL_FILE, SQLITE_FILE, SqliteStore, type StoreKind, WAKES_FILE } from "../src/store.ts";
import { HUB_FILE, RunnerHub } from "../src/runner/hub.ts";
import { collectStatus, kst, lookupStatus, renderStatus, shortModel, STATUS_MAX_CHARS, statusPages, waitFireMs, type Status, type StatusDeps } from "../src/status.ts";
import { fakeClock, withState } from "./fakes.ts";

const OPENED = "2026-10-19T00:00:00.000Z";
const NOW = Date.parse(OPENED) + 90 * 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const fixture = async (panes: unknown[] = [{ pane_id: "lead:p1", workspace_id: "w" }]) => {
  const state = withState();
  cleanups.push(state.done);
  const calls: string[] = [];
  const run = async (argv: readonly string[]): Promise<Ran> => {
    const line = argv.join(" ");
    calls.push(line);
    if (line === "herdr pane list") return ok(JSON.stringify({ result: { panes } }));
    if (line.startsWith("systemctl --user is-enabled")) return ok("enabled");
    if (line === "systemctl --user is-active dori-presence.service") return { code: 3, out: "inactive", err: "" };
    if (line.startsWith("systemctl --user is-active")) return ok("active");
    return { code: 127, out: "", err: line };
  };
  const registry = new Registry(state.dir);
  const deps: StatusDeps = { run, clock: fakeClock(NOW), registry, config: { ...defaultConfig("/home/test"), stateDir: state.dir, leadPane: "lead:p1" } };
  return { deps, registry, calls, dir: state.dir };
};
const lane = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, thread: "discord:1/2", brief: "/b", done: "d", openedAt: OPENED, ...extra });

test("status lists working lanes with model, age and last progress; paused and closed lanes are left out", async () => {
  const f = await fixture();
  await f.registry.write(lane("alpha", { model: "m/one", lastProgressPost: "Write the tests" }));
  await f.registry.write(lane("beta", { status: "paused" }));
  await f.registry.write(lane("gamma", { closedAt: OPENED }));
  const s = await collectStatus(f.deps);
  expect(s.lanes).toEqual([{ key: "alpha", model: "m/one", ageMin: 90, progress: "Write the tests" }]);
  const text = renderStatus(s);
  expect(text).toContain("1 lane working");
  expect(text).toContain("\nLanes (1)\n- alpha (90m, one): Write the tests");
  expect(text).not.toContain("beta");
});

test("status shows services, pending waits, watched repos with poll time and failures, and the gateway", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "waits.json"), JSON.stringify([{ key: "ci-pr-7", until: "merged o/r#7", note: "n", deadline: NOW + 1 }]));
  writeFileSync(join(f.dir, "github-repos.json"), JSON.stringify(["o/r"]));
  writeFileSync(join(f.dir, "github-events.json"), JSON.stringify({ repos: { "o/r": { cache: {}, pulls: {}, issues: {} } }, failures: { "o/r": NOW - 20 * 60_000 }, polledAt: NOW - 2 * 60_000 }));
  writeGatewayStatus(f.dir, { pid: 1, at: NOW - 4_000, connected: true, messageContent: true });
  const s = await collectStatus(f.deps);
  const text = renderStatus(s);
  expect(text).toContain("\nServices\n- herdr-server: running\n- dori-supervisor: running\n");
  expect(text).toContain("\n- Discord gateway: connected\n- GitHub: 1 repo watched, last poll 2m ago, 1 repo failing\n");
  expect(text).toContain("\nWaits (1)\n- ci-pr-7: on signal, times out 10-19 10:30 KST (in 0m) - n");
  expect(text).toContain("\nProblems\n- GitHub poll failing: o/r 20m ago\n");
  expect(text).toContain("- No trusted issue authors (githubIssueAuthors)");
  expect(text.startsWith("Dori status - 10-19 10:30 KST\nNeeds attention: github poll failing, no trusted issue authors. 0 lanes working, 1 wait.\n")).toBe(true);
  expect(s.gateway.state).toBe("live");
  expect(s.waits[0]).toMatchObject({ note: "n" });
  const trusted = renderStatus(await collectStatus({ ...f.deps, config: { ...f.deps.config, githubIssueAuthors: ["octo-owner", "octo-alt"] } }));
  expect(trusted).toContain("- GitHub poll failing: o/r 20m ago");
  expect(trusted).not.toContain("trusted");
  expect(trusted).toContain("- Issues: watching 1 repo");
});

test("lead state: missing pane, and a pane with no agent is cold; cap and ttl come from config", async () => {
  const missing = await fixture([]);
  expect((await collectStatus(missing.deps)).lead).toMatchObject({ pane: "lead:p1", state: "missing", cacheTtlMin: 5, capTokens: 150_000 });
  const bare = await fixture();
  const s = await collectStatus(bare.deps);
  expect(s.lead.state).toBe("cold");
  expect(renderStatus(s)).toContain("\nLead\n- lead:p1: stopped - no agent running in the lead pane\n");
});

test("status --json shape round-trips and an empty state dir needs no files and creates none", async () => {
  const f = await fixture();
  const s = await collectStatus(f.deps);
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  expect(s).toMatchObject({ lanes: [], waits: [], github: { repos: [], failures: [] }, gateway: { state: "missing" } });
  expect(s.lead).not.toHaveProperty("pendingRestart");
  expect(await Bun.file(join(f.dir, "lanes")).exists()).toBe(false);
  expect(f.calls.every((c) => c === "herdr pane list" || c.startsWith("systemctl --user is-"))).toBe(true);
});

test("status exposes a pending lead restart when requested and leaves it queued", async () => {
  const f = await fixture();
  const request = { id: "restart-status-177", at: NOW, models: [{ model: "qa/lead", thinking: "high" }, { model: "qa/fallback" }] };
  writeFileSync(join(f.dir, "lead-restart.json"), JSON.stringify(request));
  const s = await collectStatus(f.deps);
  expect(s.lead.pendingRestart).toEqual(request);
  expect(JSON.parse(JSON.stringify(s)).lead.pendingRestart).toEqual(request);
  for (const value of [request.id, "qa/lead", "high", "qa/fallback"]) expect(renderStatus(s)).toContain(value);
  expect(pendingLeadRestart(f.dir)).toEqual(request);
  expect(f.calls.every((c) => c === "herdr pane list" || c.startsWith("systemctl --user is-"))).toBe(true);
});

test("the /status text stays far under Discord's limit even with many lanes", async () => {
  const f = await fixture();
  mkdirSync(f.registry.dir, { recursive: true });
  for (let i = 0; i < 30; i++) await f.registry.write(lane(`lane-${i}`, { model: "provider/very-long-model-name-for-testing", lastProgressPost: "x".repeat(300) }));
  const text = await lookupStatus(f.deps)();
  expect(text).toMatch(/\+\d+ more/);
  expect(text.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
  expect(quotaMessage(text, "No status available.").length).toBeLessThan(2000);
});

test("/status pages through 100 lanes: every page fits Discord, every lane is listed once, page 1 names the rest", async () => {
  const f = await fixture();
  mkdirSync(f.registry.dir, { recursive: true });
  const keys = Array.from({ length: 100 }, (_, i) => `scale-lane-${i}-${"k".repeat(40)}`);
  for (const key of keys) await f.registry.write(lane(key, { model: "provider/very-long-model-name-for-testing", lastProgressPost: "x".repeat(300), worktrees: ["/data/repos/worktrees/some-long-repository-name/branch"] }));
  const pages = statusPages(await collectStatus(f.deps));
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) {
    expect(page.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
    expect(quotaMessage(page, "No status available.").length).toBeLessThan(2000);
  }
  const listed = pages.flatMap((page) => page.split("\n").filter((line) => line.startsWith("- scale-lane-")).map((line) => line.slice(2).split(" ")[0]));
  expect(listed.sort()).toEqual([...keys].sort());
  expect(pages[0]).toContain(`more on pages 2-${pages.length}`);
  expect(pages[1]!.split("\n").slice(0, 3)).toEqual([`Dori lanes - page 2 of ${pages.length} - ${kst(NOW)} KST`, "", "Lanes (100), continued"]);
  expect(pages[1]).toEndWith("\n\nNext: page 3");
  expect(pages.at(-1)).not.toContain("Next: page");
  // The slash command's page option picks the page; past the end it says how many there are.
  expect(await lookupStatus(f.deps)(AbortSignal.timeout(5_000), 2)).toBe(pages[1]!);
  expect(await lookupStatus(f.deps)(AbortSignal.timeout(5_000), 999)).toBe(`Dori status has ${pages.length} pages; there is no page 999.`);
});

test("few lanes stay one page, the same text as renderStatus", async () => {
  const f = await fixture();
  await f.registry.write(lane("solo"));
  const s = await collectStatus(f.deps);
  expect(statusPages(s)).toEqual([renderStatus(s)]);
});

const REPORT_STORES: readonly (readonly [StoreKind, (dir: string) => LaneReportStore])[] = [
  ["json", (dir) => new JsonLaneReports(dir)],
  ["sqlite", (dir) => { new SqliteStore(join(dir, SQLITE_FILE), { create: true }).close(); return new SqliteLaneReports(join(dir, SQLITE_FILE)); }],
];

test.each(REPORT_STORES)("%s store: status --json carries each lane's latest report row", async (store, open) => {
  const f = await fixture();
  await f.registry.write(lane("alpha"));
  await f.registry.write(lane("beta"));
  const reports = open(f.dir);
  reports.append({ lane: "alpha", generation: 0, kind: "progress", text: "step 1", at: NOW - 3_000 });
  reports.append({ lane: "gone", generation: 0, kind: "done", text: "closed lane", at: NOW - 2_500 });
  const latest = reports.append({ lane: "alpha", generation: 0, kind: "question", text: "which base?", evidence: "PR #4", at: NOW - 2_000 });
  reports.consume("alpha:0:1", NOW - 1_000, "thread");
  reports.close();
  const config = { ...f.deps.config, store };
  const on = await collectStatus({ ...f.deps, config });
  expect(on.lanes.find((l) => l.key === "alpha")?.report).toEqual(latest);
  expect(on.lanes.find((l) => l.key === "beta")).not.toHaveProperty("report");
  expect(JSON.parse(JSON.stringify(on))).toEqual(on);
});

test("status with no reports yet shows none and creates no table or file", async () => {
  for (const store of ["json", "sqlite"] as const) {
    const f = await fixture();
    await f.registry.write(lane("alpha"));
    if (store === "sqlite") new SqliteStore(join(f.dir, SQLITE_FILE), { create: true }).close();
    const s = await collectStatus({ ...f.deps, config: { ...f.deps.config, store } });
    expect(s.lanes[0]).not.toHaveProperty("report");
    expect(await Bun.file(join(f.dir, "lane-reports.json")).exists()).toBe(false);
    if (store === "sqlite") {
      const db = new Database(join(f.dir, SQLITE_FILE), { readonly: true });
      try { expect(db.query("SELECT name FROM sqlite_master WHERE name = 'lane_reports'").all()).toEqual([]); } finally { db.close(); }
    }
  }
});

test("status shows per-kind event counts over 24h, the wakes each kind triggered and calls per wake", async () => {
  const f = await fixture();
  const at = NOW - 60 * 60_000;
  writeFileSync(join(f.dir, JOURNAL_FILE), JSON.stringify({ events: [
    { id: "old", line: "INBOUND 1 0 yesterday", at: NOW - 25 * 60 * 60_000 },
    { id: "a", line: "INBOUND 1 1 hi", at }, { id: "b", line: "INBOUND 1 2 again", at },
    { id: "c", line: "GH_PR o/r#7 merged sha=1 u", at }, { id: "d", line: "NUDGED lane", at }, { id: "e", line: "NUDGED lane", at },
    { id: "f", line: "NUDGED lane", at },
  ] }));
  writeFileSync(join(f.dir, WAKES_FILE), [
    { at: NOW - 26 * 60 * 60_000, session: "s0", trigger: ["INBOUND"], kinds: {} },
    { at, session: "s1", trigger: ["INBOUND", "GH_PR * merged"], kinds: { INBOUND: 1, "GH_PR * merged": 1 } },
    { close: at, calls: 9 },
    { at: at + 1, session: "s1", trigger: ["INBOUND"], kinds: { INBOUND: 1 } },
    { close: at + 1, calls: 4 },
    { at: at + 2, session: "s2", trigger: ["(restart)"], kinds: {} },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const s = await collectStatus(f.deps);
  expect(s.events).toMatchObject({ hours: 24, wakes: 3, measured: 2, calls: 13 });
  expect(s.events.kinds).toEqual([
    { kind: "INBOUND", cls: "lead-urgent", events: 2, wakes: 2, measured: 2, calls: 13 },
    // The class is the current policy's: a merged PR is digest now, though it woke the lead when this wake was recorded.
    { kind: "GH_PR * merged", cls: "lead-digest", events: 1, wakes: 1, measured: 1, calls: 9 },
    { kind: "(restart)", events: 0, wakes: 1, measured: 0, calls: 0 },
    { kind: "NUDGED", cls: "lead-digest", events: 3, wakes: 0, measured: 0, calls: 0 },
  ]);
  const text = renderStatus(s);
  expect(text).toContain("\nActivity (last 24h)\n- Lead woke 3 times, 6.5 model calls per wake\n");
  expect(text).toContain("\n- Busiest: INBOUND 2 events, 2 wakes; GH_PR * merged 1 event, 1 wake; (restart) 0 events, 1 wake; NUDGED 3 events");
  // A kind moved by config is counted and classed under the config's table, with no code change.
  const moved = await collectStatus({ ...f.deps, config: { ...f.deps.config, eventPolicy: resolveEventPolicy({ kinds: { "NUDGED lane": "engine-only" } }) } });
  expect(moved.events.kinds.find((k) => k.kind === "NUDGED lane")).toEqual({ kind: "NUDGED lane", cls: "engine-only", events: 3, wakes: 0, measured: 0, calls: 0 });
});

const base: Status = {
  at: "2026-10-21T00:53:36.000Z",
  services: [
    { name: "herdr-server.service", enabled: "enabled", active: "active" },
    { name: "dori-supervisor.service", enabled: "enabled", active: "active" },
    { name: "dori-presence.service", enabled: "disabled", active: "inactive" },
  ],
  lead: { pane: "wL1:p4", state: "warm", idleMin: 0, tokens: 52_000, cacheTtlMin: 5, capTokens: 150_000 },
  lanes: [],
  waits: [],
  github: { repos: ["a/b", "c/d", "e/f"], lastPollAt: "2026-10-21T00:52:36.000Z", failures: [], issueAuthors: ["octo-owner"], issueRepos: ["a/b"] },
  gateway: { state: "live", text: "live, Message Content on (heartbeat 1s ago)" },
  unacked: 0,
  events: { hours: 24, wakes: 0, measured: 0, calls: 0, kinds: [] },
};

test("owner messages still unacked after the ack window make the status a problem", () => {
  const text = renderStatus({ ...base, unacked: 2 });
  expect(text.split("\n")[1]).toBe("Needs attention: unacked 2. 0 lanes working, no waits.");
  expect(text).toContain("\nProblems\n- 2 owner messages handed to the lead and still not acked (dori ack) after the ack window\n");
});

test("healthy status reads as titled sections with one line per item, in KST", () => {
  const text = renderStatus({ ...base, lanes: [{ key: "ops", model: "anthropic-subscription/claude-opus-5-5", ageMin: 27, repo: "dori-mode", pr: 55, progress: "Full run\nthen  the docs" }] });
  expect(text).toBe([
    "Dori status - 10-21 09:53 KST",
    "All good. 1 lane working, no waits.",
    "",
    "Services",
    "- herdr-server: running",
    "- dori-supervisor: running",
    "",
    "Lead",
    "- wL1:p4: active (last turn just now, prompt cache warm), context 52k of 150k tokens",
    "",
    "Lanes (1)",
    "- ops (27m, opus-5-5, dori-mode #55): Full run then the docs",
    "",
    "Waits (0)",
    "- none",
    "",
    "Gateway and repos",
    "- Discord gateway: connected",
    "- GitHub: 3 repos watched, last poll 1m ago",
    "- Issues: watching 1 repo",
  ].join("\n"));
});

test("long progress is cut at a word with ..., never mid-word", () => {
  const text = renderStatus({ ...base, lanes: [{ key: "ops", ageMin: 3, progress: `${"word ".repeat(60)}tail` }] });
  const line = text.split("\n").find((l) => l.startsWith("- ops (3m): "))!;
  expect(line).toEndWith("word...");
  expect(line.length).toBeLessThanOrEqual("- ops (3m): ".length + 200);
});

test("a failing service expands on its own line and the legacy unit counts only when it is active", () => {
  const down = renderStatus({ ...base, services: [{ name: "herdr-server.service", enabled: "enabled", active: "active" }, { name: "dori-supervisor.service", enabled: "enabled", active: "failed" }, base.services[2]!] });
  expect(down.split("\n")[1]).toBe("Needs attention: dori-supervisor failed. 0 lanes working, no waits.");
  expect(down).toContain("\nProblems\n- Service dori-supervisor: failed\n");
  expect(down).toContain("\nServices\n- herdr-server: running\n- dori-supervisor: failed\n");
  expect(down).not.toContain("dori-presence");
  const legacy = renderStatus({ ...base, services: [base.services[0]!, base.services[1]!, { name: "dori-presence.service", enabled: "enabled", active: "active" }] });
  expect(legacy).toContain("- Service dori-presence: running (legacy, should be off)");
});

test("wait time: a date-epoch signal is the fire time; the deadline field is only a labelled timeout; else the clipped signal", () => {
  const w = (extra: object) => ({ key: "k", until: "command [\"x\"]", ...extra });
  const epoch = Date.parse("2026-10-21T22:00:00.000Z") / 1000;
  const signal = `command ["bash","-c","[ $(date +%s) -ge ${epoch} ]"]`;
  const timeout = "2026-10-22T05:00:00.000Z";
  expect(waitFireMs(w({ until: signal, deadline: timeout }))).toBe(epoch * 1000);
  expect(waitFireMs(w({ deadline: timeout }))).toBeNull();
  const text = renderStatus({ ...base, waits: [
    w({ until: signal, deadline: timeout, note: "token refresh" }),
    w({ key: "t", until: "merged o/r#8", deadline: timeout }),
    w({ key: "m", until: "merged o/r#7" }),
  ] });
  expect(text).toContain("\nWaits (3)\n- k: fires 10-22 07:00 KST (in 21h) - token refresh\n");
  expect(text).toContain("\n- t: on signal, times out 10-22 14:00 KST (in 28h)\n");
  expect(text).toContain("\n- m: until merged o/r#7\n");
});

test("a (#N) in the lane title is never shown as a PR", async () => {
  const f = await fixture();
  await f.registry.write(lane("task-lane", { title: "polish dori /status (#55)", done: 'command ["gh","pr","list","-R","dev-bokdong/dori-mode","--head","b","--json","number"] stdout~"number"' }));
  const s = await collectStatus(f.deps);
  const l = s.lanes.find((x) => x.key === "task-lane");
  expect(l).toMatchObject({ repo: "dev-bokdong/dori-mode" });
  expect(l?.pr).toBeUndefined();
});

test("model names lose the provider and claude- prefix; other ids stay readable", () => {
  expect(shortModel("anthropic-subscription/claude-opus-5-5")).toBe("opus-5-5");
  expect(shortModel("claude-sonnet-5-5[1m]")).toBe("sonnet-5-5");
  expect(shortModel("anthropic/claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  expect(shortModel("openai/gpt-6.1-sol")).toBe("gpt-6.1-sol");
});

test("kst formats fixed +09:00 across a day boundary", () => {
  expect(kst(Date.parse("2026-10-21T15:05:00Z"))).toBe("10-22 00:05");
  expect(kst(Date.parse("2026-12-31T14:59:00Z"))).toBe("12-31 23:59");
});

test("collectStatus derives a lane's repo and PR from its Done signal, with no network", async () => {
  const f = await fixture();
  await f.registry.write(lane("pr-lane", { done: 'command ["gh","pr","list","-R","dev-bokdong/dori-mode","--head","b","--json","number"] see https://github.com/dev-bokdong/dori-mode/pull/55' }));
  await f.registry.write(lane("wt-lane", { worktrees: ["/data/repos/worktrees/some-repo/branch-1"] }));
  const s = await collectStatus(f.deps);
  expect(s.lanes.find((l) => l.key === "pr-lane")).toMatchObject({ repo: "dev-bokdong/dori-mode", pr: 55 });
  expect(s.lanes.find((l) => l.key === "wt-lane")).toMatchObject({ repo: "some-repo" });
});

test("item 6: lanes pending or exhausted on recovery are a status problem and marked in the lane list", async () => {
  const f = await fixture();
  await f.registry.write(lane("dead", { recoveryPending: true, recoveryAttempts: 3, recoveryExhausted: true }));
  await f.registry.write(lane("held", { recoveryPending: true }));
  await f.registry.write(lane("fine"));
  const s = await collectStatus(f.deps);
  expect(s.lanes.map((l) => [l.key, l.recovery])).toEqual(expect.arrayContaining([["dead", "exhausted"], ["held", "pending"], ["fine", undefined]]));
  const text = renderStatus(s);
  expect(text.split("\n")[1]).toStartWith("Needs attention: ");
  expect(text).toContain("recovery exhausted 1");
  expect(text).toContain("- Lane recovery gave up (not relaunched or nudged): dead");
  expect(text).toContain("- Lane recovery pending (not nudged): held");
  expect(text).toContain("\n- [recovery gave up] dead (");
  expect(text).toContain("\n- [recovery pending] held (");
});

test("RUNNER lanes= follows the registry's open lanes on each runner's machine, not the count of the last hello", async () => {
  const f = await fixture();
  new RunnerHub({ stateDir: f.dir, commit: () => true, now: () => NOW, monotonic: () => 0, epoch: 1 }).close();
  const db = new Database(join(f.dir, HUB_FILE));
  // Stale hello inventories: 7 and 3 lanes.
  db.run("INSERT INTO runners (label, maxGen, lastHeartbeatAt, lanes) VALUES ('local', 1, ?, 7), ('macbook', 1, ?, 3)", [NOW, NOW]);
  db.close();
  await f.registry.write(lane("alpha"));
  await f.registry.write(lane("beta", { machine: "macbook", runner: "macbook" }));
  await f.registry.write(lane("delta", { machine: "macbook" }));
  await f.registry.write(lane("gamma", { machine: "macbook", runner: "macbook", closedAt: OPENED }));
  const counts = async () => Object.fromEntries((await collectStatus(f.deps)).runners?.map((r) => [r.label, r.lanes]) ?? []);
  expect(await counts()).toEqual({ local: 1, macbook: 2 });
  await f.registry.update("beta", (l) => (l ? { ...l, closedAt: OPENED } : undefined));
  expect(await counts()).toEqual({ local: 1, macbook: 1 });
  expect(renderStatus(await collectStatus(f.deps))).toMatch(/^RUNNER macbook connected .* lanes=1$/m);
});

test("a claude-quota.json left by the removed quota gate is ignored", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "claude-quota.json"), JSON.stringify({ mode: "brief", holdsLanes: true, usage: { at: NOW, accounts: [{ name: "a", fiveHour: { usedPct: 95 } }] } }));
  const text = renderStatus(await collectStatus(f.deps));
  expect(text).not.toContain("claude");
  expect(text).not.toContain("brief");
});
