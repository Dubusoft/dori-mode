import { afterEach, beforeEach, expect, test } from "bun:test";

import type { LaneStatusTransport } from "../src/lane-reports.ts";
import { postSandboxNotice, postSkippedNotices } from "../src/sandbox-notice.ts";
import type { Ran } from "../src/run.ts";
import { recordOwnerClosed } from "../src/thread-followup.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

/** deps whose threadReply hook answers `hook` and records its argv; a transport that records posts or throws. */
const setup = (hook: Ran | undefined, channels: string[] = ["main-1"], postFails = false) => {
  const hooked: string[][] = [];
  const posts: [string, string][] = [];
  const base = depsFor(newWorld(), fakeClock(T0), state.dir, { discordChannels: channels, hooks: hook ? { threadReply: ["reply", "{thread}", "{text}"] } : {} });
  const deps = { ...base, run: async (argv: readonly string[]): Promise<Ran> => { hooked.push([...argv]); return hook ?? { code: 1, out: "", err: "no hook" }; } };
  const transport: LaneStatusTransport = {
    post: async (channel, text) => { if (postFails) throw new Error("discord 500"); posts.push([channel, text]); return "m1"; },
    edit: async () => {},
    threadState: async () => ({ archived: true, parent: "parent-1" }),
  };
  return { deps, transport, hooked, posts };
};

test("a lane with a thread gets the notice there through hooks.threadReply, marked [sandbox]", async () => {
  const s = setup({ code: 0, out: "", err: "" });
  expect(await postSandboxNotice(s.deps, { key: "k1", thread: "discord:1/2" }, "SANDBOX_SKIPPED k1: machine m2 is opted in")).toEqual([]);
  expect(s.hooked).toEqual([["reply", "discord:1/2", "[sandbox] SANDBOX_SKIPPED k1: machine m2 is opted in"]]);
  expect(s.posts).toEqual([]);
});

test("no thread, or a failed thread post, goes to the owner channel; with nowhere to post it is a SANDBOX_NOTICE_ERROR line, never a throw", async () => {
  const none = setup({ code: 0, out: "", err: "" });
  expect(await postSandboxNotice(none.deps, { key: "k1", thread: "none" }, "SANDBOX_MISSING k1: x", none.transport)).toEqual([]);
  expect(none.hooked).toEqual([]);
  expect(none.posts).toEqual([["main-1", "[sandbox] SANDBOX_MISSING k1: x"]]);
  const failed = setup({ code: 1, out: "", err: "thread gone" });
  expect(await postSandboxNotice(failed.deps, { key: "k1", thread: "discord:1/2" }, "x", failed.transport)).toEqual(["SANDBOX_NOTICE_FALLBACK k1 posted to the owner channel (thread post failed: thread gone)"]);
  expect(failed.posts).toEqual([["main-1", "[sandbox] x"]]);
  const nowhere = setup(undefined, []);
  expect(await postSandboxNotice(nowhere.deps, { key: "k1" }, "x", undefined)).toEqual(["SANDBOX_NOTICE_ERROR k1 (no DORI_DISCORD_TOKEN for the owner channel): [sandbox] x"]);
  const down = setup(undefined, ["main-1"], true);
  expect(await postSandboxNotice(down.deps, { key: "k1" }, "x", down.transport)).toEqual(["SANDBOX_NOTICE_ERROR k1 (owner channel post failed: discord 500): [sandbox] x"]);
});

test("a lane thread the owner closed gets no hook post: one line linking it goes to its parent channel; with no transport the notice is an error line", async () => {
  recordOwnerClosed(state.dir, "2", T0 - 1);
  const s = setup({ code: 0, out: "", err: "" });
  expect(await postSandboxNotice(s.deps, { key: "k1", thread: "discord:1/2" }, "SANDBOX_SKIPPED k1: x", s.transport)).toEqual([]);
  expect(s.hooked).toEqual([]);
  expect(s.posts).toEqual([["parent-1", "<#2> [sandbox] SANDBOX_SKIPPED k1: x"]]);
  const bare = setup({ code: 0, out: "", err: "" });
  expect(await postSandboxNotice(bare.deps, { key: "k1", thread: "discord:1/2" }, "x", undefined)).toEqual([
    "SANDBOX_NOTICE_ERROR k1 (closed thread redirect failed: thread 2 was closed by the owner and there is no DORI_DISCORD_TOKEN to post one line to its parent channel; no DORI_DISCORD_TOKEN for the owner channel): [sandbox] x",
  ]);
  expect(bare.hooked).toEqual([]);
});

test("postSkippedNotices posts only a launch's SANDBOX_SKIPPED notes", async () => {
  const s = setup({ code: 0, out: "", err: "" });
  expect(await postSkippedNotices(s.deps, { key: "k1", thread: "discord:1/2" }, ["LANE_WORKSPACE_REGISTERED w1", "SANDBOX_SKIPPED k1: relaunch of a lane recorded without a sandbox"])).toEqual([]);
  expect(s.hooked).toEqual([["reply", "discord:1/2", "[sandbox] SANDBOX_SKIPPED k1: relaunch of a lane recorded without a sandbox"]]);
});
