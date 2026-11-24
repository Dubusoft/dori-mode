import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { LAUNCH_ACTION, ledgerRows } from "../src/autopilot.ts";
import { claimDone, closeLane, finishClosedTask, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { eventClass } from "../src/event-policy.ts";
import type { Lane } from "../src/registry.ts";
import { laneNotAdoptedFile, laneReportFile } from "../src/lane-files.ts";
import { openOperations, plan, settleOperation } from "../src/operations.ts";
import { mergeFactLine, taskBlocker, taskFinisher } from "../src/task-finish.ts";
import { appendFollowUp, type FollowUpDiscord, recordLastReport, recordOwnerClosed } from "../src/thread-followup.ts";
import { ToodoWriter } from "../src/toodo-client.ts";
import { depsFor, fakeClock, newWorld, visible, withSqliteStore, withState, type World } from "./fakes.ts";

type Criterion = { id: number; text: string; kind: string; state: string; evidence: string | null };
type Task = { id: number; status: string; resolution: string | null; refs: string[]; notes: { kind: string; body: string }[]; criteria: Criterion[] };

/**
 * A fake toodo `/mcp` endpoint with toodo's result shape; complete_task is refused on a task already done (as toodo's
 * transition rules do) and while a criterion is not met.
 */
const fakeToodo = (task: Task) => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const ok = (id: unknown, value: unknown) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  const refuse = (id: unknown, code: string) => Response.json({
    jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Rejected: ${code}` }], isError: true, structuredContent: { error: { code } } },
  });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const rpc = await req.json() as { id: unknown; params: { name: string; arguments: Record<string, unknown> } };
      const { name, arguments: a } = rpc.params;
      calls.push({ name, args: a });
      if (req.headers.get("authorization") !== "Bearer mcp-1") return new Response("unknown token", { status: 401 });
      if (name === "get_task") return ok(rpc.id, task);
      if (name === "check_criterion") {
        const c = task.criteria.find((x) => x.id === a.criterion_id);
        if (!c) return refuse(rpc.id, "criterionNotFound");
        c.state = "met"; c.evidence = String(a.evidence);
        return ok(rpc.id, task);
      }
      if (name === "complete_task") {
        if (task.status === "done") return refuse(rpc.id, "invalidTransition");
        if (task.criteria.some((c) => c.state !== "met")) return refuse(rpc.id, "criteriaUnmet");
        task.status = "done"; task.resolution = "completed"; task.refs.push(...(a.refs as string[]));
        return ok(rpc.id, task);
      }
      if (name === "conclude_task") {
        if (task.status === "done") return refuse(rpc.id, "taskDone");
        task.status = "done"; task.resolution = String(a.outcome); task.notes.push({ kind: "conclusion", body: String(a.note) });
        return ok(rpc.id, task);
      }
      if (name === "report_blocker") {
        task.notes.push({ kind: "blocker", body: String(a.note) });
        return ok(rpc.id, task);
      }
      return refuse(rpc.id, "unknownTool");
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
};

/** Discord as the supervisor's follow-up sees it: message contents, edits and posts recorded. */
const fakeDiscord = (archivedThreads: readonly string[] = []) => {
  const contents = new Map<string, string>([["900/m1", "report"]]);
  const edits: string[][] = [];
  const sends: string[][] = [];
  const discord: FollowUpDiscord = {
    send: async (channel, content) => { sends.push([channel, content]); return "new"; },
    edit: async (channel, message, content) => { edits.push([channel, message, visible(content)]); contents.set(`${channel}/${message}`, content); },
    content: async (channel, message) => contents.get(`${channel}/${message}`) ?? "",
    threadArchived: async (thread) => archivedThreads.includes(thread),
    threadState: async (thread) => ({ archived: archivedThreads.includes(thread), parent: "work" }),
    setThread: async () => {},
  };
  return { discord, edits, sends };
};

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const PR = "https://github.com/acme/app/pull/1";
const SHA = "abc1234567890";
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString(), task: 951 };

let state: ReturnType<typeof withState>;
let world: World;
let stops: (() => void)[];
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
const inProgress = (criteria: Criterion[]): Task => ({ id: 951, status: "in_progress", resolution: null, refs: [], notes: [], criteria });
const manual = (id: number, met = false): Criterion => ({ id, text: `c${id}`, kind: "manual", state: met ? "met" : "pending", evidence: met ? "checked by hand" : null });

beforeEach(() => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  stops = [];
  writeFileSync(join(state.dir, "mcp-token"), "mcp-1\n");
  // The lead reported the lane at its claim: the follow-up edits that report.
  recordLastReport(state.dir, lane.key, { channel: "900", message: "m1", at: T0 });
});
afterEach(() => { for (const stop of stops) stop(); state.done(); });

/**
 * Claims `subject` done with its PR bound at the claim, hands the claim to the lead, and settles it five minutes later
 * with the supervisor's finisher (toodo `task`, Discord `discord`). Returns the settle pass's lines.
 */
const closeMerged = async (subject: Lane, task: Task, discord: FollowUpDiscord, run?: (base: FlowDeps["run"]) => FlowDeps["run"]): Promise<{ lines: string[]; calls: ReturnType<typeof fakeToodo>["calls"] }> => {
  const toodo = fakeToodo(task);
  stops.push(toodo.stop);
  await at(T0).registry.write(subject);
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  await claimDone(at(T0), subject, `merged ${PR}`);
  await at(T0).registry.patch(subject.key, (current) => current.claim ? { claim: { ...current.claim, pulls: [{ repo: "acme/app", number: 1, sha: "a".repeat(40) }] } } : undefined);
  await watchTick(at(T0));
  const writer = new ToodoWriter({ url: toodo.url, tokenFile: join(state.dir, "mcp-token") });
  const finishTask = taskFinisher({ writer, append: (l, text) => appendFollowUp(state.dir, discord, l, text), language: () => "Korean" });
  const base = at(T0 + 5 * MIN + 1);
  return { lines: await watchTick({ ...base, ...(run ? { run: run(base.run) } : {}), finishTask, blockTask: taskBlocker(writer) }), calls: toodo.calls };
};

test("a task-linked lane closing after its merge has its task completed and read back, its report appended, and its seen-claim close sent as digest", async () => {
  const task = inProgress([manual(1), manual(2, true)]);
  const fake = fakeDiscord();
  const { lines, calls } = await closeMerged(lane, task, fake.discord);

  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=done ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-digest");
  expect(lines[1]).toBe(`TOODO_TASK_COMPLETED demo-lane #951 ${PR} merge=${SHA}; report appended (m1)`);
  expect(eventClass(lines[1] ?? "")).toBe("lead-digest");
  // The pending manual criterion is checked with the merge as evidence; the one already met keeps its own evidence.
  expect(task.criteria.map((c) => [c.state, c.evidence?.includes(`${PR} merged into its base as ${SHA}`) ?? false])).toEqual([["met", true], ["met", false]]);
  expect(task.status).toBe("done");
  expect(task.refs).toEqual([PR]);
  const complete = calls.find((c) => c.name === "complete_task");
  expect(String(complete?.args.note)).toContain(`${PR} merged into its base as ${SHA}`);
  expect(calls.at(-1)?.name).toBe("get_task");
  expect(fake.edits).toEqual([["900", "m1", "report\n머지 acme/app#1 (abc1234) · Toodo #951 완료"]]);
  expect(fake.sends).toEqual([]);
});

test("a merged lane with no Toodo task gets the merge fact line appended, closes as digest after a seen claim, and toodo is never called", async () => {
  const { task: _none, ...untasked } = lane;
  const fake = fakeDiscord();
  const { lines, calls } = await closeMerged(untasked, inProgress([manual(1)]), fake.discord);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=no-task ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-digest");
  expect(lines[1]).toBe(`MERGE_FACT demo-lane ${PR} merge=${SHA}; report appended (m1)`);
  expect(eventClass(lines[1] ?? "")).toBe("lead-digest");
  expect(calls).toEqual([]);
  expect(fake.edits).toEqual([["900", "m1", "report\n머지 acme/app#1 (abc1234)"]]);
  expect(fake.sends).toEqual([]);
});

test("a merged lane with no Toodo task whose thread is closed gets no edit and no line in its parent channel", async () => {
  recordOwnerClosed(state.dir, "900", T0);
  const { task: _none, ...untasked } = lane;
  const fake = fakeDiscord(["900"]);
  const { lines } = await closeMerged(untasked, inProgress([]), fake.discord);
  expect(lines[1]).toBe(`MERGE_FACT demo-lane ${PR} merge=${SHA}; report not appended: thread 900 is closed`);
  expect(fake.edits).toEqual([]);
  expect(fake.sends).toEqual([]);
});

test("the merge fact line follows the owner's language, English when it is unset or unknown", () => {
  const merges = [
    { repo: "acme/app", number: 1, url: PR, base: "dev", sha: SHA },
    { repo: "acme/web", number: 22, url: "https://github.com/acme/web/pull/22", base: "dev", sha: "fedcba9876" },
  ];
  expect(mergeFactLine(merges, 951, "Korean")).toBe("머지 acme/app#1 (abc1234), acme/web#22 (fedcba9) · Toodo #951 완료");
  expect(mergeFactLine(merges.slice(0, 1), undefined, "ko-KR")).toBe("머지 acme/app#1 (abc1234)");
  expect(mergeFactLine(merges.slice(0, 1), 951, "Japanese")).toBe("マージ acme/app#1 (abc1234) · Toodo #951 完了");
  expect(mergeFactLine(merges.slice(0, 1), 951, "Simplified Chinese")).toBe("已合并 acme/app#1 (abc1234) · Toodo #951 已完成");
  expect(mergeFactLine(merges.slice(0, 1), 951, undefined)).toBe("Merged acme/app#1 (abc1234) · Toodo #951 done");
  expect(mergeFactLine(merges.slice(0, 1), undefined, "Klingon")).toBe("Merged acme/app#1 (abc1234)");
});

test("a task toodo refuses to complete wakes the lead with the reason, and the merge is still appended without the Toodo part", async () => {
  // A URL criterion toodo has not seen met: complete_task is refused.
  const task = inProgress([{ id: 1, text: "deployed", kind: "url", state: "pending", evidence: null }]);
  const fake = fakeDiscord();
  const { lines } = await closeMerged(lane, task, fake.discord);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=failed ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-urgent");
  expect(lines[1]).toStartWith("TOODO_TASK_NOT_COMPLETED demo-lane #951 toodo: toodo-server refused complete_task: Rejected: criteriaUnmet;");
  expect(eventClass(lines[1] ?? "")).toBe("lead-urgent");
  expect(task.status).toBe("in_progress");
  expect(lines[2]).toBe(`MERGE_FACT demo-lane ${PR} merge=${SHA}; report appended (m1)`);
  expect(eventClass(lines[2] ?? "")).toBe("lead-digest");
  expect(fake.edits).toEqual([["900", "m1", "report\n머지 acme/app#1 (abc1234)"]]);
  expect(fake.sends).toEqual([]);
});

test("a merged lane whose task the lead already completed with other refs says toodo=done, warns no one, and still appends the merge", async () => {
  const task: Task = { ...inProgress([manual(1, true)]), status: "done", resolution: "completed", refs: ["https://github.com/acme/app/pull/2"] };
  const fake = fakeDiscord();
  const { lines, calls } = await closeMerged(lane, task, fake.discord);
  expect(lines).toEqual([`LANE_CLOSED demo-lane closed seen-claim toodo=done ${PR}`, `MERGE_FACT demo-lane ${PR} merge=${SHA}; report appended (m1)`]);
  expect(calls.map((c) => c.name)).toEqual(["get_task"]);
  expect(task.refs).toEqual(["https://github.com/acme/app/pull/2"]);
  expect(fake.edits).toEqual([["900", "m1", "report\n머지 acme/app#1 (abc1234)"]]);
});

test("a lane whose PR does not read back merged with a merge SHA wakes the lead and its task is left alone", async () => {
  const fake = fakeDiscord();
  const run = (base: FlowDeps["run"]): FlowDeps["run"] => async (argv, opts) =>
    argv.includes("state,url,baseRefName,mergeCommit") ? { code: 0, out: JSON.stringify({ state: "MERGED", mergeCommit: null }), err: "" } : base(argv, opts);
  const { lines, calls } = await closeMerged(lane, inProgress([manual(1)]), fake.discord, run);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=unmerged ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-urgent");
  expect(lines[1]).toStartWith("TOODO_TASK_NOT_COMPLETED demo-lane #951 no merge read back: acme/app#1 reads MERGED with no merge commit;");
  // The task is only read: nothing is written to it.
  expect(calls.map((c) => c.name)).toEqual(["get_task"]);
});

/** The finish of `demo-lane` closed with no PR recorded (no claim), against a toodo holding `task`. */
const finishNoPr = async (task: Task, token = "mcp-1") => {
  const toodo = fakeToodo(task);
  stops.push(toodo.stop);
  writeFileSync(join(state.dir, "mcp-token"), `${token}\n`);
  const writer = new ToodoWriter({ url: toodo.url, tokenFile: join(state.dir, "mcp-token") });
  const finishTask = taskFinisher({ writer, append: async () => { throw new Error("appended"); } });
  return { finish: await finishClosedTask({ ...at(T0), finishTask }, lane), calls: toodo.calls };
};

test("a lane closing with no PR whose task the lead already completed says toodo=done and warns no one", async () => {
  const task: Task = { ...inProgress([manual(1, true)]), status: "done", resolution: "completed" };
  const { finish, calls } = await finishNoPr(task);
  expect(finish).toEqual({ tag: "done", lines: [] });
  expect(calls.map((c) => c.name)).toEqual(["get_task"]);
});

test("a lane closing with no PR still warns when its task is open, concluded otherwise, or cannot be read, and never completes it", async () => {
  const why = "TOODO_TASK_NOT_COMPLETED demo-lane #951 no merge read back: no PR of the lane is recorded (no claimed or supervisor-merged PR)";
  const open = inProgress([manual(1, true)]);
  const opened = await finishNoPr(open);
  expect(opened.finish?.tag).toBe("unmerged");
  expect(opened.finish?.lines[0] ?? "").toStartWith(`${why}; finish it yourself`);
  expect(opened.calls.map((c) => c.name)).toEqual(["get_task"]);
  expect(open.status).toBe("in_progress");

  const dropped = await finishNoPr({ ...inProgress([]), status: "done", resolution: "not_adopted" });
  expect(dropped.finish?.tag).toBe("unmerged");
  expect(dropped.finish?.lines[0] ?? "").toStartWith(`${why}; finish it yourself`);

  const unread = await finishNoPr(inProgress([]), "refused");
  expect(unread.finish?.tag).toBe("unmerged");
  expect(unread.finish?.lines[0] ?? "").toStartWith(`${why}; the task could not be read: toodo-server get_task answered HTTP 401`);
});

test("a thread already closed gets no append and no redirected line in its parent channel; the task is still completed", async () => {
  recordOwnerClosed(state.dir, "900", T0);
  const fake = fakeDiscord(["900"]);
  const task = inProgress([manual(1)]);
  const { lines } = await closeMerged(lane, task, fake.discord);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=done ${PR}`);
  expect(lines[1]).toBe(`TOODO_TASK_COMPLETED demo-lane #951 ${PR} merge=${SHA}; report not appended: thread 900 is closed`);
  expect(task.status).toBe("done");
  expect(fake.edits).toEqual([]);
  expect(fake.sends).toEqual([]);
});

/** Autopilot lane `ap-951-1` of task 951 (launched without --task), its launch attempt reserved and settled launched. */
const { task: _untasked, ...plainLane } = lane;
const apLane: Lane = { ...plainLane, key: "ap-951-1" };
const reserveAutopilot = (): void => {
  const store = openOperations(at(T0).config);
  try {
    const op = plan(store, T0, { lane: "toodo:951", action: LAUNCH_ACTION, target: "1", data: JSON.stringify({ laneKey: "ap-951-1" }) });
    settleOperation(store, T0, op.id, "verified", "launched ap-951-1");
  } finally { store.close(); }
};
const attemptData = (): Record<string, unknown> => {
  const store = openOperations(at(T0).config);
  try { return JSON.parse(ledgerRows(store)[0]?.data ?? "{}") as Record<string, unknown>; } finally { store.close(); }
};

test("an autopilot lane closing after its merge has its task completed with the PR and merge evidence, and its done outcome is digest", async () => {
  reserveAutopilot();
  const task = inProgress([manual(1)]);
  const { lines } = await closeMerged(apLane, task, fakeDiscord().discord);
  expect(lines[0]).toBe(`LANE_CLOSED ap-951-1 closed seen-claim toodo=done ${PR}`);
  expect(lines[1]).toStartWith(`TOODO_TASK_COMPLETED ap-951-1 #951 ${PR} merge=${SHA};`);
  const done = lines.find((l) => l.startsWith("AUTOPILOT_LANE_DONE "));
  expect(done).toBe("AUTOPILOT_LANE_DONE #951 lane=ap-951-1 attempt=1 toodo=done: toodo task #951 completed and read back by the supervisor");
  expect(eventClass(done ?? "")).toBe("lead-digest");
  expect(task.status).toBe("done");
  expect(task.refs).toEqual([PR]);
  expect(task.criteria[0]?.evidence).toContain(`${PR} merged into its base as ${SHA}`);
  expect(attemptData()).toMatchObject({ outcome: "done", toodo: "done" });
});

test("an autopilot task toodo refuses to complete gets a blocker note, one failure line, and nothing again on a repeated finish", async () => {
  reserveAutopilot();
  const task = inProgress([{ id: 1, text: "deployed", kind: "url", state: "pending", evidence: null }]);
  const { lines, calls } = await closeMerged(apLane, task, fakeDiscord().discord);
  expect(lines[0]).toBe(`LANE_CLOSED ap-951-1 closed seen-claim toodo=failed ${PR}`);
  const failures = lines.filter((l) => eventClass(l) === "lead-urgent" && !l.startsWith("LANE_CLOSED ") && !l.startsWith("AUTOPILOT_"));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toStartWith("TOODO_TASK_NOT_COMPLETED ap-951-1 #951 toodo: toodo-server refused complete_task: Rejected: criteriaUnmet;");
  expect(failures[0]).toEndWith("; blocker recorded on toodo task #951");
  // The done outcome still asks the lead to complete the task: it is not rewritten toodo=done.
  expect(lines.find((l) => l.startsWith("AUTOPILOT_LANE_DONE "))).toBe("AUTOPILOT_LANE_DONE #951 lane=ap-951-1 attempt=1: complete toodo task #951");
  expect(task.status).toBe("in_progress");
  expect(task.notes).toEqual([{ kind: "blocker", body: "Autopilot lane ap-951-1 ended without finishing this task: toodo: toodo-server refused complete_task: Rejected: criteriaUnmet. Autopilot does not launch it again; the lead decides whether to fix, drop or retry it." }]);
  expect(attemptData()).toMatchObject({ outcome: "done", toodo: "blocked" });
  // A repeated finish of the same close (a resumed pass) writes nothing and tells no one.
  const before = calls.length;
  const again = await finishClosedTask({ ...at(T0 + 6 * MIN), finishTask: async () => { throw new Error("finished again"); } }, apLane);
  expect(again).toEqual({ tag: "failed", lines: [] });
  expect(calls.length).toBe(before);
});

/** A repo-less autopilot lane `ap-951-1` (Done = its report file) closed and finished by the supervisor. */
const finishRepoless = async (task: Task, discord: FollowUpDiscord) => {
  reserveAutopilot();
  const report = laneReportFile(at(T0).config.stateDir, "ap-951-1");
  const toodo = fakeToodo(task);
  stops.push(toodo.stop);
  const writer = new ToodoWriter({ url: toodo.url, tokenFile: join(state.dir, "mcp-token") });
  const finishTask = taskFinisher({ writer, append: (l, text) => appendFollowUp(state.dir, discord, l, text), language: () => "Korean" });
  return { report, finish: await finishClosedTask({ ...at(T0), finishTask, blockTask: taskBlocker(writer) }, { ...apLane, done: `file ${JSON.stringify(report)}` }) };
};

test("a repo-less autopilot lane without its report leaves the task open with a blocker", async () => {
  const task = inProgress([manual(1)]);
  const { report, finish } = await finishRepoless(task, fakeDiscord().discord);
  expect(finish?.tag).toBe("unmerged");
  expect(finish?.lines[0]).toContain(`no report of the lane at ${report}`);
  expect(task.status).toBe("in_progress");
  expect(task.notes.map((n) => n.kind)).toEqual(["blocker"]);
});

test("a repo-less autopilot lane is completed with its installed report as evidence and its report gets the done line", async () => {
  const report = laneReportFile(at(T0).config.stateDir, "ap-951-1");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "# result\n");
  recordLastReport(state.dir, "ap-951-1", { channel: "900", message: "m1", at: T0 });
  const task = inProgress([manual(1), manual(2, true)]);
  const fake = fakeDiscord();
  const { finish } = await finishRepoless(task, fake.discord);
  expect(finish).toEqual({ tag: "done", lines: [`TOODO_TASK_COMPLETED ap-951-1 #951 report=${report}; report appended (m1)`] });
  expect(task.status).toBe("done");
  expect(task.criteria.map((c) => [c.state, c.evidence?.startsWith(`report ${report} `) ?? false])).toEqual([["met", true], ["met", false]]);
  expect(task.refs).toEqual([]);
  expect(fake.edits).toEqual([["900", "m1", "report\nToodo #951 완료"]]);
  expect(attemptData()).toMatchObject({ toodo: "done" });
});

/**
 * Autopilot lane `ap-951-1` (Done = a PR from autopilot/951) claims done with no PR, with or without the `not-adopted.md`
 * and `report.md` its claim installs, and the claim settles five minutes later with the supervisor's finisher.
 */
const settleNoPr = async (task: Task, conclusion?: string, report?: string) => {
  reserveAutopilot();
  const subject: Lane = { ...apLane, done: "pr acme/app autopilot/951" };
  // The research dir beside the state dir is shared by this file's tests: start from no installed files.
  const file = laneNotAdoptedFile(at(T0).config.stateDir, subject.key);
  rmSync(dirname(file), { recursive: true, force: true });
  for (const [path, text] of [[file, conclusion], [laneReportFile(at(T0).config.stateDir, subject.key), report]] as const) {
    if (text === undefined) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  recordLastReport(state.dir, subject.key, { channel: "900", message: "m1", at: T0 });
  world.prList = [];
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  const toodo = fakeToodo(task);
  stops.push(toodo.stop);
  await at(T0).registry.write(subject);
  await claimDone(at(T0), subject, "investigated: nothing to change");
  const announced = await watchTick(at(T0));
  const writer = new ToodoWriter({ url: toodo.url, tokenFile: join(state.dir, "mcp-token") });
  const fake = fakeDiscord();
  const finishTask = taskFinisher({ writer, append: (l, text) => appendFollowUp(state.dir, fake.discord, l, text), language: () => "Korean" });
  const lines = await watchTick({ ...at(T0 + 5 * MIN + 1), finishTask, blockTask: taskBlocker(writer) });
  return { announced, lines, calls: toodo.calls, edits: fake.edits, lane: await at(T0).registry.read(subject.key) };
};

test("an autopilot lane that concludes not adopted with no PR closes without an objection and its task is concluded not_adopted", async () => {
  const task = inProgress([manual(1)]);
  const { announced, lines, edits, lane: closed } = await settleNoPr(task, "# Not adopted\nHigh findings: 0.\n");
  expect(announced[0]).toEndWith("| verified: pr=none sig=not-adopted");
  expect(lines.filter((l) => l.startsWith("LANE_NOT_DONE ") || l.startsWith("AUTOPILOT_LANE_FAILED ") || l.startsWith("TOODO_TASK_NOT_COMPLETED "))).toEqual([]);
  const conclusion = laneNotAdoptedFile(at(T0).config.stateDir, "ap-951-1");
  expect(lines).toEqual([
    "LANE_CLOSED ap-951-1 closed seen-claim toodo=not-adopted",
    `TOODO_TASK_NOT_ADOPTED ap-951-1 #951 conclusion=${conclusion}; report appended (m1)`,
    "AUTOPILOT_LANE_DONE #951 lane=ap-951-1 attempt=1 toodo=not-adopted: toodo task #951 concluded not adopted and read back by the supervisor",
  ]);
  for (const line of lines) expect(eventClass(line)).toBe("lead-digest");
  expect(task.status).toBe("done");
  expect(task.resolution).toBe("not_adopted");
  // No blocker: the conclusion is the task's note.
  expect(task.notes.map((n) => n.kind)).toEqual(["conclusion"]);
  expect(task.notes[0]?.body).toStartWith("# Not adopted\nHigh findings: 0.\n\nConclusion: ");
  expect(closed?.closedAt).toBeDefined();
  expect(closed?.receipt).toMatchObject({ notAdopted: { conclusion } });
  expect(edits).toEqual([["900", "m1", "report\nToodo #951 not adopted로 마무리"]]);
  expect(attemptData()).toMatchObject({ outcome: "done", toodo: "not-adopted" });
});

test("an autopilot lane that finished its work with no PR closes on its report and its task is completed, not concluded not_adopted", async () => {
  const task = inProgress([manual(1), manual(2)]);
  const { announced, lines, edits, lane: closed } = await settleNoPr(task, undefined, "# Report\n1. done\n2. done\n");
  expect(announced[0]).toEndWith("| verified: pr=none sig=reported");
  const report = laneReportFile(at(T0).config.stateDir, "ap-951-1");
  expect(lines).toEqual([
    "LANE_CLOSED ap-951-1 closed seen-claim toodo=done",
    `TOODO_TASK_COMPLETED ap-951-1 #951 report=${report}; report appended (m1)`,
    "AUTOPILOT_LANE_DONE #951 lane=ap-951-1 attempt=1 toodo=done: toodo task #951 completed and read back by the supervisor",
  ]);
  for (const line of lines) expect(eventClass(line)).toBe("lead-digest");
  expect(task.status).toBe("done");
  expect(task.resolution).toBe("completed");
  expect(task.criteria.map((c) => [c.state, c.evidence?.startsWith(`report ${report} `) ?? false])).toEqual([["met", true], ["met", true]]);
  expect(task.notes.map((n) => n.kind)).toEqual([]);
  expect(closed?.receipt).toMatchObject({ reported: { report } });
  expect(edits).toEqual([["900", "m1", "report\nToodo #951 완료"]]);
  expect(attemptData()).toMatchObject({ outcome: "done", toodo: "done" });
});

test("a lane that installed both not-adopted.md and report.md is concluded not_adopted", async () => {
  const task = inProgress([manual(1)]);
  const { lines } = await settleNoPr(task, "nothing to change", "# Report\n");
  expect(lines[0]).toBe("LANE_CLOSED ap-951-1 closed seen-claim toodo=not-adopted");
  expect(task.resolution).toBe("not_adopted");
});

test("a not-adopted lane whose task the lead already finished closes with toodo=done and writes nothing", async () => {
  const task: Task = { ...inProgress([manual(1, true)]), status: "done", resolution: "completed" };
  const { lines, calls } = await settleNoPr(task, "nothing to change");
  expect(lines[0]).toBe("LANE_CLOSED ap-951-1 closed seen-claim toodo=done");
  expect(lines.some((l) => l.startsWith("AUTOPILOT_LANE_FAILED ") || l.startsWith("LANE_NOT_DONE "))).toBe(false);
  expect(calls.map((c) => c.name)).toEqual(["get_task"]);
  expect(task.notes).toEqual([]);
});

test("an autopilot lane that claims with no PR and no not-adopted conclusion is still objected to", async () => {
  const task = inProgress([manual(1)]);
  const { lines, calls, lane: open } = await settleNoPr(task);
  expect(lines).toEqual(["LANE_NOT_DONE ap-951-1 pr acme/app autopilot/951 -> no PR from autopilot/951"]);
  expect(open?.closedAt).toBeUndefined();
  expect(calls).toEqual([]);
  expect(task.status).toBe("in_progress");
});

test("a cancelled autopilot lane gets its blocker recorded once and its failure line says so", async () => {
  reserveAutopilot();
  const task = inProgress([manual(1)]);
  const toodo = fakeToodo(task);
  stops.push(toodo.stop);
  const blockTask = taskBlocker(new ToodoWriter({ url: toodo.url, tokenFile: join(state.dir, "mcp-token") }));
  await at(T0).registry.write({ ...apLane, pane: undefined, runner: "local" });
  const r = await closeLane({ ...at(T0), blockTask }, { ...apLane, pane: undefined, runner: "local" }, "cancelled", { cancelled: { reason: "start failed" } });
  const failed = r.lines.filter((l) => l.startsWith("AUTOPILOT_"));
  expect(failed).toEqual(["AUTOPILOT_LANE_FAILED #951 lane=ap-951-1 attempt=1 cancelled: start failed toodo=blocked: blocker recorded on toodo task #951; tell the owner; autopilot does not launch it again"]);
  expect(eventClass(failed[0] ?? "")).toBe("lead-urgent");
  expect(task.notes).toEqual([{ kind: "blocker", body: "Autopilot lane ap-951-1 ended without finishing this task: #951 lane=ap-951-1 attempt=1 cancelled: start failed. Autopilot does not launch it again; the lead decides whether to fix, drop or retry it." }]);
  expect(attemptData()).toMatchObject({ outcome: "failed", toodo: "blocked" });
  const calls = toodo.calls.length;
  expect((await closeLane({ ...at(T0 + MIN), blockTask }, apLane, "again")).lines).toEqual(["CLOSED ap-951-1 already closed"]);
  expect(toodo.calls.length).toBe(calls);
});
