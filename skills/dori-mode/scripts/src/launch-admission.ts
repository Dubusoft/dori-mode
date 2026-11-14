import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { MachineCheck } from "./placement.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { LaunchVerdict } from "./routing.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";

/** Every machine keeps one slot for a review, even when its pane cap is off. */
export const REVIEW_SLOTS_PER_MACHINE = 1;
/** A crashed launcher without a pane stops occupying admission after ten minutes. */
export const LAUNCH_SLOT_TTL_MS = 10 * 60_000;
/** A launch approved before its pane has appeared in an observation. */
export type LaunchSlot = { readonly key: string; readonly machine: string; readonly kind: "author" | "review"; readonly at: number };
/** Physical and reserved room under design 5.2; Infinity denotes uncapped authors. */
export const admissionSlots = (cap: number, panes: number, pending: number, reviews: number): {
  readonly physicalFree: number; readonly unfilledReviewReserve: number; readonly authorAdmissible: number; readonly reviewAdmissible: number;
} => {
  const physicalFree = cap <= 0 ? Infinity : Math.max(0, cap - panes - pending);
  const unfilledReviewReserve = Math.max(0, REVIEW_SLOTS_PER_MACHINE - reviews);
  return {
    physicalFree, unfilledReviewReserve,
    authorAdmissible: Math.max(0, physicalFree - unfilledReviewReserve),
    reviewAdmissible: Math.min(physicalFree, unfilledReviewReserve),
  };
};

const readSlots = (stateDir: string): LaunchSlot[] => {
  const path = join(stateDir, "launch-slots.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { slots: LaunchSlot[] }).slots : [];
};
const readLane = (path: string): Lane | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as Lane; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/** The locked snapshot includes registry reads, pruning, the decision and (for claims) the write. */
const inspect = (stateDir: string, check: MachineCheck, now: number, kind: LaunchSlot["kind"], key?: string, claim = false) =>
  withStateLockSync(join(stateDir, "launch-slots.lock.sqlite"), () => {
    const path = join(stateDir, "launch-slots.json"), dir = join(stateDir, "lanes");
    const lanes = new Map<string, Lane>();
    if (existsSync(dir)) for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const lane = readLane(join(dir, name));
      if (lane) lanes.set(lane.key, lane);
    }
    const before = readSlots(stateDir), panes = new Set(check.paneIds);
    const slots = before.filter((slot) => {
      const lane = lanes.get(slot.key) ?? readLane(join(stateDir, "lanes-archive", `${slot.key}.json`));
      if (lane && statusOf(lane) === "closed") return false;
      if (slot.machine === check.machine && lane?.pane && panes.has(lane.pane)) return false;
      return !(!lane?.pane && now - slot.at > LAUNCH_SLOT_TTL_MS);
    });
    const pending = slots.filter((s) => s.machine === check.machine && s.key !== key);
    const running = [...lanes.values()].filter((l) => l.key !== key && (l.machine ?? "local") === check.machine
      && statusOf(l) !== "closed" && l.review && l.pane && panes.has(l.pane));
    const room = admissionSlots(check.paneCap!, check.paneCount!, pending.length,
      new Set([...running.map((l) => l.key), ...pending.filter((s) => s.kind === "review").map((s) => s.key)]).size);
    const allowed = kind === "review" ? room.reviewAdmissible : room.authorAdmissible;
    const verdict: LaunchVerdict = !check.verdict.ok ? check.verdict : allowed > 0 ? { ok: true, reasons: [] } : {
      ok: false, reasons: [`review reserve ${REVIEW_SLOTS_PER_MACHINE} on machine ${check.machine}: ${kind ?? "author"} slots 0`],
    };
    if (claim && key !== undefined && verdict.ok) {
      const previous = slots.findIndex((s) => s.key === key);
      if (previous >= 0) slots.splice(previous, 1);
      slots.push({ key, machine: check.machine, kind, at: now });
    }
    if (JSON.stringify(before) !== JSON.stringify(slots)) saveJsonFile(path, { slots });
    return { verdict, ...room, reservedKeys: pending.map((s) => s.key) };
  });

/** Non-binding author/review precheck, also used to report slots already charged to the durable ledger. */
export const precheckSlots = (stateDir: string, check: MachineCheck, now: number, kind: LaunchSlot["kind"] = "author", key?: string) =>
  inspect(stateDir, check, now, kind, key);

/** Atomically claims room immediately before launch; a successful entry stays until its pane is observed. */
export const claimSlot = (stateDir: string, check: MachineCheck, key: string, kind: LaunchSlot["kind"], now: number): LaunchVerdict =>
  inspect(stateDir, check, now, kind, key, true).verdict;

/** Releases a failed launch's claim under the same ledger lock. */
export const releaseSlot = (stateDir: string, key: string): void =>
  withStateLockSync(join(stateDir, "launch-slots.lock.sqlite"), () => {
    const before = readSlots(stateDir), slots = before.filter((s) => s.key !== key);
    if (slots.length !== before.length) saveJsonFile(join(stateDir, "launch-slots.json"), { slots });
  });
