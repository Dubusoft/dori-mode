import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pendingReported } from "../src/lane-outcomes.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Lane } from "../src/registry.ts";
import { postLaneReport } from "../src/report-post.ts";
import {
  appendMarker, appendToMessage, closedByOwner, forgetOwnerClosed, type FollowUpDiscord, LAST_REPORTS_FILE, MalformedStateFileError, OWNER_CLOSED_FILE,
  pruneThreadFollowups, readLastReports, readOwnerClosed, recordLastReport, recordOwnerClosed, THREAD_FOLLOWUP_KEEP_MS,
} from "../src/thread-followup.ts";
import { fakeClock, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

/** Discord over HTTP: `GET /channels/<id>` answers `channels[id]`; a post answers message m-1; anything else answers `miss`. */
const discordWith = (channels: Record<string, unknown>, miss = 404) => new Discord(async (request) => {
  const id = /\/channels\/(\d+)$/.exec(request.url)?.[1];
  if (request.method === "GET" && id && id in channels) return { status: 200, headers: {}, body: JSON.stringify(channels[id]) };
  if (request.method === "POST") return { status: 200, headers: {}, body: JSON.stringify({ id: "m-1" }) };
  return { status: miss, headers: {}, body: "{}" };
}, fakeClock(T0), "t");

test("a plain channel recorded as closed by the owner counts as open and loses its record", async () => {
  const state = withState();
  cleanups.push(state.done);
  recordOwnerClosed(state.dir, "900", T0 - 1);
  recordOwnerClosed(state.dir, "901", T0 - 1);
  const discord = discordWith({ "900": { id: "900", type: 0 }, "901": { id: "901", type: 11, parent_id: "900", thread_metadata: { archived: true } } });
  expect(await closedByOwner(state.dir, discord, "900")).toBeUndefined();
  expect(await closedByOwner(state.dir, discord, "901")).toEqual({ parent: "900" });
  expect(readOwnerClosed(state.dir)).toEqual({ "901": T0 - 1 });
});

test("a recorded thread Discord no longer knows (deleted) counts as open and loses its record", async () => {
  const state = withState();
  cleanups.push(state.done);
  recordOwnerClosed(state.dir, "903", T0 - 1);
  recordOwnerClosed(state.dir, "901", T0 - 1);
  expect(await closedByOwner(state.dir, discordWith({}), "903")).toBeUndefined();
  expect(readOwnerClosed(state.dir)).toEqual({ "901": T0 - 1 });
});

test("a malformed owner-closed or last-reports file warns on read and is never overwritten", () => {
  const state = withState();
  cleanups.push(state.done);
  const warn = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  // A missing file is empty without a warning.
  expect(readOwnerClosed(state.dir)).toEqual({});
  expect(warn).not.toHaveBeenCalled();
  for (const file of [OWNER_CLOSED_FILE, LAST_REPORTS_FILE]) writeFileSync(join(state.dir, file), '{"900": 1');
  expect(readOwnerClosed(state.dir)).toEqual({});
  expect(readLastReports(state.dir)).toEqual({});
  expect(warn.mock.calls.map((c) => String(c[0]).split(" ")[0])).toEqual(["THREAD_STATE_WARNING", "THREAD_STATE_WARNING"]);
  expect(() => recordOwnerClosed(state.dir, "901", T0)).toThrow(MalformedStateFileError);
  expect(() => forgetOwnerClosed(state.dir, "900")).toThrow(MalformedStateFileError);
  expect(() => recordLastReport(state.dir, "ap-1-1", { channel: "901", message: "m-1", at: T0 })).toThrow(MalformedStateFileError);
  for (const file of [OWNER_CLOSED_FILE, LAST_REPORTS_FILE]) expect(readFileSync(join(state.dir, file), "utf8")).toBe('{"900": 1');
});

test("the prune drops owner-closed records and closed lanes' last reports once they are THREAD_FOLLOWUP_KEEP_MS old", () => {
  const state = withState();
  cleanups.push(state.done);
  const old = T0 - THREAD_FOLLOWUP_KEEP_MS;
  recordOwnerClosed(state.dir, "900", old);
  recordOwnerClosed(state.dir, "901", old + 1);
  recordOwnerClosed(state.dir, "902", old);
  recordLastReport(state.dir, "ap-1-1", { channel: "900", message: "m-1", at: old });
  recordLastReport(state.dir, "ap-2-1", { channel: "901", message: "m-2", at: old + 1 });
  recordLastReport(state.dir, "ap-3-1", { channel: "902", message: "m-3", at: old });
  // ap-3-1 is still open in thread 902: neither its last report nor its thread's close record goes.
  pruneThreadFollowups(state.dir, T0, [{ key: "ap-3-1", thread: "discord:800/902" }]);
  expect(readOwnerClosed(state.dir)).toEqual({ "901": old + 1, "902": old });
  expect(Object.keys(readLastReports(state.dir))).toEqual(["ap-2-1", "ap-3-1"]);
});

test("a failed thread read of a recorded thread still fails and keeps the record", async () => {
  const state = withState();
  cleanups.push(state.done);
  recordOwnerClosed(state.dir, "902", T0 - 1);
  await expect(closedByOwner(state.dir, discordWith({}, 503), "902")).rejects.toThrow("503");
  expect(readOwnerClosed(state.dir)).toEqual({ "902": T0 - 1 });
});

/** A message store whose edit and re-archive fail when told to; `calls` lists what reached Discord. */
const messageStore = (content: string, fail: { edit?: Error; archive?: Error } = {}) => {
  const calls: string[] = [];
  let text = content;
  const discord: FollowUpDiscord = {
    send: async () => "m-2",
    content: async () => text,
    edit: async (_channel, _message, next) => { if (fail.edit) throw fail.edit; calls.push("edit"); text = next; },
    threadArchived: async () => true,
    threadState: async () => ({ archived: true, parent: undefined }),
    setThread: async (_thread, patch) => { if (patch.archived && fail.archive) throw fail.archive; calls.push(`archived=${patch.archived}`); },
  };
  return { discord, calls, text: () => text };
};

test("an append with a stable id is skipped only on its own retry; the same text under another id or no id lands again", async () => {
  const store = messageStore("report");
  expect(await appendToMessage(store.discord, "900", "m-1", "merged", false, "a")).toBe(true);
  expect(await appendToMessage(store.discord, "900", "m-1", "later", false, "b")).toBe(true);
  // The retry of "a" finds its line even though another append came after it.
  expect(await appendToMessage(store.discord, "900", "m-1", "merged", false, "a")).toBe(true);
  expect(await appendToMessage(store.discord, "900", "m-1", "merged", false, "c")).toBe(true);
  expect(await appendToMessage(store.discord, "900", "m-1", "merged", false)).toBe(true);
  expect(store.calls).toEqual(["edit", "edit", "edit", "edit"]);
  expect(store.text()).toBe(`report\n${appendMarker("a")}merged\n${appendMarker("b")}later\n${appendMarker("c")}merged\nmerged`);
});

test("a failed re-archive is logged and never hides the edit's own error; after a landed edit the append still counts", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errors.mockRestore());
  const both = messageStore("report", { edit: new Error("edit 502"), archive: new Error("archive 503") });
  await expect(appendToMessage(both.discord, "900", "m-1", "merged", true, "a")).rejects.toThrow("edit 502");
  expect(both.calls).toEqual(["archived=false"]);
  const landed = messageStore("report", { archive: new Error("archive 503") });
  expect(await appendToMessage(landed.discord, "900", "m-1", "merged", true, "a")).toBe(true);
  expect(landed.calls).toEqual(["archived=false", "edit"]);
  expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
    "THREAD_REARCHIVE_FAILED 900 archive 503; the thread is left open",
    "THREAD_REARCHIVE_FAILED 900 archive 503; the thread is left open",
  ]);
});

test("a report with --thread naming a configured channel does not make that channel the lane's thread", async () => {
  const state = withState();
  cleanups.push(state.done);
  const lane: Lane = { key: "ap-1-1", title: "t", thread: "none", brief: "/briefs/ap.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString() };
  const deps = { config: { stateDir: state.dir, discordChannels: ["900"], ownerLanguage: "Korean" }, discord: discordWith({}), now: () => T0 };
  expect(await postLaneReport(deps, lane, "done", { to: "discord:900", thread: "900" })).toEqual({ kind: "posted", message: "m-1" });
  expect(readLastReports(state.dir)["ap-1-1"]).toBeUndefined();
  expect(pendingReported(state.dir)[0]?.thread).toBeUndefined();
});
