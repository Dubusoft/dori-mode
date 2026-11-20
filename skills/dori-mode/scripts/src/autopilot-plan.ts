import { createHash } from "node:crypto";

import type { AutopilotConfig, ToodoTask } from "./autopilot.ts";
import { githubRepoFromRemote } from "./git-remote.ts";
import { LANE_NOT_ADOPTED_NAME, LANE_REPORT_NAME } from "./lane-files.ts";
import { LANE_MODES, type LaneMode } from "./registry.ts";
import { parseSignal } from "./signals.ts";
import type { ToodoGuideline } from "./toodo-client.ts";

/**
 * Autopilot execution contract: what a marked toodo task must state before it can run as a lane without the lead
 * writing its brief, and the brief built from it. Pure: callers read the task, its dependencies and its workspace's
 * guidelines (ToodoClient) and pass them in; nothing here reads toodo, writes a file or launches.
 *
 * The contract is read from task refs, which toodo stores without interpreting them:
 * - `repo:<owner>/<name>` (optional, at most one repo): the repository the lane works in. Without it the workspace's
 *   `repository` is used when it names a GitHub repository (`owner/name` or a github.com URL); with neither the task
 *   runs repo-less: in a plain work folder, no branch or PR, and its Done is the report file its claim installs on the
 *   lead host (`reportFile`).
 * - `base:<branch>` (optional, default `autopilot.mergeBase`): the branch the lane starts from and opens its PR into;
 *   it must be `autopilot.mergeBase`, since autopilot lanes merge there only.
 * - `branch:<name>` (optional, default `autopilot/<taskId>`): the lane's branch; Done is `pr <repo> <branch>`.
 * - `mode:<ulw|mass-ulw>` (optional, default `ulw`) and `model:<id>` (optional, default the config's defaultModel).
 * - `approved:<version>`: the lead reviewed the task at that contract version. It binds only while the version holds;
 *   once the task's content changes the approval is stale and the task goes back to review.
 *
 * A task whose contract is missing, invalid or carries a stale approval is not planned: planTask returns `review` with
 * the reasons, for the lead.
 */

export const CONTRACT_REF_KEYS = ["repo", "base", "branch", "mode", "model"] as const;
type ContractKey = (typeof CONTRACT_REF_KEYS)[number];
const APPROVED_PREFIX = "approved:";
export const DEFAULT_MODE: LaneMode = "ulw";
/** Hex digits of a contract version and of a guideline snapshot hash. */
const VERSION_LENGTH = 12;

export const REVIEW_REASONS = ["repo-missing", "repo-ambiguous", "ref-invalid", "ref-conflict", "base-not-allowed", "approval-stale"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export type GuidelineSnapshot = {
  readonly workspaceId: number;
  /** Ascending by id. */
  readonly guidelines: readonly ToodoGuideline[];
  /** sha256 (first 12 hex digits) over the guidelines' ids, kinds, bodies and update times. */
  readonly hash: string;
};

export type AutopilotContract = {
  readonly taskId: number;
  /** sha256 (first 12 hex digits) over the task content the lane works from; see contractVersion. */
  readonly version: string;
  /** `owner/name`, lowercase; null for a repo-less task. */
  readonly repo: string | null;
  readonly base: string;
  /** null for a repo-less task: it makes no branch. */
  readonly branch: string | null;
  /** The lane's Done expression: `pr <repo> <branch>`, or `file "<reportFile>"` for a repo-less task. */
  readonly done: string;
  readonly mode: LaneMode;
  /** Absent: the config's defaultModel. */
  readonly model?: string;
  readonly guidelines: GuidelineSnapshot;
  /** The version a matching `approved:` ref names, or null when the task has none. */
  readonly approvedVersion: string | null;
};

export type PlanInput = {
  readonly task: ToodoTask;
  /** Toodo tasks by id; the task's dependencies are looked up here for the brief. */
  readonly tasks: ReadonlyMap<number, ToodoTask>;
  /** The guidelines of the task's workspace (ToodoClient.guidelines). */
  readonly guidelines: readonly ToodoGuideline[];
  readonly config: Pick<AutopilotConfig, "mergeBase">;
  /** The task workspace's `repository` (ToodoClient.workspaceRepository): free text, used only when it names a GitHub repo. */
  readonly workspaceRepository?: string | null;
  /**
   * The lead-host path the lane's `report.md` lands at once its claim is collected (lane-files.ts laneReportFile). A
   * task with no repo runs repo-less with this file as its Done; without it such a task goes to review `repo-missing`.
   */
  readonly reportFile?: string;
};

export type Plan =
  | { readonly kind: "ready"; readonly contract: AutopilotContract; readonly brief: string }
  | { readonly kind: "review"; readonly taskId: number; readonly version: string; readonly reasons: readonly ReviewReason[] };

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, VERSION_LENGTH);

const REPO = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/;
const MODEL = /^\S+$/;

/** A branch name `git check-ref-format --branch` accepts (the rules that matter for a typed name). */
export const validBranch = (name: string): boolean =>
  name !== "" && name !== "@" && !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".")
  && !name.endsWith(".lock") && !name.includes("..") && !name.includes("//") && !name.includes("@{")
  && !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) && name.split("/").every((part) => part !== "" && !part.startsWith("."));

const isContractKey = (key: string): key is ContractKey => (CONTRACT_REF_KEYS as readonly string[]).includes(key);

/** The GitHub repository a workspace's free-text `repository` names (`owner/name` or a github.com URL), lowercase. */
export const workspaceRepo = (repository: string | null | undefined): string | undefined => {
  const value = (repository ?? "").trim().toLowerCase();
  const repo = REPO.test(value) ? value : githubRepoFromRemote(value);
  return repo && REPO.test(repo) ? repo : undefined;
};

/** The task's contract refs by key (trimmed values, in ref order); other refs are left out. */
const contractRefs = (task: ToodoTask): Map<ContractKey, string[]> => {
  const out = new Map<ContractKey, string[]>();
  for (const ref of task.refs) {
    const colon = ref.indexOf(":");
    const key = colon < 0 ? "" : ref.slice(0, colon);
    if (!isContractKey(key)) continue;
    out.set(key, [...(out.get(key) ?? []), ref.slice(colon + 1).trim()]);
  }
  return out;
};

/**
 * The task's contract version: a hash of everything the lane works from (title, description, criteria, dependencies
 * and the contract refs). Notes, status, `lane:`/`owner:`/`approved:` and other refs are left out, so starting the task
 * or approving it does not change the version, while a scope change does. A task without a `repo:` ref also hashes the
 * repo its workspace gives it (or none), so changing the workspace's repository moves it; a task with one hashes as
 * before.
 */
export const contractVersion = (task: ToodoTask, workspaceRepository?: string | null): string => {
  const contract = contractRefs(task);
  const refs = [...contract].map(([key, values]) => [key, [...new Set(values.map((v) => (key === "repo" ? v.toLowerCase() : v)))].sort()]).sort();
  return sha({
    title: task.title, description: task.description,
    criteria: task.criteria.map((c) => [c.text, c.kind, c.target ?? null]),
    dependsOn: [...new Set(task.dependsOn)].sort((a, b) => a - b), refs,
    ...(contract.has("repo") ? {} : { workspaceRepo: workspaceRepo(workspaceRepository) ?? null }),
  });
};

export const snapshotGuidelines = (workspaceId: number, guidelines: readonly ToodoGuideline[]): GuidelineSnapshot => {
  const sorted = guidelines.filter((g) => g.workspaceId === workspaceId).sort((a, b) => a.id - b.id);
  return { workspaceId, guidelines: sorted, hash: sha(sorted.map((g) => [g.id, g.kind, g.body, g.updatedAt])) };
};

/** One value for `key`: undefined when absent, `conflict` when the task names two different ones. */
const single = (refs: Map<ContractKey, string[]>, key: ContractKey): string | undefined | "conflict" => {
  const values = [...new Set(refs.get(key) ?? [])];
  return values.length > 1 ? "conflict" : values[0];
};

/** Reads the task's contract, or the reasons it needs the lead's review. */
export const planTask = (input: PlanInput): Plan => {
  const { task, config } = input;
  const version = contractVersion(task, input.workspaceRepository);
  const refs = contractRefs(task);
  const reasons = new Set<ReviewReason>();

  const named = [...new Set((refs.get("repo") ?? []).map((r) => r.toLowerCase()))];
  const fallback = named.length ? undefined : workspaceRepo(input.workspaceRepository);
  const repos = fallback ? [fallback] : named;
  if (repos.length === 0) { if (input.reportFile === undefined) reasons.add("repo-missing"); }
  else if (repos.length > 1) reasons.add("repo-ambiguous");
  else if (!REPO.test(repos[0]!)) reasons.add("ref-invalid");

  const pick = (key: ContractKey, valid: (v: string) => boolean): string | undefined => {
    const value = single(refs, key);
    if (value === "conflict") { reasons.add("ref-conflict"); return undefined; }
    if (value !== undefined && !valid(value)) { reasons.add("ref-invalid"); return undefined; }
    return value;
  };
  const base = pick("base", validBranch) ?? config.mergeBase;
  if (base !== config.mergeBase) reasons.add("base-not-allowed");
  const branch = pick("branch", (v) => validBranch(v) && v !== config.mergeBase) ?? `autopilot/${task.id}`;
  const mode = (pick("mode", (v) => (LANE_MODES as readonly string[]).includes(v)) ?? DEFAULT_MODE) as LaneMode;
  const model = pick("model", (v) => MODEL.test(v));

  const approvals = task.refs.filter((r) => r.startsWith(APPROVED_PREFIX)).map((r) => r.slice(APPROVED_PREFIX.length).trim());
  const approvedVersion = approvals.includes(version) ? version : null;
  if (approvals.length > 0 && approvedVersion === null) reasons.add("approval-stale");

  if (reasons.size > 0) return { kind: "review", taskId: task.id, version, reasons: REVIEW_REASONS.filter((r) => reasons.has(r)) };
  const repo = repos[0] ?? null;
  const done = repo === null ? `file ${JSON.stringify(input.reportFile)}` : `pr ${repo} ${branch}`;
  parseSignal(done); // a valid repo and branch (or a quoted path) always parse; a throw here is a bug, not a review case
  const contract: AutopilotContract = {
    taskId: task.id, version, repo, base, branch: repo === null ? null : branch, done, mode, ...(model === undefined ? {} : { model }),
    guidelines: snapshotGuidelines(task.workspaceId, input.guidelines), approvedVersion,
  };
  return { kind: "ready", contract, brief: renderBrief(task, contract, input.tasks) };
};

const bullet = (text: string): string => `- ${text.trim().replace(/\n/g, "\n  ")}`;

/**
 * The lane brief for a ready contract: the task's title and description as written, its criteria, dependencies,
 * other refs, the workspace guidelines, and the execution contract. `dori launch` appends the common lane footer
 * (reporting, Done, worktree rules), so the brief does not repeat it.
 */
export const renderBrief = (task: ToodoTask, contract: AutopilotContract, tasks: ReadonlyMap<number, ToodoTask>): string => {
  const out: string[] = [`# ${task.title.trim()} (Toodo #${task.id})`, "", task.description.trim(), "", "## 완료 기준"];
  out.push(...task.criteria.map((c) => bullet(`${c.text} (${c.kind}${c.target ? `: ${c.target}` : ""})`)));
  const deps = [...new Set(task.dependsOn)].sort((a, b) => a - b);
  if (deps.length > 0) {
    out.push("", "## 의존성");
    for (const id of deps) {
      const dep = tasks.get(id);
      out.push(bullet(dep ? `#${id} ${dep.title} (${dep.status}${dep.resolution ? `, ${dep.resolution}` : ""})` : `#${id}`));
    }
  }
  const other = task.refs.filter((r) => {
    const colon = r.indexOf(":");
    const key = colon < 0 ? "" : r.slice(0, colon);
    return !isContractKey(key) && !r.startsWith(APPROVED_PREFIX);
  });
  if (other.length > 0) out.push("", "## 참조", ...other.map(bullet));
  const rules = contract.guidelines.guidelines.filter((g) => g.kind === "rule");
  const memories = contract.guidelines.guidelines.filter((g) => g.kind === "memory");
  if (rules.length + memories.length > 0) {
    out.push("", "## 워크스페이스 가이드라인", "규칙은 모두 따른다.");
    if (rules.length > 0) out.push("", "### 규칙", ...rules.map((g) => bullet(g.body)));
    if (memories.length > 0) out.push("", "### 메모", ...memories.map((g) => bullet(g.body)));
  }
  out.push("", "## 실행 계약");
  if (contract.repo === null) {
    out.push(
      bullet("저장소 없음: 레인 작업 폴더에서 작업하고 브랜치·커밋·PR을 만들지 않는다. 푸터의 PR·머지 규칙은 이 레인에 해당하지 않는다."),
      bullet("deliverable: report"),
      bullet(`결과를 DORI_LANE_OUT/${LANE_REPORT_NAME}에 쓴다: 완료 기준마다 결과와 근거(링크, 파일, 확인한 내용). 다른 산출물도 DORI_LANE_OUT에 둔다. 다 쓴 뒤 done을 보고하면 그 파일이 리드에 설치되어 Done이 된다.`),
    );
  } else {
    out.push(
      bullet(`저장소 ${contract.repo}. origin/${contract.base}에서 브랜치 ${contract.branch}를 만들어 ${contract.base}로 PR을 연다. PR 전에 origin/${contract.base}로 리베이스한다.`),
      bullet(`PR 없이 끝나는 일(보고서·조사 등)을 다 했으면 PR을 열지 않고 브랜치도 푸시하지 않는다. DORI_LANE_OUT/${LANE_REPORT_NAME}에 완료 기준마다 결과와 근거(링크, 파일, 확인한 내용)를 쓰고 done을 보고한다. 그 파일이 있고 ${contract.branch}에서 연 PR이 없으면 레인은 Done의 PR 대신 그 보고서로 닫히고 태스크는 기준 체크 후 완료(completed)된다. 이때 ${LANE_NOT_ADOPTED_NAME}는 쓰지 않는다.`),
      bullet(`조사 결과 수정할 것이 없거나 채택하지 않기로 했으면(not adopted) PR을 열지 않고 브랜치도 푸시하지 않는다. DORI_LANE_OUT/${LANE_NOT_ADOPTED_NAME}에 결론과 근거(확인한 내용, 파일, 링크)를 쓰고 done을 보고한다. 그 파일이 있고 ${contract.branch}에서 연 PR이 없으면 레인은 Done의 PR 대신 그 결론으로 닫히고 태스크는 not_adopted로 마무리된다(${LANE_REPORT_NAME}가 함께 있어도 not_adopted).`),
    );
  }
  out.push(
    bullet(`Done = ${contract.done}`),
    bullet(`모드 ${contract.mode}${contract.model ? `, 모델 ${contract.model}` : ""}`),
    bullet(`계약 버전 ${contract.version}, 가이드라인 스냅샷 ${contract.guidelines.hash}`),
  );
  return `${out.join("\n")}\n`;
};
