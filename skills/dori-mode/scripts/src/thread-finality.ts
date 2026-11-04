import { statusOf, type Lane } from "./registry.ts";

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
  /** Open decision obligations as published by the supervisor (their event line names the lane second). */
  readonly decisions: readonly { readonly id: string; readonly line?: string }[];
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
    const named = decision.line?.split(" ")[1];
    if (named !== undefined && keys.has(named)) reasons.push(`decision ${decision.id} for lane ${named} is unresolved`);
  }
  return reasons;
};
