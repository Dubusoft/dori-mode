import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp, type CiIo, ciMessageId, laneDown, launchMergeLane, mergeLaneKey, rebaseMessageId } from "../src/ci-follow.ts";
import { loadConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { eventClass } from "../src/event-policy.ts";
import type { OpenPull } from "../src/github-events.ts";
import { briefIssue, LaunchError } from "../src/launch.ts";
import { ackLaneMessage, LaneMessageError } from "../src/lane-messages.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, TEST_STORE, withState, type World } from "./fakes.ts";
import { BUILT_IN } from "../src/tunables.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/b.md", done: "merged acme/app#7", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const claimedLane: Lane = { ...lane, status: "done-claimed", claim: { at: new Date(T0 + MIN).toISOString(), evidence: "PR green", emitted: true, pulls: [{ repo: "acme/app", number: 7, sha: SHA }] } };
const pull = (patch: Partial<OpenPull> = {}): OpenPull => ({ repo: "acme/app", number: 7, sha: SHA, branch: "feat", headRepo: "acme/app", url: "https://github.com/acme/app/pull/7", conflicting: false, checks: "failing", ...patch });
const idle = { pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "idle" };

type Gh = { view: Record<string, unknown>; viewCode: number; mergeCode: number; merges: string[][]; issue: string; closes: string[][] };
const greenView = (patch: Record<string, unknown> = {}) => ({
  state: "OPEN", baseRefName: "dev", headRefOid: SHA, isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: null, ...patch,
});

/** herdr and git from fakes.ts; `gh pr view` / `gh pr merge` from a PR whose merge flips it to MERGED. */
const runner = (w: World, gh: Gh): Runner => {
  const base = fakeRunner(w);
  return async (argv, opts): Promise<Ran> => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
      w.calls.push([...argv]);
      return gh.viewCode === 0 ? { code: 0, out: JSON.stringify(gh.view), err: "" } : { code: gh.viewCode, out: "", err: "HTTP 502" };
    }
    if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "view") return { code: 0, out: JSON.stringify({ state: gh.issue }), err: "" };
    if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "close") {
      gh.closes.push([...argv]);
      gh.issue = "CLOSED";
      return { code: 0, out: "", err: "" };
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      w.calls.push([...argv]);
      gh.merges.push([...argv]);
      if (gh.mergeCode !== 0) return { code: gh.mergeCode, out: "", err: "Pull request is not mergeable" };
      gh.view = { ...gh.view, state: "MERGED", mergeCommit: { oid: "m3rge5ha" } };
      return { code: 0, out: "", err: "" };
    }
    return base(argv, opts);
  };
};

let state: ReturnType<typeof withState>;
let world: World;
let gh: Gh;
let clock: ReturnType<typeof fakeClock>;
let deps: FlowDeps;
let events: [string, string][];
let launches: string[];
let open: CiFollowUp[];
const emit = (id: string, line: string): void => { events.push([id, line]); };
const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(kind))).values()];
const io = (patch: Partial<CiIo> = {}): CiIo => ({ launch: async () => ({ ok: false, detail: "no launch in this test" }), ...patch });
const follow = (patch: Partial<CiIo> = {}): CiFollowUp => {
  const ci = new CiFollowUp(deps, io(patch));
  open.push(ci);
  return ci;
};

beforeEach(async () => {
  state = withState();
  if (TEST_STORE === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  world = newWorld();
  world.panes = [{ ...idle }];
  gh = { view: greenView(), viewCode: 0, mergeCode: 0, merges: [], issue: "OPEN", closes: [] };
  clock = fakeClock(T0);
  deps = { ...depsFor(world, clock, state.dir, {}), run: runner(world, gh) };
  await deps.registry.update(lane.key, () => claimedLane);
  events = [];
  launches = [];
  open = [];
});
afterEach(() => { for (const ci of open) ci.close(); state.done(); });

test("failing CI on a lane PR is one lane message with an ID, typed once into the idle agent pane and confirmed by that lane's ack", async () => {
  const ci = follow();
  const id = ciMessageId(pull());
  await ci.tick([pull()], emit);
  await ci.tick([pull()], emit);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain(`dori report ack ${id}`);
  // One facade send, as the recorded operation's effect: verified, input-checked, keyed by the operation's cmdId.
  expect(world.ops.filter((e) => e.op === "send")).toHaveLength(1);
  expect(world.ops.find((e) => e.op === "send")?.args).toMatchObject({
    opts: { mode: "verified", inputCheck: true, cmdId: `op:demo-lane/lane-message/${id}:1` },
  });
  expect(ci.messages.get(id)).toMatchObject({ lane: "demo-lane", state: "delivered" });

  expect(() => ackLaneMessage(ci.messages, "other-lane", id, clock.now())).toThrow(LaneMessageError);
  expect(ackLaneMessage(ci.messages, "demo-lane", id, clock.now())).toMatchObject({ state: "acked" });
  clock.at += 30 * MIN;
  await ci.tick([pull()], emit);
  expect(sent(world)).toHaveLength(1);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")).toEqual([]);
});

test("a delivered message the lane never confirms reaches the lead once, after ciConfirmMin", async () => {
  const ci = follow();
  await ci.tick([pull()], emit);
  clock.at += 19 * MIN;
  await ci.tick([pull()], emit);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")).toEqual([]);
  clock.at += 2 * MIN;
  await ci.tick([pull()], emit);
  await ci.tick([pull()], emit);
  expect(events.filter(([, l]) => l.startsWith("LANE_MESSAGE_UNCONFIRMED"))).toHaveLength(1);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")[0]).toContain("delivered but not confirmed");
  expect(sent(world)).toHaveLength(1);
});

for (const [name, setup, reason] of [
  ["busy", () => { world.panes = [{ ...idle, agent_status: "working" }]; }, "busy (working)"],
  ["paused", async () => { await deps.registry.update(lane.key, () => ({ ...lane, status: "paused" })); }, "lane paused"],
  ["missing", () => { world.panes = []; }, "pane w:p1 missing"],
] as const) {
  test(`a ${name} pane keeps the message queued, untyped, and wakes the lead once after the deadline`, async () => {
    await setup();
    const ci = follow();
    const id = ciMessageId(pull());
    await ci.tick([pull()], emit);
    expect(sent(world)).toEqual([]);
    expect(ci.messages.get(id)).toMatchObject({ state: "queued", blocked: expect.stringContaining(reason) });
    clock.at += 21 * MIN;
    await ci.tick([pull()], emit);
    await ci.tick([pull()], emit);
    expect(events.filter(([, l]) => l.startsWith("LANE_MESSAGE_UNCONFIRMED"))).toHaveLength(1);
    expect(lines("LANE_MESSAGE_UNCONFIRMED")[0]).toContain(`demo-lane ${id} not delivered: `);
    expect(sent(world)).toEqual([]);
  });
}

test("a send the runner refuses (owner's text in the input line, runner down) keeps the message queued and wakes the lead once after the deadline", async () => {
  world.sendDelivery = "failed";
  const ci = follow();
  const id = ciMessageId(pull());
  await ci.tick([pull()], emit);
  expect(ci.messages.get(id)).toMatchObject({ state: "queued", blocked: expect.stringContaining("send failed") });
  clock.at += 21 * MIN;
  await ci.tick([pull()], emit);
  expect(events.filter(([, l]) => l.startsWith("LANE_MESSAGE_UNCONFIRMED"))).toHaveLength(1);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")[0]).toContain(`demo-lane ${id} not delivered: `);
});

test("an unconfirmed send counts as delivered and is never retyped", async () => {
  world.sendDelivery = "unconfirmed";
  const ci = follow();
  const id = ciMessageId(pull());
  await ci.tick([pull()], emit);
  await ci.tick([pull()], emit);
  expect(ci.messages.get(id)).toMatchObject({ state: "delivered" });
  expect(sent(world)).toHaveLength(1);
});

test("a new head SHA supersedes the queued message for the old one", async () => {
  world.panes = [{ ...idle, agent_status: "working" }];
  const ci = follow();
  await ci.tick([pull()], emit);
  const moved = pull({ sha: "1234567890abcdef1234567890abcdef12345678" });
  await ci.tick([moved], emit);
  expect(ci.messages.get(ciMessageId(pull()))?.state).toBe("superseded");
  expect(ci.messages.get(ciMessageId(moved))?.state).toBe("queued");
});

test("a delivered message whose PR went green is superseded and never reaches the lead", async () => {
  const ci = follow();
  await ci.tick([pull()], emit);
  expect(ci.messages.get(ciMessageId(pull()))?.state).toBe("delivered");
  gh.view = greenView({ baseRefName: "main" });
  await ci.tick([pull({ checks: "green" })], emit);
  clock.at += 30 * MIN;
  await ci.tick([pull({ checks: "green" })], emit);
  expect(ci.messages.get(ciMessageId(pull()))?.state).toBe("superseded");
  expect(lines("LANE_MESSAGE_UNCONFIRMED")).toEqual([]);
});

test("a lane whose runner cannot answer keeps its failing-CI message open, and it is typed once the runner is back", async () => {
  // The PR belongs to the lane only through its worktree branch, which the lane's runner reports.
  await deps.registry.update(lane.key, () => ({ ...lane, done: "merged acme/other#99" }));
  world.inspection = { git: { toplevel: "/repo", branch: "feat", origin: "git@github.com:acme/app.git", worktrees: [] } };
  world.panes = [{ ...idle, agent_status: "working" }];
  const ci = follow();
  const id = ciMessageId(pull());
  await ci.tick([pull()], emit);
  expect(ci.messages.get(id)?.state).toBe("queued");
  world.runnerDown = true;
  await ci.tick([pull()], emit);
  expect(ci.messages.get(id)?.state).toBe("queued");
  world.runnerDown = false;
  world.panes = [{ ...idle }];
  await ci.tick([pull()], emit);
  expect(ci.messages.get(id)?.state).toBe("delivered");
  expect(sent(world)).toHaveLength(1);
});

test("a superseded failing-CI message is queued again when the same head fails again", async () => {
  world.panes = [{ ...idle, agent_status: "working" }];
  const ci = follow();
  const id = ciMessageId(pull());
  await ci.tick([pull()], emit);
  await ci.tick([pull({ checks: "pending" })], emit);
  expect(ci.messages.get(id)?.state).toBe("superseded");
  world.panes = [{ ...idle }];
  await ci.tick([pull()], emit);
  expect(ci.messages.get(id)).toMatchObject({ state: "delivered" });
  expect(sent(world)).toHaveLength(1);
});

test("a green, clean lane PR into dev is merged once with --match-head-commit and no --admin; a second poll and a restart merge nothing", async () => {
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([["gh", "pr", "merge", "7", "-R", "acme/app", "--merge", "--match-head-commit", SHA]]);
  expect(lines("CI_MERGED")).toEqual(["CI_MERGED acme/app#7 into dev lane=demo-lane head=abcdef1 merge=m3rge5ha https://github.com/acme/app/pull/7"]);
  gh.view = greenView();
  await open[0]?.tick([pull({ checks: "green" })], emit);
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toHaveLength(1);
});

test("a green lane PR is merged only at the head its done claim recorded: no claim, an older claimed head or a claim without a head never merge", async () => {
  const ci = follow();
  const green = pull({ checks: "green" });
  await deps.registry.update(lane.key, () => lane);
  await ci.tick([green], emit);
  expect(gh.merges).toEqual([]);

  // Claimed at an older head, then pushed: the PR head is not the claimed one (commit dates are not consulted).
  const OLD = "1111111111111111111111111111111111111111";
  await deps.registry.update(lane.key, () => ({ ...claimedLane, claim: { ...claimedLane.claim!, at: new Date(T0 + 9 * MIN).toISOString(), pulls: [{ repo: "acme/app", number: 7, sha: OLD }] } }));
  await ci.tick([green], emit);
  expect(gh.merges).toEqual([]);

  // A claim from before heads were recorded binds nothing.
  await deps.registry.update(lane.key, () => ({ ...claimedLane, claim: { at: new Date(T0 + 9 * MIN).toISOString(), evidence: "old dori", emitted: true } }));
  await ci.tick([green], emit);
  expect(gh.merges).toEqual([]);

  // The lane claims again at its current head: merged on the next poll, at exactly that head.
  await deps.registry.update(lane.key, () => claimedLane);
  await ci.tick([green], emit);
  expect(gh.merges).toEqual([["gh", "pr", "merge", "7", "-R", "acme/app", "--merge", "--match-head-commit", SHA]]);
});

test("a claimed PR the supervisor cannot merge (review BLOCKED, no checks) wakes the lead once as urgent MERGE_STALLED after mergeStallMin; pending CI never does", async () => {
  gh.view = greenView({ mergeStateStatus: "BLOCKED" });
  const ci = follow();
  await ci.tick([pull({ checks: "green" })], emit);
  clock.at += 14 * MIN;
  await ci.tick([pull({ checks: "green" })], emit);
  expect(lines("MERGE_STALLED")).toEqual([]);
  clock.at += 2 * MIN;
  await ci.tick([pull({ checks: "green" })], emit);
  await ci.tick([pull({ checks: "green" })], emit);
  expect(events.filter(([, l]) => l.startsWith("MERGE_STALLED"))).toHaveLength(1);
  expect(lines("MERGE_STALLED")[0]).toStartWith("MERGE_STALLED acme/app#7 lane=demo-lane head=abcdef1 mergeable MERGEABLE state BLOCKED for 15+ min");
  expect(eventClass(lines("MERGE_STALLED")[0] ?? "", deps.tunables.eventPolicy)).toBe("lead-urgent");
  expect(gh.merges).toEqual([]);

  events = [];
  const none = follow();
  await none.tick([pull({ checks: "none" })], emit);
  clock.at += 16 * MIN;
  await none.tick([pull({ checks: "none" })], emit);
  expect(lines("MERGE_STALLED")[0]).toContain(" no checks for 15+ min");

  // Long CI is the claim's own merge wait, never a stall; a poll that sees it moving resets the clock.
  events = [];
  const pending = follow();
  await pending.tick([pull({ checks: "none" })], emit);
  for (let i = 0; i < 4; i++) {
    clock.at += 20 * MIN;
    await pending.tick([pull({ checks: "pending" })], emit);
  }
  expect(lines("MERGE_STALLED")).toEqual([]);
});

test("a green, clean PR left unmerged for want of a claim is MERGE_STALLED only while its lane waits on that merge", async () => {
  const stalledFor = async (patch: Partial<Lane>): Promise<string[]> => {
    events = [];
    await deps.registry.update(lane.key, () => ({ ...lane, ...patch }));
    const ci = follow();
    await ci.tick([pull({ checks: "green" })], emit);
    clock.at += 16 * MIN;
    await ci.tick([pull({ checks: "green" })], emit);
    return lines("MERGE_STALLED");
  };
  // Told not done after its claim (the settle re-check or the lead objected): the supervisor never merges it.
  expect((await stalledFor({ status: "not-done" }))[0]).toContain("lane is not-done, no done claim for 15+ min: green and clean");
  // Still working with Done naming this PR as merged: it may be waiting for the merge instead of claiming.
  expect((await stalledFor({}))[0]).toContain("lane is working, no done claim");
  expect(await stalledFor({ status: "paused" })).toEqual([]);
  expect(gh.merges).toEqual([]);
});

test("a fork PR named like the lane's PR or branch gets no merge, CI message, merge lane or issue close", async () => {
  // The lane owns its branch "feat" (a gh pr --head Done signal) and claimed PR #7; the outsider opens #999 from a fork.
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#3", done: 'merged acme/app#7; command ["gh","pr","list","-R","acme/app","--head","feat","--json","number"]', claim: { ...claimedLane.claim!, pulls: [{ repo: "acme/app", number: 999, sha: SHA }] } }));
  gh.view = greenView({ isCrossRepository: true });
  const fork = (patch: Partial<OpenPull>) => pull({ number: 999, url: "https://github.com/acme/app/pull/999", headRepo: "outsider/app", ...patch });
  const ci = follow({ launch: async () => { launches.push("launched"); return { ok: true, detail: "STARTUP_OK" }; } });
  for (const patch of [{ checks: "green" as const }, { checks: "failing" as const }, { conflicting: true }, { checks: "green" as const, headRepo: undefined }]) {
    await ci.tick([fork(patch)], emit, [{ repo: "acme/app", number: 999, url: "https://github.com/acme/app/pull/999", branch: "feat", headRepo: "outsider/app" }]);
  }
  expect(gh.merges).toEqual([]);
  expect(launches).toEqual([]);
  expect(gh.closes).toEqual([]);
  expect(ci.messages.list({})).toEqual([]);
  expect(ci.ops.list({})).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "gh" || c[2] === "send-text")).toEqual([]);
  expect(events).toEqual([]);
});

test("mergeGate never merges a fork head, even for a lane-owned number", async () => {
  gh.view = greenView({ isCrossRepository: true });
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([]);
});

test("mergeGate never merges a PR whose checks were all skipped or neutral; one passing check makes it green", async () => {
  const skipped = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" };
  const neutral = { __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" };
  const ci = follow();
  gh.view = greenView({ statusCheckRollup: [skipped, neutral] });
  await ci.tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([]);
  gh.view = greenView({ statusCheckRollup: [skipped, neutral, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] });
  await ci.tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([["gh", "pr", "merge", "7", "-R", "acme/app", "--merge", "--match-head-commit", SHA]]);
});

test("a merge lane refuses a fork head and an option-shaped or invalid branch before any git call", async () => {
  const source = { ...claimedLane };
  for (const [patch, why] of [
    [{ headRepo: "outsider/app" }, "has its head in outsider/app"],
    [{ branch: "--upload-pack=printf${IFS}FETCH_INJECTION>&2;#" }, "is not a valid branch"],
  ] as const) {
    const r = await launchMergeLane(deps, { key: mergeLaneKey(pull()), source, pull: pull(patch), base: "dev" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(why);
  }
  const bad = await launchMergeLane({ ...deps, run: async (argv, opts) => (argv[1] === "check-ref-format" ? { code: 1, out: "", err: "" } : deps.run(argv, opts)) }, { key: mergeLaneKey(pull()), source, pull: pull({ branch: "a..b" }), base: "dev" });
  expect(bad).toEqual({ ok: false, detail: 'branch name "a..b" of acme/app#7 is not a valid branch' });
  expect(world.calls.filter((c) => c[0] === "git" && c[1] !== "check-ref-format")).toEqual([]);
});

test("a merge lane asks the runner, in order, whether the worktree exists, then to fetch and to add it; each refusal keeps its detail", async () => {
  const request = { key: mergeLaneKey(pull()), source: { ...claimedLane }, pull: pull(), base: "dev" };
  const roomy = (argv: readonly string[], opts?: Parameters<typeof deps.run>[1]) =>
    argv[0] === "df" ? Promise.resolve({ code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }) : deps.run(argv, opts);
  const exists = async () => [false];
  const failing = (fail: string) => ({ ...deps.ops, exists, git: async (lane: Parameters<typeof deps.ops.git>[0], op: Parameters<typeof deps.ops.git>[1]) => {
    await deps.ops.git(lane, op);
    return op.op === fail ? { code: 128, out: "", err: `${fail} boom\n` } : { code: 0, out: "", err: "" };
  } });
  const fetchFail = await launchMergeLane({ ...deps, run: roomy, ops: failing("fetch-branch") }, request);
  expect(fetchFail).toEqual({ ok: false, detail: "git fetch failed: fetch-branch boom" });
  world.ops.length = 0;
  const addFail = await launchMergeLane({ ...deps, run: roomy, ops: failing("worktree-add") }, request);
  expect(addFail).toEqual({ ok: false, detail: "git worktree add failed: worktree-add boom" });
  const git = world.ops.filter((o) => o.op === "git");
  expect(git.map((o) => (o.args as { op: string }).op)).toEqual(["fetch-branch", "worktree-add"]);
  expect(git[0]!.args).toMatchObject({ root: claimedLane.cwd, remote: "origin", branch: "feat" });
  expect(git[1]!.args).toMatchObject({ root: claimedLane.cwd, ref: "refs/remotes/origin/feat" });
  const present = await launchMergeLane({ ...deps, run: roomy, ops: { ...deps.ops, exists: async () => [true] } }, request);
  expect(present.detail).toMatch(/^worktree .* already exists$/);
  expect(world.calls.filter((c) => c[0] === "git" && c[1] !== "check-ref-format")).toEqual([]);
});

test("a merge lane's worktree goes under the local runner's reported worktree root, else under config.worktreeRoot", async () => {
  const request = { key: mergeLaneKey(pull()), source: { ...claimedLane }, pull: pull(), base: "dev" };
  const roomy = (argv: readonly string[], opts?: Parameters<typeof deps.run>[1]) =>
    argv[0] === "df" ? Promise.resolve({ code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }) : deps.run(argv, opts);
  const asked: string[] = [];
  const present = { ...deps.ops, exists: async (_m: string | undefined, paths: readonly string[]) => { asked.push(...paths); return [true]; } };
  const labels: string[] = [];
  const reported = (label: string) => { labels.push(label); return "/srv/wt/"; };
  await launchMergeLane({ ...deps, run: roomy, ops: present, runnerWorktreeRoot: reported }, request);
  await launchMergeLane({ ...deps, run: roomy, ops: present, runnerWorktreeRoot: () => undefined }, request);
  expect(labels).toEqual(["local"]);
  expect(asked).toEqual([`/srv/wt/app/${request.key}`, `${deps.config.worktreeRoot}/app/${request.key}`]);
});

test("a PR with no lane is not merged", async () => {
  await follow().tick([pull({ number: 99, branch: "other", checks: "green" })], emit);
  expect(gh.merges).toEqual([]);
});

test("a merge a crash left attempted is settled by read-back: merged verifies without merging, unreadable is ambiguous and never merges", async () => {
  const id = `demo-lane/merge/acme/app#7@${SHA}`;
  const attempted = { id, lane: "demo-lane", action: "merge", target: `acme/app#7@${SHA}`, state: "attempted" as const, detail: "attempted", attempts: 1, at: T0, updatedAt: T0 };
  const ci = follow();
  ci.ops.put(attempted);
  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  await ci.tick([pull({ checks: "green" })], emit);
  expect(ci.ops.get(id)?.state).toBe("verified");
  expect(lines("CI_MERGED")[0]).toContain("merge=m3rge5ha");

  ci.ops.put(attempted);
  gh.view = greenView();
  gh.viewCode = 1;
  await ci.tick([pull({ checks: "green" })], emit);
  gh.viewCode = 0;
  await ci.tick([pull({ checks: "green" })], emit);
  expect(ci.ops.get(id)?.state).toBe("ambiguous");
  expect(gh.merges).toEqual([]);
});

test("never merges into main; into dev a green, claimed PR merges with no other gate, an old config's ciToodoWorkspaces ignored", async () => {
  gh.view = greenView({ baseRefName: "main" });
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([]);

  deps = { ...deps, config: Object.assign({}, deps.config, { ciToodoWorkspaces: { "Acme/App": 3 } }) };
  gh.view = greenView();
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toHaveLength(1);
  expect(lines("CI_MERGE_SKIPPED")).toEqual([]);
});

const recordLaunch: CiIo["launch"] = async (d, request) => {
  launches.push(request.key);
  await d.registry.update(request.key, () => ({ ...lane, key: request.key, done: `merged acme/app#${request.pull.number}`, openedAt: new Date(clock.now()).toISOString() }));
  return { ok: true, detail: "STARTUP_OK" };
};

test("a conflicting PR whose lane is live gets one rebase message and no merge lane; once the lane's agent is gone a merge lane starts and the message is superseded", async () => {
  const conflicting = pull({ conflicting: true, checks: "green" });
  const id = rebaseMessageId(conflicting);
  const ci = follow({ launch: recordLaunch });
  await ci.tick([conflicting], emit);
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain("rebase your branch onto origin/dev yourself");
  expect(sent(world)[0]).toContain(`dori report ack ${id}`);
  expect(ci.messages.get(id)).toMatchObject({ lane: "demo-lane", state: "delivered" });

  // A busy agent is still live: it gets no merge lane beside it.
  world.panes = [{ ...idle, agent_status: "working" }];
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([]);
  expect(lines("CI_MERGE_LANE")).toEqual([]);
  expect(lines("CI_CONFLICT")).toEqual([]);

  world.panes = [];
  await ci.tick([conflicting], emit);
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([mergeLaneKey(conflicting)]);
  expect(events.filter(([, l]) => l.startsWith("CI_MERGE_LANE")).map(([id]) => id)).toEqual([`ci-merge-lane:acme/app#7@${SHA}`, `ci-merge-lane:acme/app#7@${SHA}`]);
  expect(events.find(([, l]) => l.startsWith("CI_MERGE_LANE"))?.[1]).toContain("(lane demo-lane: pane w:p1 missing, head abcdef1)");
  expect(ci.messages.get(id)?.state).toBe("superseded");
});

for (const [name, setup, reason] of [
  ["paused", async () => { await deps.registry.update(lane.key, () => ({ ...claimedLane, status: "paused" })); }, "lane paused"],
  ["agentless", () => { world.panes = [{ pane_id: "w:p1", workspace_id: "w" }]; }, "pane w:p1 runs no agent"],
  ["missing", () => { world.panes = []; }, "pane w:p1 missing"],
] as const) {
  test(`a conflicting PR whose lane is ${name} gets a merge lane and no rebase message`, async () => {
    await setup();
    const conflicting = pull({ conflicting: true, checks: "green" });
    const ci = follow({ launch: recordLaunch });
    await ci.tick([conflicting], emit);
    expect(launches).toEqual(["merge-app-7"]);
    expect(lines("CI_MERGE_LANE")[0]).toContain(`(lane demo-lane: ${reason}, head abcdef1)`);
    expect(ci.messages.get(rebaseMessageId(conflicting))).toBeUndefined();
  });
}

test("laneDown: a closed lane is down; an unreadable pane list counts as live", () => {
  expect(laneDown({ ...lane, closedAt: new Date(T0).toISOString() }, [idle])).toBe("lane closed");
  expect(laneDown(lane, [idle])).toBeUndefined();
  expect(laneDown(lane, new Error("herdr down"))).toBeUndefined();
});

test("a conflicting lane PR gets one merge lane through an operation; when none can start the lead hears CI_CONFLICT and nothing is retried", async () => {
  world.panes = [];
  const launch: CiIo["launch"] = async (d, request) => {
    launches.push(request.key);
    await d.registry.update(request.key, () => ({ ...lane, key: request.key, done: "merged acme/app#7", openedAt: new Date(clock.now()).toISOString() }));
    return { ok: true, detail: "STARTUP_OK" };
  };
  const conflicting = pull({ conflicting: true, checks: "green" });
  const ci = follow({ launch });
  await ci.tick([conflicting], emit);
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([mergeLaneKey(conflicting)]);
  expect(lines("CI_MERGE_LANE")[0]).toStartWith("CI_MERGE_LANE merge-app-7 ");
  expect(gh.merges).toEqual([]);

  const other = pull({ number: 8, conflicting: true, checks: "green" });
  await deps.registry.update("lane-eight", () => ({ ...lane, key: "lane-eight", pane: "w:p8", done: "merged acme/app#8" }));
  const refused = follow({ launch: async (_d, request) => { launches.push(request.key); return { ok: false, detail: "HOLD load 160 >= 150" }; } });
  await refused.tick([other], emit);
  await refused.tick([other], emit);
  expect(launches).toEqual(["merge-app-7", "merge-app-8"]);
  expect(events.filter(([, l]) => l.startsWith("CI_CONFLICT"))).toHaveLength(1);
  expect(lines("CI_CONFLICT")).toEqual([expect.stringContaining("CI_CONFLICT acme/app#8 lane=lane-eight head=abcdef1 conflicts with dev and no merge lane could start: HOLD load 160 >= 150")]);
});

test("a brief's issue: line binds the lane to a GitHub issue; a malformed one refuses the launch", () => {
  expect(briefIssue("# Task\nissue: acme/app#5\n")).toBe("acme/app#5");
  expect(briefIssue("- `issue: acme/app#5`")).toBe("acme/app#5");
  expect(briefIssue("Background: the issue: see below")).toBeUndefined();
  expect(() => briefIssue("issue: #5")).toThrow(LaunchError);
});

test("an issue-bound lane's issue is closed with one comment once its PR is merged into dev, even after the lane closed; later polls and a restart close nothing more", async () => {
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#5" }));
  const ci = follow();
  await ci.tick([pull({ checks: "pending" })], emit);
  expect(gh.closes).toEqual([]);

  // The lane closes at its green PR; the lead merges afterwards.
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#5", closedAt: new Date(T0 + 2 * MIN).toISOString() }));
  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  const merged = [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", headRepo: "acme/app" }];
  await ci.tick([], emit, merged);
  await ci.tick([], emit, merged);
  await follow().tick([], emit, merged);
  expect(gh.closes).toEqual([["gh", "issue", "close", "5", "-R", "acme/app", "--comment", "Closed by dori: acme/app#7 (lane demo-lane) is merged into dev as m3rge5ha. https://github.com/acme/app/pull/7"]]);
  expect(lines("CI_ISSUE_CLOSED")).toEqual(["CI_ISSUE_CLOSED acme/app#5 lane=demo-lane after acme/app#7 merged into dev merge=m3rge5ha https://github.com/acme/app/pull/7"]);
  expect(eventClass(lines("CI_ISSUE_CLOSED")[0] ?? "", deps.tunables.eventPolicy)).toBe("lead-digest");
});

test("an issue is not closed for a PR merged into main, nor commented on when someone already closed it", async () => {
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#5" }));
  const ci = follow();
  await ci.tick([pull({ checks: "pending" })], emit);
  const merged = [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", headRepo: "acme/app" }];
  gh.view = greenView({ state: "MERGED", baseRefName: "main", mergeCommit: { oid: "m41n" } });
  await ci.tick([], emit, merged);
  expect(gh.closes).toEqual([]);

  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  gh.issue = "CLOSED";
  await follow().tick([], emit, merged);
  expect(gh.closes).toEqual([]);
  expect(lines("CI_ISSUE_CLOSED")).toEqual([]);
  expect(open[1]?.ops.get("demo-lane/close-issue/acme/app#5@acme/app#7")?.state).toBe("verified");
});

const mergedSeven = [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", headRepo: "acme/app" }];
const views = () => world.calls.filter((c) => c[0] === "gh" && c[2] === "view").length;

test("a merged PR of an open lane is read back once as digest MERGE_VERIFIED with its merge SHA; later polls and a restart read nothing", async () => {
  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  const ci = follow();
  await ci.tick([], emit, mergedSeven);
  await ci.tick([], emit, mergedSeven);
  await follow().tick([], emit, mergedSeven);
  expect(events.filter(([, l]) => l.startsWith("MERGE_"))).toEqual([
    ["merge-verified:acme/app#7", "MERGE_VERIFIED acme/app#7 into dev lane=demo-lane merge=m3rge5ha https://github.com/acme/app/pull/7"],
  ]);
  expect(views()).toBe(1);
  expect(eventClass(lines("MERGE_VERIFIED")[0] ?? "", deps.tunables.eventPolicy)).toBe("lead-digest");
  expect(eventClass("GH_PR acme/app#7 merged sha=x u", deps.tunables.eventPolicy)).toBe("lead-digest");
});

test("a PR the supervisor merged itself (CI_MERGED) is not read back again, and a PR of no open lane is never read", async () => {
  const ci = follow();
  await ci.tick([pull({ checks: "green" })], emit);
  expect(lines("CI_MERGED")).toHaveLength(1);
  const before = views();
  await ci.tick([], emit, [...mergedSeven, { repo: "acme/app", number: 99, url: "https://github.com/acme/app/pull/99", branch: "other", headRepo: "acme/app" }]);
  expect(views()).toBe(before);
  expect(lines("MERGE_")).toEqual([]);
});

test("a merged lane PR that cannot be read back wakes the lead once as MERGE_UNVERIFIED after MERGE_ATTEMPTS polls", async () => {
  gh.viewCode = 1;
  const ci = follow();
  await ci.tick([], emit, mergedSeven);
  await ci.tick([], emit, mergedSeven);
  expect(lines("MERGE_")).toEqual([]);
  await ci.tick([], emit, mergedSeven);
  await ci.tick([], emit, mergedSeven);
  expect(events.filter(([, l]) => l.startsWith("MERGE_")).map(([, l]) => l)).toEqual([
    expect.stringContaining("MERGE_UNVERIFIED acme/app#7 lane=demo-lane merge could not be read back after 3 tries: gh pr view acme/app#7 exit 1: HTTP 502"),
  ]);
  expect(views()).toBe(3);
  expect(eventClass(lines("MERGE_UNVERIFIED")[0] ?? "", deps.tunables.eventPolicy)).toBe("lead-urgent");
});

test("GH_PR checks_failing and conflicting are digest; an eventPolicy in the config file is ignored", async () => {
  const file = join(state.dir, "config.json");
  writeFileSync(file, JSON.stringify({ eventPolicy: { kinds: { "GH_PR * conflicting": "lead-urgent" } } }));
  expect("eventPolicy" in await loadConfig(file, "/home/test")).toBe(false);
  const policy = BUILT_IN.eventPolicy;
  expect(eventClass("GH_PR acme/app#7 checks_failing sha=x u", policy)).toBe("lead-digest");
  expect(eventClass("GH_PR acme/app#7 conflicting sha=x u", policy)).toBe("lead-digest");
  expect(eventClass("LANE_MESSAGE_UNCONFIRMED demo-lane ci-app-7-abcdef1 x", policy)).toBe("lead-urgent");
  expect(eventClass("CI_CONFLICT acme/app#7 x", policy)).toBe("lead-urgent");
});

test("a merge lane its sandbox refuses is not started: the refusal is its detail and reaches the owner in the source lane's thread", async () => {
  const roomy = (argv: readonly string[], opts?: Parameters<typeof deps.run>[1]) =>
    argv[0] === "df" ? Promise.resolve({ code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }) : deps.run(argv, opts);
  const hooked = { ...deps, run: roomy, which: () => null, ops: { ...deps.ops, exists: async () => [false] }, config: { ...deps.config, hooks: { ...deps.config.hooks, threadReply: ["notify", "{thread}", "{text}"] } } };
  const r = await launchMergeLane(hooked, { key: mergeLaneKey(pull()), source: { ...claimedLane }, pull: pull(), base: "dev" });
  expect(r.ok).toBe(false);
  expect(r.detail).toStartWith(`SANDBOX_MISSING ${mergeLaneKey(pull())}: lane-sandbox is not on PATH`);
  expect(world.ops.filter((o) => o.op === "start")).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toEqual([["notify", lane.thread, `[sandbox] ${r.detail}`]]);
});
