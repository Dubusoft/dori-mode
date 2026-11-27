import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { GuardThresholds } from "./config.ts";
import type { HostSample } from "./host-guard.ts";
import { withStateLockSync } from "./state-lock.ts";
import { replaceFileDurable } from "./durable-write.ts";

export type LaunchVerdict = { readonly ok: boolean; readonly reasons: readonly string[] };

export const canLaunch = (s: HostSample, t: GuardThresholds): LaunchVerdict => {
  const reasons: string[] = [];
  if (s.memFreePct < t.memFreeMinPct) reasons.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) reasons.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes >= t.panesMax) reasons.push(`panes ${s.panes} >= ${t.panesMax}`);
  return { ok: reasons.length === 0, reasons };
};

const holdFile = (stateDir: string): string => join(stateDir, "launch-hold.json");

/** A launch that `dori launch` answered HOLD for; it waits in launch-hold.json until it launches or is dropped. */
export type QueuedLaunch = {
  /** Internal review launch, preserved while it waits for room. */
  readonly review?: true;
  readonly key: string;
  readonly title: string;
  readonly done: string;
  readonly brief: string;
  readonly cwd?: string;
  /** owner/repo names from the Done line's merged/closed signals. */
  readonly repos?: readonly string[];
  readonly thread?: string;
  readonly model?: string;
  /** `mass-ulw` when launched with that mode; absent means `ulw`. */
  readonly mode?: "mass-ulw";
  /** The launch's `--task` (Toodo task id). */
  readonly task?: number;
  readonly machine?: string;
  /** The launch's `--grant` names. */
  readonly grants?: readonly string[];
  readonly queuedAt: string;
  readonly reasons: readonly string[];
};

/** `blocked` false keeps the queue after LAUNCH_READY; a file without `blocked` (older versions) counts as held. */
type HoldFlag = { readonly blocked?: boolean; readonly at?: number; readonly reasons?: readonly string[] };
/** The top-level flag is the local host's; `machines` holds one flag per remote label. */
type HoldState = HoldFlag & { readonly revision?: string; readonly machines?: Readonly<Record<string, HoldFlag & { readonly blocked: boolean }>>; readonly queue?: readonly QueuedLaunch[] };

const LOCAL = "local";
const remoteLabel = (machine?: string): string | undefined => machine === undefined || machine === LOCAL ? undefined : machine;

const flagOf = (hold: HoldState | undefined, machine?: string): HoldFlag | undefined => {
  const label = remoteLabel(machine);
  return label === undefined ? hold : hold?.machines?.[label];
};

const withFlag = (hold: HoldState | undefined, machine: string | undefined, flag: HoldFlag & { readonly blocked: boolean }): HoldState => {
  const label = remoteLabel(machine);
  if (label === undefined) return { ...hold, ...flag };
  const base = hold ?? { blocked: false };
  return { ...base, machines: { ...base.machines, [label]: { ...base.machines?.[label], ...flag } } };
};

type Kind = "string" | "strings" | "boolean" | "finite" | "posint" | "mass-ulw";
const KINDS: Record<Kind, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  strings: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  boolean: (v) => typeof v === "boolean",
  finite: (v) => typeof v === "number" && Number.isFinite(v),
  posint: (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
  "mass-ulw": (v) => v === "mass-ulw",
};
/** Field table: kind and whether the key must be present. A present key must match its kind. */
type Fields = Readonly<Record<string, readonly [Kind, boolean]>>;
const conforms = (value: unknown, fields: Fields): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.entries(fields).every(([key, [kind, required]]) => key in value ? KINDS[kind]((value as Record<string, unknown>)[key]) : !required);

const FLAG_FIELDS: Fields = { blocked: ["boolean", false], at: ["finite", false], reasons: ["strings", false] };
const MACHINE_FLAG_FIELDS: Fields = { ...FLAG_FIELDS, blocked: ["boolean", true] };
const LAUNCH_FIELDS: Fields = {
  key: ["string", true], title: ["string", true], done: ["string", true], brief: ["string", true],
  cwd: ["string", false], repos: ["strings", false], thread: ["string", false], model: ["string", false], mode: ["mass-ulw", false],
  task: ["posint", false], machine: ["string", false], grants: ["strings", false],
  queuedAt: ["string", true], reasons: ["strings", true],
};

const lockedHold = <T>(stateDir: string, act: () => T): T =>
  withStateLockSync(join(stateDir, "launch-hold.lock.sqlite"), act);

// clearLaunchHold acknowledges the exact HOLD a supervisor observed before its asynchronous LAUNCH_READY emission.
const observedHolds = new Map<string, string>();
const observedKey = (stateDir: string, machine?: string): string => `${stateDir}\0${remoteLabel(machine) ?? LOCAL}`;
const holdRevision = (hold: HoldState): string => hold.revision ?? JSON.stringify(hold);

const validLaunch = (value: unknown): value is QueuedLaunch => conforms(value, LAUNCH_FIELDS);

const readHold = (stateDir: string): HoldState | undefined => {
  const path = holdFile(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!conforms(raw, FLAG_FIELDS) ||
        ("machines" in raw && (typeof raw.machines !== "object" || raw.machines === null || Array.isArray(raw.machines) || !Object.values(raw.machines).every((flag) => conforms(flag, MACHINE_FLAG_FIELDS)))) ||
        ("queue" in raw && !Array.isArray(raw.queue))) throw new Error("invalid launch hold state");
    const entries = "queue" in raw ? raw.queue as unknown[] : undefined;
    const queue = entries?.filter(validLaunch);
    if (entries && queue!.length !== entries.length) console.error(`LAUNCH_HOLD_INVALID_ENTRY dropped invalid queue entries from ${path}`);
    return { ...raw, ...(queue === undefined ? {} : { queue }) } as HoldState;
  } catch (e) {
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); } catch (r) { if ((r as NodeJS.ErrnoException).code !== "ENOENT") throw r; }
    console.error(`LAUNCH_HOLD_CORRUPT moved ${path} to ${aside}: ${e instanceof Error ? e.message : String(e)}; continuing blocked with an empty queue`);
    const safeState: HoldState = { blocked: true, reasons: ["launch-hold.json corrupt"], queue: [] };
    return writeHold(stateDir, safeState);
  }
};

const writeHold = (stateDir: string, state: HoldState): HoldState => {
  mkdirSync(stateDir, { recursive: true });
  const next = { ...state, revision: randomUUID() };
  replaceFileDurable(holdFile(stateDir), JSON.stringify(next, null, 1), 0o600);
  return next;
};

/**
 * `dori can-launch` and `dori launch` raise the blocked flag while their answer is HOLD, so the supervisor knows work is
 * waiting on the host and can wake the lead (LAUNCH_READY) the moment there is room again. CAN_LAUNCH lowers it.
 * The queued launches are kept either way.
 */
export const recordLaunchVerdict = (stateDir: string, verdict: LaunchVerdict, at: number, machine?: string): void => {
  lockedHold(stateDir, () => {
    const hold = readHold(stateDir);
    if (verdict.ok) {
      if (flagOf(hold, machine)) writeHold(stateDir, withFlag(hold, machine, { blocked: false }));
    } else writeHold(stateDir, withFlag(hold, machine, { blocked: true, at, reasons: verdict.reasons }));
  });
};

/** True while `machine` (default: the local host) is blocked; a file without a local `blocked` counts as held. */
export const launchHeld = (stateDir: string, machine?: string): boolean => lockedHold(stateDir, () => {
  const hold = readHold(stateDir);
  const flag = flagOf(hold, machine);
  const held = remoteLabel(machine) === undefined ? !!hold && hold.blocked !== false : flag?.blocked === true;
  if (!hold || !held) { observedHolds.delete(observedKey(stateDir, machine)); return false; }
  observedHolds.set(observedKey(stateDir, machine), holdRevision(hold));
  return true;
});

/** Lowers the blocked flag (LAUNCH_READY fired or CAN_LAUNCH); queued launches stay until they launch or are dropped. */
export const clearLaunchHold = (stateDir: string, machine?: string): void => {
  lockedHold(stateDir, () => {
    const key = observedKey(stateDir, machine);
    const observed = observedHolds.get(key);
    observedHolds.delete(key);
    const hold = readHold(stateDir);
    if (hold && (observed === undefined || observed === holdRevision(hold))) writeHold(stateDir, withFlag(hold, machine, { blocked: false }));
  });
};

/** The queued launches that target `machine` (default: the local host; entries without a machine are local). */
export const queueFor = (queue: readonly QueuedLaunch[], machine?: string): readonly QueuedLaunch[] =>
  queue.filter((q) => remoteLabel(q.machine) === remoteLabel(machine));

export const launchQueue = (stateDir: string): readonly QueuedLaunch[] => lockedHold(stateDir, () => readHold(stateDir)?.queue ?? []);

/** Adds (or refreshes, keeping its first queued-at time) a held launch; returns the whole queue. */
export const enqueueLaunch = (stateDir: string, item: QueuedLaunch): readonly QueuedLaunch[] => lockedHold(stateDir, () => {
  const hold = readHold(stateDir) ?? { blocked: false };
  const old = (hold.queue ?? []).find((q) => q.key === item.key);
  const queue = [...(hold.queue ?? []).filter((q) => q.key !== item.key), { ...item, queuedAt: old?.queuedAt ?? item.queuedAt }];
  writeHold(stateDir, { ...withFlag(hold, item.machine, { blocked: true, at: Date.parse(item.queuedAt), reasons: item.reasons }), queue });
  return queue;
});

/** Removes a queued launch (it launched, or `dori hold drop`); false when it was not queued. */
export const dequeueLaunch = (stateDir: string, key: string): boolean => lockedHold(stateDir, () => {
  const hold = readHold(stateDir);
  if (!hold?.queue?.some((q) => q.key === key)) return false;
  writeHold(stateDir, { ...hold, queue: hold.queue.filter((q) => q.key !== key) });
  return true;
});

/** The queued launches as one line for LAUNCH_READY ("" when none), so a restarted lead loses nothing. */
export const launchQueueText = (queue: readonly QueuedLaunch[]): string =>
  queue.length
    ? `; queued launches (${queue.length}): ${queue.map((q) => [
      q.key,
      ...(q.cwd ? [`cwd=${q.cwd}`] : []),
      ...(q.repos?.length ? [`repo=${q.repos.join(",")}`] : []),
      ...(q.thread && q.thread !== "none" ? [`thread=${q.thread}`] : []),
      ...(q.machine ? [`machine=${q.machine}`] : []),
      ...(q.mode ? [`mode=${q.mode}`] : []),
      ...(q.task !== undefined ? [`task=${q.task}`] : []),
      ...(q.grants?.length ? [`grant=${q.grants.join(",")}`] : []),
      `done=${JSON.stringify(q.done)}`,
      `brief=${q.brief}`,
      `queued ${q.queuedAt}`,
    ].join(" ")).join("; ")} (dori hold list)`
    : "";
