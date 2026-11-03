/**
 * The part of a Toodo `start_task` response a lane launch uses. The lead calls `start_task` (a task never starts itself)
 * and hands the response to `dori launch --toodo-start`, so the lane runs in the worktree and pane Toodo opened instead
 * of a second worktree or tab.
 */
export type ToodoStart = {
  readonly taskId?: number;
  /** The task's worktree; null for a workspace without git (runner none). */
  readonly worktreePath?: string;
  /** The task's herdr workspace, to find its pane again when the listed id is gone. */
  readonly herdrWorkspaceId?: string;
  /** Pane ids of the herdr workspace without an agent, in Toodo's order. */
  readonly shellPanes: readonly string[];
  /** Why Toodo listed no panes (runner plain, tmux or none, herdr down). */
  readonly paneError?: string;
};

export class ToodoStartError extends Error {}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The task object: the response itself, an MCP result's structuredContent, or the JSON in its first text content. */
const unwrap = (value: unknown): Record<string, unknown> | undefined => {
  const top = record(value);
  if (!top) return undefined;
  const structured = record(top.structuredContent);
  if (structured) return structured;
  if (Array.isArray(top.content)) {
    const body = top.content.map(record).find((c) => c?.type === "text" && typeof c.text === "string");
    if (body) {
      try { return unwrap(JSON.parse(body.text as string)); } catch { throw new ToodoStartError("the start_task result's text content is not JSON"); }
    }
  }
  return top;
};

/** Parse a saved `start_task` response. Throws ToodoStartError when it is not one. */
export const parseToodoStart = (json: string): ToodoStart => {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ToodoStartError("the start_task response is not JSON"); }
  const task = unwrap(value);
  if (!task || !("worktreePath" in task) || !Array.isArray(task.panes)) throw new ToodoStartError("not a start_task response: it needs worktreePath and panes");
  if (task.isError === true) throw new ToodoStartError("the start_task call failed");
  const shellPanes = task.panes.map(record).filter((p) => p && !text(p.agent)).map((p) => text(p?.paneId)).filter((id): id is string => Boolean(id));
  const worktreePath = text(task.worktreePath);
  const herdrWorkspaceId = text(task.herdrWorkspaceId);
  const paneError = text(task.paneError);
  return {
    ...(typeof task.id === "number" ? { taskId: task.id } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(herdrWorkspaceId ? { herdrWorkspaceId } : {}),
    shellPanes,
    ...(paneError ? { paneError } : {}),
  };
};

/** Read `--toodo-start`: inline JSON, or the path of a file holding it. */
export const readToodoStart = async (arg: string): Promise<ToodoStart> => {
  if (arg.startsWith("{")) return parseToodoStart(arg);
  const file = Bun.file(arg);
  if (!(await file.exists())) throw new ToodoStartError(`start_task response file not found: ${arg}`);
  return parseToodoStart(await file.text());
};
