/**
 * One-off sweep for the "started a thread" notices (THREAD_CREATED, type 18) left in a channel body while
 * removeThreadNotice missed them. Lists by default; deletes only with --apply, and only a type 18 notice whose reference
 * names a thread of that same channel. Every other message is left alone.
 *
 *   bun src/thread-notice-sweep.ts <channel>           list the notices it would delete (and the type 18 ones it skips)
 *   bun src/thread-notice-sweep.ts <channel> --apply   delete those notices, then list again
 *   bun src/thread-notice-sweep.ts <channel> --qa      start a test thread, drop its notice, check the channel, archive it
 */
import { resolveCredential } from "./credentials.ts";
import { Discord } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { removeThreadNotice } from "./owner-decisions.ts";
import { realClock } from "./run.ts";

export type ChannelMessage = { readonly id: string; readonly type: number; readonly reference?: string };

export type SweepTransport = {
  /** Up to PAGE messages older than `before` (the newest when undefined), newest first, as Discord returns them. */
  messagesBefore(channel: string, before: string | undefined): Promise<readonly ChannelMessage[]>;
  threadState(threadId: string): Promise<{ readonly parent: string | undefined }>;
  deleteMessage(channel: string, messageId: string): Promise<void>;
};

const THREAD_CREATED = 18;
const PAGE = 100;

export type SweepResult = {
  readonly notices: readonly { readonly id: string; readonly thread: string }[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly deleted: readonly string[];
};

export const sweepThreadNotices = async (transport: SweepTransport, channel: string, apply: boolean): Promise<SweepResult> => {
  const candidates: ChannelMessage[] = [];
  for (let before: string | undefined; ;) {
    const page = await transport.messagesBefore(channel, before);
    candidates.push(...page.filter((m) => m.type === THREAD_CREATED));
    if (page.length < PAGE) break;
    before = page.at(-1)?.id;
  }
  const notices: { id: string; thread: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const m of candidates) {
    if (!m.reference) { skipped.push({ id: m.id, reason: "no thread reference" }); continue; }
    try {
      const { parent } = await transport.threadState(m.reference);
      if (parent === channel) notices.push({ id: m.id, thread: m.reference });
      else skipped.push({ id: m.id, reason: `thread ${m.reference} belongs to ${parent ?? "no channel"}` });
    } catch (e) {
      skipped.push({ id: m.id, reason: `thread ${m.reference} unreadable: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const deleted: string[] = [];
  if (apply) {
    for (const n of notices) {
      await transport.deleteMessage(channel, n.id);
      deleted.push(n.id);
    }
  }
  return { notices, skipped, deleted };
};

const discordSweepTransport = (discord: Discord): SweepTransport => ({
  messagesBefore: async (channel, before) => {
    const raw = await discord.call<readonly { id?: unknown; type?: unknown; message_reference?: { channel_id?: unknown } }[]>(
      "GET", `/channels/${channel}/messages?limit=${PAGE}${before ? `&before=${before}` : ""}`);
    return raw.map((m) => ({
      id: String(m.id), type: typeof m.type === "number" ? m.type : -1,
      ...(typeof m.message_reference?.channel_id === "string" ? { reference: m.message_reference.channel_id } : {}),
    }));
  },
  threadState: (threadId) => discord.threadState(threadId),
  deleteMessage: (channel, messageId) => discord.deleteMessage(channel, messageId),
});

const print = (label: string, result: SweepResult): void => {
  for (const n of result.notices) console.log(`${label} NOTICE ${n.id} thread=${n.thread}`);
  for (const s of result.skipped) console.log(`${label} SKIPPED ${s.id}: ${s.reason}`);
  console.log(`${label} NOTICES ${result.notices.length} SKIPPED ${result.skipped.length}`);
};

if (import.meta.main) {
  const [channel, flag, ...extra] = process.argv.slice(2);
  if (!channel || !/^\d+$/.test(channel) || extra.length || (flag !== undefined && flag !== "--apply" && flag !== "--qa")) {
    console.error("usage: bun src/thread-notice-sweep.ts <channel> [--apply | --qa]");
    process.exit(2);
  }
  const token = resolveCredential("DORI_DISCORD_TOKEN");
  if (!token) { console.error("DORI_DISCORD_TOKEN is not set"); process.exit(2); }
  const discord = new Discord(fetchHttp, realClock, token);
  const transport = discordSweepTransport(discord);
  if (flag === "--qa") {
    const { id } = await discord.startThread(channel, undefined, "[QA] thread notice", undefined, 60);
    console.log(`QA_THREAD ${id}`);
    const kept = await removeThreadNotice(discord, channel, id);
    const left = (await sweepThreadNotices(transport, channel, false)).notices.filter((n) => n.thread === id);
    await discord.setThread(id, { archived: true });
    console.log(`QA_ARCHIVED ${id}`);
    if (kept || left.length) { console.log(`QA_FAIL ${kept ?? `notice ${left.map((n) => n.id).join(",")} still in the channel`}`); process.exit(1); }
    console.log(`QA_PASS the notice for ${id} is gone from the channel`);
  } else {
    const result = await sweepThreadNotices(transport, channel, flag === "--apply");
    print(flag === "--apply" ? "BEFORE" : "DRY_RUN", result);
    if (flag === "--apply") {
      for (const id of result.deleted) console.log(`DELETED ${id}`);
      print("AFTER", await sweepThreadNotices(transport, channel, false));
    }
  }
}
