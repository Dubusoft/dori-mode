/**
 * The event policy table (design 1.7): every event kind is delivered by class. `lead-urgent` wakes the lead,
 * `lead-digest` waits for the next urgent delivery (or `digestMaxDelayMin`), `engine-only` is journaled for the engine and
 * the counts only. The supervisor never posts an event to the owner itself: everything the owner hears goes through the lead.
 * The removed `owner-only` class still loads from an old config, as `lead-digest`, with one warning per process.
 *
 * A kind is the event line's first word, optionally followed by more words that must match the line's next words in
 * order; `*` matches any one word. `HOST_GUARD ALERT` matches `HOST_GUARD ALERT load 40`, `GH_PR * merged` matches
 * `GH_PR acme/app#7 merged ...`. The most specific matching kind wins (more words, then fewer `*`); a line no kind
 * matches gets `default`. Kinds are open-ended: a new event source needs only a config entry, or none at all.
 */
export const EVENT_CLASSES = ["lead-urgent", "lead-digest", "engine-only"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export type EventPolicy = {
  /** The class of a line no kind matches. */
  readonly default: EventClass;
  readonly kinds: Readonly<Record<string, EventClass>>;
};

const URGENT_KINDS = [
  "INBOUND", "INBOUND_EDIT", "INBOUND_DELETE", "VISITOR", "LANE_NOT_DONE", "LANE_REPORT",
  // A lane waiting on its agent's on-screen question instead of dori report (ask-user.ts).
  "LANE_ASKING",
  "DEAD_PANE", "UNRECOGNISED_PANE", "NO-REPORT", "NO-PROGRESS",
  "HOST_GUARD ALERT", "HOST_GUARD CLEAR", "HOST_GUARD OFFLINE", "HOST_GUARD OUTDATED", "LAUNCH_READY", "WORKING-WHILE-PAUSED",
  // The supervisor killed or paused something because memory ran critically low; the lead relays it to the owner.
  "HOST_GUARD CRITICAL",
  "WAIT_DONE", "WAIT_TIMEOUT", "SUPERVISOR_STUCK", "UNHANDLED", "UNREPORTED", "UNRESOLVED",
  "LANE_RECOVERY_EXHAUSTED",
  // The restart cap refused to restart a lead that does not take its events (supervise-lead-lifecycle.ts capRefuses).
  "LEAD_UNRESPONSIVE",
  "WAIT_FAILED", "WAITS_CORRUPT",
  "TASK_STALLED", "OPERATION_AMBIGUOUS", "OPERATION_FAILED",
  // CI follow-up: a lane that did not confirm its message in time, and a conflict no merge lane could take.
  "LANE_MESSAGE_UNCONFIRMED", "CI_CONFLICT",
  // A merged lane PR whose merge the supervisor could not read back.
  "MERGE_UNVERIFIED",
  // A lane's done claim wakes the lead when the lane finishes; its window then starts at that delivery (done-flow.ts).
  "LANE_DONE_CLAIMED",
  // A lane that ended is news the lead acts on: report to the owner, free the slot.
  "LANE_CLOSED", "LANE_AUTO_CLOSED", "CI_MERGED",
  // A report from a closed or unregistered lane: question, blocked and done still need the lead; the rest is digest.
  "LANE_REPORT_LATE * question", "LANE_REPORT_LATE * blocked", "LANE_REPORT_LATE * done",
  "GH_PR * closed", "GH_PR * review", "GH_PR * comment",
  "GH_ISSUE * opened", "GH_ISSUE * reopened",
] as const;

/**
 * Kinds that stay digest whatever `default` says. The lane hears about its PR first (CI follow-up messages it and merges
 * or opens a merge lane), and a lane's milestone and progress reports wait for the next urgent delivery. The supervisor
 * settles the rest itself: a done claim (urgent LANE_DONE_CLAIMED) is re-checked live (then closed, or objected to,
 * LANE_NOT_DONE, which is urgent), and a merged lane PR has its merge read back (MERGE_VERIFIED, or urgent MERGE_UNVERIFIED).
 * A close whose LANE_DONE_CLAIMED the lead already received (`LANE_CLOSED <key> closed seen-claim`) is digest: the lead
 * heard of the claim, and the close only confirms it. A close of an undelivered claim stays urgent.
 */
const DIGEST_KINDS = [
  "GH_PR * checks_failing", "GH_PR * conflicting", "GH_PR * merged", "LANE_REPORT * milestone", "LANE_REPORT * progress",
  "LANE_REPORT_LATE * milestone", "LANE_REPORT_LATE * progress",
  "MERGE_VERIFIED", "LANE_CLOSED * closed seen-claim",
  // A worker machine without the guard agent, one whose shell cannot run it, or one whose agent is current again,
  // needs no action now.
  "HOST_GUARD NOT_INSTALLED", "HOST_GUARD UNSUPPORTED", "HOST_GUARD CURRENT",
] as const;

/** Kept only for old journals: LANE_FINISH_NOTICE events of the removed lane-finish line must never reach the lead. */
const ENGINE_KINDS = ["LANE_FINISH_NOTICE"] as const;

/** The actionable kinds wake the lead, every other line is digest. */
export const DEFAULT_EVENT_POLICY: EventPolicy = {
  default: "lead-digest",
  kinds: Object.fromEntries([
    ...URGENT_KINDS.map((kind) => [kind, "lead-urgent"]), ...DIGEST_KINDS.map((kind) => [kind, "lead-digest"]),
    ...ENGINE_KINDS.map((kind) => [kind, "engine-only"]),
  ]),
};

/** Owner tracking reads these from the lead's journal: they may only be lead classes. */
const LEAD_ONLY_KINDS = ["INBOUND", "INBOUND_EDIT", "INBOUND_DELETE"];

export class EventPolicyError extends Error {}

const isClass = (value: unknown): value is EventClass => typeof value === "string" && (EVENT_CLASSES as readonly string[]).includes(value);

/** The removed class an old config may still name; it now means `lead-digest`. */
const REMOVED_OWNER_ONLY = "owner-only";
let warnedOwnerOnly = false;

/**
 * The policy from a config's `eventPolicy` (absent: the default). Its `kinds` are laid over the default table, so a
 * config names only the kinds it changes. Throws EventPolicyError on a value that is not a class or a malformed kind.
 */
export const resolveEventPolicy = (raw: unknown): EventPolicy => {
  if (raw === undefined) return DEFAULT_EVENT_POLICY;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new EventPolicyError("eventPolicy must be an object");
  const { default: rawFallback, kinds } = raw as { default?: unknown; kinds?: unknown };
  const ownerOnly: string[] = [];
  const compat = (name: string, value: unknown): unknown => {
    if (value !== REMOVED_OWNER_ONLY) return value;
    ownerOnly.push(name);
    return "lead-digest";
  };
  const fallback = compat("default", rawFallback);
  if (fallback !== undefined && !isClass(fallback)) throw new EventPolicyError(`eventPolicy.default must be one of ${EVENT_CLASSES.join(", ")}`);
  if (kinds !== undefined && (typeof kinds !== "object" || kinds === null || Array.isArray(kinds))) throw new EventPolicyError("eventPolicy.kinds must be an object");
  const merged: Record<string, EventClass> = { ...DEFAULT_EVENT_POLICY.kinds };
  for (const [kind, rawValue] of Object.entries(kinds ?? {})) {
    const value = compat(kind, rawValue);
    if (!isClass(value)) throw new EventPolicyError(`eventPolicy.kinds["${kind}"] must be one of ${EVENT_CLASSES.join(", ")}`);
    const words = kind.split(" ");
    if (!kind || words.some((word) => !word) || words[0] === "*") throw new EventPolicyError(`eventPolicy.kinds["${kind}"]: a kind is words separated by single spaces, starting with the event name`);
    if (LEAD_ONLY_KINDS.includes(words[0] as string) && !value.startsWith("lead-")) {
      throw new EventPolicyError(`eventPolicy.kinds["${kind}"]: owner messages must reach the lead (lead-urgent or lead-digest)`);
    }
    merged[kind] = value;
  }
  if (ownerOnly.length && !warnedOwnerOnly) {
    warnedOwnerOnly = true;
    console.error(`EVENT_POLICY_OWNER_ONLY_REMOVED ${ownerOnly.join(", ")}: the owner-only class was removed (the supervisor no longer posts events to the owner); treated as lead-digest`);
  }
  return { default: fallback ?? DEFAULT_EVENT_POLICY.default, kinds: merged };
};

type Entry = { readonly kind: string; readonly words: readonly string[]; readonly cls: EventClass };
const compiled = new WeakMap<EventPolicy, Map<string, readonly Entry[]>>();

/** Kinds by first word, most specific first. */
const index = (policy: EventPolicy): Map<string, readonly Entry[]> => {
  const hit = compiled.get(policy);
  if (hit) return hit;
  const map = new Map<string, Entry[]>();
  for (const [kind, cls] of Object.entries(policy.kinds)) {
    const words = kind.split(" ");
    const list = map.get(words[0] as string) ?? [];
    list.push({ kind, words, cls });
    map.set(words[0] as string, list);
  }
  const wild = (e: Entry) => e.words.filter((w) => w === "*").length;
  for (const list of map.values()) list.sort((a, b) => b.words.length - a.words.length || wild(a) - wild(b) || a.kind.localeCompare(b.kind));
  compiled.set(policy, map);
  return map;
};

const match = (line: string, policy: EventPolicy): Entry | undefined => {
  const words = line.split(" ");
  return index(policy).get(words[0] as string)?.find((e) => e.words.every((w, i) => i < words.length && (w === "*" || w === words[i])));
};

/** The kind a line counts under: the matching table entry, else its first word. */
export const eventKind = (line: string, policy: EventPolicy = DEFAULT_EVENT_POLICY): string =>
  match(line, policy)?.kind ?? (line.split(" ", 1)[0] || "(empty)");

export const eventClass = (line: string, policy: EventPolicy = DEFAULT_EVENT_POLICY): EventClass => match(line, policy)?.cls ?? policy.default;

/** Lead classes are journaled for the lead; engine-only never reaches it. */
export const forLead = (cls: EventClass): boolean => cls === "lead-urgent" || cls === "lead-digest";
