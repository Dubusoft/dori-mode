import { afterEach, expect, test } from "bun:test";

import { pendingReported } from "../src/lane-outcomes.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Lane } from "../src/registry.ts";
import { postLaneReport } from "../src/report-post.ts";
import { closedByOwner, readLastReports, readOwnerClosed, recordOwnerClosed } from "../src/thread-followup.ts";
import { fakeClock, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

/** Discord over HTTP: `GET /channels/<id>` answers `channels[id]`; a post answers message m-1. */
const discordWith = (channels: Record<string, unknown>) => new Discord(async (request) => {
  const id = /\/channels\/(\d+)$/.exec(request.url)?.[1];
  if (request.method === "GET" && id && id in channels) return { status: 200, headers: {}, body: JSON.stringify(channels[id]) };
  if (request.method === "POST") return { status: 200, headers: {}, body: JSON.stringify({ id: "m-1" }) };
  return { status: 404, headers: {}, body: "{}" };
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

test("a failed thread read of a recorded thread still fails and keeps the record", async () => {
  const state = withState();
  cleanups.push(state.done);
  recordOwnerClosed(state.dir, "902", T0 - 1);
  await expect(closedByOwner(state.dir, discordWith({}), "902")).rejects.toThrow();
  expect(readOwnerClosed(state.dir)).toEqual({ "902": T0 - 1 });
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
