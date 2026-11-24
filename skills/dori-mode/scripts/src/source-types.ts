import type { EventMeta } from "./supervise-journal.ts";

/*
 * What event-sources.ts and schedule.ts share. Both import this module and it imports neither, so loading either of
 * them first works (they used to import each other, and loading schedule.ts first failed on SCHEDULE_FAILED).
 * event-sources.ts re-exports all of it.
 */

export const SOURCE_TYPES = ["poll", "webhook", "file", "schedule"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export class SourceError extends Error {}

export const TEXT_MAX = 500;

/** One line: whitespace collapsed, clipped to TEXT_MAX. */
export const sourceText = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}~` : flat;
};

export type SourceStatus = {
  readonly type: "builtin" | SourceType;
  /** New events journaled, and events dropped as duplicates of an id the store already had. */
  readonly events: number;
  readonly duplicates: number;
  readonly lastEventAt?: number;
  /** The policy kind of the last new event (never its text: dori status is posted to Discord). */
  readonly lastKind?: string;
  readonly failing?: true;
  readonly lastError?: string;
  readonly lastErrorAt?: number;
  /** Webhook requests refused for a missing or wrong secret. */
  readonly rejected?: number;
  /** A file source's read position. */
  readonly cursor?: { readonly path: string; readonly offset: number };
  /** A schedule's newest planned slot, when its last run settled, how it ended, and what a due run waits for. */
  readonly lastSlot?: number;
  readonly lastRunAt?: number;
  readonly lastResult?: string;
  readonly waiting?: string;
};

export type SourceEnqueue = (id: string, line: string, meta?: EventMeta) => boolean;
