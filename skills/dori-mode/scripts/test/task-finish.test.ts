import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { eventClass } from "../src/event-policy.ts";
import type { Lane } from "../src/registry.ts";
import { taskFinisher } from "../src/task-finish.ts";
import { appendFollowUp, type FollowUpDiscord, recordLastReport, recordOwnerClosed } from "../src/thread-followup.ts";
import { ToodoWriter } from "../src/toodo-client.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

type Criterion = { id: number; text: string; kind: string; state: string; evidence: string | null };
type Task = { id: number; status: string; resolution: string | null; refs: string[]; notes: { kind: string; body: string }[]; criteria: Criterion[] };

/** A fake toodo `/mcp` endpoint with toodo's result shape; complete_task is refused while a criterion is not met. */
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
        if (task.criteria.some((c) => c.state !== "met")) return refuse(rpc.id, "criteriaUnmet");
        task.status = "done"; task.resolution = "completed"; task.refs.push(...(a.refs as string[]));
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
    edit: async (channel, message, content) => { edits.push([channel, message, content]); contents.set(`${channel}/${message}`, content); },
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
  const finishTask = taskFinisher({
    writer: new ToodoWriter({ url: toodo.url, tokenFile: join(state.dir, "mcp-token") }),
    append: (l, text) => appendFollowUp(state.dir, discord, l, text),
  });
  const base = at(T0 + 5 * MIN + 1);
  return { lines: await watchTick({ ...base, ...(run ? { run: run(base.run) } : {}), finishTask }), calls: toodo.calls };
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
  expect(fake.edits).toEqual([["900", "m1", `report\n머지 확인: ${PR} (abc1234) · Toodo #951 완료`]]);
  expect(fake.sends).toEqual([]);
});

test("a lane with no Toodo task closes as before and wakes the lead; toodo is never called", async () => {
  const { task: _none, ...untasked } = lane;
  const fake = fakeDiscord();
  const { lines, calls } = await closeMerged(untasked, inProgress([manual(1)]), fake.discord);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=no-task ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-urgent");
  expect(calls).toEqual([]);
  expect(fake.edits).toEqual([]);
});

test("a task toodo refuses to complete wakes the lead with the reason, and nothing is appended", async () => {
  // A URL criterion toodo has not seen met: complete_task is refused.
  const task = inProgress([{ id: 1, text: "deployed", kind: "url", state: "pending", evidence: null }]);
  const fake = fakeDiscord();
  const { lines } = await closeMerged(lane, task, fake.discord);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=failed ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-urgent");
  expect(lines[1]).toStartWith("TOODO_TASK_NOT_COMPLETED demo-lane #951 toodo: toodo-server refused complete_task: Rejected: criteriaUnmet;");
  expect(eventClass(lines[1] ?? "")).toBe("lead-urgent");
  expect(task.status).toBe("in_progress");
  expect(fake.edits).toEqual([]);
});

test("a lane whose PR does not read back merged with a merge SHA wakes the lead and its task is left alone", async () => {
  const fake = fakeDiscord();
  const run = (base: FlowDeps["run"]): FlowDeps["run"] => async (argv, opts) =>
    argv.includes("state,url,baseRefName,mergeCommit") ? { code: 0, out: JSON.stringify({ state: "MERGED", mergeCommit: null }), err: "" } : base(argv, opts);
  const { lines, calls } = await closeMerged(lane, inProgress([manual(1)]), fake.discord, run);
  expect(lines[0]).toBe(`LANE_CLOSED demo-lane closed seen-claim toodo=unmerged ${PR}`);
  expect(eventClass(lines[0] ?? "")).toBe("lead-urgent");
  expect(lines[1]).toStartWith("TOODO_TASK_NOT_COMPLETED demo-lane #951 no merge read back: acme/app#1 reads MERGED with no merge commit;");
  expect(calls).toEqual([]);
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
