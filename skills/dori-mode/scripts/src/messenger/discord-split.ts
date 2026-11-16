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
