/** A thrown value as text: an Error's message, anything else as String() renders it. */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whitespace runs collapsed to one space and trimmed, then clipped to `max` characters when given. */
export const oneLine = (text: string, max?: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return max === undefined ? flat : flat.slice(0, max);
};

/** A thrown value as one line of at most `max` characters, for a log or status line. */
export const errLine = (e: unknown, max = 200): string => oneLine(errText(e), max);
