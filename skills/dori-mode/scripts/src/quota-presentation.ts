import { displayTime } from "./display-time.ts";

/** Where a served read came from. */
export type QuotaCacheNote = {
  /** When the endpoints were last called. */
  readonly fetchedAt: number;
  /** This call ran the lookup itself. */
  readonly refreshed: boolean;
  /** Accounts backing off after a 429, with the time their backoff ends. */
  readonly backoff: readonly { readonly name: string; readonly until: number }[];
  /** Accounts served from a read older than the TTL (a 429 fallback, or no lookup during a backoff), with its time. */
  readonly stale: readonly { readonly name: string; readonly at: number }[];
};

export const ageText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Lines saying a read came from the cache, which accounts are stale and which back off after a 429; none for a fresh read. */
export const cacheNoteLines = (note: QuotaCacheNote | undefined, now: number, timeZone?: string): string[] => {
  if (!note) return [];
  return [
    ...(note.refreshed ? [] : [`QUOTA | cached read from ${ageText(now - note.fetchedAt)} ago`]),
    ...note.stale.map((s) => `QUOTA | ${s.name}: stale, last good read ${ageText(now - s.at)} ago`),
    ...note.backoff.map((b) => `QUOTA | ${b.name}: rate-limited (HTTP 429), no usage call until ${displayTime(b.until, timeZone, "short")}`),
  ];
};
