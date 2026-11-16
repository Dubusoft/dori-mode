import { createHash } from "node:crypto";

import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { splitDiscordMessage } from "./discord-split.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

/** Message flag that posts without a push or desktop notification (Discord's SUPPRESS_NOTIFICATIONS). */
export const DISCORD_SUPPRESS_NOTIFICATIONS = 1 << 12;
/** Most messages one `GET /channels/{id}/messages` returns. */
export const DISCORD_MESSAGES_PAGE = 100;

/**
 * A message as `Discord.messagesAfter` reads it: its id, Discord message type (0 is a plain message), author, text, and the
 * channel its message reference names (a THREAD_CREATED notice names its thread).
 */
export type DiscordMessage = { readonly id: string; readonly type: number; readonly authorId: string; readonly content: string; readonly reference?: string };

/** How `Discord.startThread` left the owner: joined by the add, already a member, not configured, or the add's error. */
export type ThreadMember = "added" | "already" | "skipped" | { readonly failed: string };

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Record<string, unknown>): Promise<T> {
    // withBackoff adds a per-call nonce; preserve an explicit send identity at the HTTP boundary instead.
    const http: Http = body?.nonce === undefined ? this.http : (req) => this.http({ ...req, body: JSON.stringify(body) });
    const res = await withBackoff(http, this.clock, { method, url: `${this.base}${path}`, headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, undefined, retryAfter);
    if (res.status >= 300) throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  /**
   * Ordered chunks; returns the first id. Retries reuse nonces within Discord's few-minute dedupe window.
   * Without a stable id, identical content in the same channel is treated as a retry; use distinct ids for repeats.
   */
  async send(channelId: string, content: string, stableId?: string, components?: readonly unknown[], flags?: number): Promise<string> {
    let first: string | undefined;
    const chunks = splitDiscordMessage(guardText(content));
    for (const [index, chunk] of chunks.entries()) {
      const nonce = createHash("sha256").update(JSON.stringify([channelId, stableId ?? content, index])).digest("hex").slice(0, 25);
      // Components (buttons) ride on the last chunk, under the whole text.
      const extra = components && index === chunks.length - 1 ? { components } : {};
      const id = (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, { content: chunk, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true, ...extra, ...(flags ? { flags } : {}) })).id;
      first ??= id;
    }
    return first ?? "";
  }

  /**
   * Posts through a channel webhook under another name and avatar (Discord lets no bot post as a person). The text goes
   * through guardText like every bot post; the webhook URL holds its token, so it never appears in an error.
   */
  async executeWebhook(webhookUrl: string, content: string, identity: { readonly username: string; readonly avatarUrl?: string }): Promise<string> {
    if (!/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(webhookUrl)) throw new MessengerError("discord webhook: not a Discord webhook URL", 0);
    const body = JSON.stringify({
      content: guardText(content), username: identity.username.slice(0, 80), allowed_mentions: { parse: [] },
      ...(identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}),
    });
    const res = await withBackoff(this.http, this.clock, { method: "POST", url: `${webhookUrl}?wait=true`, headers: { "Content-Type": "application/json" }, body }, undefined, retryAfter);
    if (res.status >= 300) throw new MessengerError(`discord webhook POST: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    const id = (JSON.parse(res.body) as { id?: unknown }).id;
    if (typeof id !== "string") throw new MessengerError("discord webhook POST: no message id", res.status);
    return id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(content) });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.call("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** Up to DISCORD_MESSAGES_PAGE messages posted in `channelId` after message `afterId`, as Discord returns them. */
  async messagesAfter(channelId: string, afterId: string): Promise<DiscordMessage[]> {
    const raw = await this.call<readonly { id?: unknown; type?: unknown; content?: unknown; author?: { id?: unknown }; message_reference?: { channel_id?: unknown } }[]>("GET", `/channels/${channelId}/messages?after=${afterId}&limit=${DISCORD_MESSAGES_PAGE}`);
    return raw.map((m) => ({
      id: String(m.id), type: typeof m.type === "number" ? m.type : -1,
      authorId: typeof m.author?.id === "string" ? m.author.id : "", content: typeof m.content === "string" ? m.content : "",
      ...(typeof m.message_reference?.channel_id === "string" ? { reference: m.message_reference.channel_id } : {}),
    }));
  }

  private self: Promise<string> | undefined;

  /** The bot's own user id (GET /users/@me), read once per client; a failed read is retried on the next call. */
  selfId(): Promise<string> {
    this.self ??= this.call<{ id?: unknown }>("GET", "/users/@me").then((me) => {
      if (typeof me.id !== "string") throw new Error("discord /users/@me: no id");
      return me.id;
    }).catch((e: unknown) => { this.self = undefined; throw e; });
    return this.self;
  }

  /** A message's current text. */
  async content(channelId: string, messageId: string): Promise<string> {
    const content = (await this.call<{ content?: unknown }>("GET", `/channels/${channelId}/messages/${messageId}`)).content;
    return typeof content === "string" ? content : "";
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  /**
   * Starts a thread on `messageId`, or a standalone public thread in `channelId` when it is undefined, then makes `memberId`
   * (the owner) a thread member so the thread shows up in their list. When the starter message mentions them, Discord has
   * already joined them as the thread starts: that reads back as "already", and Discord shows no "added" line for it.
   * A failed add never fails the thread; it comes back as `failed` for the caller to surface. A non-numeric or absent id
   * is "skipped". `autoArchiveMin` sets how long the thread stays open without activity (Discord's default when absent).
   */
  async startThread(channelId: string, messageId: string | undefined, name: string, memberId?: string, autoArchiveMin?: 60 | 1440 | 4320 | 10080): Promise<{ readonly id: string; readonly member: ThreadMember }> {
    const title = guardText(name).slice(0, 100);
    const archive = autoArchiveMin ? { auto_archive_duration: autoArchiveMin } : {};
    const id = (messageId
      ? await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, { name: title, ...archive })
      : await this.call<{ id: string }>("POST", `/channels/${channelId}/threads`, { name: title, type: 11, ...archive })).id;
    if (memberId === undefined || !/^\d+$/.test(memberId)) return { id, member: "skipped" };
    try {
      try {
        await this.call("GET", `/channels/${id}/thread-members/${memberId}`);
        return { id, member: "already" };
      } catch (e) {
        if (!(e instanceof MessengerError) || e.status !== 404) throw e;
      }
      await this.call("PUT", `/channels/${id}/thread-members/${memberId}`);
      return { id, member: "added" };
    } catch (e) {
      return { id, member: { failed: e instanceof Error ? e.message : String(e) } };
    }
  }

  async setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void> {
    await this.call("PATCH", `/channels/${threadId}`, { ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
  }

  /** Reads a thread back: whether Discord reports it archived. A channel that is not a thread is an error. */
  async threadArchived(threadId: string): Promise<boolean> {
    return (await this.threadState(threadId)).archived;
  }

  /**
   * Reads a thread back: whether it is archived, its parent channel (undefined when Discord names none) and the id of its
   * last message (`last_message_id`, which may name a deleted message; undefined when Discord gives none). A channel that
   * is not a thread is an error.
   */
  async threadState(threadId: string): Promise<{ readonly archived: boolean; readonly parent: string | undefined; readonly lastMessageId?: string | undefined }> {
    const channel = await this.call<{ thread_metadata?: { archived?: unknown }; parent_id?: unknown; last_message_id?: unknown }>("GET", `/channels/${threadId}`);
    const archived = channel.thread_metadata?.archived;
    if (typeof archived !== "boolean") throw new Error(`discord channel ${threadId} is not a thread`);
    return {
      archived, parent: typeof channel.parent_id === "string" && channel.parent_id ? channel.parent_id : undefined,
      lastMessageId: typeof channel.last_message_id === "string" && channel.last_message_id ? channel.last_message_id : undefined,
    };
  }
}
