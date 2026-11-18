import { afterEach, expect, test } from "bun:test";

import { autoReportPoster, writtenIn } from "../src/auto-report.ts";
import { pendingReported } from "../src/lane-outcomes.ts";
import type { Lane } from "../src/registry.ts";
import { appendFollowUp, type FollowUpDiscord, readLastReports, recordOwnerClosed } from "../src/thread-followup.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = { key: "ap-12-1", title: "로그인 버그", thread: "discord:900/901", brief: "/briefs/ap.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString() };
const claim = { at: new Date(T0).toISOString(), evidence: "https://github.com/acme/app/pull/1 abc1234", text: "로그인 버그를 고쳤습니다" };

/** Discord as a report post and the merge append see it: every post answers m-<n>, and contents follow edits. */
const fakeDiscord = (archived: readonly string[] = []) => {
  const contents = new Map<string, string>();
  const sends: string[][] = [];
  const discord: FollowUpDiscord = {
    send: async (channel, content) => { sends.push([channel, content]); const id = `m-${sends.length}`; contents.set(`${channel}/${id}`, content); return id; },
    edit: async (channel, message, content) => { contents.set(`${channel}/${message}`, content); },
    content: async (channel, message) => contents.get(`${channel}/${message}`) ?? "",
    threadArchived: async (thread) => archived.includes(thread),
    threadState: async (thread) => ({ archived: archived.includes(thread), parent: "900" }),
    setThread: async () => {},
  };
  return { discord, sends, contents };
};
const poster = (stateDir: string, discord: FollowUpDiscord) =>
  autoReportPoster({ config: { stateDir, discordChannels: ["900"] }, discord, now: () => T0, home: "/home/test", language: () => "Korean" });

test("a done text counts as the owner's language by the share of its letters in that script, links and code aside", () => {
  expect(writtenIn("로그인 버그를 고친 PR을 열었고 CI가 통과했습니다 https://github.com/acme/app/pull/1", "Korean")).toBe(true);
  expect(writtenIn("Fixed the login bug; PR https://github.com/acme/app/pull/1 is green", "Korean")).toBe(false);
  expect(writtenIn("https://github.com/acme/app/pull/1 `abc1234`", "Korean")).toBe(false);
  expect(writtenIn("Fixed the login bug", undefined)).toBe(true);
  expect(writtenIn("로그인 버그를 고쳤습니다", "English")).toBe(false);
  expect(writtenIn("ログインのバグを直しました", "Japanese")).toBe(true);
  expect(writtenIn("修复了登录错误", "Japanese")).toBe(false);
  expect(writtenIn("修复了登录错误", "Chinese")).toBe(true);
});

test("the auto report goes into the lane's thread as its last report with a reported receipt, so the merge fact appended at the close edits it", async () => {
  const state = withState();
  cleanups.push(state.done);
  const { discord, sends, contents } = fakeDiscord();
  expect(await poster(state.dir, discord)(lane, claim)).toBe("m-1");
  expect(sends).toEqual([["901", "[System] 로그인 버그(ap-12-1) 완료했습니다.\n로그인 버그를 고쳤습니다\n근거: https://github.com/acme/app/pull/1 abc1234"]]);
  expect(readLastReports(state.dir)["ap-12-1"]).toEqual({ channel: "901", message: "m-1", at: T0 });
  expect(pendingReported(state.dir)).toMatchObject([{ lane: "ap-12-1", message: "m-1", thread: "901", note: "auto-reported by the supervisor" }]);
  expect(await appendFollowUp(state.dir, discord, lane, "머지 acme/app#1 (abc1234)")).toEqual({ appended: true, message: "m-1" });
  expect(contents.get("901/m-1")).toEndWith("\n머지 acme/app#1 (abc1234)");
});

test("an auto report for a thread the owner closed is one line in its parent channel, recorded as a follow-up", async () => {
  const state = withState();
  cleanups.push(state.done);
  recordOwnerClosed(state.dir, "901", T0 - 1);
  const { discord, sends } = fakeDiscord(["901"]);
  expect(await poster(state.dir, discord)(lane, claim)).toBe("m-1");
  expect(sends[0]?.[0]).toBe("900");
  expect(sends[0]?.[1]).toStartWith("<#901> [System] 로그인 버그(ap-12-1) 완료했습니다.");
  expect(pendingReported(state.dir)).toMatchObject([{ lane: "ap-12-1", message: "m-1", target: "discord:900", followUp: true }]);
  expect(readLastReports(state.dir)["ap-12-1"]).toBeUndefined();
});
