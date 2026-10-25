import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { discordAttachments, discordSnowflakeAt, type InboundMessage } from "./discord-inbound.ts";
import { type Discord, DISCORD_MESSAGE_LIMIT, splitDiscordMessage } from "./discord.ts";
import type { ToodoApi, ToodoDiscordMirrorConfig } from "./toodo.ts";

/*
 * One conversation in the Toodo chat and one Discord channel (config toodo.discordMirror).
 *
 *   Toodo -> Discord  the owner's Toodo messages through the channel webhook, under the owner's name and avatar; the
 *                     lead's Toodo replies as bot posts. Each post ends with the marker `-# via Toodo #<n>`. Messages
 *                     with an origin (imported from elsewhere) and the server's finish reports are not copied.
 *   Discord -> Toodo  the owner's messages and the bot's own posts in the channel, imported with import_chat_message
 *                     (origin discord, origin id = the Discord message id) as author user and lead. Toodo stores an
 *                     imported owner message as taken, so the lead gets every owner message once: from the side it was
 *                     written on (Discord's INBOUND or Toodo's inbox). Other people's messages are not imported: an
 *                     imported user message counts as the owner's, e.g. as `confirm <code>`.
 *
 * Loops: webhook messages never reach the inbound side (discord-inbound.ts drops webhook_id), the bot's mirrored posts
 * are recognised by their Discord ids and by the marker, and imported messages carry an origin, so they are never
 * copied back. Restarts: the state file keeps the Toodo cursor, a post in flight, the id map and the imports not yet
 * stored. A post in flight when the process died is looked up by its marker in the channel before it is sent again.
 * Edits and deletes are not mirrored (v1); threads under the channel are not part of the mirror.
 */

export const TOODO_MIRROR_FILE = "toodo-mirror.json";
export const TOODO_MIRROR_ORIGIN = "discord";
/** Ids kept in each map; older ones can no longer come back through the REST catch-up or the Toodo cursor. */
export const TOODO_MIRROR_KEEP = 2_000;

export const mirrorMarker = (toodoId: number): string => `-# via Toodo #${toodoId}`;
const MARKER = /(?:^|\n)-# via Toodo #(\d+)$/;
/** The Toodo message id a mirrored post carries in its marker, or undefined. */
export const mirrorMarkerId = (content: string): number | undefined => {
  const m = MARKER.exec(content);
  return m ? Number(m[1]) : undefined;
};

export type MirrorPost = { readonly id: string; readonly content: string; readonly bot: boolean; readonly webhookId?: string };

/** The Discord side of the mirror; tests give a fake. */
export type MirrorDiscord = {
  /** Posts through the channel webhook under the owner's name and avatar; the Discord message id. */
  postAsOwner(content: string): Promise<string>;
  /** Posts as the bot; a stable id keeps a retried post from appearing twice. */
  postAsBot(content: string, stableId: string): Promise<string>;
  /** The channel's latest messages, newest first (to find a post a crash left unrecorded). */
  recent(): Promise<readonly MirrorPost[]>;
};

type PendingImport = { readonly id: string; readonly author: "user" | "lead"; readonly text: string };
type MirrorState = {
  /** Discord messages older than this snowflake (when the mirror was first set up) are history and never imported. */
  since: string;
  /** The last Toodo chat id handled on the way out; absent until the first pass sets it at the newest message. */
  cursor?: number;
  /** A Toodo message whose post started and was not recorded. */
  posting?: number;
  /** Toodo message id -> the Discord ids of its posts. */
  posted: Record<string, string[]>;
  /** Discord messages recorded and not yet stored in Toodo, oldest first. */
  imports: PendingImport[];
  /** Discord message id -> the Toodo message it was stored as. */
  imported: Record<string, number>;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readState = (path: string): MirrorState | undefined => {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw new Error(`unreadable Toodo mirror state ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!record(raw) || typeof raw.since !== "string" || !record(raw.posted) || !Array.isArray(raw.imports) || !record(raw.imported)) {
    throw new Error(`invalid Toodo mirror state ${path}`);
  }
  return raw as MirrorState;
};

const writeState = (stateDir: string, path: string, state: MirrorState): void => {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
};

const trim = <T>(map: Record<string, T>): void => {
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - TOODO_MIRROR_KEEP))) delete map[key];
};

/** `$(` is refused in outbound text to catch messages built through a shell; a person's typed text is data, never that. */
const typed = (text: string): string => text.replaceAll("$(", "$\u200b(");

export type ToodoMirrorDeps = {
  readonly channel: string;
  readonly stateDir: string;
  readonly discord: MirrorDiscord;
  readonly now: () => number;
  /** Asks for a pass soon (a Discord message was recorded for import). */
  readonly wake?: () => void;
  readonly log?: (line: string) => void;
};

export const toodoMirror = (deps: ToodoMirrorDeps) => {
  const log = deps.log ?? console.error;
  const path = join(deps.stateDir, TOODO_MIRROR_FILE);
  const state: MirrorState = readState(path) ?? { since: discordSnowflakeAt(deps.now()), posted: {}, imports: [], imported: {} };
  const save = (): void => {
    trim(state.posted);
    trim(state.imported);
    writeState(deps.stateDir, path, state);
  };
  save();
  const mirroredIds = (): Set<string> => new Set(Object.values(state.posted).flat());

  /** Posts one Toodo message: chunks within Discord's limit, each ending with the marker. */
  const post = async (id: number, author: "user" | "lead", body: string): Promise<string[]> => {
    const marker = mirrorMarker(id);
    const chunks = splitDiscordMessage(typed(body).trim() || "(empty message)", DISCORD_MESSAGE_LIMIT - marker.length - 1);
    const ids: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const content = `${chunk}\n${marker}`;
      ids.push(author === "user" ? await deps.discord.postAsOwner(content) : await deps.discord.postAsBot(content, `toodo-mirror:${id}:${index}`));
    }
    return ids;
  };

  /** A post the last process started and did not record: found by its marker, else sent again by the outbound pass. */
  const settle = async (): Promise<void> => {
    if (state.posting === undefined) return;
    const posting = state.posting;
    const found = (await deps.discord.recent()).filter((m) => (m.bot || m.webhookId !== undefined) && mirrorMarkerId(m.content) === posting).map((m) => m.id);
    if (found.length) {
      state.posted[String(posting)] = found.reverse();
      state.cursor = Math.max(state.cursor ?? 0, posting);
      log(`TOODO_MIRROR_SETTLED ${posting} already posted`);
    }
    state.posting = undefined;
    save();
  };

  const imports = async (toodo: ToodoApi): Promise<void> => {
    while (state.imports.length) {
      const next = state.imports[0];
      if (!next) break;
      if (!mirroredIds().has(next.id) && state.imported[next.id] === undefined) {
        const stored = await toodo.importMessage(next.author, redactSecrets(next.text), TOODO_MIRROR_ORIGIN, next.id);
        state.imported[next.id] = stored.id;
      }
      state.imports.shift();
      save();
    }
  };

  const outbound = async (toodo: ToodoApi): Promise<void> => {
    if (state.cursor === undefined) {
      // The first pass ever: messages from before the mirror was set up are history.
      let after = 0;
      for (;;) {
        const feed = await toodo.listChat(after);
        for (const m of feed.messages) after = Math.max(after, m.id);
        if (!feed.more || !feed.messages.length) break;
      }
      state.cursor = after;
      save();
      return;
    }
    for (;;) {
      const feed = await toodo.listChat(state.cursor);
      for (const m of feed.messages) {
        if (m.id <= state.cursor) continue;
        if (!m.origin && (m.author === "user" || m.author === "lead")) {
          state.posting = m.id;
          save();
          state.posted[String(m.id)] = await post(m.id, m.author, m.body);
          state.posting = undefined;
        }
        state.cursor = m.id;
        save();
      }
      if (!feed.more || !feed.messages.length) break;
    }
  };

  return {
    channel: deps.channel,
    /**
     * Records a Discord message of the mirror channel for import (synchronously durable, before the inbound side emits
     * it and moves its cursor): the owner's as author user, the bot's own as author lead unless it is a mirrored post.
     */
    record(channel: string, m: InboundMessage, author: "user" | "lead"): void {
      if (channel !== deps.channel || m.webhookId !== undefined) return;
      if (BigInt(m.id) < BigInt(state.since)) return;
      if (state.imported[m.id] !== undefined || state.imports.some((p) => p.id === m.id)) return;
      if (author === "lead" && (mirroredIds().has(m.id) || mirrorMarkerId(m.content) !== undefined)) return;
      const text = `${m.content.trim()}${discordAttachments(m.attachments)}`;
      if (!text) return;
      state.imports.push({ id: m.id, author, text });
      save();
      deps.wake?.();
    },
    /** Settles a post a crash left open, stores the recorded Discord messages in Toodo, then copies new Toodo messages out. */
    async pass(toodo: ToodoApi): Promise<void> {
      await settle();
      await imports(toodo);
      await outbound(toodo);
    },
  };
};

export type ToodoMirror = ReturnType<typeof toodoMirror>;

/** The mirror's Discord side over the bot's REST client and the channel webhook. The owner's identity is resolved once. */
export const mirrorDiscord = (discord: Discord, config: ToodoDiscordMirrorConfig, ownerId: string | undefined, readFile = (p: string) => readFileSync(p, "utf8")): MirrorDiscord => {
  let identity: Promise<{ readonly username: string; readonly avatarUrl?: string }> | undefined;
  const owner = () => identity ??= (async () => {
    if (config.ownerName && config.ownerAvatarUrl) return { username: config.ownerName, avatarUrl: config.ownerAvatarUrl };
    let user: Record<string, unknown> = {};
    if (ownerId && /^\d+$/.test(ownerId)) {
      try {
        const raw: unknown = await discord.call("GET", `/users/${ownerId}`);
        if (record(raw)) user = raw;
      } catch {
        // The name and avatar fall back below; a later restart fetches again.
      }
    }
    const name = config.ownerName ?? (typeof user.global_name === "string" && user.global_name ? user.global_name : typeof user.username === "string" ? user.username : "Owner");
    const avatar = config.ownerAvatarUrl ?? (typeof user.avatar === "string" && ownerId ? `https://cdn.discordapp.com/avatars/${ownerId}/${user.avatar}.png` : undefined);
    return { username: name, ...(avatar ? { avatarUrl: avatar } : {}) };
  })();
  return {
    postAsOwner: async (content) => {
      const url = readFile(expandHome(config.webhookUrlFile)).trim();
      return discord.executeWebhook(url, content, await owner());
    },
    postAsBot: (content, stableId) => discord.send(config.channel, content, stableId),
    recent: async () => {
      const raw: unknown = await discord.call("GET", `/channels/${config.channel}/messages?limit=50`);
      if (!Array.isArray(raw)) throw new TypeError("Invalid Discord messages for the Toodo mirror channel");
      return raw.flatMap((m): MirrorPost[] => record(m) && typeof m.id === "string" && typeof m.content === "string" ? [{
        id: m.id, content: m.content, bot: record(m.author) && m.author.bot === true,
        ...(typeof m.webhook_id === "string" ? { webhookId: m.webhook_id } : {}),
      }] : []);
    },
  };
};
