import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../done-flow.ts";
import { recordOwnerClosed } from "../thread-followup.ts";
import { DiscordCommands, type QuotaLookup, type StatusLookup } from "./discord-commands.ts";
import {
  type DiscordInboundOptions, discordChannels, discordDispatchThreads, discordMessageChannel, discordOwnerConfigured, discordThread,
  discordThreadFloor, emitDiscordDelete, emitDiscordEdit, emitDiscordInbound, listDiscordInbound, listDiscordThreads,
  parseDiscordMessage, pollDiscordInbound,
} from "./discord-inbound.ts";
import { Discord, discordPresence, type GatewaySession, openDiscordGateway, type GatewaySocket } from "./discord.ts";
import { type Http, MessengerError } from "./http.ts";
import { realTimers, type Timers } from "./typing.ts";

export type SupervisorDiscordOptions = {
  readonly token: string;
  readonly http: Http;
  readonly emit: (id: string, line: string) => Promise<void>;
  readonly lookup: QuotaLookup;
  readonly statusLookup?: StatusLookup;
  readonly open?: (url?: string) => GatewaySocket;
  readonly timers?: Timers;
  readonly log?: (line: string) => void;
};

/** The gateway session a stopping supervisor leaves for the next one. */
export const GATEWAY_SESSION_FILE = "discord-gateway-session.json";
/** An older session is not tried: Discord keeps a closed session resumable only briefly, and a refused RESUME costs a reconnect. */
export const GATEWAY_SESSION_MAX_AGE_MS = 5 * 60_000;

/** Takes (reads and removes) the session a stopped supervisor left, when it is recent enough to resume. */
export const takeGatewaySession = (stateDir: string, now: number): GatewaySession | undefined => {
  const path = join(stateDir, GATEWAY_SESSION_FILE);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return undefined; }
  rmSync(path, { force: true });
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { session, seq, url, at } = value as Record<string, unknown>;
    if (typeof session !== "string" || typeof seq !== "number" || typeof url !== "string" || !url.startsWith("wss://") || typeof at !== "number") return undefined;
    if (now - at > GATEWAY_SESSION_MAX_AGE_MS || at > now) return undefined;
    return { session, seq, url };
  } catch { return undefined; }
};

/** Leaves `session` for the next supervisor (tmp + rename, owner-only). */
export const saveGatewaySession = (stateDir: string, session: GatewaySession, now: number): void => {
  const path = join(stateDir, GATEWAY_SESSION_FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...session, at: now }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

/**
 * Gateway delivery never advances the REST watermark: an unseen gap cannot be skipped.
 * Watched: configured channels, open lane threads, and every thread whose parent is a configured channel.
 */
export const supervisorDiscord = (deps: FlowDeps, options: SupervisorDiscordOptions) => {
  const log = options.log ?? console.error;
  const config = deps.config.discord;
  if (!config) throw new TypeError("supervise requires config.discord; run dori setup");
  const discord = new Discord(options.http, deps.clock, options.token);
  // The owner's close-thread button reaches the lead as a digest line, with the lane bound to that thread when one is.
  const threadClosed = async (threadId: string, interactionId: string): Promise<void> => {
    recordOwnerClosed(deps.config.stateDir, threadId, deps.clock.now());
    const lane = (await deps.registry.open()).find((l) => l.thread.endsWith(`/${threadId}`))?.key;
    await options.emit(`discord:${threadId}:close:${interactionId}`, `THREAD_CLOSED_BY_OWNER ${threadId}${lane ? ` lane ${lane}` : ""}`);
  };
  // The owner's hook button click reaches the lead as one journal line after the configured hook was started.
  const clicked = (name: string, arg: string, channel: string, interactionId: string): Promise<void> =>
    options.emit(`discord:${channel}:button:${interactionId}`, `BUTTON_CLICKED_BY_OWNER ${name} ${arg}`);
  const commands = new DiscordCommands(options.http, options.token, config, options.lookup, undefined, deps.config.discordChannels, options.statusLookup, threadClosed,
    { hooks: deps.config.buttonHooks ?? {}, clicked });
  let lastPoll = -Infinity;
  let polling: Promise<void> | undefined;
  let catchupRequested = false;
  let stopped = false;
  let watched: readonly string[] = [];
  const statePath = join(deps.config.stateDir, "discord-inbound.json");
  const configuredChannels = deps.config.discordChannels;
  const configured = () => discordChannels(configuredChannels, []);
  if (!discordOwnerConfigured(config.ownerId)) {
    log("DISCORD_INBOUND_WARNING discord.ownerId is not configured; every Discord author is treated as a VISITOR, never the owner (run dori setup)");
  }
  let botId: string | undefined;
  let contentWarned = false;
  // Owner message id -> channel, so a MESSAGE_DELETE can be reported for messages this process has seen. Bounded.
  const ownerMessages = new Map<string, string>();
  const inboundOptions: DiscordInboundOptions = {
    get botId() { return botId; },
    log,
    onMissingContent: () => {
      if (contentWarned) return;
      contentWarned = true;
      log('DISCORD_INBOUND_WARNING a message arrived with no content: enable the privileged "Message Content Intent" in the Developer Portal (Bot tab); such messages are forwarded marked as content unavailable');
    },
    onOwner: (channel, id) => {
      ownerMessages.delete(id);
      ownerMessages.set(id, channel);
      if (ownerMessages.size > 1_000) ownerMessages.delete(ownerMessages.keys().next().value ?? "");
    },
  };
  const watches = async (channel: string): Promise<boolean> =>
    discordChannels(configuredChannels, await deps.registry.open()).includes(channel) || configured().includes((await parentOf(channel)) ?? "");
  // Thread id -> parent channel; null marks a channel that is not a thread. Fed by gateway thread events and REST.
  const parents = new Map<string, string | null>();
  const lookups = new Map<string, Promise<string | null>>();
  const parentOf = (channel: string): Promise<string | null> => {
    const known = parents.get(channel);
    if (known !== undefined) return Promise.resolve(known);
    let pending = lookups.get(channel);
    if (!pending) {
      pending = discord.call("GET", `/channels/${channel}`).then(
        (value) => discordThread(value)?.parent ?? null,
        (error: unknown) => {
          // Channels the bot cannot read are cached as foreign; other failures retry on the next message.
          if (error instanceof MessengerError && (error.status === 403 || error.status === 404)) return null;
          throw error;
        },
      ).then((parent) => {
        if (!parents.has(channel)) parents.set(channel, parent);
        return parents.get(channel) ?? null;
      }).finally(() => { lookups.delete(channel); });
      lookups.set(channel, pending);
    }
    return pending;
  };
  const catchup = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    catchupRequested = true;
    if (polling) return polling;
    polling = (async () => {
      while (catchupRequested && !stopped) {
        catchupRequested = false;
        lastPoll = deps.clock.now();
        try {
          watched = discordChannels(configuredChannels, await deps.registry.open());
          let threads: string[] = [];
          let floor: string | undefined;
          try {
            const active = await listDiscordThreads(discord, config.guildId);
            for (const thread of active) parents.set(thread.id, thread.parent);
            const parentsWatched = configured();
            threads = active.filter((thread) => parentsWatched.includes(thread.parent) && !watched.includes(thread.id)).map((thread) => thread.id);
            floor = await discordThreadFloor(statePath, deps.clock.now(), log);
          } catch {
            threads = [];
            log("INBOUND_ERROR cannot list active Discord threads");
          }
          for (const channel of [...watched, ...threads]) {
            if (stopped) break;
            try {
              await pollDiscordInbound(deps.run, [channel], statePath, options.emit,
                (ch, after) => listDiscordInbound(discord, ch, after, deps.config.discordFirstSeenLimit), config.ownerId,
                watched.includes(channel) ? undefined : floor, inboundOptions);
            } catch {
              log(`INBOUND_ERROR ${channel} REST catch-up failed`);
            }
          }
        } catch {
          log("INBOUND_ERROR cannot read watched Discord channels");
        }
      }
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const registration = commands.register().catch(() => { log("DISCORD_COMMANDS_ERROR guild command registration failed"); });
  // Resuming the session the previous supervisor left makes Discord replay what arrived while no process was connected,
  // a close-button click during a restart included.
  const resume = takeGatewaySession(deps.config.stateDir, deps.clock.now());
  if (resume) log("DISCORD_GATEWAY resuming the previous supervisor's session");
  const gateway = discordPresence(options.open ?? openDiscordGateway, options.token, options.timers ?? realTimers,
    (data) => commands.handle(data), {
      messageContent: true,
      ...(resume ? { resume } : {}),
      log,
      onReady: catchup,
      // The gateway has stopped for good (bad token, intents or sharding): the lead hears it once; REST catch-up keeps polling.
      onFatal: (code, reason) => {
        void options.emit(`discord-gateway-fatal:${code}:${deps.clock.now()}`, `DISCORD_GATEWAY_FATAL close=${code} ${reason} reconnect stopped; fix the bot token or intents, then restart the supervisor`)
          .catch(() => { log(`DISCORD_GATEWAY_ERROR cannot queue DISCORD_GATEWAY_FATAL close=${code}`); });
      },
      onDispatch: (type, data) => {
        if (type === "READY" && typeof data === "object" && data !== null && "user" in data) {
          const user: unknown = data.user;
          if (typeof user === "object" && user !== null && "id" in user && typeof user.id === "string") botId = user.id;
        }
        for (const thread of discordDispatchThreads(type, data)) parents.set(thread.id, thread.parent);
      },
      onMessage: async (value) => {
        if (stopped) return;
        const channel = discordMessageChannel(value);
        if (!channel) return;
        if (await watches(channel)) await emitDiscordInbound(channel, parseDiscordMessage(value), options.emit, config.ownerId, inboundOptions);
      },
      onMessageUpdate: async (value) => {
        if (stopped) return;
        const channel = discordMessageChannel(value);
        if (channel && await watches(channel)) await emitDiscordEdit(channel, value, options.emit, config.ownerId, inboundOptions);
      },
      onMessageDelete: async (value) => {
        if (stopped || typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return;
        const channel = ownerMessages.get(value.id);
        if (!channel || discordMessageChannel(value) !== channel) return;
        ownerMessages.delete(value.id);
        await emitDiscordDelete(channel, value.id, options.emit);
      },
    });
  return {
    /** Gateway state for the heartbeat file. */
    state: () => ({ connected: gateway.connected, messageContent: gateway.messageContent }),
    async tick(): Promise<void> {
      const channels = discordChannels(configuredChannels, await deps.registry.open());
      if (polling) { await polling; return; }
      const newChannel = channels.some((channel) => !watched.includes(channel));
      const interval = gateway.healthy ? deps.config.discordSafetyPollSeconds * 1_000 : 5_000;
      if (newChannel || deps.clock.now() - lastPoll >= interval) await catchup();
    },
    async close(): Promise<void> {
      stopped = true;
      gateway.close();
      const session = gateway.session();
      if (session) {
        try { saveGatewaySession(deps.config.stateDir, session, deps.clock.now()); }
        catch { log("DISCORD_GATEWAY_ERROR cannot save the gateway session for the next supervisor"); }
      }
      await gateway.settled();
      await polling;
      await registration;
    },
  };
};
