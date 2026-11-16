import type { WorktreeFact } from "./branch-cleanup.ts";
import type { FlowDeps } from "./done-flow.ts";
import { openOperations, operationId, type OperationState, type OperationStore, perform, type ReadBack } from "./operations.ts";
import type { Lane } from "./registry.ts";
import type { Ran } from "./run.ts";
import type { Check } from "./signals.ts";

/** What the lane's runner read of a lane's checkout: its worktrees, Done checks, and where its git ran (design A17, D10). */
export type LaneRead = {
  /** The lane's worktrees (found by the runner by key, and those the registry recorded); none for a remote lane. */
  readonly worktrees: readonly WorktreeFact[];
  /** The Done checks, when asked: in the lane's cwd, or in leadCwd for a remote lane or a gone cwd (on the local runner). */
  readonly checks?: readonly Check[];
  /** A local lane's cwd is set and no longer exists. */
  readonly cwdGone: boolean;
  /** Where a local lane's git runs: its cwd, else leadCwd. */
  readonly root: string;
};

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? "";
const named = (key: string, name: string): boolean => name === key || name.startsWith(`${key}-`);

/**
 * One worktree's git facts (branch, HEAD, dirty, ahead) and its checkout's origin, read by the lane's runner. The
 * runner finds worktrees by name, so the path is inspected under its own directory name, listed from `<path>/.` (a
 * root the listing does not skip). Undefined when git does not list it as a worktree.
 */
export const probeWorktree = async (deps: FlowDeps, lane: Lane, path: string): Promise<WorktreeFact | undefined> => {
  const inspection = await deps.ops.inspect({ ...lane, key: baseName(path) }, { git: true, cwd: `${path}/.` });
  const hit = inspection.git?.worktrees.find((w) => w.path === path);
  return hit ? { ...hit, ...(inspection.git?.origin ? { origin: inspection.git.origin } : {}) } : undefined;
};

/**
 * Reads a lane through its runner: one `q.lane.inspect` (git facts, and the Done checks when `done`), then each worktree
 * the registry recorded or the runner found by key, read one by one (the runner cannot see the registry). A remote
 * lane's worktrees are never read (D10); its Done checks run on the local runner in leadCwd. Throws LaneOpsError when
 * the runner cannot answer.
 */
export const readLane = async (deps: FlowDeps, lane: Lane, want: { readonly done?: boolean } = {}): Promise<LaneRead> => {
  const done = want.done ? { done: lane.done, doneCwd: deps.config.leadCwd } : {};
  if (lane.machine) {
    const checks = want.done ? (await deps.ops.inspect(lane, done)).done?.checks : undefined;
    return { worktrees: [], ...(checks ? { checks } : {}), cwdGone: false, root: deps.config.leadCwd };
  }
  const inspection = await deps.ops.inspect(lane, { git: true, roots: [deps.config.leadCwd], ...done });
  const cwdGone = Boolean(lane.cwd) && !inspection.cwdExists;
  const listed = (inspection.git?.worktrees ?? []).filter((w) => named(lane.key, baseName(w.path)) || named(lane.key, (w.branch ?? "").split("/").pop() ?? ""));
  const paths = [...new Set([...listed.map((w) => w.path), ...(lane.worktrees ?? []).map((p) => p.replace(/\/+$/, ""))])];
  const present = paths.length ? await deps.ops.exists(undefined, paths) : [];
  const worktrees: WorktreeFact[] = [];
  for (const [i, path] of paths.entries()) {
    if (!present[i]) { worktrees.push({ path, exists: false }); continue; }
    worktrees.push((await probeWorktree(deps, lane, path)) ?? listed.find((w) => w.path === path) ?? { path, exists: true, error: "git lists no worktree there" });
  }
  const checks = inspection.done?.checks;
  return { worktrees, ...(checks ? { checks } : {}), cwdGone, root: lane.cwd && !cwdGone ? lane.cwd : deps.config.leadCwd };
};

export const withOperations = async <T>(deps: FlowDeps, body: (store: OperationStore) => Promise<T>): Promise<T> => {
  const store = deps.operations ?? openOperations(deps.config);
  try { return await body(store); } finally { if (!deps.operations) store.close(); }
};

/** One effect's result for the close sequence: `err`/`out` are the effect's own output when it ran (today's receipt text). */
export type Step = { readonly state: OperationState; readonly err: string; readonly out: string; readonly id?: string; readonly detail?: string };
export type Act = (action: string, target: string, effect: (cmdId: string) => Promise<Ran>, readBack: ReadBack) => Promise<Step>;

/**
 * The effect runs at most once per verified operation, and a read-back decides (operations.ts). Its runner command id is
 * `op:<operation id>:<attempt>`: the runner answers a repeated command id with its first result, so a retry of a failed
 * operation (a worktree cleaned since) needs its own.
 */
export const actRecorded = (deps: FlowDeps, store: OperationStore, lane: Lane): Act => async (action, target, effect, readBack) => {
  let ran: Ran | undefined;
  const id = operationId({ lane: lane.key, action, target });
  const { op } = await perform(store, deps.clock.now, { lane: lane.key, action, target }, async () => {
    ran = await effect(`op:${id}:${store.get(id)?.attempts ?? 0}`);
    return { ok: ran.code === 0, detail: ran.code === 0 ? "" : ran.err || ran.out };
  }, readBack);
  return { state: op.state, err: ran?.err ?? op.detail, out: ran?.out ?? "", id: op.id, detail: op.detail };
};
