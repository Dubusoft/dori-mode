import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, claimEventId, closeLane, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { claimGate } from "../src/ci-follow.ts";
import { eventClass, resolveEventPolicy } from "../src/event-policy.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
/** The lane's pane is listed with its agent, so the close's pane-close operation has something to close (its read-back sees it gone after). */
const livePane = () => { world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }]; };
/** The lanes whose runner was asked to close them (`lane.close`). */
const closedVia = () => world.ops.filter((e) => e.op === "close").map((e) => e.key);
/** The lane.git worktree removals the close asked the lane's runner for. */
const removals = () => world.ops.filter((e) => e.op === "git" && (e.args as { op: string }).op === "worktree-remove").map((e) => e.args as { op: string; root: string; path: string; opts?: { cmdId?: string } });

beforeEach(async () => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open; the lane hears a fixed sentence and reads the reasons from its status", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing; touch /tmp/x"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["changelog entry missing; touch /tmp/x"]);
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).at(-1)).toBe("[LEAD] not done: the Done check of demo-lane did not pass. Read the reasons with dori lane status demo-lane, keep working, and claim again when fixed");
  expect(sent(world).some((t) => t.includes("touch"))).toBe(false);
  // The reasons reach the lane's runner, where `dori lane status` reads them.
  expect(world.ops.filter((e) => e.op === "notify").map((e) => e.args)).toEqual([
    { status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "merged acme/app#1 abc123" } },
    { status: "not-done", objection: { at: new Date(T0 + MIN).toISOString(), reasons: ["changelog entry missing; touch /tmp/x"] } },
  ]);
});

test("the claim notice and the objection go to the lane through its runner, which alone decides whether its pane can take them", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, [";printf PANE_INJECTION;#"]);
  expect(world.ops.filter((e) => e.op === "send").map((e) => e.key)).toEqual(["demo-lane", "demo-lane"]);
  expect(sent(world).some((text) => text.includes("PANE_INJECTION"))).toBe(false);
  expect(world.calls.filter((c) => c[0] === "herdr")).toEqual([]);
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).toBe("not-done");
});

test("a remote lane on its runner is told where to read the reasons with the runner's dori", async () => {
  const remote: Lane = { ...lane, key: "remote-lane", machine: "box", runner: "box", reportVia: "cli" };
  await at(T0).registry.write(remote);
  await objectDone(at(T0), remote, ["tests red"]);
  expect(sent(world).at(-1)).toBe("[LEAD] not done: the Done check of remote-lane did not pass; the lead has the reasons. Read them with ~/.dori/runner/bin/dori lane status remote-lane, keep working, and claim again when fixed");
});

test("a done claim records the lane's open same-repo PRs at their live head SHA, never a fork PR, and nothing for a failed read", async () => {
  const HEAD = "a".repeat(40);
  const bound: Lane = { ...lane, done: 'merged acme/app#1; merged acme/app#5; command ["gh","pr","list","-R","acme/app","--head","feat","--json","number"]' };
  await at(T0).registry.write(bound);
  const base = at(T0);
  const run = async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
    if (argv[0] === "gh" && argv[2] === "view" && argv[3] === "1") return { code: 0, out: JSON.stringify({ number: 1, state: "OPEN", headRefOid: HEAD, isCrossRepository: false }), err: "" };
    if (argv[0] === "gh" && argv[2] === "view" && argv[3] === "5") return { code: 1, out: "", err: "HTTP 502" };
    if (argv[0] === "gh" && argv[2] === "list") return { code: 0, out: JSON.stringify([{ number: 9, state: "OPEN", headRefOid: "b".repeat(40), isCrossRepository: true }, { number: 3, state: "OPEN", headRefOid: "c".repeat(40), isCrossRepository: false }]), err: "" };
    return base.run(argv, opts);
  };
  await claimDone({ ...base, run }, bound, "merged acme/app#1");
  expect((await base.registry.read("demo-lane"))?.claim?.pulls).toEqual([{ repo: "acme/app", number: 1, sha: HEAD }, { repo: "acme/app", number: 3, sha: "c".repeat(40) }]);
});

test("sendVerified types nothing when the pane list cannot be read", async () => {
  const deps = at(T0);
  const run = async (argv: readonly string[]) => (argv[2] === "list" ? { code: 1, out: "", err: "server down" } : deps.run(argv));
  expect(await sendVerified(run, deps.clock, "w:p1", "[LEAD] hello")).toBe("failed");
  expect(world.calls.filter((c) => c[2] === "send-text")).toEqual([]);
});

test("five quiet minutes after a claim is handed over the lane is closed and its worktree removed", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual([]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toBe("LANE_CLOSED demo-lane closed seen-claim");
  expect(closedVia()).toEqual(["demo-lane"]);
  expect(removals()).toEqual([{ op: "worktree-remove", root: "/repo", path: WT, opts: { cmdId: `op:demo-lane/worktree-remove/${WT}:1` } }]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("a second done with the same evidence keeps the first claim: one LANE_DONE_CLAIMED, one notice, the window unmoved", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  const notices = sent(world).length;
  const ghCalls = world.calls.filter((c) => c[0] === "gh").length;
  expect(await claimDone(at(T0 + 2 * MIN), lane, "merged acme/app#1 abc123")).toBe(`LANE_DONE_ALREADY_CLAIMED demo-lane ${new Date(T0).toISOString()} merged acme/app#1 abc123`);
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.claim).toMatchObject({ at: new Date(T0).toISOString(), emitted: true });
  expect(sent(world)).toHaveLength(notices);
  expect(world.calls.filter((c) => c[0] === "gh")).toHaveLength(ghCalls);
  expect(await watchTick(at(T0 + 3 * MIN))).toEqual([]);
  // New evidence is a new claim, announced again.
  await claimDone(at(T0 + 4 * MIN), lane, "merged acme/app#1 def456");
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 def456"]);
});

test("after an objection the same evidence claims again", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["tests red"]);
  expect(await claimDone(at(T0 + 2 * MIN), lane, "merged acme/app#1")).toStartWith("LANE_DONE_CLAIMED demo-lane");
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("done-claimed");
  expect(after?.claim?.at).toBe(new Date(T0 + 2 * MIN).toISOString());
});

test("claim evidence and objection reasons are capped at 300 chars in event lines, and kept whole in the registry", async () => {
  const evidence = "e".repeat(400);
  expect(await claimDone(at(T0), { ...lane, pane: undefined }, evidence)).toBe(`LANE_DONE_CLAIMED demo-lane - ${"e".repeat(299)}…`);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.evidence).toBe(evidence);
  const reasons = ["r".repeat(400)];
  expect(await objectDone(at(T0), { ...lane, pane: undefined }, reasons)).toBe(`LANE_NOT_DONE demo-lane ${"r".repeat(299)}…`);
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual(reasons);
  expect(await objectDone(at(T0), { ...lane, pane: undefined }, ["x".repeat(300)])).toBe(`LANE_NOT_DONE demo-lane ${"x".repeat(300)}`);
});

test("the watcher's claim announcement is capped too", async () => {
  await claimDone(at(T0), lane, "w".repeat(400));
  expect(await watchTick(at(T0))).toEqual([`LANE_DONE_CLAIMED demo-lane w:p1 ${"w".repeat(299)}…`]);
});

test("CLOSED and LANE_CLOSED carry no receipt JSON while the registry keeps the receipt", async () => {
  livePane();
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(true);
  expect(r.lines.at(-1)).toBe("CLOSED demo-lane");
  expect(r.lines.some((l) => l.includes("{"))).toBe(false);
  expect((await at(T0).registry.read("demo-lane"))?.receipt).toMatchObject({ note: "manual", cleanup: expect.arrayContaining(["pane w:p1 closed"]) });
});

test("LANE_CLOSED keeps the PR URL the claim names", async () => {
  livePane();
  const url = "https://github.com/acme/app/pull/1";
  await claimDone(at(T0), lane, `merged ${url} abc123`);
  await watchTick(at(T0));
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim ${url}`);
});

test("settling a claim reads each Done signal once, in one inspection by the lane's runner, reusing them in the close", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  // The Done signal reads (signals.ts), not branch cleanup's own PR read (other --json fields).
  const reads = (from: number) => world.calls.slice(from).filter((c) => c[0] === "gh" && c[2] === "view" && (c.at(-1) === "state,mergeCommit" || c.at(-1) === "state")).map((c) => c.slice(1, 4).join(" "));
  const start = world.calls.length;
  const opsStart = world.ops.length;
  expect((await watchTick(at(T0 + 5 * MIN + 1)))[0]).toBe("LANE_CLOSED demo-lane closed seen-claim");
  const doneReads = world.ops.slice(opsStart).filter((e) => e.op === "inspect" && (e.args as { want: { done?: string } }).want.done !== undefined);
  expect(doneReads.map((e) => (e.args as { want: unknown }).want)).toEqual([{ git: true, roots: ["/repo"], done: lane.done, doneCwd: "/repo" }]);
  expect(reads(start).sort()).toEqual(["issue view 2", "pr view 1"]);
});

test("a close runs through the lane's runner: inspect, then the recorded worktree removal, then lane.close", async () => {
  livePane();
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(true);
  const steps = world.ops.filter((e) => e.op === "inspect" || e.op === "git" || e.op === "close").map((e) => e.op);
  expect(steps[0]).toBe("inspect");
  expect(steps.slice(steps.indexOf("git"))).toEqual(["git", "close"]);
  expect(removals()).toEqual([{ op: "worktree-remove", root: "/repo", path: WT, opts: { cmdId: `op:demo-lane/worktree-remove/${WT}:1` } }]);
  expect(world.ops.find((e) => e.op === "close")?.args).toEqual({ opts: { cmdId: "op:demo-lane/pane-close/w:p1:1" } });
});

test("with the lane's runner down a close is refused RUNNER_UNAVAILABLE and the lane stays open, its worktree and pane untouched", async () => {
  livePane();
  world.runnerDown = true;
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane: RUNNER_UNAVAILABLE runner=local ");
  expect(world.ops.filter((e) => e.op === "git" || e.op === "close")).toEqual([]);
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).toBe("working");
  world.runnerDown = false;
  expect((await closeLane(at(T0), lane, "manual")).closed).toBe(true);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

/** A lane whose Done is one `merged` PR the claim binds at HEAD; its live view follows `pr` (checks, head, state). */
const mergeOnly = (pr: { state: string; head?: string; checks: { status: string; conclusion?: string }[] }) => {
  const HEAD = "a".repeat(40);
  const bound: Lane = { ...lane, done: "merged acme/app#1" };
  const deps = (ms: number): FlowDeps => {
    const base = at(ms);
    const run = async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
      const fields = argv[argv.indexOf("--json") + 1] ?? "";
      if (argv[0] === "gh" && argv[2] === "view" && fields.includes("headRefOid") && !fields.includes("headRefName")) {
        return { code: 0, out: JSON.stringify({ number: 1, state: pr.state, headRefOid: pr.head ?? HEAD, isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", statusCheckRollup: pr.checks.map((c) => ({ __typename: "CheckRun", ...c })) }), err: "" };
      }
      return base.run(argv, opts);
    };
    return { ...base, run };
  };
  return { bound, deps, HEAD };
};

test("a Done=merged claim whose CI outlasts the window stays claimed, stays mergeable for the supervisor, and closes once the PR merges", async () => {
  livePane();
  world.prState = "OPEN";
  const pr: { state: string; checks: { status: string; conclusion?: string }[] } = { state: "OPEN", checks: [{ status: "IN_PROGRESS" }] };
  const { bound, deps, HEAD } = mergeOnly(pr);
  await deps(T0).registry.write(bound);
  await claimDone(deps(T0), bound, "PR acme/app#1 pushed");
  expect(await watchTick(deps(T0))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 PR acme/app#1 pushed"]);
  // The window ends with CI still running: no objection, the claim and its bound head stand.
  expect(await watchTick(deps(T0 + 6 * MIN))).toEqual([]);
  pr.checks = [{ status: "COMPLETED", conclusion: "SUCCESS" }];
  expect(await watchTick(deps(T0 + 20 * MIN))).toEqual([]);
  const waiting = (await at(T0).registry.read("demo-lane")) ?? bound;
  expect(statusOf(waiting)).toBe("done-claimed");
  expect(claimGate(waiting, { repo: "acme/app", number: 1, sha: HEAD })).toEqual({ ok: true, why: "claimed at this head" });
  expect(closedVia()).toHaveLength(0);
  // The supervisor merges it: the next pass reads the signal live and closes the lane.
  world.prState = "MERGED";
  pr.state = "MERGED";
  const lines = await watchTick(deps(T0 + 21 * MIN));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane closed seen-claim");
  expect(closedVia()).toEqual(["demo-lane"]);
});

test("a Done=merged claim objects with the reason once a check fails, the head moves, or the merge wait passes mergeWaitMaxMin", async () => {
  world.prState = "OPEN";
  const pr: { state: string; head?: string; checks: { status: string; conclusion?: string }[] } = { state: "OPEN", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] };
  const { bound, deps } = mergeOnly(pr);
  const objection = async () => ((await at(T0).registry.read("demo-lane")) ?? bound).objection?.reasons;
  const claimAndSettle = async (ms: number, afterClaim = () => {}): Promise<string[]> => {
    await deps(ms).registry.write(bound);
    await claimDone(deps(ms), bound, `claim ${ms}`);
    afterClaim();
    await watchTick(deps(ms));
    return watchTick(deps(ms + 6 * MIN));
  };
  expect((await claimAndSettle(T0))[0]).toStartWith("LANE_NOT_DONE demo-lane");
  expect(await objection()).toEqual(["merged acme/app#1 -> OPEN", "acme/app#1 has 1 failed check(s)"]);
  pr.checks = [{ status: "QUEUED" }];
  // A push after the claim: the PR's head is no longer the one the claim recorded.
  await claimAndSettle(T0 + 10 * MIN, () => { pr.head = "b".repeat(40); });
  expect((await objection())?.[1]).toStartWith("acme/app#1 head moved to bbbbbbbbbb after the claim");
  delete pr.head;
  await claimAndSettle(T0 + 20 * MIN);
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? bound)).toBe("done-claimed");
  // Handed over at T0+20: still waiting at T0+79, refused at T0+80 (mergeWaitMaxMin 60).
  expect(await watchTick(deps(T0 + 79 * MIN))).toEqual([]);
  expect((await watchTick(deps(T0 + 80 * MIN)))[0]).toStartWith("LANE_NOT_DONE demo-lane");
  expect((await objection())?.[1]).toStartWith("not merged within 60 min of the claim");
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1");
  // Handed over at T0+2: the window ends at T0+7, not five minutes after the restart.
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 7 * MIN + 1));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toBe("REFUSED demo-lane: a Done signal is not live (to give the lane up: dori close demo-lane --cancelled --reason TEXT)");
  expect(closedVia()).toHaveLength(0);
});

test("delivery is confirmed by the pane's agent status moving to working, with exactly one Enter", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("delivered");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("text still in the input line gets exactly one more Enter, and still there after it the send failed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.screens = ["❯ ", ...Array<string>(10).fill("❯ [LEAD] stuck text still here")];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] stuck text still here")).toBe("failed");
  expect(sent(world)).toEqual(["[LEAD] stuck text still here"]);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(2);
});

test("other text in the input line (maybe the owner's) is never typed into or submitted", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.screen = "❯ half a sentence";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("failed");
  world.screen = "an ask-user dialog, no prompt";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("failed");
  expect(world.calls.filter((c) => c[2] === "send-text" || c[2] === "send-keys")).toEqual([]);
});

test("the same text left unsubmitted by an earlier send only gets Enter, never a second copy", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  world.screens = ["❯ [LEAD] please report"];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("delivered");
  expect(sent(world)).toEqual([]);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a pane that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] queued while busy")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});

const KEPT_WT = "/data/repos/worktrees/demo/feat-x";
const closedKept = (paths: readonly string[] = [KEPT_WT], patch: Partial<Lane> = {}): Lane => ({
  ...lane, done: "merged acme/app#1", worktrees: [...paths], status: "closed", closedAt: new Date(T0).toISOString(),
  receipt: { cleanup: paths.map((p) => `worktree ${p} kept: fatal: '${p}' contains modified or untracked files`) }, ...patch,
});
/** The runner's git facts of `paths` (merged over every inspection), each clean or dirty. */
const facts = (paths: readonly string[], dirty: boolean) => {
  world.inspection = { git: { worktrees: paths.map((path) => ({ path, exists: true, dirty, ahead: 0 })) } };
};

test("a closed lane's worktree its close had to keep is removed once clean, under worktreeRoot, with one digest line", async () => {
  await at(T0).registry.write(closedKept());
  facts([KEPT_WT], true);
  expect(await watchTick(at(T0))).toEqual([]);
  facts([KEPT_WT], false);
  expect(await watchTick(at(T0))).toEqual([`WORKTREE_CLEANED demo-lane ${KEPT_WT}`]);
  expect(removals()).toEqual([{ op: "worktree-remove", root: "/repo", path: KEPT_WT }]);
});

test("working, not-done and paused lanes keep their worktrees even after their PR merged", async () => {
  facts([KEPT_WT], false);
  for (const status of ["working", "not-done", "paused"] as const) {
    await at(T0).registry.write({ ...lane, done: "merged acme/app#1", worktrees: [KEPT_WT], status });
    expect(await watchTick(at(T0))).toEqual([]);
  }
  expect(removals()).toHaveLength(0);
});

test("the root comes from config, a path outside it is never removed, and a failed removal is a LANE_WATCH_WARN", async () => {
  await at(T0).registry.write(closedKept(["/repo/.wt/other", "/data/repos/worktrees/../escape"]));
  expect(await watchTick(at(T0))).toEqual([]);
  facts(["/repo/.wt/other"], false);
  const custom = depsFor(world, fakeClock(T0), state.dir, { worktreeRoot: "/repo/.wt" });
  const failing = { ...custom, ops: { ...custom.ops, git: async () => ({ code: 128, out: "", err: "fatal: locked" }) } };
  expect(await watchTick(failing)).toEqual(["LANE_WATCH_WARN demo-lane worktree /repo/.wt/other not removed: fatal: locked"]);
  expect(await watchTick(custom)).toEqual(["WORKTREE_CLEANED demo-lane /repo/.wt/other"]);
});

test("LANE_DONE_CLAIMED is handed over before the claim is marked announced, and a failed hand-over keeps it unannounced", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  const failing = async (): Promise<void> => { throw new Error("journal disk full"); };
  await expect(watchTick(at(T0 + MIN), failing)).rejects.toThrow("journal disk full");
  expect((await at(T0).registry.read("demo-lane"))?.claim?.emitted).toBe(false);
  const got: string[] = [];
  await watchTick(at(T0 + 2 * MIN), async (line) => { got.push(line); });
  expect(got).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.emitted).toBe(true);
});

test("one lane's failure is a LANE_WATCH_WARN line and the other lanes are still watched", async () => {
  await at(T0).registry.write({ ...lane, key: "a-broken", status: "done-claimed", claim: { at: new Date(T0 - 10 * MIN).toISOString(), evidence: "x", emitted: true }, done: "merged acme/app#1" });
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  const base = at(T0 + MIN);
  const registry = Object.assign(Object.create(base.registry) as typeof base.registry, {
    update: async (key: string, mutate: Parameters<typeof base.registry.update>[1]) => { if (key === "a-broken") throw new Error("registry write failed"); return base.registry.update(key, mutate); },
  });
  const lines = await watchTick({ ...base, registry });
  expect([...lines].sort()).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123", "LANE_WATCH_WARN a-broken registry write failed"]);
});

/** `received` is the supervisor's answer for journaled ids (absent: `dori watch`, no supervisor). */
const onDelivery = (ms: number, received?: (id: string) => boolean, digestClaims = false): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, {
    ...(digestClaims ? { eventPolicy: resolveEventPolicy({ kinds: { LANE_DONE_CLAIMED: "lead-digest" } }) } : {}),
  }),
  ...(received ? { leadDelivered: received } : {}),
});

test("with claims made digest, a claim is the supervisor's to settle: its window runs from the hand-over even while the lead never receives it", async () => {
  livePane();
  await claimDone(onDelivery(T0, undefined, true), lane, "merged acme/app#1 abc123");
  expect(sent(world).at(-1)).toContain("closes automatically at 12:05Z (5 minutes) once its Done signals read back live");
  const never = () => false;
  expect(await watchTick(onDelivery(T0 + MIN, never, true))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.deliveredAt).toBe(new Date(T0 + MIN).toISOString());
  expect(await watchTick(onDelivery(T0 + 5 * MIN, never, true))).toEqual([]);
  const lines = await watchTick(onDelivery(T0 + 6 * MIN + 1, never, true));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual(["demo-lane"]);
});

test("by default a claim the lead receives 40 minutes late still gets the full window from that delivery, and its close is digest", async () => {
  livePane();
  let received = false;
  const claimAt = new Date(T0).toISOString();
  const lead = (id: string) => received && id === claimEventId("demo-lane", claimAt);
  await claimDone(onDelivery(T0), lane, "merged acme/app#1 abc123");
  expect(sent(world).at(-1)).toContain("closes automatically 5 minutes after the lead receives this claim");
  const ids: (string | undefined)[] = [];
  expect(await watchTick(onDelivery(T0 + MIN, lead), async (_line, id) => { ids.push(id); })).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(ids).toEqual([`done-claim:demo-lane:${claimAt}`]);
  // Undelivered (the lead is down): the claim waits, however old.
  expect(await watchTick(onDelivery(T0 + 39 * MIN, lead))).toEqual([]);
  received = true;
  expect(await watchTick(onDelivery(T0 + 40 * MIN, lead))).toEqual([]);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.deliveredAt).toBe(new Date(T0 + 40 * MIN).toISOString());
  expect(await watchTick(onDelivery(T0 + 44 * MIN, lead))).toEqual([]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(onDelivery(T0 + 45 * MIN + 1, lead));
  expect(lines[0]).toBe("LANE_CLOSED demo-lane closed seen-claim");
  expect(eventClass(lines[0] ?? "")).toBe("lead-digest");
  expect(closedVia()).toEqual(["demo-lane"]);
});

test("with no supervisor (dori watch) the window starts when the claim is handed over", async () => {
  await claimDone(onDelivery(T0), lane, "merged acme/app#1");
  expect(await watchTick(onDelivery(T0 + 20 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1"]);
  expect(await watchTick(onDelivery(T0 + 24 * MIN))).toEqual([]);
  expect((await watchTick(onDelivery(T0 + 25 * MIN)))[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("a close whose claim the lead already received is digest (seen-claim); a merge that closes the lane before the lead received its claim wakes the lead", async () => {
  livePane();
  await claimDone(onDelivery(T0), lane, "merged acme/app#1");
  await watchTick(onDelivery(T0, () => true));
  const seen = (await watchTick(onDelivery(T0 + 5 * MIN + 1, () => true)))[0] ?? "";
  expect(seen).toStartWith("LANE_CLOSED demo-lane closed seen-claim");
  expect(eventClass(seen)).toBe("lead-digest");

  await at(T0).registry.write(lane);
  livePane();
  await claimDone(onDelivery(T0), lane, "merged acme/app#1");
  // The lead never receives the claim: its window never starts, so the lane stays open however long it waits.
  expect(await watchTick(onDelivery(T0, () => false))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1"]);
  expect(await watchTick(onDelivery(T0 + 60 * MIN, () => false))).toEqual([]);
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).toBe("done-claimed");
  // Its PR then reads merged: the lane closes at once, before the lead got the claim, so this close wakes the lead.
  const base = onDelivery(T0 + 61 * MIN, () => false);
  const merged = JSON.stringify({ state: "MERGED", headRefName: "demo-lane", headRefOid: "a".repeat(40), baseRefName: "dev", isCrossRepository: false });
  const run: FlowDeps["run"] = async (argv, opts) =>
    argv[0] === "gh" && argv[2] === "view" && argv.includes("state,headRefName,headRefOid,baseRefName,isCrossRepository") ? { code: 0, out: merged, err: "" } : base.run(argv, opts);
  const unseen = (await watchTick({ ...base, run }))[0] ?? "";
  expect(unseen).toStartWith("LANE_CLOSED demo-lane closed");
  expect(unseen).not.toContain("seen-claim");
  expect(eventClass(unseen)).toBe("lead-urgent");
});

test("a claim announced by an older dori (no event id) keeps its window from the claim", async () => {
  await at(T0).registry.write({ ...lane, status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "merged acme/app#1", emitted: true } });
  expect((await watchTick(onDelivery(T0 + 5 * MIN + 1, () => false)))[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("an autoClose: machine lane claims and closes as LANE_AUTO_* lines with its window from the claim, never waiting for the lead", async () => {
  livePane();
  const machine: Lane = { ...lane, autoClose: "machine" };
  await at(T0).registry.write(machine);
  await claimDone(onDelivery(T0), machine, "merged acme/app#1");
  expect(sent(world).at(-1)).toContain("closes automatically at 12:05Z (5 minutes)");
  const ids: (string | undefined)[] = [];
  expect(await watchTick(onDelivery(T0 + MIN, () => false), async (_line, id) => { ids.push(id); })).toEqual(["LANE_AUTO_CLAIMED demo-lane w:p1 merged acme/app#1"]);
  expect(ids).toEqual([undefined]);
  const lines = await watchTick(onDelivery(T0 + 5 * MIN + 1, () => false));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("LANE_AUTO_CLOSED demo-lane ");
  expect(closedVia()).toEqual(["demo-lane"]);
});

test("events about a lane carry its meta: the claim announcement gets lane, thread and cwd", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  const got: [string, unknown][] = [];
  await watchTick(at(T0 + MIN), async (line, _id, meta) => { got.push([line, meta]); });
  expect(got).toEqual([["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123", { lane: "demo-lane", thread: "chat:team/123", cwd: "/repo" }]]);
});
