import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_AUTOPILOT, type ToodoTask } from "../src/autopilot.ts";
import { contractVersion, type Plan, planTask, snapshotGuidelines, validBranch } from "../src/autopilot-plan.ts";
import { parseSignal } from "../src/signals.ts";
import { ToodoClient, type ToodoFetch, type ToodoGuideline, ToodoUnreadable } from "../src/toodo-client.ts";

const WS = 7;

const task = (id: number, over: Partial<ToodoTask> = {}): ToodoTask => ({
  id, workspaceId: WS, title: `task ${id}`, description: `## Purpose\ndo ${id}\n\n## Background\nwhy ${id}`, status: "planned", resolution: null,
  dependsOn: [], refs: ["owner:discord:c/m", "repo:Dubusoft/dori-mode"], criteria: [{ text: "tests pass", kind: "manual" }],
  wait: null, autopilot: true, dueDate: null, ...over,
});

const rule: ToodoGuideline = { id: 2, workspaceId: WS, kind: "rule", body: "Write reports in Korean.", updatedAt: 100 };
const memory: ToodoGuideline = { id: 1, workspaceId: WS, kind: "memory", body: "CI runs the typecheck only.", updatedAt: 90 };

const plan = (t: ToodoTask, over: { tasks?: ToodoTask[]; guidelines?: ToodoGuideline[]; mergeBase?: string } = {}): Plan => planTask({
  task: t, tasks: new Map((over.tasks ?? [t]).map((x) => [x.id, x])), guidelines: over.guidelines ?? [rule, memory],
  config: { mergeBase: over.mergeBase ?? DEFAULT_AUTOPILOT.mergeBase },
});

const ready = (p: Plan) => {
  if (p.kind !== "ready") throw new Error(`expected ready, got review ${p.reasons.join(", ")}`);
  return p;
};
const reasons = (p: Plan) => (p.kind === "review" ? p.reasons : []);

// Contract

test("a task naming only its repo gets the defaults: base mergeBase, branch autopilot/<id>, mode ulw, Done pr <repo> <branch>", () => {
  const { contract } = ready(plan(task(958)));
  expect(contract).toMatchObject({
    taskId: 958, repo: "dubusoft/dori-mode", base: "dev", branch: "autopilot/958", done: "pr dubusoft/dori-mode autopilot/958", mode: "ulw", approvedVersion: null,
  });
  expect(contract.model).toBeUndefined();
  expect(parseSignal(contract.done)).toEqual({ kind: "pr", repo: "dubusoft/dori-mode", branch: "autopilot/958" });
});

test("base, branch, mode and model refs set the contract", () => {
  const t = task(958, { refs: ["repo:dubusoft/dori-mode", "base:main", "branch:feat/autopilot-contract-958", "mode:mass-ulw", "model:anthropic/claude-x"] });
  const { contract } = ready(plan(t, { mergeBase: "main" }));
  expect(contract).toMatchObject({ base: "main", branch: "feat/autopilot-contract-958", done: "pr dubusoft/dori-mode feat/autopilot-contract-958", mode: "mass-ulw", model: "anthropic/claude-x" });
});

test("the guideline snapshot keeps the task workspace's guidelines by id and its hash follows their content", () => {
  const other: ToodoGuideline = { ...rule, id: 3, workspaceId: 9 };
  const { contract } = ready(plan(task(1), { guidelines: [rule, other, memory] }));
  expect(contract.guidelines.guidelines.map((g) => g.id)).toEqual([1, 2]);
  expect(contract.guidelines.hash).toBe(snapshotGuidelines(WS, [memory, rule]).hash);
  expect(snapshotGuidelines(WS, [memory, { ...rule, body: "changed", updatedAt: 101 }]).hash).not.toBe(contract.guidelines.hash);
});

// Review

test("no repo ref, two repos, a malformed repo, branch or mode, or two different branches go to review", () => {
  expect(reasons(plan(task(1, { refs: ["owner:discord:c/m"] })))).toEqual(["repo-missing"]);
  expect(reasons(plan(task(1, { refs: ["repo:a/b", "repo:a/c"] })))).toEqual(["repo-ambiguous"]);
  expect(reasons(plan(task(1, { refs: ["repo:A/b", "repo:a/B"] })))).toEqual([]);
  expect(reasons(plan(task(1, { refs: ["repo:not a repo"] })))).toEqual(["ref-invalid"]);
  expect(reasons(plan(task(1, { refs: ["repo:a/b", "branch:bad..name"] })))).toEqual(["ref-invalid"]);
  expect(reasons(plan(task(1, { refs: ["repo:a/b", "branch:dev"] })))).toEqual(["ref-invalid"]);
  expect(reasons(plan(task(1, { refs: ["repo:a/b", "mode:fast"] })))).toEqual(["ref-invalid"]);
  expect(reasons(plan(task(1, { refs: ["repo:a/b", "branch:x", "branch:y"] })))).toEqual(["ref-conflict"]);
});

test("a base other than autopilot.mergeBase goes to review base-not-allowed", () => {
  expect(reasons(plan(task(1, { refs: ["repo:a/b", "base:main"] })))).toEqual(["base-not-allowed"]);
});

test("an approval binds to its version: it holds while the content does and is stale once the scope changes", () => {
  const t = task(1);
  const version = contractVersion(t);
  const approved = { ...t, refs: [...t.refs, `approved:${version}`] };
  expect(ready(plan(approved)).contract.approvedVersion).toBe(version);
  expect(contractVersion({ ...approved, refs: [...approved.refs, "lane:ap-1-1"], status: "in_progress" })).toBe(version);
  const rescoped = { ...approved, criteria: [...t.criteria, { text: "docs updated", kind: "manual" }] };
  expect(contractVersion(rescoped)).not.toBe(version);
  expect(plan(rescoped)).toEqual({ kind: "review", taskId: 1, version: contractVersion(rescoped), reasons: ["approval-stale"] });
});

test("validBranch follows git's branch name rules", () => {
  for (const ok of ["feat/x", "autopilot/958", "a.b-c_d"]) expect(validBranch(ok)).toBe(true);
  for (const bad of ["", "-x", "a..b", "a b", "a~1", "x.lock", "x/", "/x", "a//b", "a/.b", "a@{1", "a:b", "x."]) expect(validBranch(bad)).toBe(false);
});

// Template brief

test("the brief carries the title, description, criteria, dependencies, refs, guidelines and contract, without the lane footer", () => {
  const dep = task(5, { title: "prerequisite", status: "done", resolution: "merged" });
  const t = task(958, {
    title: "Execution contract", dependsOn: [5], refs: ["owner:discord:c/m", "repo:dubusoft/dori-mode", "branch:feat/x", "issue:#12"],
    criteria: [{ text: "tests pass", kind: "manual" }, { text: "health", kind: "url", target: "https://x.test/health" }],
  });
  const { brief, contract } = ready(plan(t, { tasks: [dep, t] }));
  expect(brief).toBe([
    "# Execution contract (Toodo #958)",
    "",
    "## Purpose\ndo 958\n\n## Background\nwhy 958",
    "",
    "## 완료 기준",
    "- tests pass (manual)",
    "- health (url: https://x.test/health)",
    "",
    "## 의존성",
    "- #5 prerequisite (done, merged)",
    "",
    "## 참조",
    "- owner:discord:c/m",
    "- issue:#12",
    "",
    "## 워크스페이스 가이드라인",
    "규칙은 모두 따른다.",
    "",
    "### 규칙",
    "- Write reports in Korean.",
    "",
    "### 메모",
    "- CI runs the typecheck only.",
    "",
    "## 실행 계약",
    "- 저장소 dubusoft/dori-mode. origin/dev에서 브랜치 feat/x를 만들어 dev로 PR을 연다. PR 전에 origin/dev로 리베이스한다.",
    "- Done = pr dubusoft/dori-mode feat/x",
    "- 모드 ulw",
    `- 계약 버전 ${contract.version}, 가이드라인 스냅샷 ${contract.guidelines.hash}`,
    "",
  ].join("\n"));
  expect(brief).not.toContain("Lane footer");
});

test("a brief without dependencies, other refs or guidelines leaves those sections out", () => {
  const { brief } = ready(plan(task(1, { refs: ["repo:a/b"] }), { guidelines: [] }));
  expect(brief).not.toContain("## 의존성");
  expect(brief).not.toContain("## 참조");
  expect(brief).not.toContain("## 워크스페이스 가이드라인");
});

// Toodo guidelines read

let dir: string;
let tokenFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-autopilot-plan-"));
  tokenFile = join(dir, "web-token");
  writeFileSync(tokenFile, "tok-1\n");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("guidelines posts list_guidelines with the workspace id and returns the guidelines", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: ToodoFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return json(200, [{ ...rule, createdAt: 50 }]);
  };
  expect(await new ToodoClient({ url: "http://toodo.test/", tokenFile }, { fetch }).guidelines(WS)).toEqual([rule]);
  expect(calls).toEqual([{ url: "http://toodo.test/api/rpc/list_guidelines", body: { workspaceId: WS } }]);
});

test("a guideline of an unknown kind or a reply that is not a list is ToodoUnreadable", async () => {
  for (const reply of [[{ ...rule, kind: "note" }], { error: "x" }]) {
    const client = new ToodoClient({ url: "http://toodo.test", tokenFile }, { fetch: async () => json(200, reply) });
    expect(await client.guidelines(WS).catch((e: unknown) => e)).toBeInstanceOf(ToodoUnreadable);
  }
});
