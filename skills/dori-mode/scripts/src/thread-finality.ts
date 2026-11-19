import { readFileSync } from "node:fs";
import { join } from "node:path";

import { replaceFileAtomic } from "./durable-write.ts";
import { statusOf, type Lane } from "./registry.ts";

/**
 * Threads whose work `dori supervise` found finished, thread id -> when (epoch ms): written by `dori supervise` alone,
 * when it puts the owner's close button on a finished thread's last report (or archives a thread with no report in it),
 * and for an older `--final` report's button (its receipt). A report recorded after that time is new work on the thread.
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
  replaceFileAtomic(path, JSON.stringify({ ...buttons, [thread]: at }), 0o600);
};

/**
 * Finished threads waiting for their close, thread id -> the report message carrying the owner's close button, when
 * that report was posted, and when the wait started (epoch ms; the button's post, a newer report or the owner's last
 * message in the thread, whichever is latest). Written by `dori supervise` alone, so the wait and the one button survive
 * a restart.
 */
export const CLOSE_TIMERS_FILE = "thread-close-timers.json";

export type CloseTimer = { readonly message: string; readonly reportAt: number; readonly since: number };

export const readCloseTimers = (stateDir: string): Record<string, CloseTimer> => {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(stateDir, CLOSE_TIMERS_FILE), "utf8")); } catch { return {}; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, CloseTimer] => {
    const timer = entry[1] as Partial<CloseTimer> | null;
    return typeof timer?.message === "string" && Number.isFinite(timer.reportAt) && Number.isFinite(timer.since);
  }));
};

const writeCloseTimers = (stateDir: string, timers: Record<string, CloseTimer>): void => {
  replaceFileAtomic(join(stateDir, CLOSE_TIMERS_FILE), JSON.stringify(timers), 0o600);
};

/**
 * Records that `timer.message` carries `thread`'s close button and its wait runs from `timer.since`; a later start
 * already on record (the owner wrote meanwhile) is kept. Read and written with no await between, so a concurrent touch
 * is not lost.
 */
export const recordCloseTimer = (stateDir: string, thread: string, timer: CloseTimer): void => {
  const timers = readCloseTimers(stateDir);
  writeCloseTimers(stateDir, { ...timers, [thread]: { ...timer, since: Math.max(timer.since, timers[thread]?.since ?? -Infinity) } });
};

/** Restarts `thread`'s wait at `at` when one runs (the owner wrote in the thread); returns whether it did. */
export const touchCloseTimer = (stateDir: string, thread: string, at: number): boolean => {
  const timers = readCloseTimers(stateDir);
  const timer = timers[thread];
  if (!timer || timer.since >= at) return false;
  writeCloseTimers(stateDir, { ...timers, [thread]: { ...timer, since: at } });
  return true;
};

export const dropCloseTimer = (stateDir: string, thread: string): void => {
  const timers = readCloseTimers(stateDir);
  if (!(thread in timers)) return;
  delete timers[thread];
  writeCloseTimers(stateDir, timers);
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
