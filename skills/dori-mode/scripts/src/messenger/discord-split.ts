export const DISCORD_MESSAGE_LIMIT = 2000;

const FENCE = /^\s*(```+|~~~+)/;

/** The fence opener still open at the end of `text` (starting with `open`), or undefined when balanced. */
const openFence = (text: string, open: string | undefined): string | undefined => {
  let current = open;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (!marker) continue;
    if (current === undefined) current = line.trim();
    else if (marker.startsWith(current.slice(0, 3))) current = undefined;
  }
  return current;
};

/** A literal backslash-n (or backslash-r-backslash-n) that is not itself escaped. */
const LITERAL_NEWLINE = /(?<!\\)(?:\\r)?\\n/g;
/** An inline code span of one or two backticks on a single line; triple backticks are fences, handled per line. */
const INLINE_CODE = /(`{1,2})(?!`)[^`]*?(?<!`)\1(?!`)/g;

/**
 * `text` with each literal backslash-n typed as two characters (a shell string such as `--text "a\nb"`) turned into a
 * real line break, so it reads as one in Discord. Fenced code blocks and inline code spans keep their text as written.
 */
export const realNewlines = (text: string): string => {
  if (!text.includes("\\n")) return text;
  const prose = (part: string) => part.replace(LITERAL_NEWLINE, "\n");
  const outsideCode = (line: string) => {
    let out = "";
    let last = 0;
    for (const span of line.matchAll(INLINE_CODE)) {
      out += prose(line.slice(last, span.index)) + span[0];
      last = span.index + span[0].length;
    }
    return out + prose(line.slice(last));
  };
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker?.startsWith(fence.slice(0, 3))) fence = undefined;
      return line;
    }
    if (marker && !line.includes("\\n")) { fence = marker; return line; }
    return outsideCode(line);
  }).join("\n");
};

/**
 * Ordered chunks of at most `limit` characters, cut at the last newline, else the last space, else hard. A code fence
 * left open by a cut is closed at the end of its chunk and reopened (with its language) at the start of the next.
 */
export const splitDiscordMessage = (text: string, limit = DISCORD_MESSAGE_LIMIT): string[] => {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  let fence: string | undefined;
  for (;;) {
    const prefix = fence === undefined ? "" : `${fence}\n`;
    if (prefix.length + rest.length <= limit) { chunks.push(prefix + rest); return chunks; }
    // Always leave room for a closing "\n```" so the chunk stays within the limit if a fence is open at the cut.
    const budget = Math.max(1, limit - prefix.length - 4);
    const window = rest.slice(0, budget + 1);
    let cut = window.lastIndexOf("\n", budget);
    let skip = 1;
    if (cut <= 0) { cut = window.lastIndexOf(" ", budget); }
    if (cut <= 0) {
      cut = budget;
      skip = 0;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut--;
    }
    const piece = rest.slice(0, cut);
    rest = rest.slice(cut + skip);
    const after = openFence(piece, fence);
    chunks.push(prefix + piece + (after === undefined ? "" : "\n```"));
    fence = after;
  }
};
