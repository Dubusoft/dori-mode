import { type ArgvTemplate, type DiscordConfig, fill } from "../config.ts";
import { disabledRows, type HookInteraction, hookInteraction, type HookSpawner, spawnButtonHook } from "./discord-buttons.ts";
import { type DecideInteraction, decideInteraction } from "./decision-buttons.ts";
import type { Http } from "./http.ts";
import { MessengerError } from "./http.ts";

export const guildCommands = [
  { name: "quota", description: "Show subscription quota", type: 1 },
  {
    name: "status", description: "Show Dori services, lead, lanes and waits", type: 1,
    options: [{ type: 4, name: "page", description: "Page 2 and on list the lanes page 1 has no room for", required: false, min_value: 1 }],
  },
] as const;
export type QuotaLookup = (signal: AbortSignal) => Promise<string>;
/** The /status text source: `page` is the command's page option, 1 without it. */
export type StatusLookup = (signal: AbortSignal, page: number) => Promise<string>;

type Interaction = {
  readonly id: string;
  readonly token: string;
  readonly application_id: string;
  readonly guild_id: string;
  readonly userId: string;
  readonly command: "quota" | "status";
  readonly channelIds: readonly string[];
  /** /status page:N; 1 when absent or not a positive integer. */
  readonly page: number;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The close-thread button's custom_id carries the thread id, so a click works after a restart with no stored state.
 * `dori supervise` puts it on a finished thread's last report (lane-outcomes.ts autoCloseTick).
 */
const CLOSE_THREAD = /^dori:close-thread:(\d+)$/;
const closeRow = (threadId: string, closed: boolean) => [{
  type: 1,
  components: [{ type: 2, style: 2, label: closed ? "닫았습니다" : "스레드 닫기", custom_id: `dori:close-thread:${threadId}`, ...(closed ? { disabled: true } : {}) }],
}];
/** The action row carrying the close-thread button of `threadId`, live or (`closed`) disabled as closed. */
export const closeThreadButton = (threadId: string, closed = false): unknown[] => closeRow(threadId, closed);
/** Called after the owner's click archived `threadId`; `interactionId` is unique per click. */
export type ThreadClosed = (threadId: string, interactionId: string) => Promise<void>;
/** Called after the owner's button click started hook `name`; `channel` is the message's channel or thread. */
export type ButtonClicked = (name: string, arg: string, channel: string, interactionId: string) => Promise<void>;
/**
 * Routes the owner's answer-button click on option `choice` of `decision`, made in `channel` (`late`: past Discord's
 * answer window); resolves to the owner's reply (none when the thread's `[System]` notice confirms the answer) and the
 * buttons as they should now show (decision-inbound.ts routeDecisionClick).
 */
export type DecisionClicked = (click: {
  readonly decision: string; readonly choice: number; readonly channel: string; readonly interaction: string; readonly late: boolean;
}) => Promise<{ readonly content?: string; readonly components?: readonly unknown[] }>;
export type ButtonHookOptions = {
  /** config `buttonHooks`: hook name -> argv template. */
  readonly hooks?: Readonly<Record<string, ArgvTemplate>>;
  readonly spawn?: HookSpawner;
  readonly clicked?: ButtonClicked;
  /** Answer buttons (`dori:decide:`); without it every such click gets the unknown-button reply. */
  readonly decide?: DecisionClicked;
};

type CloseInteraction = {
  readonly id: string;
  readonly token: string;
  readonly application_id: string;
  readonly guild_id: string;
  readonly userId: string;
  readonly threadId: string;
  /** The message carrying the button, when Discord sent it: a late click disables the button through it. */
  readonly messageId?: string;
};

const closeInteraction = (value: unknown): CloseInteraction | undefined => {
  if (!record(value) || value.type !== 3 || !record(value.data) || value.data.component_type !== 2 || typeof value.data.custom_id !== "string") return;
  const threadId = CLOSE_THREAD.exec(value.data.custom_id)?.[1];
  if (!threadId || typeof value.id !== "string" || typeof value.token !== "string" || typeof value.application_id !== "string" || typeof value.guild_id !== "string") return;
  if (!record(value.member) || !record(value.member.user) || typeof value.member.user.id !== "string") return;
  const messageId = record(value.message) && typeof value.message.id === "string" ? value.message.id : undefined;
  return { id: value.id, token: value.token, application_id: value.application_id, guild_id: value.guild_id, userId: value.member.user.id, threadId, ...(messageId ? { messageId } : {}) };
};

const commandInteraction = (value: unknown): Interaction | undefined => {
  if (!record(value) || value.type !== 2 || !record(value.data) || value.data.type !== 1) return;
  const command = value.data.name;
  if (command !== "quota" && command !== "status") return;
  if (typeof value.id !== "string" || typeof value.token !== "string" || typeof value.application_id !== "string" || typeof value.guild_id !== "string") return;
  if (!record(value.member) || !record(value.member.user) || typeof value.member.user.id !== "string") return;
  const channelIds = [value.channel_id, record(value.channel) ? value.channel.parent_id : undefined].filter((id): id is string => typeof id === "string");
  const option = Array.isArray(value.data.options) ? value.data.options.find((o: unknown) => record(o) && o.name === "page") : undefined;
  const page = record(option) && Number.isSafeInteger(option.value) && (option.value as number) >= 1 ? option.value as number : 1;
  return { id: value.id, token: value.token, application_id: value.application_id, guild_id: value.guild_id, userId: value.member.user.id, command, channelIds, page };
};

/** Neutralize code fences/control characters from account labels, and keep one complete code block. */
export const quotaMessage = (text: string, empty = "No subscription quota is configured."): string => {
  const clean = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/`/g, "'");
  const body = clean || empty;
  const bounded = body.length <= 1992 ? body : `${body.slice(0, 1976).replace(/[\uD800-\uDBFF]$/, "")}\n[truncated]`;
  return `\`\`\`\n${bounded}\n\`\`\``;
};

/** Uses the existing presence socket; REST interactions never start a model turn. */
export class DiscordCommands {
  constructor(
    private readonly http: Http,
    private readonly botToken: string,
    private readonly config: DiscordConfig,
    private readonly lookup: QuotaLookup,
    private readonly deadline: () => AbortSignal = () => AbortSignal.timeout(20_000),
    /** Channels this Dori owns, or a function read per interaction (the supervisor's live config); empty answers everywhere. */
    private readonly ownChannels: readonly string[] | (() => readonly string[]) = [],
    /** The /status text source; without it /status is ignored. */
    private readonly statusLookup?: StatusLookup,
    /** Told about each thread the owner's close button archived; without it the close is only logged. */
    private readonly threadClosed?: ThreadClosed,
    /** Owner-only `dori:hook:` buttons; without hooks every such click gets the unknown-button reply. */
    private readonly buttons: ButtonHookOptions = {},
  ) {}

  private async request(method: "PUT" | "POST" | "PATCH", path: string, body: unknown, authenticated = false): Promise<void> {
    const response = await this.http({
      method, url: `https://discord.com/api/v10${path}`,
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bot ${this.botToken}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === "POST" ? 2_500 : 10_000),
    });
    // Never include paths, interaction tokens or Discord's response body in errors.
    if (response.status >= 300) throw new MessengerError("Discord command request failed", response.status);
  }

  async register(): Promise<void> {
    const { applicationId, guildId, ownerId } = this.config;
    if (![applicationId, guildId, ownerId].every((id) => /^\d+$/.test(id))) throw new MessengerError("Discord slash command IDs must be configured", 0);
    await this.request("PUT", `/applications/${applicationId}/guilds/${guildId}/commands`, guildCommands, true);
  }

  /**
   * A close-thread button click, handled in code: a non-owner gets an ephemeral refusal; the owner's click is answered
   * at once by updating the message (button disabled), then the thread is archived and `threadClosed` is told. A failed
   * archive re-enables the button so the owner can retry.
   *
   * An owner click whose acknowledgement fails is still carried out: a click made while the supervisor was restarting
   * reaches the next process when it resumes the gateway session, past Discord's 3 s answer window. Then the button
   * message is disabled with the bot's own token and the thread archived, so the click takes effect late instead of
   * being lost.
   */
  private async closeThread(interaction: CloseInteraction): Promise<void> {
    if (interaction.application_id !== this.config.applicationId || interaction.guild_id !== this.config.guildId) return;
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;
    if (interaction.userId !== this.config.ownerId) {
      await this.request("POST", callback, { type: 4, data: { flags: 64, content: "스레드 닫기는 오너만 할 수 있습니다." } })
        .catch(() => { console.error("Discord close-thread acknowledgement failed"); });
      return;
    }
    let late = false;
    try {
      await this.request("POST", callback, { type: 7, data: { components: closeRow(interaction.threadId, true) } });
    } catch {
      late = true;
      console.error(`Discord close-thread acknowledgement failed ${interaction.threadId}; closing it anyway`);
    }
    const message = interaction.messageId ? `/channels/${interaction.threadId}/messages/${interaction.messageId}` : undefined;
    // A late click edits the bot's own message before the archive: an archived thread's messages cannot be edited.
    if (late && message) {
      await this.request("PATCH", message, { components: closeRow(interaction.threadId, true) }, true)
        .catch(() => { console.error(`Discord close-thread button disable failed ${interaction.threadId}`); });
    }
    try {
      await this.request("PATCH", `/channels/${interaction.threadId}`, { archived: true }, true);
    } catch {
      console.error(`Discord close-thread archive failed ${interaction.threadId}`);
      const restore = !late
        ? this.request("PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { components: closeRow(interaction.threadId, false) })
        : message ? this.request("PATCH", message, { components: closeRow(interaction.threadId, false) }, true) : Promise.resolve();
      await restore.catch(() => { console.error("Discord close-thread button restore failed"); });
      return;
    }
    await this.threadClosed?.(interaction.threadId, interaction.id).catch(() => { console.error(`Discord close-thread event failed ${interaction.threadId}`); });
  }

  /**
   * A hook button click. A non-owner (or a foreign application or guild) gets an ephemeral refusal and an unconfigured
   * hook name the unknown-button reply. The owner's click updates the message at once (every button disabled, the
   * clicked one marked 접수됨), then spawns the hook and reports the click. A failed update leaves the buttons live
   * and runs nothing.
   */
  private async hookButton(interaction: HookInteraction): Promise<void> {
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;
    const refuse = (content: string) => this.request("POST", callback, { type: 4, data: { flags: 64, content } });
    const argv = this.buttons.hooks?.[interaction.name];
    try {
      if (interaction.application_id !== this.config.applicationId || interaction.guild_id !== this.config.guildId || interaction.userId !== this.config.ownerId) {
        await refuse("이 버튼은 오너만 누를 수 있습니다.");
        return;
      }
      if (!argv) {
        await refuse("알 수 없는 버튼입니다.");
        return;
      }
      await this.request("POST", callback, { type: 7, data: { components: disabledRows(interaction.message.components, interaction.customId) } });
    } catch {
      console.error(`Discord button ${interaction.name} acknowledgement failed`);
      return;
    }
    (this.buttons.spawn ?? spawnButtonHook)(fill(argv, {
      name: interaction.name, arg: interaction.arg, channel: interaction.channel, message: interaction.message.id, interaction: interaction.id,
    }), interaction.name);
    await this.buttons.clicked?.(interaction.name, interaction.arg, interaction.channel, interaction.id)
      .catch(() => { console.error(`Discord button ${interaction.name} event failed`); });
  }

  /**
   * An answer-button click: a non-owner (or a foreign application or guild) and a click with no router get an ephemeral
   * reply. The owner's click is acknowledged at once (deferred, nothing shown yet), then routed (`decide` checks the
   * thread, the decision's state and whether the lane can take it); its buttons are updated to show the choice and the
   * reply, when the router gives one, follows as an ephemeral message (a first direct answer has none: the thread's
   * `[System]` notice is its one visible confirmation). A failed route records nothing the router did not record and tells the owner
   * to type the number.
   *
   * A click whose acknowledgement fails is still routed, as `late`: made while the supervisor was restarting, it reaches
   * the next process when it resumes the gateway session, past Discord's 3 s answer window, so the interaction can no
   * longer answer. Then the buttons are updated with the bot's own token and the reply is posted in the thread, where the
   * owner sees it.
   */
  private async decideButton(interaction: DecideInteraction): Promise<void> {
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;
    const refuse = (content: string) => this.request("POST", callback, { type: 4, data: { flags: 64, content } })
      .catch(() => { console.error(`Discord decision button ${interaction.decision} acknowledgement failed`); });
    if (interaction.application_id !== this.config.applicationId || interaction.guild_id !== this.config.guildId || interaction.userId !== this.config.ownerId) {
      return refuse("이 버튼은 오너만 누를 수 있습니다.");
    }
    if (!this.buttons.decide) return refuse("알 수 없는 버튼입니다.");
    let late = false;
    try { await this.request("POST", callback, { type: 6 }); }
    catch {
      late = true;
      console.error(`Discord decision button ${interaction.decision} acknowledgement failed; routing it late`);
    }
    let result: { readonly content?: string; readonly components?: readonly unknown[] };
    try {
      result = await this.buttons.decide({ decision: interaction.decision, choice: interaction.choice, channel: interaction.channel, interaction: interaction.id, late });
    } catch {
      console.error(`Discord decision button ${interaction.decision} routing failed`);
      result = { content: "답을 기록하지 못했습니다. 번호를 스레드에 적어 주세요." };
    }
    const webhook = `/webhooks/${interaction.application_id}/${interaction.token}`;
    const message = late
      ? interaction.message ? `/channels/${interaction.channel}/messages/${interaction.message}` : undefined
      : `${webhook}/messages/@original`;
    if (result.components && message) {
      await this.request("PATCH", message, { components: result.components }, late)
        .catch(() => { console.error(`Discord decision button ${interaction.decision} update failed`); });
    }
    if (result.content === undefined) return;
    const reply = late
      ? this.request("POST", `/channels/${interaction.channel}/messages`, { content: `[System] 재시작 중에 누른 버튼(${interaction.decision} ${interaction.choice}번)입니다. ${result.content}`, allowed_mentions: { parse: [] } }, true)
      : this.request("POST", webhook, { content: result.content, flags: 64 });
    await reply.catch(() => { console.error(`Discord decision button ${interaction.decision} reply failed`); });
  }

  async handle(value: unknown): Promise<void> {
    const close = closeInteraction(value);
    if (close) return this.closeThread(close);
    const decide = decideInteraction(value);
    if (decide) return this.decideButton(decide);
    const hook = hookInteraction(value);
    if (hook) return this.hookButton(hook);
    const interaction = commandInteraction(value);
    if (!interaction || interaction.application_id !== this.config.applicationId || interaction.guild_id !== this.config.guildId) return;
    if (interaction.command === "status" && !this.statusLookup) return;
    const label = interaction.command === "status" ? "Status" : "Quota";
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;
    try {
      const channels = typeof this.ownChannels === "function" ? this.ownChannels() : this.ownChannels;
      if (channels.length > 0 && !interaction.channelIds.some((id) => channels.includes(id))) {
        await this.request("POST", callback, { type: 4, data: { flags: 64, content: `이 채널은 다른 Dori의 채널입니다. 해당 Dori 봇의 /${interaction.command}를 사용해 주세요.` } });
        return;
      }
      if (interaction.userId !== this.config.ownerId) {
        await this.request("POST", callback, { type: 4, data: { flags: 64, content: "This command is only available to the owner." } });
        return;
      }
      await this.request("POST", callback, { type: 5, data: { flags: 64 } });
    } catch {
      console.error(`Discord ${interaction.command} acknowledgement failed`);
      return;
    }
    let content: string;
    const signal = this.deadline();
    let abort: () => void = () => {};
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const lookup = interaction.command === "status" ? this.statusLookup : this.lookup;
      const text = await Promise.race([lookup?.(signal, interaction.page) ?? Promise.reject(new Error("no lookup")), cancelled]);
      content = interaction.command === "status" ? quotaMessage(text, "No status available.") : quotaMessage(text);
    } catch {
      content = signal.aborted ? `${label} lookup timed out. Try again.` : `${label} lookup failed. Try again.`;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    try {
      await this.request("PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { content, allowed_mentions: { parse: [] } });
    } catch {
      console.error(`Discord ${interaction.command} response failed`);
    }
  }
}
