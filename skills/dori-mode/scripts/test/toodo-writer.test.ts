import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToodoWriteFailed, ToodoWriter } from "../src/toodo-client.ts";

type Note = { kind: string; body: string; at: number };
type Criterion = { id: number; text: string; kind: string; target: null; state: string; evidence: string | null };
type Task = { id: number; status: string; resolution: string | null; refs: string[]; notes: Note[]; criteria: Criterion[] };
type Call = { name: string; args: Record<string, unknown>; authorization: string | null };

/**
 * A fake toodo MCP endpoint: stateless `tools/call` on `/mcp` with toodo's result shape (the task as JSON text, a refusal
 * as `isError` with `structuredContent.error`). `loseReply` applies the named tool's write and answers 500, as a reply
 * lost on the way back; `ignore` answers the write without applying it.
 */
const fakeToodo = (task: Task, opts: { loseReply?: Set<string>; ignore?: Set<string> } = {}) => {
  const calls: Call[] = [];
  const ok = (id: unknown, value: unknown) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } });
  const refuse = (id: unknown, code: string, message: string) => Response.json({
    jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Rejected: ${message}` }], isError: true, structuredContent: { error: { kind: "rejected", code, message } } },
  });
  const apply = (name: string, a: Record<string, unknown>): { code: string; message: string } | undefined => {
    const note = (kind: string) => { task.notes.push({ kind, body: String(a.note).trim(), at: task.notes.length }); };
    const addRefs = () => { for (const r of (a.refs as string[] | undefined) ?? []) if (!task.refs.includes(r)) task.refs.push(r); };
    switch (name) {
      case "start_task":
        if (task.status !== "planned") return { code: "invalidStatusChange", message: `task ${task.id} is ${task.status}` };
        task.status = "in_progress"; addRefs(); return undefined;
      case "add_progress_note": note(String(a.kind ?? "progress")); return undefined;
      case "report_blocker": note("blocker"); return undefined;
      case "check_criterion": {
        const c = task.criteria.find((x) => x.id === a.criterion_id);
        if (!c) return { code: "criterionNotFound", message: `task ${task.id} has no criterion ${String(a.criterion_id)}` };
        c.state = a.met === false ? "pending" : "met"; c.evidence = a.met === false ? null : String(a.evidence).trim(); return undefined;
      }
      case "complete_task":
        if (task.criteria.some((c) => c.state !== "met")) return { code: "criteriaUnmet", message: "a criterion is not met" };
        task.status = "done"; task.resolution = "completed"; addRefs(); return undefined;
      default: return { code: "unknownTool", message: name };
    }
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp" || req.method !== "POST") return new Response("no", { status: 404 });
      const authorization = req.headers.get("authorization");
      const rpc = await req.json() as { id: unknown; method: string; params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ name: rpc.params.name, args: rpc.params.arguments, authorization });
      if (authorization !== "Bearer mcp-1") return new Response("Toodo MCP: unknown token", { status: 401 });
      const { name, arguments: a } = rpc.params;
      if (name === "get_task") return a.id === task.id ? ok(rpc.id, { ...task, workspaceId: 7, title: "t", notes: task.notes }) : refuse(rpc.id, "taskNotFound", "no task");
      if (opts.ignore?.has(name)) return ok(rpc.id, task);
      const refused = apply(name, a);
      if (refused) return refuse(rpc.id, refused.code, refused.message);
      if (opts.loseReply?.has(name)) return new Response("upstream gone", { status: 500 });
      return ok(rpc.id, task);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, calls, stop: () => server.stop(true) };
};

let dir: string;
let tokenFile: string;
let stops: (() => void)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-toodo-writer-"));
  tokenFile = join(dir, "mcp-token");
  writeFileSync(tokenFile, "mcp-1\n");
  stops = [];
});
afterEach(() => { for (const stop of stops) stop(); rmSync(dir, { recursive: true, force: true }); });

const planned = (): Task => ({
  id: 12, status: "planned", resolution: null, refs: [], notes: [],
  criteria: [{ id: 3, text: "tests pass", kind: "manual", target: null, state: "pending", evidence: null }],
});
const serve = (task: Task, opts?: Parameters<typeof fakeToodo>[1]) => {
  const fake = fakeToodo(task, opts);
  stops.push(fake.stop);
  return { fake, writer: new ToodoWriter({ url: fake.url, tokenFile }) };
};
const names = (calls: Call[]) => calls.map((c) => c.name);

test("each write is sent once with toodo's arguments, read back, and skipped when repeated", async () => {
  const task = planned();
  const { fake, writer } = serve(task);

  expect((await writer.startTask(12, { reason: "lane ap-12-1", refs: ["lane:ap-12-1"] })).wrote).toBe(true);
  expect((await writer.addProgressNote(12, "Plan: adapter\n", "decision")).wrote).toBe(true);
  expect((await writer.reportBlocker(12, "needs the token")).wrote).toBe(true);
  expect((await writer.checkCriterion(12, 3, " bun test green ")).wrote).toBe(true);
  const done = await writer.completeTask(12, { note: "shipped", refs: ["pr:7"] });
  expect(done).toEqual({
    wrote: true,
    task: {
      id: 12, status: "done", resolution: "completed", refs: ["lane:ap-12-1", "pr:7"],
      notes: [{ kind: "decision", body: "Plan: adapter" }, { kind: "blocker", body: "needs the token" }],
      criteria: [{ id: 3, kind: "manual", state: "met", evidence: "bun test green" }],
    },
  });
  expect(names(fake.calls)).toEqual([
    "get_task", "start_task", "get_task", "get_task", "add_progress_note", "get_task", "get_task", "report_blocker", "get_task",
    "get_task", "check_criterion", "get_task", "get_task", "complete_task", "get_task",
  ]);
  expect(fake.calls.filter((c) => c.name !== "get_task").map((c) => c.args)).toEqual([
    { id: 12, refs: ["lane:ap-12-1"], reason: "lane ap-12-1" },
    { task_id: 12, note: "Plan: adapter", kind: "decision" },
    { task_id: 12, note: "needs the token" },
    { task_id: 12, criterion_id: 3, met: true, evidence: "bun test green" },
    { id: 12, refs: ["pr:7"], note: "shipped" },
  ]);
  expect(fake.calls.every((c) => c.authorization === "Bearer mcp-1")).toBe(true);

  fake.calls.length = 0;
  const again = [
    await writer.startTask(12, { refs: ["lane:ap-12-1"] }).catch((e: unknown) => e),
    await writer.addProgressNote(12, "Plan: adapter", "decision"),
    await writer.reportBlocker(12, "needs the token"),
    await writer.checkCriterion(12, 3, "bun test green"),
    await writer.completeTask(12, { refs: ["pr:7"] }),
  ];
  // A done task is not in_progress, so starting it again is a real write that toodo refuses.
  expect(again[0]).toBeInstanceOf(ToodoWriteFailed);
  expect(again.slice(1).map((w) => (w as { wrote: boolean }).wrote)).toEqual([false, false, false, false]);
  expect(names(fake.calls)).toEqual(["get_task", "start_task", "get_task", "get_task", "get_task", "get_task", "get_task"]);
});

test("a write whose reply is lost is confirmed by the read-back", async () => {
  const task = planned();
  const { fake, writer } = serve(task, { loseReply: new Set(["start_task", "add_progress_note"]) });
  expect((await writer.startTask(12, { refs: ["lane:x"] })).task.status).toBe("in_progress");
  expect((await writer.addProgressNote(12, "PR opened")).wrote).toBe(true);
  expect(task.notes.map((n) => n.body)).toEqual(["PR opened"]);
  expect(names(fake.calls)).toEqual(["get_task", "start_task", "get_task", "get_task", "add_progress_note", "get_task"]);
});

test("a refused write throws toodo's code and message, and an unshown write throws", async () => {
  const { writer } = serve(planned(), { ignore: new Set(["report_blocker"]) });
  const missing = await writer.checkCriterion(12, 99, "x").catch((e: unknown) => e);
  expect(missing).toBeInstanceOf(ToodoWriteFailed);
  expect((missing as ToodoWriteFailed).code).toBe("criterionNotFound");
  expect((missing as ToodoWriteFailed).message).toContain("has no criterion 99");

  const unmet = await writer.completeTask(12).catch((e: unknown) => e);
  expect((unmet as ToodoWriteFailed).code).toBe("criteriaUnmet");

  const unshown = await writer.reportBlocker(12, "stuck").catch((e: unknown) => e);
  expect(unshown).toBeInstanceOf(ToodoWriteFailed);
  expect((unshown as ToodoWriteFailed).message).toContain("does not show the write");

  const gone = await writer.addProgressNote(404, "x").catch((e: unknown) => e);
  expect((gone as ToodoWriteFailed).code).toBe("taskNotFound");
});

test("a refused or missing token writes nothing", async () => {
  const { fake } = serve(planned());
  writeFileSync(tokenFile, "web-1\n");
  const refused = await new ToodoWriter({ url: fake.url, tokenFile }).startTask(12).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(ToodoWriteFailed);
  expect((refused as ToodoWriteFailed).message).toContain("HTTP 401 (the token was refused)");
  const absent = await new ToodoWriter({ url: fake.url, tokenFile: join(dir, "absent") }).startTask(12).catch((e: unknown) => e);
  expect((absent as ToodoWriteFailed).message).toContain("cannot read the token file");
  expect(names(fake.calls)).toEqual(["get_task"]);
});
