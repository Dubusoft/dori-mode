import { afterEach, expect, test } from "bun:test";

import { LANE_FINISH_HOLD_MS, laneFinish, laneFinishText, postOwnerLine, type FinishDiscord } from "../src/lane-finish.ts";
import { MessengerError } from "../src/messenger/http.ts";
import type { Lane } from "../src/registry.ts";
import { OUTBOX_ATTEMPTS, OUTBOX_RETRY_MS, Supervisor, type SupervisorHooks } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;
const MERGED = "CI_MERGED acme/app#7 into dev lane=alpha head=abc1234 merge=def1234567890abc https://github.com/acme/app/pull/7";

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, state.dir);
  const posts: { text: string; id: string; thread?: string }[] = [];
  let failures = 0;
  const hooks: SupervisorHooks = {
    announce: async (text, id, thread) => {
      if (failures > 0) { failures--; throw new Error("discord down"); }
      posts.push({ text, id, ...(thread ? { thread } : {}) });
    },
  };
  const tick = async (supervisor: Supervisor): Promise<void> => {
    await supervisor.reportTick();
    await supervisor.reactionsSettled();
  };
  return { state, clock, deps, posts, hooks, tick, fail: (n: number) => { failures = n; } };
};

const lane = (key: string, extra: Partial<Lane> = {}): Lane => ({
  key, title: `${key} work`, thread: "discord:111/222", brief: "/tmp/brief.md", done: "merged acme/app#7", openedAt: new Date(T0).toISOString(), ...extra,
} as Lane);

test("finish lines name their lane, outcome, PR and merge; other lines finish nothing", () => {
  expect(laneFinish(MERGED)).toEqual({ lane: "alpha", merged: true, pr: "https://github.com/acme/app/pull/7", merge: "def1234567890abc" });
  expect(laneFinish("MERGE_VERIFIED acme/app#7 into dev lane=alpha merge=def1234 https://github.com/acme/app/pull/7")).toMatchObject({ lane: "alpha", merged: true, merge: "def1234" });
  expect(laneFinish("LANE_AUTO_CLOSED robot {}")).toEqual({ lane: "robot", closed: "auto-closed" });
  expect(laneFinish("CI_MERGED acme/app#7 into dev head=abc")).toBeUndefined();
  expect(laneFinish("LANE_CLOSED $(rm) x")).toBeUndefined();
  expect(laneFinish("LANE_DONE_CLAIMED alpha x")).toBeUndefined();
  expect(laneFinishText({ lane: "beta", closed: "closed" })).toBe("Lane beta finished: closed.");
});

test("one line per lane: merge and close fold into it, and neither later events nor a restarted supervisor post again", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha"));
  const first = new Supervisor(f.deps, f.hooks);
  first.enqueue("ci-merged:acme/app#7", MERGED);
  first.enqueue("lane-closed:alpha", "LANE_CLOSED alpha {\"checks\":[]}");
  await f.tick(first);
  expect(f.posts).toEqual([]);
  // Restarted while the line is held: the journaled outbox row still goes out once.
  const second = new Supervisor(f.deps, f.hooks);
  f.clock.at += LANE_FINISH_HOLD_MS;
  await f.tick(second);
  expect(f.posts).toEqual([{
    text: "Lane alpha finished (alpha work): merged and closed. PR https://github.com/acme/app/pull/7. Merge def123456789.",
    id: "lane-finish:alpha", thread: "discord:111/222",
  }]);
  second.enqueue("merge-verified:acme/app#7", "MERGE_VERIFIED acme/app#7 into dev lane=alpha merge=def1234 https://github.com/acme/app/pull/7");
  const third = new Supervisor(f.deps, f.hooks);
  third.enqueue("lane-closed:alpha:again", "LANE_CLOSED alpha again");
  f.clock.at += 10 * LANE_FINISH_HOLD_MS;
  await f.tick(third);
  expect(f.posts).toHaveLength(1);
  expect(readJournal(f.state.dir).outbox ?? []).toEqual([]);
});

test("a failing post is retried past OUTBOX_ATTEMPTS, never dropped, and posted once when it succeeds", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "none" }));
  const supervisor = new Supervisor(f.deps, f.hooks);
  f.fail(OUTBOX_ATTEMPTS + 2);
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha x");
  f.clock.at += LANE_FINISH_HOLD_MS;
  for (let i = 0; i < OUTBOX_ATTEMPTS + 2; i++) {
    await f.tick(supervisor);
    f.clock.at += OUTBOX_RETRY_MS;
  }
  expect(f.posts).toEqual([]);
  expect(readJournal(f.state.dir).outbox).toMatchObject([{ id: "lane-finish:alpha", attempts: OUTBOX_ATTEMPTS + 2 }]);
  await f.tick(supervisor);
  await f.tick(supervisor);
  expect(f.posts).toEqual([{ text: "Lane alpha finished (alpha work): closed.", id: "lane-finish:alpha", thread: "none" }]);
  expect(readJournal(f.state.dir).outbox ?? []).toEqual([]);
});

test("an autoClose: machine lane gets its line; laneFinishNotice false posts nothing", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("robot", { autoClose: "machine" }));
  const on = new Supervisor(f.deps, f.hooks);
  on.enqueue("lane-closed:robot", "LANE_AUTO_CLOSED robot {}");
  f.clock.at += LANE_FINISH_HOLD_MS;
  await f.tick(on);
  expect(f.posts.map((post) => post.text)).toEqual(["Lane robot finished (robot work): auto-closed."]);
  const off = new Supervisor({ ...f.deps, config: { ...f.deps.config, laneFinishNotice: false } }, f.hooks);
  off.enqueue("lane-closed:quiet", "LANE_CLOSED quiet x");
  f.clock.at += LANE_FINISH_HOLD_MS;
  await f.tick(off);
  expect(f.posts).toHaveLength(1);
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

  for (const thread of [undefined, "none", "slack:C1/123.4"]) {
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
