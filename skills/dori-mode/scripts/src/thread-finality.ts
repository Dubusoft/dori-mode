import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { statusOf, type Lane } from "./registry.ts";

/**
 * Threads whose finished work `dori supervise` closed, thread id -> when (epoch ms): written by `dori supervise` alone,
 * when it archives a finished thread itself, and for a close button posted before threads were closed automatically (an
 * older `--final` report's receipt). A report recorded after that time is new work on the thread. The file keeps its old
 * name so the records of a running install carry over.
 */
export const FINISHED_THREADS_FILE = "close-buttons.json";

export const readFinishedThreads = (stateDir: string): Record<string, number> => {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(stateDir, FINISHED_THREADS_FILE), "utf8")); } catch { return {}; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
};

/** Records `thread` finished at `at`, keeping the later time (tmp + rename). */
export const recordFinishedThread = (stateDir: string, thread: string, at: number): void => {
  const buttons = readFinishedThreads(stateDir);
  if ((buttons[thread] ?? -Infinity) >= at) return;
  const path = join(stateDir, FINISHED_THREADS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...buttons, [thread]: at }), { mode: 0o600 });
  renameSync(tmp, path);
};

/** The thread id of a ref (`discord:<channel>/<thread>`, `discord:<thread>`) or of a bare id. */
export const threadIdOf = (ref: string): string => ref.replace(/^[a-z]+:/, "").split("/").pop() ?? "";

export type ThreadInput = {
  /** The thread id. */
  readonly thread: string;
  /** Lanes known to have worked on the thread (reported or not), closed or not. */
  readonly lanes: readonly string[];
  readonly open: readonly Lane[];
  /** Lanes on the thread whose finish the owner has not been told about yet (no `dori reported`). */
  readonly unreported: readonly string[];
  /** Registered waits (only `key` and `thread` are read). */
  readonly waits: readonly { readonly key: string; readonly thread?: string }[];
  /**
   * Open decision obligations as published by the supervisor (their event line names the lane second), and open owner
   * decisions (owner-decisions.ts ownerDecisionBlockers), which name their lane directly.
   */
  readonly decisions: readonly { readonly id: string; readonly line?: string; readonly lane?: string }[];
};

/**
 * Why `dori supervise` must not close a thread yet: a lane bound to it still open (any status
 * short of closed), a finished lane on it not reported, a wait registered with it, or an open decision for one of its
 * lanes. Empty: everything on the thread is finished and reported.
 */
export const threadBlockers = ({ thread, lanes, open, unreported, waits, decisions }: ThreadInput): string[] => {
  const reasons: string[] = [];
  const onThread = (ref: string | undefined): boolean => ref !== undefined && ref !== "none" && threadIdOf(ref) === thread;
  const live = open.filter((lane) => onThread(lane.thread) && statusOf(lane) !== "closed");
  for (const lane of live) reasons.push(`lane ${lane.key} is still open on this thread (${statusOf(lane)})`);
  for (const key of unreported) reasons.push(`lane ${key} is not reported`);
  for (const wait of waits) if (onThread(wait.thread)) reasons.push(`wait ${wait.key} is registered on this thread`);
  const keys = new Set([...lanes, ...unreported, ...live.map((lane) => lane.key)]);
  for (const decision of decisions) {
    const named = decision.lane ?? decision.line?.split(" ")[1];
    if (named !== undefined && keys.has(named)) reasons.push(`decision ${decision.id} for lane ${named} is unresolved`);
  }
  return reasons;
};
