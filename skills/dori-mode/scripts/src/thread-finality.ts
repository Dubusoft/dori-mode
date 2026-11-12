import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { statusOf, type Lane } from "./registry.ts";

/**
 * Threads that got the owner's close-thread button, thread id -> when (epoch ms): written by `dori supervise` alone, for a
 * `--final` report's button (from its receipt) and for the one it posts itself; `dori reported --final` reads it.
 */
export const CLOSE_BUTTONS_FILE = "close-buttons.json";

export const readCloseButtons = (stateDir: string): Record<string, number> => {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(stateDir, CLOSE_BUTTONS_FILE), "utf8")); } catch { return {}; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
};

/** Records a close button on `thread` at `at`, keeping the later time (tmp + rename). */
export const recordCloseButton = (stateDir: string, thread: string, at: number): void => {
  const buttons = readCloseButtons(stateDir);
  if ((buttons[thread] ?? -Infinity) >= at) return;
  const path = join(stateDir, CLOSE_BUTTONS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...buttons, [thread]: at }), { mode: 0o600 });
  renameSync(tmp, path);
};

/** The thread id of a ref (`discord:<channel>/<thread>`, `discord:<thread>`) or of a bare id. */
export const threadIdOf = (ref: string): string => ref.replace(/^[a-z]+:/, "").split("/").pop() ?? "";

const FINISHED = new Set(["done-claimed", "verified-done", "closed"]);

export type FinalityInput = {
  readonly lane: Lane;
  /** The id of the thread the report is posted into. */
  readonly thread: string;
  readonly open: readonly Lane[];
  /** Registered waits (only `key` and `thread` are read). */
  readonly waits: readonly { readonly key: string; readonly thread?: string }[];
  /**
   * Open decision obligations as published by the supervisor (their event line names the lane second), and open owner
   * decisions (owner-decisions.ts ownerDecisionBlockers), which name their lane directly.
   */
  readonly decisions: readonly { readonly id: string; readonly line?: string; readonly lane?: string }[];
};

/**
 * Why `dori reported <key> --final` must not attach the owner's close-thread button yet: another open lane bound to the
 * thread, a wait registered with that thread, an open decision obligation for one of the thread's lanes, or the reported
 * lane itself not finished (done-claimed, verified-done and closed count as finished). Empty: the button may go on.
 */
export const finalityBlockers = ({ lane, thread, open, waits, decisions }: FinalityInput): string[] => {
  const reasons: string[] = [];
  const status = statusOf(lane);
  if (!FINISHED.has(status)) reasons.push(`lane ${lane.key} is ${status}`);
  const onThread = (ref: string | undefined): boolean => ref !== undefined && ref !== "none" && threadIdOf(ref) === thread;
  const others = open.filter((other) => other.key !== lane.key && onThread(other.thread) && statusOf(other) !== "closed");
  for (const other of others) reasons.push(`lane ${other.key} is still open on this thread (${statusOf(other)})`);
  for (const wait of waits) if (onThread(wait.thread)) reasons.push(`wait ${wait.key} is registered on this thread`);
  const keys = new Set([lane.key, ...others.map((other) => other.key)]);
  for (const decision of decisions) {
    const named = decision.lane ?? decision.line?.split(" ")[1];
    if (named !== undefined && keys.has(named)) reasons.push(`decision ${decision.id} for lane ${named} is unresolved`);
  }
  return reasons;
};

export type ThreadInput = {
  /** The thread id. */
  readonly thread: string;
  /** Lanes known to have worked on the thread (reported or not), closed or not. */
  readonly lanes: readonly string[];
  readonly open: readonly Lane[];
  /** Lanes on the thread whose finish the owner has not been told about yet (no `dori reported`). */
  readonly unreported: readonly string[];
  readonly waits: FinalityInput["waits"];
  readonly decisions: FinalityInput["decisions"];
};

/**
 * Why `dori supervise` must not post the close-thread button into a thread yet: a lane bound to it still open (any status
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
