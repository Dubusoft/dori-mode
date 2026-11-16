import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { ack, AckError, AWAITING_NOTE_MAX, handled } from "./ack.ts";
import { alertsChannelOf } from "./config.ts";
import { envFilePath, resolveCredential } from "./credentials.ts";
import type { FlowDeps } from "./done-flow.ts";
import { staleOwnerEvents, unreadAfterAck } from "./inbox.ts";
import { oneLine } from "./lane-report-store.ts";
import { buttonRow } from "./messenger/discord-buttons.ts";
import { discordOwnerConfigured } from "./messenger/discord-inbound.ts";
import { Discord } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { discordThreadOf, resolveTarget } from "./messenger/target.ts";
import { realClock } from "./run.ts";

const redirectClosedThread = async (
  discord: Discord, thread: string, text: string, parent: string | undefined, owner: string | undefined,
  line: (thread: string, text: string) => string, missing: () => never, components?: readonly unknown[],
): Promise<{ message: string; target: string }> => {
  const target = parent ?? owner ?? missing();
  const message = await discord.send(target, line(thread, text), randomUUID(), components);
  return { message, target };
};

export type DiscordCliDeps = {
  readonly flow: FlowDeps;
  readonly die: (message: string, code?: number) => never;
  readonly messengerToken: (name: string) => string;
  /** The CLI's shared flags (parsed from the arguments after the command), with its opt/need readers and first positional. */
  readonly flags: { readonly values: { readonly [name: string]: unknown }; readonly positionals: readonly string[] };
  readonly opt: (name: string) => string | undefined;
  readonly need: (name: string) => string;
  readonly key: string | undefined;
};

/** The Discord message commands: `dori ack|handled|reported|send|thread|typing`, `args` starting with the command. */
export const discordMain = async (args: string[], { flow: deps, die, messengerToken, flags, opt, need, key }: DiscordCliDeps): Promise<number> => {
  const [command = "", ...rest] = args;
  const { config } = deps;
  /** Posts `text` to a resolved Discord target and returns the new message's id. */
  const postMessage = async (to: string, text: string, components?: readonly unknown[]): Promise<string> =>
    // Each post is its own message: without a unique id Discord would dedupe a repeat of the same text.
    new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN")).send(to, text, randomUUID(), components);

  switch (command) {
    case "ack": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { tasks: { type: "string" } } });
      // Each message is named explicitly as a <channel> <messageId> pair; --tasks applies to one message only.
      const pairs = parsed.positionals;
      if (!pairs.length || pairs.length % 2 || (pairs.length > 2 && parsed.values.tasks !== undefined)) {
        die("usage: dori ack <channel> <messageId> [<channel> <messageId> ...] [--tasks N, one message only]");
      }
      const tasks = parsed.values.tasks === undefined ? undefined : Number(parsed.values.tasks);
      let discord: Discord | undefined;
      for (let i = 0; i < pairs.length; i += 2) {
        const [channel = "", message = ""] = [pairs[i], pairs[i + 1]];
        discord ??= new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`));
        await ack(config.stateDir, discord, channel, message, realClock.now(), tasks);
        console.log(`ACKED ${channel} ${message}`);
      }
      // Read-only: unread owner events in the acked channels, so follow-ups are seen before the reply. Never fails the ack.
      const acked: { channel: string; message: string }[] = [];
      for (let i = 0; i < pairs.length; i += 2) acked.push({ channel: pairs[i] ?? "", message: pairs[i + 1] ?? "" });
      for (const line of unreadAfterAck(config.stateDir, acked)) console.log(line);
      break;
    }
    case "reported": {
      // `dori reported <key> --text T`: post lane <key>'s outcome to the owner (the lane's thread unless --to/--thread),
      // then record the receipt. A failed post records nothing, so the obligation stays open.
      const { recordReported } = await import("./lane-outcomes.ts");
      const options = ["text", "append", "to", "thread", "note"];
      const final = flags.values.final === true;
      const append = opt("append");
      if (!key || flags.positionals.length > 1 || Object.keys(flags.values).some((name) => !options.includes(name) && name !== "final") || options.some((name) => name in flags.values && !opt(name))
        || !opt("text") === (append === undefined) || (append !== undefined && (final || "to" in flags.values || "thread" in flags.values))) {
        die("usage: dori reported <key> --text TEXT [--to TARGET] [--thread ID] [--note TEXT] | dori reported <key> --append TEXT [--note TEXT]");
      }
      const found = (await deps.registry.read(key ?? "")) ?? die(`no registered lane "${key}"`);
      const followUps = await import("./thread-followup.ts");
      const discord = new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN"));
      const owner = config.discordChannels[0];
      const note = opt("note");
      const receipt = (posted: { message: string; target: string; thread?: string; button?: boolean; followUp?: boolean }): void => {
        recordReported(config.stateDir, found.key, realClock.now(), note ? oneLine(note) : undefined, posted);
      };
      const redirect = async (thread: string, text: string, parent: string | undefined): Promise<void> => {
        const { message, target } = await redirectClosedThread(
          discord, thread, text, parent, owner, followUps.closedThreadLine,
          () => die(`REPORT_NOT_POSTED ${found.key}: thread ${thread} was closed by the owner, its parent channel is unknown and no discordChannels entry names the owner channel; nothing recorded`),
        );
        receipt({ message, target: `discord:${target}`, followUp: true });
        console.log(`REPORT_REDIRECTED ${found.key} ${message}: thread ${thread} was closed by the owner, so one line linking it went to ${parent ? "its parent channel" : "the owner channel"} ${target}`);
      };
      if (append !== undefined) {
        // The follow-up edits the lane's last report (else its [System] status message): nothing new lands in the thread.
        const status = found.statusMessageId && found.thread.startsWith("discord:") ? { channel: resolveTarget("discord", found.thread).to, message: found.statusMessageId } : undefined;
        const last = followUps.readLastReports(config.stateDir)[found.key] ?? status
          ?? die(`REPORT_APPEND_NO_MESSAGE ${found.key}: this lane has no report or status message to append to; post the report with --text`);
        const closed = await followUps.closedByOwner(config.stateDir, discord, last.channel);
        if (closed) { await redirect(last.channel, append, closed.parent); break; }
        const archived = await discord.threadArchived(last.channel).catch(() => false);
        if (!(await followUps.appendToMessage(discord, last.channel, last.message, append, archived))) {
          die(`REPORT_APPEND_TOO_LONG ${found.key}: the report with this text would pass Discord's message limit; shorten it, or post a new report with --text`);
        }
        receipt({ message: last.message, target: `discord:${last.channel}`, followUp: true });
        console.log(`REPORT_APPENDED ${found.key} ${last.message}`);
        break;
      }
      const bound = found.thread && found.thread !== "none" ? found.thread : undefined;
      const ref = opt("to") ?? bound ?? die(`lane ${key} has no bound thread; name where to post with --to TARGET (a thread ref such as discord:<channel>/<thread>)`);
      // A Discord ref posts there; a bare --to id posts on Discord only when the lane's bound thread is a Discord one.
      const isDiscord = (r: string | undefined): boolean => r?.startsWith("discord:") === true;
      if (!isDiscord(ref) && (ref.includes(":") || !isDiscord(bound))) die(`cannot tell the platform of "${ref}"; use a thread ref such as discord:<channel>/<thread>`);
      const platform = "discord";
      const { to, thread } = resolveTarget(platform, ref, opt("thread"));
      // No report carries a close button: `dori supervise` closes the thread itself once its work is finished and
      // reported. `--final` (from older leads) is accepted and changes nothing.
      // `discord:<thread>` and a bare thread id count as a thread too, unless the id is a configured channel.
      const threadId = opt("thread") ?? discordThreadOf(ref, config.discordChannels);
      const closed = threadId === to ? await followUps.closedByOwner(config.stateDir, discord, to) : undefined;
      if (closed) { await redirect(to, opt("text") ?? "", closed.parent); break; }
      const message = await postMessage(to, opt("text") ?? "");
      if (!message) die(`REPORT_NOT_POSTED ${key}: ${platform} returned no message id; nothing recorded`);
      // The message a later --append edits.
      if (threadId === to) followUps.recordLastReport(config.stateDir, found.key, { channel: to, message, at: realClock.now() });
      // The lane's thread for the supervisor's automatic close: its bound thread, else the thread this report went into.
      const laneThread = (bound && isDiscord(bound) ? discordThreadOf(bound, config.discordChannels) : undefined) ?? (threadId === to ? to : undefined);
      receipt({ message, target: `${platform}:${to}${thread ? `/${thread}` : ""}`, ...(laneThread ? { thread: laneThread } : {}) });
      console.log(`REPORTED_RECORDED ${found.key} ${message}`);
      break;
    }
    case "handled": {
      const parsed = parseArgs({
        args: rest, allowPositionals: true,
        options: {
          lane: { type: "string", multiple: true }, reply: { type: "boolean" }, all: { type: "boolean" }, tasks: { type: "string" },
          awaiting: { type: "boolean" }, note: { type: "string" },
        },
      });
      const [channel, message, ...extra] = parsed.positionals;
      if (!channel || !message || extra.length) die("usage: dori handled <channel> <messageId> [--tasks N] [--lane key ...] [--reply] [--all] [--awaiting [--note TEXT]]");
      for (const key of parsed.values.lane ?? []) {
        if (!(await deps.registry.read(key))) die(`no registered lane "${key}"`);
      }
      const reply = parsed.values.reply === true;
      // A message the lead never acked is acked here first (hourglass off, eyes on), with a warning; a failed ack never
      // blocks the link.
      const discord = (): Discord => new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ??
        (() => { throw new AckError(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`); })());
      const outcome = await handled(config.stateDir, discord, channel ?? "", message ?? "", realClock.now(), {
        tasks: parsed.values.tasks === undefined ? undefined : Number(parsed.values.tasks),
        lanes: parsed.values.lane, reply, ...(parsed.values.all ? { all: true } : {}),
        ...(parsed.values.awaiting ? { awaiting: true } : {}),
        ...(parsed.values.note !== undefined ? { note: oneLine(parsed.values.note).slice(0, AWAITING_NOTE_MAX) } : {}),
      });
      if (outcome.autoAck === "acked") console.log(`HANDLED_AUTO_ACKED ${channel} ${message}: no dori ack before dori handled, so it was acked now; run dori ack first next time`);
      if (outcome.autoAck === "failed") console.error(`HANDLED_AUTO_ACK_FAILED ${channel} ${message}: no dori ack before dori handled and acking it now failed (${outcome.error}); handled is recorded anyway`);
      console.log(parsed.values.awaiting ? `HANDLED_AWAITING ${channel} ${message}` : `HANDLED_LINKED ${channel} ${message}`);
      break;
    }
    case "send": {
      const platform = key ?? "discord";
      if (platform !== "discord") die(`unknown platform ${platform}`);
      // `--to alerts`: the system-notice channel (config alertsChannel, else the main channel), read from the config now.
      const target = need("to");
      const ref = target === "alerts" ? alertsChannelOf(config) ?? die("SEND_NOT_POSTED --to alerts: neither alertsChannel nor discordChannels is configured") : target;
      const { to } = resolveTarget("discord", ref, opt("thread"));
      const text = need("text");
      const edit = opt("edit");
      const buttons = opt("buttons");
      if (buttons !== undefined && edit) die("--buttons cannot be used with --edit");
      let components: unknown[] | undefined;
      try { components = buttons === undefined ? undefined : buttonRow(buttons); } catch (e) { die(e instanceof Error ? e.message : String(e)); }
      if (!edit) {
        if (flags.values.force !== true) {
          const stale = staleOwnerEvents(config.stateDir, to);
          if (stale.count) {
            console.log(`SEND_STALE ${stale.count}`);
            for (const line of stale.lines) console.log(line);
            process.exit(3);
          }
        }
      }
      const discord = new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN"));
      const { closedByOwner, closedThreadLine } = await import("./thread-followup.ts");
      const closed = await closedByOwner(config.stateDir, discord, to);
      if (closed && flags.values["no-redirect"] === true) {
        console.log(`SEND_NOT_REDIRECTED ${to}: thread ${to} was closed by the owner and --no-redirect is set, so nothing was posted`);
        process.exit(5);
      }
      if (closed) {
        const { message: sent, target } = await redirectClosedThread(
          discord, to, text, closed.parent, config.discordChannels[0], closedThreadLine,
          () => die(`SEND_NOT_POSTED thread ${to} was closed by the owner, its parent channel is unknown and no discordChannels entry names the owner channel`),
          components,
        );
        console.log(`SENT_REDIRECTED ${sent}: thread ${to} was closed by the owner, so one line linking it went to ${closed.parent ? "its parent channel" : "the owner channel"} ${target}`);
        break;
      }
      if (!edit) {
        const sent = await postMessage(to, text, components);
        console.log(`SENT ${sent}`);
      } else await discord.edit(to, edit, text);
      break;
    }
    case "thread": {
      // `dori thread [discord] --to CHANNEL [--message ID] --name NAME`: start a thread (on a message, else standalone) and
      // make discord.ownerId a member. The thread ref is printed either way; a failed add prints THREAD_OWNER_FAILED and exits 1.
      if ((key ?? "discord") !== "discord") die(`unknown platform ${key}`);
      if (flags.positionals.length > 1 || Object.keys(flags.values).some((name) => !["to", "message", "name", "drop-notice"].includes(name))) {
        die("usage: dori thread [discord] --to CHANNEL [--message ID] --name NAME [--drop-notice]");
      }
      const { to } = resolveTarget("discord", need("to"));
      const owner = config.discord?.ownerId;
      if (!discordOwnerConfigured(owner)) console.error("THREAD_OWNER_SKIPPED discord.ownerId is not configured; the thread is created without adding the owner");
      const discord = new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN"));
      const { id, member } = await discord.startThread(to, opt("message"), need("name"), discordOwnerConfigured(owner) ? owner : undefined);
      console.log(`THREAD discord:${to}/${id}`);
      // --drop-notice: the channel keeps no "started a thread" line; a failed delete only warns, the thread is usable.
      if (flags.values["drop-notice"] === true) {
        const { removeThreadNotice } = await import("./owner-decisions.ts");
        const kept = await removeThreadNotice(discord, to, id);
        if (kept) console.error(`THREAD_NOTICE_KEPT ${id}: the "started a thread" notice could not be deleted (${kept}); the thread is created and usable`);
        else console.log(`THREAD_NOTICE_REMOVED ${id}`);
      }
      if (member === "added") console.log(`THREAD_OWNER_ADDED ${id}`);
      else if (member === "already") console.log(`THREAD_OWNER_ALREADY_MEMBER ${id}: Discord joined the owner as the thread started (the starter message mentions them), so no "added" line shows`);
      else if (member !== "skipped") {
        console.log(`THREAD_OWNER_FAILED ${id} ${owner}: ${member.failed}`);
        process.exitCode = 1;
      }
      break;
    }
    case "typing": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { off: { type: "boolean" } } });
      const [target, ...extra] = parsed.positionals;
      const on = parsed.values.off !== true;
      const channel = target === "discord" ? extra[0] : target;
      if (channel && extra.length === (target === "discord" ? 1 : 0) && on) {
        const { to, thread } = resolveTarget("discord", channel);
        const id = thread ?? to;
        const dc = new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`));
        await dc.typing(id);
        console.log(`TYPING discord ${id} on`);
      } else die("usage: dori typing [discord] <channel>");
      break;
    }
  }
  return 0;
};
