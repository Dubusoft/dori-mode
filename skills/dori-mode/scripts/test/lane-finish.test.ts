import { afterEach, expect, spyOn, test } from "bun:test";

import { postOwnerLine, type FinishDiscord } from "../src/lane-finish.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;

test("a lane-finish outbox row left by an older journal is dropped with one log line and never posted", async () => {
  const state = withState();
  cleanups.push(state.done);
  writeJournal(state.dir, {
    events: [],
    outbox: [
      { id: "lane-finish:x", text: JSON.stringify({ lane: "x", closed: "closed" }), retryAt: T0 + 60_000 },
      { id: "lead-stuck:1", text: "The lead is stuck." },
    ],
  });
  const posts: { text: string; id: string }[] = [];
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const supervisor = new Supervisor(depsFor(newWorld(), fakeClock(T0), state.dir), { announce: async (text, id) => { posts.push({ text, id }); } });
    cleanups.unshift(() => supervisor.close());
    await supervisor.reactionsSettled();
    expect(posts).toEqual([{ text: "The lead is stuck.", id: "lead-stuck:1" }]);
    expect(readJournal(state.dir).outbox ?? []).toEqual([]);
    expect(errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("lane-finish:x")))
      .toEqual(["OWNER_ANNOUNCE_DROPPED lane-finish:x: lane-finish lines are no longer posted"]);
  } finally { errors.mockRestore(); }
});

const fakeDiscord = (opts: { archived?: boolean; fail?: MessengerError | Error } = {}) => {
  const calls: string[] = [];
  const discord: FinishDiscord = {
    send: async (channel, text, id) => {
      if (opts.fail && channel !== "main") throw opts.fail;
      calls.push(`send ${channel} ${id} ${text}`);
      return "m1";
    },
    threadArchived: async (thread) => {
      if (opts.fail) throw opts.fail;
      calls.push(`archived? ${thread}`);
      return opts.archived ?? false;
    },
    setThread: async (thread, patch) => { calls.push(`set ${thread} ${JSON.stringify(patch)}`); },
  };
  return { discord, calls };
};

test("postOwnerLine: the lane thread first, the main channel without a Discord thread or when the thread is gone", async () => {
  const open = fakeDiscord();
  expect(await postOwnerLine(open.discord, "main", "discord:111/222", "hi", "lane-finish:a")).toBe("222");
  expect(open.calls).toEqual(["archived? 222", "send 222 lane-finish:a hi"]);

  // Posting reopens an archived thread, so it is archived again.
  const archived = fakeDiscord({ archived: true });
  await postOwnerLine(archived.discord, "main", "discord:111/222", "hi", "lane-finish:a");
  expect(archived.calls).toEqual(["archived? 222", "send 222 lane-finish:a hi", "set 222 {\"archived\":true}"]);

  const channel = fakeDiscord();
  expect(await postOwnerLine(channel.discord, "main", "discord:111", "hi", "x")).toBe("111");
  expect(channel.calls).toEqual(["send 111 x hi"]);

  for (const thread of [undefined, "none", "other:C1/123.4"]) {
    const plain = fakeDiscord();
    expect(await postOwnerLine(plain.discord, "main", thread, "hi", "x")).toBe("main");
    expect(plain.calls).toEqual(["send main x hi"]);
  }

  const gone = fakeDiscord({ fail: new MessengerError("discord GET /channels/222: 404", 404) });
  expect(await postOwnerLine(gone.discord, "main", "discord:111/222", "hi", "x")).toBe("main");
  expect(gone.calls).toEqual(["send main x hi"]);

  // Any other failure is the outbox's to retry: nothing goes to the main channel, so a retry cannot duplicate.
  const down = fakeDiscord({ fail: new MessengerError("discord GET /channels/222: 502", 502) });
  await expect(postOwnerLine(down.discord, "main", "discord:111/222", "hi", "x")).rejects.toThrow("502");
  expect(down.calls).toEqual([]);
  await expect(postOwnerLine(fakeDiscord().discord, undefined, "none", "hi", "x")).rejects.toThrow("no discordChannels configured");
});
