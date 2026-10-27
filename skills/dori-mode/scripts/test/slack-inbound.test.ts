import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

const SELF = "U_DORI";
const state = withState();
afterEach(() => {});

type Workspace = { replies: Record<string, { ts: string; user?: string; text: string; bot_id?: string }[]>; view: unknown[]; counts: Record<string, unknown>; nextTs: number };

const slackFake = (w: Workspace, onReplies?: () => Promise<void>) => {
  const calls: string[] = [];
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const method = req.url.split("/").pop() ?? "";
    calls.push(method);
    const p = JSON.parse(String(req.body ?? "{}")) as Record<string, unknown>;
    const body = (b: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, ...(b as object) }) });
    if (method === "chat.postMessage") {
      const ts = `${w.nextTs++}.000100`;
      const root = typeof p.thread_ts === "string" ? p.thread_ts : ts;
      (w.replies[`${p.channel}:${root}`] ??= []).push({ ts, user: SELF, text: String(p.text) });
      return body({ channel: p.channel, ts });
    }
    if (method === "conversations.replies") {
      await onReplies?.();
      const all = w.replies[`${p.channel}:${p.ts}`] ?? [];
      return body({ messages: all.filter((m) => Number(m.ts) > Number(p.oldest ?? 0)) });
    }
    if (method === "subscriptions.thread.getView") return body({ threads: w.view });
    if (method === "client.counts") return body(w.counts);
    return body({});
  };
  return { http, calls };
};

const setup = (name: string, onReplies?: () => Promise<void>) => {
  const w: Workspace = { replies: {}, view: [], counts: { channels: [], ims: [], mpims: [] }, nextTs: 1000 };
  const { http, calls } = slackFake(w, onReplies);
  const ledger = new ThreadLedger(join(state.dir, `${name}.json`));
  const slack = new Slack(http, fakeClock(0), { token: "t" }, "https://slack.test/api", ledger);
  return { w, slack, ledger, calls };
};

test("a guest's untagged reply in a thread the Dori started through a raw API call is still picked up", async () => {
  const { w, slack, ledger } = setup("raw-root");
  const root = (await slack.call("chat.postMessage", { channel: "C1", text: "Kicking off the release checklist" })) as { ts: string };
  w.replies[`C1:${root.ts}`]?.push({ ts: "2000.000100", user: "U_GUEST", text: "the staging deploy is red" });
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got).toEqual([{ source: "own-thread", channel: "C1", ts: "2000.000100", threadTs: root.ts, user: "U_GUEST", text: "the staging deploy is red" }]);
  expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toEqual([]);
});

test("a reply the Dori posts into someone else's thread also makes that thread watched, and its own messages are never inbound", async () => {
  const { w, slack, ledger } = setup("reply");
  w.replies["C2:500.000100"] = [{ ts: "500.000100", user: "U_OWNER", text: "can you check this?" }];
  await slack.post("C2", "on it", "500.000100");
  w.replies["C2:500.000100"]?.push({ ts: "3000.000100", user: "U_OWNER", text: "thanks, also the logs" }, { ts: "3001.000100", bot_id: "B1", user: "U_BOT", text: "automated" });
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got.map((g) => [g.source, g.ts, g.user])).toEqual([["own-thread", "3000.000100", "U_OWNER"]]);
});

test("unread replies from the threads view and DMs with unreads are surfaced, each message once", async () => {
  const { w, slack, ledger } = setup("view");
  w.view = [{ root_msg: { channel: "C3", ts: "10.1", user: "U_OWNER" }, unread_replies: [{ ts: "11.1", thread_ts: "10.1", user: "U_TEAM", text: "ping" }, { ts: "12.1", thread_ts: "10.1", user: SELF, text: "mine" }] }];
  w.counts = { channels: [{ id: "C9", has_unreads: true, mention_count: 0 }, { id: "C8", has_unreads: true, mention_count: 2 }], ims: [{ id: "D1", has_unreads: true, mention_count: 1 }], mpims: [] };
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got.map((g) => `${g.source}:${g.channel}:${g.ts}`)).toEqual(["threads-view:C3:11.1", "unread:D1:", "unread:C8:"]);
});

test("the thread ledger survives a restart: a new process still watches threads posted before it", async () => {
  const a = setup("restart");
  const root = (await a.slack.post("C4", "starting the migration")).ts;
  const fresh = new ThreadLedger(join(state.dir, "restart.json"));
  expect((await fresh.list()).map((t) => `${t.channel}:${t.rootTs}`)).toEqual([`C4:${root}`]);
});

const seedThreads = async (w: Workspace, ledger: ThreadLedger, channel: string, roots: string[]) => {
  for (const root of roots) {
    await ledger.record(channel, root, root);
    w.replies[`${channel}:${root}`] = [{ ts: `${Math.floor(Number(root)) + 1}.000100`, user: "U_GUEST", text: "hi" }];
  }
};

test("one poll over several threads writes the ledger once, and a poll that finds nothing new writes nothing", async () => {
  const { w, slack, ledger } = setup("batch");
  await seedThreads(w, ledger, "C6", ["100.000100", "200.000100", "300.000100"]);
  const file = join(state.dir, "batch.json");
  const writes: string[] = [];
  const orig = Bun.write;
  (Bun as { write: unknown }).write = (dest: unknown, ...rest: unknown[]) => {
    writes.push(String(dest));
    return (orig as (...a: unknown[]) => unknown)(dest, ...rest);
  };
  try {
    expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toHaveLength(3);
    expect(writes.filter((p) => p.startsWith(file))).toHaveLength(1);
    writes.length = 0;
    expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toEqual([]);
    expect(writes).toEqual([]);
  } finally {
    (Bun as { write: unknown }).write = orig;
  }
  expect((await new ThreadLedger(file).list()).map((t) => t.seenTs)).toEqual(["101.000100", "201.000100", "301.000100"]);
});

test("a poll that fails midway still flushes the cursors it already advanced", async () => {
  const { w, slack, ledger } = setup("errflush");
  await seedThreads(w, ledger, "C7", ["100.000100"]);
  const orig = slack.call.bind(slack);
  slack.call = async (m, p) => {
    if (m === "client.counts") throw new Error("boom");
    return orig(m, p);
  };
  await expect(pollSlackInbound(slack, ledger, { selfUserId: SELF })).rejects.toThrow("boom");
  expect((await new ThreadLedger(join(state.dir, "errflush.json")).list()).map((t) => t.seenTs)).toEqual(["101.000100"]);
});

test("thread replies are fetched in parallel but never more than four at once, and results keep thread order", async () => {
  let inFlight = 0;
  let peak = 0;
  const gate = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    inFlight--;
  };
  const { w, slack, ledger } = setup("pool", gate);
  const roots = Array.from({ length: 10 }, (_, i) => `${(i + 1) * 100}.000100`);
  await seedThreads(w, ledger, "C8", roots);
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(peak).toBe(4);
  expect(got.map((g) => g.threadTs)).toEqual(roots);
});
