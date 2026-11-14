import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { Lane } from "./registry.ts";

/**
 * The operational rollback switch of the supervisor's automatic merges (`dori merge pause|resume|status`). While the
 * pause file exists CI follow-up makes no `gh pr merge` at all (ci-follow.ts, right before the merge, after the full
 * gate), review jobs and receipts go on, lanes waiting on a merge stay held (supervise-loop.ts withReviewHold) and the
 * author lane's status message carries `merge paused: <reason>` (review-status.ts). Every reader reads the file fresh,
 * so a CLI change takes effect on the supervisor's next pass without a restart. Resuming only removes the file: the next
 * pass merges through the whole gate again (mergeGate, claimGate, and an approval of the snapshot observed then), so a
 * receipt that went stale during the pause never merges. There is deliberately no switch that skips the review gate:
 * pausing is the only rollback.
 */

export const MERGE_PAUSE_FILE = "review-merge-pause.json";

export const mergePausePath = (stateDir: string): string => join(stateDir, MERGE_PAUSE_FILE);

export type MergePause = { readonly reason: string; readonly since: string; readonly who: string };

/** The pause in force, or undefined. A file that cannot be read or parsed still pauses: a brake fails closed. */
export const readMergePause = (stateDir: string): MergePause | undefined => {
  let text: string;
  try { text = readFileSync(mergePausePath(stateDir), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { reason: `pause file unreadable: ${e instanceof Error ? e.message : String(e)}`, since: "?", who: "?" };
  }
  try {
    const raw = JSON.parse(text) as { reason?: unknown; since?: unknown; who?: unknown };
    return {
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason : "no reason recorded",
      since: typeof raw.since === "string" ? raw.since : "?",
      who: typeof raw.who === "string" ? raw.who : "?",
    };
  } catch { return { reason: "pause file unparsable", since: "?", who: "?" }; }
};

const writeMergePause = (stateDir: string, pause: MergePause): void => {
  const path = mergePausePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pause)}\n`);
  renameSync(tmp, path);
};

/** The visible text of a pause: `merge paused: <reason>`, as status lines and log lines show it. */
export const mergePausedText = (pause: MergePause): string => `merge paused: ${pause.reason.replace(/\s+/g, " ").trim()}`;

const pauseDetail = (pause: MergePause): string => `${mergePausedText(pause)} (since ${pause.since}, by ${pause.who})`;

/**
 * Whether the pause keeps `lane` open: while paused, a lane whose claim binds any PR waits on a merge that cannot happen
 * now, so the done watcher neither closes nor objects to it (done-flow.ts reviewHold, still only until every bound PR
 * reads merged). Not paused: false, and the review gate's own hold decides alone.
 */
export const mergePauseHolds = (stateDir: string, lane: Lane): boolean =>
  readMergePause(stateDir) !== undefined && (lane.claim?.pulls?.length ?? 0) > 0;

export type MergePauseDeps = {
  readonly stateDir: string;
  readonly now: () => number;
  /** Who runs the command (recorded as `who`). */
  readonly who: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

export const MERGE_USAGE = [
  "usage: dori merge pause --reason TEXT",
  "       dori merge resume",
  "       dori merge status",
].join("\n");

/** `dori merge <pause|resume|status>`; returns the exit code (2 on a usage error). */
export const mergePauseMain = (args: readonly string[], deps: MergePauseDeps): number => {
  let parsed;
  try { parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: { reason: { type: "string" } } }); }
  catch (e) { deps.err(`${e instanceof Error ? e.message : String(e)}\n${MERGE_USAGE}`); return 2; }
  const [sub = "", ...extra] = parsed.positionals;
  const reason = parsed.values.reason?.trim();
  if (extra.length || !["pause", "resume", "status"].includes(sub)) { deps.err(MERGE_USAGE); return 2; }
  if (sub !== "pause" && parsed.values.reason !== undefined) { deps.err(`--reason is not an option of merge ${sub}\n${MERGE_USAGE}`); return 2; }
  const current = readMergePause(deps.stateDir);
  if (sub === "status") {
    deps.out(current ? `MERGE_PAUSED ${pauseDetail(current)}` : "MERGE_ACTIVE automatic merges run through the review gate");
    return 0;
  }
  if (sub === "pause") {
    if (!reason) { deps.err(`merge pause needs --reason TEXT\n${MERGE_USAGE}`); return 2; }
    // Pausing twice keeps the first pause (its reason, time and author): the brake is already on.
    if (current) { deps.out(`MERGE_PAUSED ${pauseDetail(current)} (already paused)`); return 0; }
    const next: MergePause = { reason, since: new Date(deps.now()).toISOString(), who: deps.who };
    writeMergePause(deps.stateDir, next);
    deps.out(`MERGE_PAUSED ${pauseDetail(next)}`);
    return 0;
  }
  if (!current) { deps.out("MERGE_NOT_PAUSED"); return 0; }
  rmSync(mergePausePath(deps.stateDir), { force: true });
  deps.out("MERGE_RESUMED merges go on through the full review gate at the next poll");
  return 0;
};
