import { readFileSync } from "node:fs";

import { expandHome } from "../config.ts";
import { guardText, type Http } from "./http.ts";

/*
 * The Toodo Lead chat as a Dori channel: Toodo's external Lead mode (toodo docs/external-lead.md). Dori is the outside
 * lead: it reads the chat inbox and answers through the MCP endpoint (`POST /mcp`, JSON-RPC, one `tools/call` per
 * request) with the lead token, and wakes on the server's event stream (`GET /api/events`). Only chat tools are called
 * with the lead token; task tools called with it would post lead lines into the chat.
 */

/** The channel name of the Toodo chat in INBOUND lines and in `dori ack/handled/send/typing`. */
export const TOODO_CHANNEL = "toodo";

export type ToodoConfig = {
  /** The server's base URL, e.g. http://127.0.0.1:47616. */
  readonly url: string;
  /** The file holding the lead token (`lead-token` in the server's data directory). */
  readonly leadTokenFile: string;
  /** Seconds between safety reads of the inbox when no event arrives; default 60. */
  readonly pollSeconds?: number;
  /** One Discord channel that shows the same conversation as the Toodo chat (toodo-mirror.ts); absent mirrors nothing. */
  readonly discordMirror?: ToodoDiscordMirrorConfig;
};

export type ToodoDiscordMirrorConfig = {
  /** The Discord channel id (a top-level text channel the bot can read and post in). */
  readonly channel: string;
  /** The file holding the channel's webhook URL; the owner's Toodo messages are posted through it under their name. */
  readonly webhookUrlFile: string;
  /** The owner's name on mirrored posts; default their Discord name (discord.ownerId), fetched once. */
  readonly ownerName?: string;
  /** The owner's avatar image URL on mirrored posts; default their Discord avatar, fetched once. */
  readonly ownerAvatarUrl?: string;
};

export const TOODO_POLL_SECONDS = 60;

export class ToodoError extends Error {}

/** Why `toodo` in the config is unusable, or undefined. */
export const toodoConfigError = (toodo: unknown): string | undefined => {
  if (toodo === undefined) return undefined;
  if (typeof toodo !== "object" || toodo === null || Array.isArray(toodo)) return "toodo must be an object";
  const t = toodo as Record<string, unknown>;
  if (typeof t.url !== "string" || !/^https?:\/\/[^/\s]+/.test(t.url)) return "toodo.url must be the server's http(s) URL";
  if (typeof t.leadTokenFile !== "string" || !t.leadTokenFile.trim()) return "toodo.leadTokenFile must name the server's lead-token file";
  if (t.pollSeconds !== undefined && (typeof t.pollSeconds !== "number" || !Number.isFinite(t.pollSeconds) || t.pollSeconds < 5)) return "toodo.pollSeconds must be at least 5";
  if (t.discordMirror === undefined) return undefined;
  const m = t.discordMirror;
  if (typeof m !== "object" || m === null || Array.isArray(m)) return "toodo.discordMirror must be an object";
  const mirror = m as Record<string, unknown>;
  if (typeof mirror.channel !== "string" || !/^\d+$/.test(mirror.channel)) return "toodo.discordMirror.channel must be a Discord channel id";
  if (typeof mirror.webhookUrlFile !== "string" || !mirror.webhookUrlFile.trim()) return "toodo.discordMirror.webhookUrlFile must name the file holding the channel's webhook URL";
  if (mirror.ownerName !== undefined && (typeof mirror.ownerName !== "string" || !mirror.ownerName.trim() || mirror.ownerName.length > 80)) return "toodo.discordMirror.ownerName must be a name of 1 to 80 characters";
  if (mirror.ownerAvatarUrl !== undefined && (typeof mirror.ownerAvatarUrl !== "string" || !/^https:\/\/\S+$/.test(mirror.ownerAvatarUrl))) return "toodo.discordMirror.ownerAvatarUrl must be an https URL";
  return undefined;
};

/** The lead token from `leadTokenFile` (re-read on every call, so a rotated token is picked up). */
export const readToodoToken = (config: ToodoConfig): string => {
  const path = expandHome(config.leadTokenFile);
  let token: string;
  try { token = readFileSync(path, "utf8").trim(); } catch (e) {
    throw new ToodoError(`cannot read the Toodo lead token ${path}: ${e instanceof Error && "code" in e ? String(e.code) : String(e)}`);
  }
  if (!token) throw new ToodoError(`the Toodo lead token file ${path} is empty`);
  return token;
};

export type ToodoPendingItem = {
  /** `chat-<n>` or `event-<n>`. */
  readonly id: string;
  readonly at: number;
  readonly takenBefore?: number;
  readonly kind: "chat" | "task_event" | string;
  readonly body?: string;
  readonly taskId?: number;
  readonly title?: string;
  readonly status?: string;
  readonly reportId?: number;
};
export type ToodoPending = { readonly items: readonly ToodoPendingItem[]; readonly remaining?: number; readonly open?: readonly string[]; readonly missing?: readonly string[] };
export type ToodoMessage = { readonly id: number; readonly author: "user" | "lead" | "system" | string; readonly body: string; readonly at: number; readonly origin?: string };
export type ToodoFeed = { readonly messages: readonly ToodoMessage[]; readonly more: boolean };

/** The chat tools Dori uses; tests give a fake. */
export type ToodoApi = {
  peek(): Promise<ToodoPending>;
  take(ids: readonly string[]): Promise<ToodoPending>;
  ack(ids: readonly string[]): Promise<void>;
  reply(text: string, handles?: readonly string[]): Promise<ToodoMessage>;
  markHandled(id: string, link: { readonly replyId: number } | { readonly taskId: number }): Promise<void>;
  typing(on: boolean): Promise<void>;
  listChat(after: number, limit?: number): Promise<ToodoFeed>;
  /**
   * Stores a message written in another chat (import_chat_message): a person's is stored as taken, so it never enters
   * the inbox. The same origin and id again stores nothing and returns the stored message.
   */
  importMessage(author: "user" | "lead", text: string, origin: string, originId: string): Promise<ToodoMessage>;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON-RPC response of a stateless MCP POST: plain JSON, or one `data:` line of an event-stream answer. */
const rpcBody = (body: string): unknown => {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
  if (!data) throw new ToodoError("Toodo answered with neither JSON nor an event-stream data line");
  return JSON.parse(data);
};

/** The chat's message id from an inbox id (`chat-12` -> 12), or undefined. */
export const chatNumber = (id: string): number | undefined => {
  const m = /^chat-(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

export class Toodo implements ToodoApi {
  private next = 1;
  constructor(private readonly http: Http, private readonly url: string, private readonly token: () => string, private readonly timeoutMs = 30_000) {}

  /** One `tools/call`; the tool's JSON text is parsed. A tool error (isError) or JSON-RPC error throws ToodoError. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.http({
      method: "POST", url: `${this.url.replace(/\/+$/, "")}/mcp`,
      headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.next++, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status !== 200) throw new ToodoError(`Toodo ${name}: HTTP ${res.status}${res.status === 401 ? " (wrong lead token)" : ""}`);
    const rpc = rpcBody(res.body);
    if (!record(rpc)) throw new ToodoError(`Toodo ${name}: not a JSON-RPC response`);
    if (record(rpc.error)) throw new ToodoError(`Toodo ${name}: ${String(rpc.error.message ?? "error")}`);
    const result = rpc.result;
    if (!record(result) || !Array.isArray(result.content)) throw new ToodoError(`Toodo ${name}: no tool result`);
    const first: unknown = result.content[0];
    const text = record(first) && typeof first.text === "string" ? first.text : "";
    if (result.isError === true) throw new ToodoError(`Toodo ${name}: ${text.slice(0, 300) || "tool error"}`);
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }

  private async pending(name: string, args: Record<string, unknown>): Promise<ToodoPending> {
    const value = await this.call(name, args);
    if (!record(value) || !Array.isArray(value.items)) throw new ToodoError(`Toodo ${name}: no items`);
    return value as ToodoPending;
  }

  peek(): Promise<ToodoPending> { return this.pending("peek_pending", {}); }
  take(ids: readonly string[]): Promise<ToodoPending> { return this.pending("take_pending", { ids: [...ids] }); }
  async ack(ids: readonly string[]): Promise<void> { await this.call("ack_chat", { ids: [...ids] }); }

  async reply(text: string, handles: readonly string[] = []): Promise<ToodoMessage> {
    const value = await this.call("reply_in_chat", { text: guardText(text), ...(handles.length ? { handles: [...handles] } : {}) });
    const message = record(value) && record(value.message) ? value.message : value;
    if (!record(message) || typeof message.id !== "number") throw new ToodoError("Toodo reply_in_chat: no message id");
    return message as ToodoMessage;
  }

  async markHandled(id: string, link: { readonly replyId: number } | { readonly taskId: number }): Promise<void> {
    await this.call("mark_chat_handled", { id, ...("replyId" in link ? { reply_id: link.replyId } : { task_id: link.taskId }) });
  }

  async typing(on: boolean): Promise<void> { await this.call("set_typing", { typing: on }); }

  async listChat(after: number, limit = 100): Promise<ToodoFeed> {
    const value = await this.call("list_chat", { after, limit });
    if (!record(value) || !Array.isArray(value.messages)) throw new ToodoError("Toodo list_chat: no messages");
    return { messages: value.messages as ToodoMessage[], more: value.more === true };
  }

  async importMessage(author: "user" | "lead", text: string, origin: string, originId: string): Promise<ToodoMessage> {
    const value = await this.call("import_chat_message", { author, text, origin, origin_id: originId });
    const message = record(value) && record(value.message) ? value.message : value;
    if (!record(message) || typeof message.id !== "number") throw new ToodoError("Toodo import_chat_message: no message id");
    return message as ToodoMessage;
  }
}

export const toodoClient = (http: Http, config: ToodoConfig): Toodo => new Toodo(http, config.url, () => readToodoToken(config));

/**
 * Reads `GET /api/events` until it ends, calling `wake` for each `chat-changed` (and once when the stream opens, since
 * anything sent while it was closed raised no event). The stream carries no ids and is only a hint to read again.
 */
export const listenToodoEvents = async (config: ToodoConfig, wake: () => void, signal: AbortSignal, onOpen?: () => void): Promise<void> => {
  const res = await fetch(`${config.url.replace(/\/+$/, "")}/api/events`, {
    headers: { authorization: `Bearer ${readToodoToken(config)}`, accept: "text/event-stream" }, signal,
  });
  if (res.status !== 200 || !res.body) throw new ToodoError(`Toodo event stream: HTTP ${res.status}`);
  onOpen?.();
  wake();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (/^event:\s*chat-changed$/.test(line) || /^data:.*chat-changed/.test(line)) wake();
    }
  }
};
