import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneTaskId, laneToodoReader, laneToodoRequest, type LaneToodoResult } from "../src/toodo-lane-read.ts";
import { fakeToodo } from "./support/fake-toodo.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "toodo-lane-read-"));
  dirs.push(dir);
  const tokenFile = join(dir, "web-token");
  writeFileSync(tokenFile, "web-token-value\n");
  const toodo = fakeToodo(tokenFile);
  const logs: string[] = [];
  return { toodo, logs, read: laneToodoReader({ client: toodo.client, log: (line) => { logs.push(line); } }) };
};

const json = (result: LaneToodoResult): Record<string, unknown> => {
  if (!result.ok) throw new Error(`${result.code} ${result.detail}`);
  return JSON.parse(result.text) as Record<string, unknown>;
};

test("get without an id shows the lane's own task with its dependencies and related tasks", async () => {
  const s = setup();
  const value = json(await s.read("ap-10-1", { op: "get" }));
  expect((value.task as { id: number }).id).toBe(10);
  expect(value.dependsOn).toEqual([{ id: 11, workspaceId: 1, title: "Prerequisite", status: "done", resolution: "merged", dependsOn: [] }]);
  expect(value.related).toEqual([{ id: 20, workspaceId: 2, title: "Related elsewhere", status: "planned", resolution: null, dependsOn: [] }]);
});

test("a lane reads a related task in another workspace and a task of its own workspace, whose out-of-scope link shows only its id", async () => {
  const s = setup();
  expect((json(await s.read("ap-10-1", { op: "get", id: 20 })).task as { id: number }).id).toBe(20);
  const sibling = json(await s.read("ap-10-1", { op: "get", id: 12 }));
  expect((sibling.task as { id: number }).id).toBe(12);
  expect(sibling.dependsOn).toEqual([{ id: 30 }]);
});

test("a task of another workspace that is not linked to the lane's task is refused", async () => {
  const s = setup();
  const result = await s.read("ap-10-1", { op: "get", id: 30 });
  expect(result).toMatchObject({ ok: false, code: "TOODO_LANE_OUT_OF_SCOPE" });
  expect(s.logs).toContain("TOODO_LANE_READ_DENIED lane=ap-10-1 op=get code=TOODO_LANE_OUT_OF_SCOPE");
  expect(await s.read("ap-10-1", { op: "get", id: 99 })).toMatchObject({ ok: false, code: "TOODO_LANE_NOT_FOUND" });
});

test("search and guidelines stay in the lane task's workspace", async () => {
  const s = setup();
  const found = json(await s.read("ap-10-1", { op: "search", query: "ALPHA" }));
  expect((found.tasks as { id: number }[]).map((t) => t.id)).toEqual([12, 10]);
  expect(found.more).toBe(false);
  expect((json(await s.read("ap-10-1", { op: "search", query: "#11" })).tasks as { id: number }[]).map((t) => t.id)).toEqual([11]);
  expect(json(await s.read("ap-10-1", { op: "guidelines" }))).toEqual({
    workspaceId: 1, guidelines: [{ id: 1, workspaceId: 1, kind: "rule", body: "Reply in Korean", createdAt: 1, updatedAt: 1 }],
  });
});

test("a lane without a task reads nothing, and only read commands ever reach toodo-server", async () => {
  const s = setup();
  expect(await s.read("search-api", { op: "get" })).toMatchObject({ ok: false, code: "TOODO_LANE_NO_TASK" });
  expect(await s.read("ap-77-1", { op: "get" })).toMatchObject({ ok: false, code: "TOODO_LANE_NO_TASK" });
  for (const request of [{ op: "get" }, { op: "get", id: 20 }, { op: "search", query: "x" }, { op: "guidelines" }] as const) await s.read("ap-10-1", request);
  expect(new Set(s.toodo.paths)).toEqual(new Set(["/api/rpc/get_task", "/api/rpc/list_task_relations", "/api/rpc/list_tasks", "/api/rpc/list_guidelines"]));
});

test("only the three read requests parse, and only autopilot keys name a task", () => {
  expect(laneToodoRequest("get", undefined, undefined)).toEqual({ op: "get" });
  expect(laneToodoRequest("get", 12, undefined)).toEqual({ op: "get", id: 12 });
  expect(laneToodoRequest("search", undefined, "  x ")).toEqual({ op: "search", query: "x" });
  expect(laneToodoRequest("guidelines", undefined, undefined)).toEqual({ op: "guidelines" });
  for (const [op, id, query] of [["update_task", 1, undefined], ["complete_task", undefined, undefined], ["get", -1, undefined], ["get", 1.5, undefined],
    ["search", undefined, " "], ["search", undefined, "x".repeat(201)], ["guidelines", 1, undefined]] as const) {
    expect(laneToodoRequest(op, id, query)).toBeUndefined();
  }
  expect(laneTaskId("ap-1674-1")).toBe(1674);
  expect(laneTaskId("ap-1674")).toBeUndefined();
  expect(laneTaskId("review-ap-1674-1")).toBeUndefined();
});
