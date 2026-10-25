import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { discordSnowflakeAt, emitDiscordInbound, parseDiscordMessage } from "../src/messenger/discord-inbound.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { toodoConfigError } from "../src/messenger/toodo.ts";
import { mirrorDiscord, toodoMirror, TOODO_MIRROR_FILE } from "../src/messenger/toodo-mirror.ts";
import { supervisorToodo } from "../src/messenger/toodo-supervisor.ts";
import { redactSecrets } from "../src/redact.ts";
import { fakeClock, withState } from "./fakes.ts";
import { fakeToodoState, fileToodo } from "./fixtures/toodo-fake.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const START = 1_800_000_000_000;
const CHANNEL = "900";
const OWNER = "111";
const BOT = "222";
const VISITOR = "333";
const WEBHOOK = "https://discord.com/api/webhooks/77/webhook-token-for-tests";

type Post = { id: string; content: string; author: { id: string; username: string; bot?: boolean }; webhook_id?: string; username?: string; avatar_url?: string; nonce?: string };

/** The mirror channel as Discord would keep it, behind the bot REST API and the channel webhook. */
const fakeChannel = () => {
  let next = BigInt(discordSnowflakeAt(START)) + 1_000n;
  const posts: Post[] = [];
  const id = (): string => String(next++);
  const ok = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  let failWebhook: "before" | "after" | undefined;
  const http: Http = async (req: HttpRequest) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body) as Record<string, string> : {};
    if (req.method === "POST" && req.url === `${WEBHOOK}?wait=true`) {
      if (failWebhook === "before") { failWebhook = undefined; throw new Error("killed before Discord got the post"); }
      const post: Post = { id: id(), content: body.content ?? "", author: { id: "77", username: body.username ?? "", bot: true }, webhook_id: "77", username: body.username, avatar_url: body.avatar_url };
      posts.push(post);
      if (failWebhook === "after") { failWebhook = undefined; throw new Error("killed after Discord stored the post"); }
      return ok(post);
    }
    if (req.method === "POST" && req.url === `https://discord.com/api/v10/channels/${CHANNEL}/messages`) {
      // enforce_nonce: a repeated nonce returns the message it created.
      const known = posts.find((p) => p.nonce !== undefined && p.nonce === body.nonce);
      if (known) return ok(known);
      const post: Post = { id: id(), content: body.content ?? "", author: { id: BOT, username: "dori", bot: true }, nonce: body.nonce };
      posts.push(post);
      return ok(post);
    }
    if (req.method === "GET" && req.url === `https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=50`) return ok([...posts].reverse().slice(0, 50));
    if (req.method === "GET" && req.url === `https://discord.com/api/v10/users/${OWNER}`) return ok({ id: OWNER, username: "owner", global_name: "Owner Name", avatar: "abc" });
    return { status: 404, headers: {}, body: `unexpected ${req.method} ${req.url}` };
  };
  /** A message written in Discord by someone (not through the bot or the webhook). */
  const write = (author: string, content: string): Post => {
    const post: Post = { id: id(), content, author: { id: author, username: author === OWNER ? "owner" : author === BOT ? "dori" : "visitor", ...(author === BOT ? { bot: true } : {}) } };
    posts.push(post);
    return post;
  };
  return { http, posts, write, failNextWebhook: (when: "before" | "after") => { failWebhook = when; } };
};

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(START);
  const channel = fakeChannel();
  const toodoFile = join(state.dir, "toodo-fake.json");
  const webhookFile = join(state.dir, "webhook-url");
  writeFileSync(webhookFile, `${WEBHOOK}\n`);
  writeFileSync(toodoFile, JSON.stringify({ messages: [{ id: 1, author: "user", body: "from before the mirror", at: 0 }], events: [], typing: false, calls: [] }));
  const toodo = fileToodo(toodoFile);
  const add = (message: { id: number; author: string; body: string; origin?: string; taken?: boolean }) => {
    const s = fakeToodoState(toodoFile);
    s.messages.push({ at: 0, ...message });
    writeFileSync(toodoFile, JSON.stringify(s));
  };
  let wakes = 0;
  const mirror = () => toodoMirror({
    channel: CHANNEL, stateDir: state.dir, now: clock.now, log: () => {}, wake: () => { wakes++; },
    discord: mirrorDiscord(new Discord(channel.http, clock, "bot-token"), { channel: CHANNEL, webhookUrlFile: webhookFile }, OWNER),
  });
  /** Inbound lines by journal key: the durable queue keeps one event per key. */
  const inbound = new Map<string, string>();
  /** Delivers channel posts to the inbound side the way the gateway and the REST catch-up do. */
  const deliver = async (m: ReturnType<typeof mirror>, posts: readonly Post[]) => {
    for (const post of posts) {
      await emitDiscordInbound(CHANNEL, parseDiscordMessage({ ...post, attachments: [] }), async (key, line) => { if (!inbound.has(key)) inbound.set(key, line); }, OWNER, { botId: BOT, onMirror: m.record });
    }
  };
  const imports = () => fakeToodoState(toodoFile).calls.filter((c) => c.startsWith("import "));
  return { state, clock, channel, toodo, toodoFile, add, mirror, inbound, deliver, imports, wakes: () => wakes };
};

test("Toodo to Discord: the owner's message through the webhook under their name, the lead's reply as a bot post, once each", async () => {
  const f = fixture();
  const mirror = f.mirror();
  await mirror.pass(f.toodo);
  expect(f.channel.posts).toEqual([]);

  f.add({ id: 2, author: "user", body: "ship it, token=abcd1234efgh" });
  f.add({ id: 3, author: "lead", body: "Shipping now." });
  f.add({ id: 4, author: "system", body: "Task 5 finished" });
  f.add({ id: 5, author: "user", body: "written in another chat", origin: "matrix", taken: true });
  await mirror.pass(f.toodo);
  await mirror.pass(f.toodo);

  expect(f.channel.posts.map((p) => ({ content: p.content, webhook: p.webhook_id !== undefined, username: p.username, avatar: p.avatar_url }))).toEqual([
    { content: "ship it, token=[REDACTED]\n-# via Toodo #2", webhook: true, username: "Owner Name", avatar: `https://cdn.discordapp.com/avatars/${OWNER}/abc.png` },
    { content: "Shipping now.\n-# via Toodo #3", webhook: false, username: undefined, avatar: undefined },
  ]);

  // The copies come back through the gateway and the REST catch-up: none reaches the lead or is imported into Toodo.
  await f.deliver(mirror, f.channel.posts);
  await mirror.pass(f.toodo);
  expect([...f.inbound.values()]).toEqual([]);
  expect(f.imports()).toEqual([]);
  expect(f.channel.posts).toHaveLength(2);
});

test("Discord to Toodo: the owner's message reaches the lead once and is imported once; the bot's own post is imported as the lead's", async () => {
  const f = fixture();
  const mirror = f.mirror();
  const enqueued: string[] = [];
  const source = supervisorToodo({
    toodo: () => f.toodo, enqueue: (id, line) => { enqueued.push(`${id} ${line}`); return true; }, stateDir: f.state.dir, now: f.clock.now, pollMs: 60_000, mirror,
  });
  await source.pass();
  enqueued.length = 0;

  const confirm = f.channel.write(OWNER, "confirm 4821");
  const visitor = f.channel.write(VISITOR, "confirm 9999");
  const reply = f.channel.write(BOT, "Deleting the branch now.");
  // Gateway, then the REST catch-up after a reconnect: the same messages twice.
  await f.deliver(mirror, [confirm, visitor, reply]);
  await f.deliver(mirror, [confirm, visitor, reply]);
  expect(f.wakes()).toBe(2);

  expect([...f.inbound.values()]).toEqual([
    `INBOUND ${CHANNEL} ${confirm.id} owner confirm 4821`,
    expect.stringMatching(new RegExp(`^VISITOR ${CHANNEL} ${visitor.id} visitor `)),
  ]);

  await source.pass();
  await source.pass();
  const stored = fakeToodoState(f.toodoFile).messages.filter((m) => m.origin);
  // A typed confirmation is stored as a person's message (what Toodo's confirmation reads), already taken; the visitor's is not stored.
  expect(stored.map((m) => ({ author: m.author, body: m.body, origin: m.origin, originId: m.originId, taken: m.taken }))).toEqual([
    { author: "user", body: "confirm 4821", origin: "discord", originId: confirm.id, taken: true },
    { author: "lead", body: "Deleting the branch now.", origin: "discord", originId: reply.id, taken: true },
  ]);
  expect(f.imports()).toEqual([`import discord:${confirm.id}`, `import discord:${reply.id}`]);
  // The Toodo inbox gave the lead nothing (imported messages are taken), and nothing went back to Discord.
  expect(enqueued).toEqual([]);
  expect(f.channel.posts).toHaveLength(3);
});

test("an owner message in Toodo reaches the lead once, from the Toodo inbox; its webhook copy is dropped on the Discord side", async () => {
  const f = fixture();
  const mirror = f.mirror();
  const enqueued: string[] = [];
  const source = supervisorToodo({
    toodo: () => f.toodo, enqueue: (id, line) => { enqueued.push(`${id} ${line}`); return true; }, stateDir: f.state.dir, now: f.clock.now, pollMs: 60_000, mirror,
  });
  await source.pass();
  enqueued.length = 0;
  f.add({ id: 2, author: "user", body: "plan the release" });
  await source.pass();
  await f.deliver(mirror, f.channel.posts);
  await source.pass();
  expect(enqueued).toEqual(["toodo:chat:2 INBOUND toodo 2 user plan the release"]);
  expect([...f.inbound.values()]).toEqual([]);
  expect(f.channel.posts.map((p) => p.content)).toEqual(["plan the release\n-# via Toodo #2"]);
});

test("restart: a post the process died in is found by its marker and not sent again; one Discord never got is sent once", async () => {
  const f = fixture();
  await f.mirror().pass(f.toodo);

  f.add({ id: 2, author: "user", body: "first" });
  f.channel.failNextWebhook("after");
  await expect(f.mirror().pass(f.toodo)).rejects.toThrow("killed after Discord stored the post");
  expect(JSON.parse(readFileSync(join(f.state.dir, TOODO_MIRROR_FILE), "utf8")).posting).toBe(2);

  // A new process over the same state.
  f.add({ id: 3, author: "user", body: "second" });
  await f.mirror().pass(f.toodo);
  expect(f.channel.posts.map((p) => p.content)).toEqual(["first\n-# via Toodo #2", "second\n-# via Toodo #3"]);

  f.add({ id: 4, author: "lead", body: "third" });
  f.channel.failNextWebhook("before");
  f.add({ id: 5, author: "user", body: "fourth" });
  await expect(f.mirror().pass(f.toodo)).rejects.toThrow("killed before Discord got the post");
  await f.mirror().pass(f.toodo);
  // A clean restart posts nothing again.
  await f.mirror().pass(f.toodo);
  expect(f.channel.posts.map((p) => p.content)).toEqual(["first\n-# via Toodo #2", "second\n-# via Toodo #3", "third\n-# via Toodo #4", "fourth\n-# via Toodo #5"]);
});

test("restart: Discord messages recorded but not yet stored in Toodo are imported by the next process, once", async () => {
  const f = fixture();
  const first = f.mirror();
  await first.pass(f.toodo);
  const owner = f.channel.write(OWNER, "check the deploy");
  await f.deliver(first, [owner]);
  // The process dies before its pass; the next one reads the recorded message from the state file.
  await f.mirror().pass(f.toodo);
  await f.deliver(f.mirror(), [owner]);
  await f.mirror().pass(f.toodo);
  expect(f.imports()).toEqual([`import discord:${owner.id}`]);
  expect(f.channel.posts).toHaveLength(1);
});

test("Discord messages from before the mirror was set up are not imported", async () => {
  const f = fixture();
  const mirror = f.mirror();
  await mirror.pass(f.toodo);
  const old = { id: String(BigInt(discordSnowflakeAt(START)) - 5n), content: "old", author: { id: OWNER, username: "owner" } };
  await f.deliver(mirror, [old]);
  await mirror.pass(f.toodo);
  expect(f.imports()).toEqual([]);
});

test("config: toodo.discordMirror names one channel and the webhook URL file", () => {
  const base = { url: "http://127.0.0.1:47616", leadTokenFile: "~/lead-token" };
  expect(toodoConfigError(base)).toBeUndefined();
  expect(toodoConfigError({ ...base, discordMirror: { channel: CHANNEL, webhookUrlFile: "~/.dori/mirror-webhook" } })).toBeUndefined();
  expect(toodoConfigError({ ...base, discordMirror: { channel: CHANNEL, webhookUrlFile: "x", ownerName: "Owner", ownerAvatarUrl: "https://example.com/a.png" } })).toBeUndefined();
  expect(toodoConfigError({ ...base, discordMirror: "900" })).toBe("toodo.discordMirror must be an object");
  expect(toodoConfigError({ ...base, discordMirror: { channel: "general", webhookUrlFile: "x" } })).toBe("toodo.discordMirror.channel must be a Discord channel id");
  expect(toodoConfigError({ ...base, discordMirror: { channel: CHANNEL } })).toBe("toodo.discordMirror.webhookUrlFile must name the file holding the channel's webhook URL");
  expect(toodoConfigError({ ...base, discordMirror: { channel: CHANNEL, webhookUrlFile: "x", ownerAvatarUrl: "http://example.com/a.png" } })).toBe("toodo.discordMirror.ownerAvatarUrl must be an https URL");
});

test("a Discord webhook URL is redacted from outbound text, and a webhook error never shows it", async () => {
  expect(redactSecrets(`posted via ${WEBHOOK}`)).toBe("posted via https://discord.com/api/webhooks/77/[REDACTED]");
  const discord = new Discord(async () => ({ status: 400, headers: {}, body: "bad request" }), fakeClock(START), "bot-token");
  const failure = await discord.executeWebhook(WEBHOOK, "hi", { username: "Owner" }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain("webhook-token-for-tests");
  await expect(discord.executeWebhook("https://example.com/hook", "hi", { username: "Owner" })).rejects.toThrow("not a Discord webhook URL");
});
