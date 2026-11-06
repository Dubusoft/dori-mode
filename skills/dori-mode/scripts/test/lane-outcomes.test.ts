import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventPriority, Supervisor } from "../src/supervise.ts";
import { outcomeLane, pendingReported, recordReported, REPORTED_DIR, takeReminders } from "../src/lane-outcomes.ts";
import { CLOSE_BUTTONS_FILE, readCloseButtons } from "../src/thread-finality.ts";
import { Waits } from "../src/waits.ts";
import type { Lane } from "../src/registry.ts";
import { renderStatus, type Status } from "../src/status.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  const deps = depsFor(world, clock, state.dir);
  const unreported = () => (readJournal(state.dir).events as { id: string; line: string }[]).filter((event) => event.line.startsWith("UNREPORTED "));
  return { state, clock, deps, world, unreported };
};

const lane = (key: string, extra: Partial<Lane> = {}): Lane => ({
  key, title: key, thread: "none", pane: undefined, brief: "/tmp/brief.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), ...extra,
} as Lane);

const deliveredOutcome = async () => {
  const f = fixture();
  const pane = { pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" };
  f.world.panes.push(pane);
  // Keep the push step away from the input: only supervisor observations advance these tests.
  f.world.screen = "❯ owner draft";
  const session = join(f.state.dir, "lead.jsonl");
  writeFileSync(session, "{}\n");
  utimesSync(session, T0 / 1000, T0 / 1000);
  const supervisor = new Supervisor({ ...f.deps, config: { ...f.deps.config, cacheTtlMin: 60 }, run: async (argv, opts) => {
    if (argv[0] === "ps" && argv[1] === "-A") return { code: 0, out: `101 10 /usr/bin/omo --session-id ${session}`, err: "" };
    if (argv[0] === "herdr" && argv[2] === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 10 } } }), err: "" };
    return f.deps.run(argv, opts);
  } });
  supervisor.enqueue("closed:alpha", "LANE_CLOSED alpha x");
  await supervisor.flush();
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ deliveredAt: T0 });
  expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBeUndefined();
  return { ...f, pane, supervisor };
};

for (const ended of ["idle", "done"]) {
  test(`a delivered outcome gets its first UNREPORTED on working -> ${ended}, then keeps normal backoff`, async () => {
    const f = await deliveredOutcome();
    f.clock.at += 1_000;
    await f.supervisor.flush();
    expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBe(true);
    expect(f.unreported()).toEqual([]);
    f.pane.agent_status = ended;
    f.clock.at += 1_000;
    const before = f.world.calls.filter((call) => call[2] === "list").length;
    await f.supervisor.flush();
    expect(f.world.calls.filter((call) => call[2] === "list").length - before).toBe(1);
    expect(f.unreported()).toHaveLength(1);
    expect(f.unreported()[0]).toMatchObject({ id: `unreported:alpha:${T0}:1`, at: T0 + 2_000 });
    expect(f.unreported()[0]?.line).toStartWith("UNREPORTED alpha ");
    f.clock.at += 5 * MIN - 1;
    await f.supervisor.reportTick();
    expect(f.unreported()).toHaveLength(1);
    f.clock.at += 1;
    await f.supervisor.reportTick();
    expect(f.unreported()[1]?.id).toBe(`unreported:alpha:${T0}:2`);
  });
}

test("delivery followed only by idle observations waits for reportTimeoutMin", async () => {
  const f = await deliveredOutcome();
  f.pane.agent_status = "idle";
  f.clock.at += 1_000;
  await f.supervisor.flush();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBeUndefined();
  f.clock.at = T0 + 5 * MIN;
  await f.supervisor.flush();
  expect(f.unreported()[0]?.id).toBe(`unreported:alpha:${T0}:1`);
});

test("a report receipt on the turn-end tick wins over the idle observation", async () => {
  const f = await deliveredOutcome();
  f.clock.at += 1_000;
  await f.supervisor.flush();
  f.pane.agent_status = "idle";
  f.clock.at += 1_000;
  recordReported(f.state.dir, "alpha", f.clock.now());
  await f.supervisor.flush();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0].reportedAt).toBe(f.clock.now());
});

test("an unobserved lead still gets the timeout reminder", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("closed:alpha", "LANE_CLOSED alpha x");
  f.clock.at = T0 + 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()[0]?.id).toBe(`unreported:alpha:${T0}:1`);
  expect(readJournal(f.state.dir).outcomes[0].deliveredAt).toBeUndefined();
  expect(f.world.calls).toEqual([]);
});

test("a machine lane owes no report when its delivered turn ends early", async () => {
  const f = await deliveredOutcome();
  await f.deps.registry.write(lane("alpha", { autoClose: "machine" }));
  f.clock.at += 1_000;
  await f.supervisor.flush();
  f.pane.agent_status = "idle";
  f.clock.at += 1_000;
  await f.supervisor.flush();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ reportedAt: f.clock.now(), note: "autoClose: machine" });
});

test("outcome lines name their lane; other lines and malformed keys name none", () => {
  expect(outcomeLane("LANE_CLOSED alpha {\"checks\":[]}")).toBe("alpha");
  expect(outcomeLane("CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x")).toBe("alpha");
  expect(outcomeLane("CI_MERGED acme/app#7 into dev head=abc")).toBeUndefined();
  expect(outcomeLane("LANE_DONE_CLAIMED alpha w:p1 proof")).toBe("alpha");
  expect(outcomeLane("LANE_AUTO_CLAIMED alpha w:p1 proof")).toBeUndefined();
  expect(outcomeLane("LANE_AUTO_CLOSED alpha x")).toBeUndefined();
  expect(outcomeLane("LANE_CLOSED $(rm) x")).toBeUndefined();
});

test("CI_MERGED and LANE_CLOSED of one lane are one obligation: UNREPORTED after reportTimeoutMin, re-sent with backoff, stopped by dori reported", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("ci-merged:acme/app#7", "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x");
  f.clock.at += MIN;
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha {\"checks\":[]}");
  expect(readJournal(f.state.dir).outcomes).toEqual([
    { lane: "alpha", since: T0, line: "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x", events: ["ci-merged:acme/app#7", "lane-closed:alpha"] },
  ]);
  f.clock.at = T0 + 5 * MIN - 1;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  f.clock.at = T0 + 5 * MIN;
  await supervisor.reportTick();
  const [first] = f.unreported();
  expect(first?.line).toStartWith("UNREPORTED alpha finished 5 min ago and the owner has not been told: run dori reported alpha --text TEXT to post the outcome to the owner in its thread. CI_MERGED acme/app#7");
  expect(eventPriority(first?.line ?? "")).toBe("urgent");
  // Re-sent one window later, then after twice the previous wait; a restarted supervisor keeps the count.
  f.clock.at += 5 * MIN;
  await new Supervisor(f.deps).reportTick();
  expect(f.unreported()).toHaveLength(2);
  const restarted = new Supervisor(f.deps);
  f.clock.at += 10 * MIN - 1;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(2);
  f.clock.at += 1;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(3);
  // The lead reports; nothing more is sent, and a later outcome event of the lane opens nothing.
  recordReported(f.state.dir, "alpha", f.clock.now(), "told in its thread");
  await restarted.reportTick();
  expect(readdirSync(join(f.state.dir, REPORTED_DIR))).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "alpha", reportedAt: f.clock.now(), note: "told in its thread" });
  restarted.enqueue("lane-closed:alpha:again", "LANE_CLOSED alpha again");
  f.clock.at += 120 * MIN;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(3);
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
});

test("a report recorded before the outcome event arrives settles it, and two lanes are two obligations", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  recordReported(f.state.dir, "beta", f.clock.now());
  await supervisor.reportTick();
  supervisor.enqueue("lane-closed:beta", "LANE_CLOSED beta x");
  supervisor.enqueue("lane-closed:gamma", "LANE_CLOSED gamma x");
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported().map((event) => event.line.split(" ")[1])).toEqual(["gamma"]);
});

test("outcomes in the history at startup open nothing, and an engine-only outcome is not owed", async () => {
  const f = fixture();
  writeJournal(f.state.dir, { events: [{ id: "lane-closed:old", line: "LANE_CLOSED old x", at: T0 - 60 * MIN }] });
  const supervisor = new Supervisor({ ...f.deps, config: { ...f.deps.config, eventPolicy: { default: "lead-digest", kinds: { ...f.deps.config.eventPolicy.kinds, LANE_CLOSED: "engine-only" } } } });
  supervisor.enqueue("lane-closed:quiet", "LANE_CLOSED quiet x");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes ?? []).toEqual([]);
  expect(f.unreported()).toEqual([]);
});

test("a lane with autoClose: machine owes no report", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("robot", { autoClose: "machine" }));
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-closed:robot", "LANE_CLOSED robot x");
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "robot", reportedAt: f.clock.now(), note: "autoClose: machine" });
});

const CLAIM = "LANE_DONE_CLAIMED alpha w:p1 merged acme/app#1";

test("a done claim opens the lane's obligation: listed for inbox take, UNREPORTED after reportTimeoutMin", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  expect(readJournal(f.state.dir).outcomes).toEqual([{ lane: "alpha", since: T0, line: CLAIM, events: ["done-claim:alpha:1"], claim: true }]);
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([
    `unreported:alpha\tUNREPORTED alpha since ${new Date(T0).toISOString()}: run dori reported alpha --text TEXT to post the outcome to the owner in its thread`,
  ]);
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  const [first] = f.unreported();
  expect(first?.line).toBe(`UNREPORTED alpha claimed done 5 min ago and the owner has not been told: run dori reported alpha --text TEXT to post the outcome to the owner in its thread. ${CLAIM}`);
});

test("the seen-claim close joins the claim's obligation: a reported claim is not owed again", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  f.clock.at += 10 * MIN;
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim {}");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes).toEqual([
    { lane: "alpha", since: T0, line: CLAIM, events: ["done-claim:alpha:1", "lane-closed:alpha"], reportedAt: T0 },
  ]);
  // Joined by a real outcome, the row is no longer the claim's: a later rejection leaves it.
  supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
});

test("a machine lane's LANE_AUTO_CLAIMED opens nothing", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("auto-claim:robot", "LANE_AUTO_CLAIMED robot w:p1 proof");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes ?? []).toEqual([]);
  expect(f.unreported()).toEqual([]);
});

test("LANE_NOT_DONE drops an unreported claim's obligation", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  await supervisor.reportTick();
  f.clock.at += MIN;
  supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
  expect(readJournal(f.state.dir).outcomes).toEqual([]);
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(takeReminders(f.state.dir)).toEqual([]);
});

test("LANE_NOT_DONE drops a reported claim's row, so the next claim is owed afresh", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  f.clock.at += MIN;
  supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
  expect(readJournal(f.state.dir).outcomes).toEqual([]);
  f.clock.at += 30 * MIN;
  const again = f.clock.now();
  supervisor.enqueue("done-claim:alpha:2", `${CLAIM} fixed`);
  expect(readJournal(f.state.dir).outcomes).toEqual([{ lane: "alpha", since: again, line: `${CLAIM} fixed`, events: ["done-claim:alpha:2"], claim: true }]);
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported().map((event) => event.line.split(" ").slice(0, 3).join(" "))).toEqual(["UNREPORTED alpha claimed"]);
});

test("dori object-done (a registry objection, no event) drops the claim's obligation at the next tick; an older objection does not", async () => {
  const f = fixture();
  const objection = (at: number) => lane("alpha", { status: "not-done", objection: { at: new Date(at).toISOString(), reasons: ["dirty tree"] } });
  await f.deps.registry.write(objection(T0 - MIN));
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
  f.clock.at += MIN;
  await f.deps.registry.write(objection(f.clock.now()));
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes).toEqual([]);
  expect(takeReminders(f.state.dir)).toEqual([]);
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
});

test("a claim joined by CI_MERGED or LANE_CLOSED is a real outcome: LANE_NOT_DONE and objections leave it", async () => {
  for (const [id, line] of [["ci-merged:acme/app#1", "CI_MERGED acme/app#1 into dev lane=alpha head=abc merge=def https://x"], ["lane-closed:alpha", "LANE_CLOSED alpha closed {}"]] as const) {
    const f = fixture();
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("done-claim:alpha:1", CLAIM);
    supervisor.enqueue(id, line);
    f.clock.at += MIN;
    await f.deps.registry.write(lane("alpha", { status: "not-done", objection: { at: new Date(f.clock.now()).toISOString(), reasons: ["x"] } }));
    supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
    f.clock.at += 4 * MIN;
    await supervisor.reportTick();
    expect(readJournal(f.state.dir).outcomes).toEqual([expect.objectContaining({ lane: "alpha", events: ["done-claim:alpha:1", id] })]);
    expect(readJournal(f.state.dir).outcomes[0].claim).toBeUndefined();
    expect(f.unreported().map((event) => event.line.split(" ").slice(0, 3).join(" "))).toEqual(["UNREPORTED alpha finished"]);
  }
});

test("open obligations are listed for inbox take until reported", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  expect(takeReminders(f.state.dir)).toEqual([]);
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha done");
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([
    `unreported:alpha\tUNREPORTED alpha since ${new Date(T0).toISOString()}: run dori reported alpha --text TEXT to post the outcome to the owner in its thread`,
  ]);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([]);
});

test("dori status names unreported lanes as a problem", () => {
  const base = {
    at: new Date(T0).toISOString(), services: [], lanes: [], waits: [], unacked: 0,
    lead: { pane: "lead:p1", state: "warm", cacheTtlMin: 60, capTokens: 100_000 },
    github: { repos: [], failures: [], issueAuthors: ["owner"], issueRepos: [] },
    gateway: { state: "live", text: "" },
    events: { hours: 24, wakes: 0, measured: 0, calls: 0, kinds: [] },
  } as unknown as Status;
  expect(renderStatus(base)).not.toContain("unreported");
  const text = renderStatus({ ...base, unreported: [{ lane: "alpha", since: new Date(T0 - 12 * MIN).toISOString() }] });
  expect(text.split("\n")[1]).toContain("unreported 1");
  expect(text).toContain("- Finished lanes not reported to the owner yet (dori reported <key> --text TEXT): alpha 12m ago");
});

// A preload replacing fetch: each request is appended to $FAKE_LOG as JSON; $FAKE_STATUS (default 200) is the reply status.
const fakeFetch = (dir: string): string => {
  const preload = join(dir, "fake-fetch.js");
  writeFileSync(preload, [
    'const { appendFileSync } = require("node:fs");',
    'globalThis.fetch = async (url, init) => {',
    '  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined }) + "\\n");',
    '  const status = Number(process.env.FAKE_STATUS ?? 200);',
    '  return new Response(status < 300 ? JSON.stringify({ id: "m-42" }) : "{\\"message\\":\\"Missing Access\\"}", { status });',
    '};',
  ].join("\n"));
  return preload;
};

const cli = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  const log = join(dir, "fetch.log");
  rmSync(log, { force: true });
  const p = Bun.spawn(["bun", "--preload", fakeFetch(dir), join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test-token", FAKE_LOG: log, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { url: string; method: string; body?: { content?: string; nonce?: string } }) : [];
  return { out, err, code, requests };
};

// Each case spawns `bun src/cli.ts`; a loaded full run on a small host needs more than bun's default 5 s per test.
const CLI_TIMEOUT = 30_000;

test("dori reported is lead-only, needs a registered lane, and needs --text", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200" }));
  const denied = await cli(f.state.dir, ["reported", "alpha", "--text", "merged"], { DORI_LANE_KEY: "alpha" });
  expect(denied.code).toBe(2);
  expect(denied.err).toStartWith("DORI_CLI_LANE_ONLY reported:");
  const unknown = await cli(f.state.dir, ["reported", "nope", "--text", "merged"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no registered lane "nope"');
  const bare = await cli(f.state.dir, ["reported", "alpha", "--note", "told"]);
  expect(bare.code).toBe(1);
  expect(bare.err).toContain("usage: dori reported <key> --text TEXT [--final] [--to TARGET] [--thread ID] [--note TEXT]");
  expect([...denied.requests, ...unknown.requests, ...bare.requests]).toEqual([]);
  expect(existsSync(join(f.state.dir, REPORTED_DIR))).toBe(false);
}, CLI_TIMEOUT);

test("dori reported posts to the lane's bound thread, then records the receipt with the message id and target", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200" }));
  const ok = await cli(f.state.dir, ["reported", "alpha", "--text", "alpha merged: acme/app#7", "--note", "told in its thread"]);
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  expect(ok.out.trim()).toBe("REPORTED_RECORDED alpha m-42");
  expect(ok.requests).toHaveLength(1);
  expect(ok.requests[0]).toMatchObject({ method: "POST", url: "https://discord.com/api/v10/channels/200/messages", body: { content: "alpha merged: acme/app#7" } });
  expect(ok.requests[0]?.body?.nonce).toBeString();
  expect(pendingReported(f.state.dir).map(({ lane: key, note, message, target }) => ({ key, note, message, target })))
    .toEqual([{ key: "alpha", note: "told in its thread", message: "m-42", target: "discord:200" }]);
  // --to overrides the bound thread; a bare id posts on the lane's platform.
  const override = await cli(f.state.dir, ["reported", "alpha", "--text", "again", "--to", "300"]);
  expect(override.code).toBe(0);
  expect(override.requests.map((r) => r.url)).toEqual(["https://discord.com/api/v10/channels/300/messages"]);
  expect(pendingReported(f.state.dir).map((r) => r.target).sort()).toEqual(["discord:200", "discord:300"]);
}, CLI_TIMEOUT);

test("a failed post records no receipt and exits non-zero", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200" }));
  const failed = await cli(f.state.dir, ["reported", "alpha", "--text", "alpha merged"], { FAKE_STATUS: "403" });
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("discord POST /channels/200/messages: 403");
  expect(failed.out).not.toContain("REPORTED_RECORDED");
  expect(failed.requests).toHaveLength(1);
  expect(pendingReported(f.state.dir)).toEqual([]);
}, CLI_TIMEOUT);

test("a lane with no bound thread and no --to dies without posting or recording", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha"));
  const none = await cli(f.state.dir, ["reported", "alpha", "--text", "alpha merged"]);
  expect(none.code).toBe(1);
  expect(none.err).toContain("lane alpha has no bound thread; name where to post with --to TARGET");
  expect(none.requests).toEqual([]);
  expect(existsSync(join(f.state.dir, REPORTED_DIR))).toBe(false);
}, CLI_TIMEOUT);

test("pendingReported reads receipts written before reports carried a message id", () => {
  const f = fixture();
  mkdirSync(join(f.state.dir, REPORTED_DIR), { recursive: true });
  writeFileSync(join(f.state.dir, REPORTED_DIR, `${T0}-old.json`), JSON.stringify({ lane: "alpha", at: T0, note: "told" }));
  expect(pendingReported(f.state.dir).map(({ path: _path, ...rest }) => rest)).toEqual([{ lane: "alpha", at: T0, note: "told" }]);
});

const closeButtons = () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  const posts: { thread: string; id: string }[] = [];
  const tick = async () => { await supervisor.reportTick(); await supervisor.closeButtonTick(async (thread, id) => { posts.push({ thread, id }); }); };
  const close = (key: string) => f.deps.registry.patch(key, { closedAt: new Date(f.clock.now()).toISOString() });
  const report = (key: string, extra: { button?: boolean } = {}) => recordReported(f.state.dir, key, f.clock.now(), undefined, { message: "m", target: "discord:200", thread: "200", ...extra });
  return { ...f, supervisor, posts, tick, close, report };
};

test("the supervisor posts the close button once the last lane on a thread is closed and reported, once per report", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200" }));
  f.supervisor.enqueue("claim:alpha", "LANE_DONE_CLAIMED alpha w:p1 proof");
  f.clock.at += 1_000;
  f.report("alpha");
  // Reported at the claim: the lane is still open, so the button waits for its close.
  await f.tick();
  expect(f.posts).toEqual([]);
  f.clock.at += 1_000;
  await f.close("alpha");
  await f.tick();
  expect(f.posts).toEqual([{ thread: "200", id: `close-button:200:${T0 + 1_000}` }]);
  expect(readCloseButtons(f.state.dir)).toEqual({ "200": T0 + 2_000 });
  await f.tick();
  expect(f.posts).toHaveLength(1);
  // New work on the thread, finished and reported later, gets a button of its own.
  await f.deps.registry.write(lane("beta", { thread: "discord:100/200" }));
  f.clock.at += 1_000;
  await f.close("beta");
  f.report("beta");
  await f.tick();
  expect(f.posts.map((post) => post.id)).toEqual([`close-button:200:${T0 + 1_000}`, `close-button:200:${T0 + 3_000}`]);
  f.supervisor.close();
});

test("a --final report's button stands for the thread: the supervisor posts none", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  f.report("alpha", { button: true });
  await f.tick();
  expect(f.posts).toEqual([]);
  expect(readCloseButtons(f.state.dir)).toEqual({ "200": T0 });
  f.supervisor.close();
});

test("an open lane, an unreported lane, a wait or an open decision on the thread holds the button back", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  await f.deps.registry.write(lane("beta", { thread: "discord:100/200" }));
  await f.deps.registry.write(lane("gamma", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  f.supervisor.enqueue("closed:gamma", "LANE_CLOSED gamma x");
  f.report("alpha");
  await f.tick();
  expect(f.posts).toEqual([]);
  await f.close("beta");
  f.report("gamma");
  const waits = new Waits(f.state.dir);
  waits.register({ key: "release", until: "file ready", note: "n", cwd: f.state.dir, thread: "discord:100/200" }, f.clock.now());
  await f.tick();
  expect(f.posts).toEqual([]);
  waits.cancel("release");
  f.supervisor.enqueue("q:alpha", "LANE_REPORT alpha question which one?");
  await f.tick();
  expect(f.posts).toEqual([]);
  // Resolved: nothing is left on the thread.
  mkdirSync(join(f.state.dir, "resolved"), { recursive: true });
  writeFileSync(join(f.state.dir, "resolved", `${T0}-q.json`), JSON.stringify({ id: "q:alpha", at: T0 }));
  f.supervisor.resolveTick();
  await f.tick();
  expect(f.posts.map((post) => post.thread)).toEqual(["200"]);
  f.supervisor.close();
});

test("receipts without a thread (written before this check) never post a button", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  recordReported(f.state.dir, "alpha", T0, undefined, { message: "m", target: "discord:200" });
  await f.tick();
  expect(f.posts).toEqual([]);
  f.supervisor.close();
});

test("a report of a lane that closed before the supervisor's button re-arms nothing; a lane closed after it does", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  await f.deps.registry.write(lane("beta", { thread: "discord:100/200" }));
  f.report("alpha");
  await f.tick();
  expect(f.posts).toEqual([]);
  // beta closes; its report has not arrived yet, so nothing is left on the thread and the button goes on.
  f.clock.at += 1_000;
  await f.close("beta");
  f.clock.at += 1_000;
  await f.tick();
  expect(f.posts).toEqual([{ thread: "200", id: `close-button:200:${T0}` }]);
  // beta's report arrives after the button: that button already covers it.
  f.clock.at += 5_000;
  f.report("beta");
  await f.tick();
  await f.tick();
  expect(f.posts).toHaveLength(1);
  // gamma starts after the button, closes and is reported: new work gets a button of its own.
  await f.deps.registry.write(lane("gamma", { thread: "discord:100/200" }));
  f.clock.at += 1_000;
  await f.close("gamma");
  f.report("gamma");
  await f.tick();
  expect(f.posts.map((post) => post.id)).toEqual([`close-button:200:${T0}`, `close-button:200:${f.clock.now()}`]);
  f.supervisor.close();
});

test("a repeat report of a lane after its --final button does not post a second button", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  f.report("alpha", { button: true });
  await f.tick();
  f.clock.at += MIN;
  f.report("alpha");
  await f.tick();
  expect(f.posts).toEqual([]);
  expect(readCloseButtons(f.state.dir)).toEqual({ "200": T0 });
  f.supervisor.close();
});

test("repeat reports of a lane into the same thread get one supervisor button", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  f.report("alpha");
  await f.tick();
  for (let i = 0; i < 2; i++) {
    f.clock.at += 1_000;
    f.report("alpha");
    await f.tick();
  }
  expect(f.posts).toEqual([{ thread: "200", id: `close-button:200:${T0}` }]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "alpha", thread: "200", lastReportAt: T0, reportedAt: T0 });
  f.supervisor.close();
});

test("receipts are taken in time order, and a replayed receipt re-arms nothing", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  const posted = { message: "m", target: "discord:200", thread: "200" };
  // Both pending in one pass, the later plain report written first.
  recordReported(f.state.dir, "alpha", T0 + 1_000, undefined, posted);
  recordReported(f.state.dir, "alpha", T0, undefined, { ...posted, button: true });
  await f.tick();
  expect(f.posts).toEqual([]);
  recordReported(f.state.dir, "alpha", T0 + 1_000, undefined, posted);
  await f.tick();
  expect(f.posts).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lastReportAt: T0 });
  f.supervisor.close();
});

test("the first explicit report after a machine lane closed itself gets the button", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("robot", { thread: "discord:100/200", autoClose: "machine", closedAt: new Date(T0).toISOString() }));
  f.supervisor.enqueue("lane-closed:robot", "LANE_CLOSED robot x");
  f.clock.at += 5 * MIN;
  await f.tick();
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "robot", note: "autoClose: machine" });
  expect(f.posts).toEqual([]);
  f.report("robot");
  await f.tick();
  expect(f.posts).toEqual([{ thread: "200", id: `close-button:200:${f.clock.now()}` }]);
  f.supervisor.close();
});

test("another lane reported into a thread after its --final button gets a button of its own", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  f.report("alpha", { button: true });
  await f.tick();
  await f.deps.registry.write(lane("beta", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  f.clock.at += 1_000;
  f.report("beta");
  await f.tick();
  expect(f.posts).toEqual([{ thread: "200", id: `close-button:200:${T0 + 1_000}` }]);
  f.supervisor.close();
});

test("a repeat report while the lane is open keeps the button waiting for its close", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200" }));
  f.report("alpha");
  await f.tick();
  f.clock.at += 1_000;
  f.report("alpha");
  await f.tick();
  expect(f.posts).toEqual([]);
  f.clock.at += 1_000;
  await f.close("alpha");
  await f.tick();
  await f.tick();
  expect(f.posts).toEqual([{ thread: "200", id: `close-button:200:${T0}` }]);
  f.supervisor.close();
});

test("dori reported --final records its button and thread; one after the supervisor's button is withheld", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  const final = await cli(f.state.dir, ["reported", "alpha", "--text", "done", "--final"]);
  expect(final.code).toBe(0);
  expect(final.out).not.toContain("REPORT_BUTTON_WITHHELD");
  expect(JSON.stringify(final.requests[0]?.body)).toContain("dori:close-thread:200");
  expect(pendingReported(f.state.dir).map(({ thread, button }) => ({ thread, button }))).toEqual([{ thread: "200", button: true }]);
  writeFileSync(join(f.state.dir, CLOSE_BUTTONS_FILE), JSON.stringify({ "200": T0 + 1 }));
  const again = await cli(f.state.dir, ["reported", "alpha", "--text", "done", "--final"]);
  expect(again.code).toBe(0);
  expect(again.out).toContain("REPORT_BUTTON_WITHHELD alpha: the close button is already posted on this thread");
  expect(JSON.stringify(again.requests[0]?.body)).not.toContain("dori:close-thread");
}, CLI_TIMEOUT);

test("a lane stored with a bare thread id (older launches) gets its --final button and its supervisor button", async () => {
  const f = closeButtons();
  await f.deps.registry.write(lane("alpha", { thread: "200", closedAt: new Date(T0).toISOString() }));
  expect((await f.deps.registry.read("alpha"))?.thread).toBe("discord:200");
  const final = await cli(f.state.dir, ["reported", "alpha", "--text", "done", "--final"]);
  expect(final.code).toBe(0);
  expect(final.out).not.toContain("REPORT_BUTTON_WITHHELD");
  expect(JSON.stringify(final.requests[0]?.body)).toContain("dori:close-thread:200");
  await f.deps.registry.write(lane("beta", { thread: "300", closedAt: new Date(T0).toISOString() }));
  const plain = await cli(f.state.dir, ["reported", "beta", "--text", "done"]);
  expect(plain.code).toBe(0);
  // The CLI stamps its receipts with the real clock; an old supervisor clock would prune them as long reported.
  f.clock.at = Date.now();
  await f.tick();
  expect(f.posts.map((post) => post.thread)).toEqual(["300"]);
  f.supervisor.close();
}, CLI_TIMEOUT);

test("dori reported --to discord:<thread> --final posts into that thread with the button; a configured channel is no thread", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", closedAt: new Date(T0).toISOString() }));
  const final = await cli(f.state.dir, ["reported", "alpha", "--text", "done", "--final", "--to", "discord:200"]);
  expect(final.code).toBe(0);
  expect(final.out).not.toContain("REPORT_BUTTON_WITHHELD");
  expect(JSON.stringify(final.requests[0]?.body)).toContain("dori:close-thread:200");
  const config = join(f.state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ discordChannels: ["100"] }));
  const channel = await cli(f.state.dir, ["reported", "alpha", "--text", "done", "--final", "--to", "discord:100"], { DORI_CONFIG: config });
  expect(channel.code).toBe(0);
  expect(channel.out).toContain("REPORT_BUTTON_WITHHELD alpha: the report is not posted into a thread");
}, CLI_TIMEOUT);
