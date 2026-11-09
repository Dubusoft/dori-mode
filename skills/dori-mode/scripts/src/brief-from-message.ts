import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { completeLines, EVENT_LOG, parseLogLine } from "./inbox.ts";
import { EDIT_NOTE, splitChannelName } from "./messenger/discord-inbound.ts";

/**
 * `dori launch --from-message <channel> <messageId> ... [--note TEXT ...]`: the lane brief assembled mechanically from
 * the owner's own Discord messages as the supervisor delivered them (lead-events.log), so the lead need not restate them.
 */

export class BriefFromMessageError extends Error {}

export type MessageRef = { readonly channel: string; readonly message: string };

const SNOWFLAKE = /^\d+$/;

/**
 * The launch's `--from-message <channel> <messageId>` pairs and `--note TEXT` values (also `--note=TEXT`), in the
 * given order. The shared flag parser keeps one string per flag and one value per flag, so these are read from the raw
 * arguments.
 */
export const launchBriefArgs = (args: readonly string[]): { readonly refs: MessageRef[]; readonly notes: string[] } => {
  const refs: MessageRef[] = [];
  const notes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    if (arg === "--from-message") {
      const channel = args[i + 1];
      const message = args[i + 2];
      if (channel === undefined || message === undefined || !SNOWFLAKE.test(channel) || !SNOWFLAKE.test(message)) {
        throw new BriefFromMessageError("--from-message takes two values: <channel> <messageId> (Discord ids, digits only)");
      }
      refs.push({ channel, message });
      i += 2;
    } else if (arg === "--note") {
      const text = args[i + 1];
      if (text === undefined) throw new BriefFromMessageError("--note needs a TEXT value");
      notes.push(text);
      i += 1;
    } else if (arg.startsWith("--note=")) notes.push(arg.slice("--note=".length));
    else if (arg.startsWith("--from-message=")) throw new BriefFromMessageError("--from-message takes two values: <channel> <messageId> (Discord ids, digits only)");
  }
  return { refs, notes };
};

const OWNER_KIND = /^(INBOUND|INBOUND_EDIT|INBOUND_DELETE|VISITOR) (\d+) (\d+)(?: (.*))?$/s;

/** `<author> <text>` of an INBOUND line (author is a Discord username, one token) to `<text>`. */
const afterAuthor = (rest: string): string => rest.replace(/^\S+ ?/, "");

/**
 * The owner's text of message `ref` from the local delivery log: the latest INBOUND_EDIT when there is one (by edit
 * timestamp), else the latest INBOUND (a recovered-content revision supersedes the placeholder). Refuses a deleted
 * message, a visitor's message and an id the log does not have.
 */
export const ownerMessageText = (stateDir: string, ref: MessageRef): string => {
  const label = `message ${ref.message} in channel ${ref.channel}`;
  let original: string | undefined;
  let edit: { readonly at: string; readonly text: string } | undefined;
  let deleted = false;
  let visitor = false;
  for (const { text } of completeLines(join(stateDir, EVENT_LOG), 0)) {
    const event = parseLogLine(text);
    const m = OWNER_KIND.exec(event.line);
    if (!m || m[2] !== ref.channel || m[3] !== ref.message || !event.id.startsWith(`discord:${ref.channel}:${ref.message}`)) continue;
    // The trailing channel name token is the supervisor's, not the owner's text.
    const rest = splitChannelName(m[4] ?? "").text;
    if (m[1] === "VISITOR") visitor = true;
    else if (m[1] === "INBOUND_DELETE") deleted = true;
    else if (m[1] === "INBOUND") original = afterAuthor(rest);
    else {
      const note = rest.indexOf(EDIT_NOTE);
      const body = note < 0 ? afterAuthor(rest) : rest.slice(note + EDIT_NOTE.length).trimStart();
      const at = event.id.split(":edit:")[1] ?? "";
      if (!edit || at >= edit.at) edit = { at, text: body };
    }
  }
  if (deleted) throw new BriefFromMessageError(`${label} was deleted by the owner (INBOUND_DELETE); not launching from it`);
  const text = edit?.text ?? original;
  if (text === undefined) {
    if (visitor) throw new BriefFromMessageError(`${label} is a VISITOR message, not the owner's; only owner messages can make a brief`);
    throw new BriefFromMessageError(`${label} is not in the local inbox (${join(stateDir, EVENT_LOG)}); pass an owner message the supervisor delivered`);
  }
  return text.trim();
};

/** The brief: `# <title>`, `## Owner request` with the texts in order, then `## Lead notes` bullets when there are notes. */
export const assembleBrief = (title: string, texts: readonly string[], notes: readonly string[]): string => [
  `# ${title}`,
  "",
  "## Owner request",
  "",
  ...texts.flatMap((text) => [text, ""]),
  ...(notes.length ? ["## Lead notes", "", ...notes.map((note) => `- ${note.replace(/\s*\n\s*/g, " ").trim()}`), ""] : []),
].join("\n");

/** Where a lane's generated brief lives: stateDir/briefs/<key>.md. Never contains '?' (mass-ulw would not bind). */
export const generatedBriefPath = (stateDir: string, key: string): string => {
  const path = join(stateDir, "briefs", `${key}.md`);
  if (path.includes("?")) throw new BriefFromMessageError(`the generated brief path ${path} contains '?'; move the state directory or pass --brief FILE`);
  return path;
};

/** Writes the assembled brief to `path` (creating stateDir/briefs). */
export const writeGeneratedBrief = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
};
