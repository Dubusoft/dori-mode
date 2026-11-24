import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { MachineCheck } from "./placement.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { LaunchVerdict } from "./routing.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";

/** A launch whose pane has not been observed stops occupying admission after ten minutes, whether or not its lane has a pane. */
export const LAUNCH_SLOT_TTL_MS = 10 * 60_000;
/** A launch approved before its pane has appeared in an observation. */
export type LaunchSlot = { readonly key: string; readonly machine: string; readonly at: number };
/** Lanes the pane cap still admits after observed panes and pending launches; Infinity while the cap is off. */
export const admissionSlots = (cap: number, panes: number, pending: number): number =>
  cap <= 0 ? Infinity : Math.max(0, cap - panes - pending);

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

/** Keys of the registry's open lanes on `machine` ("local": lanes without a machine). */
const openLaneKeys = (stateDir: string, machine: string): string[] => {
  const dir = join(stateDir, "lanes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
    const lane = readLane(join(dir, f));
    return lane && statusOf(lane) !== "closed" && (lane.machine ?? "local") === machine ? [lane.key] : [];
  });
};

/**
 * The locked snapshot includes registry reads, pruning, the decision and (for claims) the write. With a lane cap, the
 * machine's open lanes and pending launches (by key, never `key` itself) must stay below it.
 */
const inspect = (stateDir: string, check: MachineCheck, now: number, key?: string, claim = false) =>
  withStateLockSync(join(stateDir, "launch-slots.lock.sqlite"), () => {
    const path = join(stateDir, "launch-slots.json");
    const before = readSlots(stateDir), panes = new Set(check.paneIds);
    const slots = before.filter((slot) => {
      const lane = readLane(join(stateDir, "lanes", `${slot.key}.json`)) ?? readLane(join(stateDir, "lanes-archive", `${slot.key}.json`));
      if (lane && statusOf(lane) === "closed") return false;
      if (slot.machine === check.machine && lane?.pane && panes.has(lane.pane)) return false;
      return now - slot.at <= LAUNCH_SLOT_TTL_MS;
    });
    const pending = slots.filter((s) => s.machine === check.machine && s.key !== key);
    const paneFree = admissionSlots(check.paneCap!, check.paneCount!, pending.length);
    const lanes = check.laneCap === undefined ? 0
      : new Set([...openLaneKeys(stateDir, check.machine), ...pending.map((s) => s.key)].filter((k) => k !== key)).size;
    const free = check.laneCap === undefined ? paneFree : Math.min(paneFree, Math.max(0, check.laneCap - lanes));
    const verdict: LaunchVerdict = !check.verdict.ok ? check.verdict
      : paneFree <= 0 ? { ok: false, reasons: [`launch slots 0 on machine ${check.machine}: ${pending.length} pending launch(es) fill the pane cap ${check.paneCap}`] }
      : free <= 0 ? { ok: false, reasons: [`lanes ${lanes} >= maxLanes ${check.laneCap} on machine ${check.machine}`] }
      : { ok: true, reasons: [] };
    if (claim && key !== undefined && verdict.ok) {
      const previous = slots.findIndex((s) => s.key === key);
      if (previous >= 0) slots.splice(previous, 1);
      slots.push({ key, machine: check.machine, at: now });
    }
    if (JSON.stringify(before) !== JSON.stringify(slots)) saveJsonFile(path, { slots });
    return { verdict, free, reservedKeys: pending.map((s) => s.key) };
  });

/** Non-binding precheck, also used to report slots already charged to the durable ledger. */
export const precheckSlots = (stateDir: string, check: MachineCheck, now: number, key?: string) =>
  inspect(stateDir, check, now, key);

/** Atomically claims room immediately before launch; a successful entry stays until its pane is observed. */
export const claimSlot = (stateDir: string, check: MachineCheck, key: string, now: number): LaunchVerdict =>
  inspect(stateDir, check, now, key, true).verdict;

/** Releases a failed launch's claim under the same ledger lock. */
export const releaseSlot = (stateDir: string, key: string): void =>
  withStateLockSync(join(stateDir, "launch-slots.lock.sqlite"), () => {
    const before = readSlots(stateDir), slots = before.filter((s) => s.key !== key);
    if (slots.length !== before.length) saveJsonFile(join(stateDir, "launch-slots.json"), { slots });
  });
