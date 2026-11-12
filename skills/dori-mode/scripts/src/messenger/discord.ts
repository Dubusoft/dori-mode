import { createHash } from "node:crypto";

import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export const DISCORD_MESSAGE_LIMIT = 2000;
/** Message flag that posts without a push or desktop notification (Discord's SUPPRESS_NOTIFICATIONS). */
export const DISCORD_SUPPRESS_NOTIFICATIONS = 1 << 12;
/** Most messages one `GET /channels/{id}/messages` returns. */
export const DISCORD_MESSAGES_PAGE = 100;

/**
 * A message as `Discord.messagesAfter` reads it: its id, Discord message type (0 is a plain message), author, text, and the
 * channel its message reference names (a THREAD_CREATED notice names its thread).
 */
export type DiscordMessage = { readonly id: string; readonly type: number; readonly authorId: string; readonly content: string; readonly reference?: string };
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
      if (await this.isThreadMember(id, memberId)) return { id, member: "already" };
      await this.addThreadMember(id, memberId);
      return { id, member: "added" };
    } catch (e) {
      return { id, member: { failed: e instanceof Error ? e.message : String(e) } };
    }
  }

  /** Whether `userId` is a member of thread `threadId`: Discord's 404 (unknown member) is false, any other error throws. */
  async isThreadMember(threadId: string, userId: string): Promise<boolean> {
    try {
      await this.call("GET", `/channels/${threadId}/thread-members/${userId}`);
      return true;
    } catch (e) {
      if (e instanceof MessengerError && e.status === 404) return false;
      throw e;
    }
  }

  async addThreadMember(threadId: string, userId: string): Promise<void> {
    await this.call("PUT", `/channels/${threadId}/thread-members/${userId}`);
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

export type GatewaySocket = {
  send(data: string): void;
  close(code?: number): void;
  onMessage(cb: (data: string) => void): void;
  onClose?(cb: (code: number) => void): void;
  onError?(cb: () => void): void;
};

export const DISCORD_INTENTS_GUILDS = 1;
export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;
export const DISCORD_INTENTS_MESSAGE_CONTENT = 1 << 15;

export const openDiscordGateway = (url = "wss://gateway.discord.gg/?v=10&encoding=json"): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code = 4000) => ws.close(code),
    onMessage: (cb) => { ws.addEventListener("message", (event) => cb(String(event.data))); },
    onClose: (cb) => { ws.addEventListener("close", (event) => cb(event.code)); },
    onError: (cb) => { ws.addEventListener("error", cb); },
  };
};

type GatewayOptions = {
  readonly messageContent?: boolean;
  readonly onMessage?: (data: unknown) => Promise<void>;
  /** MESSAGE_UPDATE, only while Message Content is requested (otherwise the edited text is withheld). */
  readonly onMessageUpdate?: (data: unknown) => Promise<void>;
  /** MESSAGE_DELETE carries only ids, so it is delivered with or without Message Content. */
  readonly onMessageDelete?: (data: unknown) => Promise<void>;
  readonly onReady?: () => Promise<void>;
  /** Synchronous view of every dispatch (op 0) before its specific handler, e.g. to cache thread parents. */
  readonly onDispatch?: (type: string, data: unknown) => void;
  readonly log?: (line: string) => void;
  readonly random?: () => number;
  /** A close code no reconnect can fix (see DISCORD_FATAL_CLOSE): the gateway stops reconnecting and calls this once. */
  readonly onFatal?: (code: number, reason: string) => void;
  /** A session an earlier process left (see GatewaySession): the first connect RESUMEs it, so Discord replays what it missed. */
  readonly resume?: GatewaySession;
};

/** What RESUME needs: the session id, the last sequence number seen and the session's resume gateway URL. */
export type GatewaySession = { readonly session: string; readonly seq: number; readonly url: string };

/**
 * Close codes Discord documents as not to be reconnected after: retrying only burns the daily IDENTIFY budget until
 * someone fixes the token, sharding or intents. 4014 is fatal only once Message Content is no longer requested.
 */
export const DISCORD_FATAL_CLOSE: Readonly<Record<number, string>> = {
  4004: "authentication-failed",
  4010: "invalid-shard",
  4011: "sharding-required",
  4012: "invalid-api-version",
  4013: "invalid-intents",
  4014: "disallowed-intents",
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A single owned connection, including while reconnecting or degrading privileged intents. */
export const discordPresence = (
  open: (url?: string) => GatewaySocket,
  token: string,
  clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void },
  onInteraction?: (data: unknown) => Promise<void>,
  options: GatewayOptions = {},
) => {
  let ws: GatewaySocket | undefined;
  let seq: number | null = options.resume?.seq ?? null;
  let session: string | undefined = options.resume?.session;
  let resumeUrl: string | undefined = options.resume?.url;
  let beat: unknown;
  let firstBeat: unknown;
  let retry: unknown;
  let handshake: unknown;
  let failures = 0;
  let stopped = false;
  let fatal: number | undefined;
  let healthy = false;
  let acknowledged = true;
  let content = options.messageContent === true;
  const handlers = new Set<Promise<void>>();
  const log = options.log ?? console.error;
  const dispatch = (work: (() => Promise<void>) | undefined) => {
    if (!work || stopped) return;
    const pending = Promise.resolve().then(work).catch(() => log("DISCORD_GATEWAY_ERROR event handler failed"));
    handlers.add(pending);
    void pending.finally(() => handlers.delete(pending));
  };
  const clearConnection = () => {
    healthy = false;
    if (beat !== undefined) clock.clearInterval(beat);
    if (firstBeat !== undefined) clock.clearInterval(firstBeat);
    if (handshake !== undefined) clock.clearInterval(handshake);
    beat = undefined;
    firstBeat = undefined;
    handshake = undefined;
  };
  const resetSession = () => { session = undefined; seq = null; resumeUrl = undefined; };
  const reconnect = (socket?: GatewaySocket) => {
    if (stopped || fatal !== undefined || (socket && socket !== ws)) return;
    clearConnection();
    const previous = ws;
    ws = undefined;
    // Clear identity first: close callbacks from this socket cannot schedule a second retry.
    previous?.close();
    if (retry !== undefined) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
    log(`DISCORD_GATEWAY reconnect in ${delay}ms`);
    retry = clock.setInterval(() => {
      clock.clearInterval(retry);
      retry = undefined;
      connect();
    }, delay);
  };
  const connect = () => {
    if (stopped) return;
    try {
      const socket = open(resumeUrl);
      ws = socket;
      acknowledged = true;
      socket.onClose?.((code) => {
        if (stopped || socket !== ws) return;
        const reason = DISCORD_FATAL_CLOSE[code];
        if (reason && !(code === 4014 && content)) {
          fatal = code;
          clearConnection();
          ws = undefined;
          log(`DISCORD_GATEWAY_FATAL close=${code} ${reason}; not reconnecting`);
          try { options.onFatal?.(code, reason); }
          catch { log("DISCORD_GATEWAY_ERROR fatal close handler failed"); }
          return;
        }
        if (code === 4014 && content) {
          content = false;
          resetSession();
          log('DISCORD_GATEWAY enable "Message Content Intent" in the Developer Portal (Bot tab); using presence/interactions with REST inbound fallback');
        } else if ([4007, 4009].includes(code)) resetSession();
        reconnect(socket);
      });
      socket.onError?.(() => reconnect(socket));
      if (socket.onClose) {
        handshake = clock.setInterval(() => reconnect(socket), 30_000);
      }
      socket.onMessage((raw) => {
        if (stopped || socket !== ws) return;
        try {
          const m: unknown = JSON.parse(raw);
          if (!record(m) || typeof m.op !== "number") throw new TypeError("Invalid gateway frame");
          if (typeof m.s === "number") seq = m.s;
          switch (m.op) {
            case 0:
              if (typeof m.t === "string" && options.onDispatch) {
                try { options.onDispatch(m.t, m.d); }
                catch { log("DISCORD_GATEWAY_ERROR dispatch observer failed"); }
              }
              if (m.t === "READY" || m.t === "RESUMED") {
                if (m.t === "READY" && record(m.d)) {
                  if (typeof m.d.session_id === "string") session = m.d.session_id;
                  if (typeof m.d.resume_gateway_url === "string") resumeUrl = `${m.d.resume_gateway_url.replace(/\/$/, "")}/?v=10&encoding=json`;
                }
                if (handshake !== undefined) clock.clearInterval(handshake);
                handshake = undefined;
                healthy = true;
                failures = 0;
                dispatch(options.onReady);
              }
              if (m.t === "INTERACTION_CREATE") dispatch(onInteraction ? () => onInteraction(m.d) : undefined);
              if (m.t === "MESSAGE_CREATE" && content) dispatch(options.onMessage ? () => options.onMessage?.(m.d) ?? Promise.resolve() : undefined);
              if (m.t === "MESSAGE_UPDATE" && content) dispatch(options.onMessageUpdate ? () => options.onMessageUpdate?.(m.d) ?? Promise.resolve() : undefined);
              if (m.t === "MESSAGE_DELETE") dispatch(options.onMessageDelete ? () => options.onMessageDelete?.(m.d) ?? Promise.resolve() : undefined);
              break;
            case 1:
              socket.send(JSON.stringify({ op: 1, d: seq }));
              acknowledged = false;
              break;
            case 7:
              reconnect(socket);
              break;
            case 9:
              if (m.d !== true) resetSession();
              reconnect(socket);
              break;
            case 10:
              if (!record(m.d) || typeof m.d.heartbeat_interval !== "number" || m.d.heartbeat_interval <= 0) throw new TypeError("Invalid gateway heartbeat");
              if (beat !== undefined) clock.clearInterval(beat);
              if (firstBeat !== undefined) clock.clearInterval(firstBeat);
              const heartbeat = () => {
                if (!acknowledged) { reconnect(socket); return; }
                try { socket.send(JSON.stringify({ op: 1, d: seq })); acknowledged = false; }
                catch { reconnect(socket); }
              };
              const interval = m.d.heartbeat_interval;
              if (socket.onClose) {
                firstBeat = clock.setInterval(() => {
                  clock.clearInterval(firstBeat);
                  firstBeat = undefined;
                  heartbeat();
                  if (ws === socket && !stopped) beat = clock.setInterval(heartbeat, interval);
                }, interval * (options.random ?? Math.random)());
              } else beat = clock.setInterval(heartbeat, interval);
              if (session && seq !== null) socket.send(JSON.stringify({ op: 6, d: { token, session_id: session, seq } }));
              else socket.send(JSON.stringify({ op: 2, d: {
                token,
                intents: DISCORD_INTENTS_GUILDS | DISCORD_INTENTS_GUILD_MESSAGES | (content ? DISCORD_INTENTS_MESSAGE_CONTENT : 0),
                properties: { os: process.platform, browser: "dori", device: "dori" },
                presence: { status: "online", since: null, activities: [], afk: false },
              } }));
              break;
            case 11:
              acknowledged = true;
              break;
          }
        } catch {
          log("DISCORD_GATEWAY_ERROR invalid frame or socket failure");
          reconnect(socket);
        }
      });
    } catch {
      log("DISCORD_GATEWAY_ERROR connection failed");
      reconnect();
    }
  };
  connect();
  return {
    get healthy() { return healthy && content; },
    /** Raw socket state for the status file: connected, and whether Message Content is still requested. */
    get connected() { return healthy; },
    get messageContent() { return content; },
    /** The fatal close code that stopped reconnecting, if any. */
    get fatal() { return fatal; },
    async settled() { await Promise.all(handlers); },
    /** The session a later process can resume, when this one has a READY session. */
    session(): GatewaySession | undefined {
      return session !== undefined && seq !== null && resumeUrl !== undefined ? { session, seq, url: resumeUrl } : undefined;
    },
    close() {
      stopped = true;
      clearConnection();
      if (retry !== undefined) clock.clearInterval(retry);
      ws?.close();
      ws = undefined;
    },
  };
};
