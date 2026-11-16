import { expect, test } from "bun:test";

import { Discord, discordPresence } from "../src/messenger/discord.ts";
import { type Http, type HttpRequest, type HttpResponse, UnsafeMessageError } from "../src/messenger/http.ts";
import { transcribe, TranscriptionError } from "../src/messenger/voice.ts";
import { fakeClock } from "./fakes.ts";

type Script = (req: HttpRequest, n: number) => HttpResponse;
const fakeHttp = (script: Script) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: JSON.stringify(body) });
const sleeps = () => {
  const waited: number[] = [];
  const clock = { ...fakeClock(0), sleep: async (ms: number) => { waited.push(ms); } };
  return { clock, waited };
};
const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: { setInterval: (cb: () => void) => { live.add(cb); return cb; }, clearInterval: (h: unknown) => { live.delete(h as () => void); } },
    fire: () => { for (const cb of live) cb(); },
  };
};

test("text carrying a $( substitution is refused before any request goes out", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: true }));
  const clock = sleeps().clock;
  await expect(new Discord(http, clock, "b").send("9", "x $(ls)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("Discord messages are sent without pinging anyone and edited in place; threads are named and archived", async () => {
  const { http, seen } = fakeHttp((req) => ok(req.method === "POST" && req.url.endsWith("/messages") ? { id: "M1" } : { id: "T1" }));
  const dc = new Discord(http, sleeps().clock, "b");
  expect(await dc.send("C1", "hello @everyone")).toBe("M1");
  await dc.edit("C1", "M1", "hello again");
  expect(await dc.startThread("C1", "M1", "[working] fix login")).toEqual({ id: "T1", member: "skipped" });
  await dc.setThread("T1", { name: "[done] fix login", archived: true });
  expect(JSON.parse(String(seen[0]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`)).toEqual(["POST /channels/C1/messages", "PATCH /channels/C1/messages/M1", "POST /channels/C1/messages/M1/threads", "PATCH /channels/T1"]);
});

test("startThread adds the owner, reports an owner Discord already joined, and returns a failed add instead of hiding it", async () => {
  const run = async (member: number, put: number) => {
    const { http, seen } = fakeHttp((req) => req.url.endsWith("/threads") ? ok({ id: "T1" }, 201)
      : req.method === "GET" ? ok(member === 200 ? { user_id: "42" } : { code: 10007 }, member)
      : ok(put === 204 ? "" : { message: "Missing Access" }, put));
    const result = await new Discord(http, sleeps().clock, "b").startThread("C1", "M1", "t", "42");
    return { result, calls: seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`) };
  };
  const added = await run(404, 204);
  expect(added.result).toEqual({ id: "T1", member: "added" });
  expect(added.calls).toEqual(["POST /channels/C1/messages/M1/threads", "GET /channels/T1/thread-members/42", "PUT /channels/T1/thread-members/42"]);
  const already = await run(200, 204);
  expect(already.result).toEqual({ id: "T1", member: "already" });
  expect(already.calls).not.toContain("PUT /channels/T1/thread-members/42");
  const failed = await run(404, 403);
  expect(failed.result.id).toBe("T1");
  expect(failed.result.member).toEqual({ failed: expect.stringContaining("403") });
});

test("a voice note becomes text through the configured hook, and a failing or empty transcription is an error", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, out: "  ship it  ", err: "" }; };
  expect(await transcribe(run, ["stt", "--file", "{file}"], "/tmp/v 1.ogg")).toBe("ship it");
  expect(calls[0]).toEqual(["stt", "--file", "/tmp/v 1.ogg"]);
  await expect(transcribe(async () => ({ code: 0, out: "", err: "" }), ["stt", "{file}"], "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
  await expect(transcribe(run, undefined, "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
});

test("Discord presence identifies as online after hello, heartbeats with the last sequence, and stops beating on close", () => {
  const sent: string[] = [];
  let onMsg: (d: string) => void = () => {};
  const t = fakeTimers();
  let closed = false;
  const p = discordPresence(() => ({ send: (d) => sent.push(d), close: () => { closed = true; }, onMessage: (cb) => { onMsg = cb; } }), "BOT", t.timers);
  onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  onMsg(JSON.stringify({ op: 0, s: 3, t: "READY", d: {} }));
  t.fire();
  const identify = JSON.parse(sent[0] ?? "{}");
  expect(identify.op).toBe(2);
  expect(identify.d.presence.status).toBe("online");
  expect(JSON.parse(sent[1] ?? "{}")).toEqual({ op: 1, d: 3 });
  p.close();
  expect(closed).toBe(true);
  expect(t.live.size).toBe(0);
});
