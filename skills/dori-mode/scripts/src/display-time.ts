// How owner-facing system messages show a time: in the config's `displayTimeZone` (an IANA name, default UTC), labelled
// with that zone's abbreviation. Logs, journals, event ids and stored ISO timestamps stay UTC; only rendered text uses this.

/** The zone owner-facing times are shown in when config.json sets none. */
export const DEFAULT_DISPLAY_TIME_ZONE = "UTC";

/** Labels for zones whose `Intl` short name is only an offset ("GMT+9"). */
const LABELS: Readonly<Record<string, string>> = {
  "UTC": "UTC", "Etc/UTC": "UTC", "Asia/Seoul": "KST", "Asia/Tokyo": "JST", "Asia/Shanghai": "CST", "Asia/Kolkata": "IST",
};

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (tz: string): Intl.DateTimeFormat => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    formats.set(tz, f);
  }
  return f;
};

/** True when `tz` is a time zone name `Intl` accepts. */
export const validTimeZone = (tz: string): boolean => {
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
};

/** `tz` when it is a valid zone name, else DEFAULT_DISPLAY_TIME_ZONE. */
export const displayZone = (tz: string | undefined): string => (tz && validTimeZone(tz) ? tz : DEFAULT_DISPLAY_TIME_ZONE);

/**
 * `ms` in `tz` (invalid or absent: UTC) with the zone's label: "2026-11-10 17:46 KST" (`date: "full"`, the default) or
 * "11-10 17:46 KST" (`date: "short"`).
 */
export const displayTime = (ms: number, tz: string | undefined, date: "full" | "short" = "full"): string => {
  const zone = displayZone(tz);
  const parts = Object.fromEntries(format(zone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const day = date === "full" ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.month}-${parts.day}`;
  return `${day} ${parts.hour}:${parts.minute} ${LABELS[zone] ?? parts.timeZoneName}`;
};
