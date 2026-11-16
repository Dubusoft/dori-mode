import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp, mergeLaneKey } from "../src/ci-follow.ts";
import type { OpenPull } from "../src/github-events.ts";
import { MERGE_PAUSE_FILE, mergePauseHolds, mergePauseMain, readMergePause } from "../src/merge-pause.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";
import { withMergePauseHold } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

/**
 * The merge rollback switch (merge-pause.ts): `dori merge pause` stops every `gh pr merge` of CI follow-up, and
 * `dori merge resume` lets merges go on at the next poll. CiFollowUp over a fake GitHub, on a temp stateDir with a fake
 * clock.
 */

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H7 = sha("a"), H9 = sha("9");
const REASON = "rollout check";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const greenView = (head: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: "OPEN", baseRefName: "dev", headRefOid: head, isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: null, ...patch,
});

const harness = async () => {
  const state = withState();
  cleanups.push(state.done);
  const dir = state.dir;
  const clock = fakeClock(T0);
  const world = newWorld();
  const views = new Map<number, Record<string, unknown>>([[7, greenView(H7)]]);
  const merges: string[][] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts): Promise<Ran> => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return { code: 0, out: JSON.stringify(views.get(Number(argv[3]))), err: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      merges.push([...argv]);
      const n = Number(argv[3]);
      views.set(n, { ...views.get(n), state: "MERGED", mergeCommit: { oid: sha("f") } });
      return { code: 0, out: "", err: "" };
    }
    return base(argv, opts);
  };
  const deps = { ...depsFor(world, clock, dir), run };
  const brief = join(dir, "author.md");
  writeFileSync(brief, "Implement the thing.\n");
  const author = (head = H7, patch: Partial<Lane> = {}): Lane => ({
    key: "author", title: "author", thread: "t1", brief, done: `merged ${REPO}#7`, cwd: "/repo/author", openedAt: new Date(T0).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "e", emitted: true, pulls: [{ repo: REPO, number: 7, sha: head }] }, ...patch,
  });
  await deps.registry.write(author());
  const events: [string, string][] = [];
  const emit = (id: string, line: string): void => { events.push([id, line]); };
  const ci = new CiFollowUp(deps, { launch: async () => ({ ok: false, detail: "no merge lane in this test" }) });
  cleanups.unshift(() => { ci.close(); });
  const pull = (head = H7): OpenPull => ({
    repo: REPO, number: 7, sha: head, branch: "feat-7", headRepo: REPO, url: `https://github.com/${REPO}/pull/7`, conflicting: false, checks: "green",
  });
  const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(`${kind} `))).values()];
  const poll = async (pulls: readonly OpenPull[] = [pull()]): Promise<void> => { await ci.tick(pulls, emit); };
  const out: string[] = [];
  const cli = (...args: string[]): number => mergePauseMain(args, {
    stateDir: dir, now: clock.now, who: "lead (test)", out: (l) => { out.push(l); }, err: (l) => { out.push(`ERR ${l}`); },
  });
  return { dir, clock, deps, views, merges, ci, author, pull, events, lines, poll, cli, out };
};

const MERGED_AT_H7 = ["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H7];

test("paused: a claimed green PR gets no gh pr merge, one MERGE_PAUSED line, no stall, and its lane stays held", async () => {
  const h = await harness();
  expect(h.cli("pause", "--reason", REASON)).toBe(0);
  for (let i = 0; i < 3; i++) await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.lines("CI_MERGED")).toEqual([]);
  const paused = h.lines("MERGE_PAUSED");
  expect(paused).toHaveLength(1);
  expect(paused[0]).toContain(`merge paused: ${REASON}`);
  // A long pause is no merge stall: the pause, not the PR, is what waits.
  h.clock.at += 2 * 60 * 60_000;
  await h.poll();
  expect(h.lines("MERGE_STALLED")).toEqual([]);
  expect(await withMergePauseHold(h.deps).mergeHold!(h.author())).toBe(true);
  // A lane whose claim binds no PR waits on no merge: the pause does not hold it.
  expect(await withMergePauseHold(h.deps).mergeHold!(h.author(H7, { claim: { at: new Date(T0).toISOString(), evidence: "e", emitted: true } }))).toBe(false);
});

test("resume: the next poll merges at the claimed head, read fresh with no restart", async () => {
  const h = await harness();
  h.cli("pause", "--reason", REASON);
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.cli("resume")).toBe(0);
  expect(await withMergePauseHold(h.deps).mergeHold!(h.author())).toBe(false);
  await h.poll();
  expect(h.merges).toEqual([MERGED_AT_H7]);
  expect(h.lines("CI_MERGED")).toHaveLength(1);
});

test("head moved during the pause: after resume the old head never merges; the new head merges once claimed", async () => {
  const h = await harness();
  h.cli("pause", "--reason", REASON);
  await h.poll();
  // The author pushes H9 while merges are paused, and has not claimed at it yet.
  h.views.set(7, greenView(H9));
  h.cli("resume");
  // A poll that still lists the old head cannot merge it: GitHub's head moved.
  await h.poll([h.pull(H7)]);
  await h.poll([h.pull(H9)]);
  expect(h.merges).toEqual([]);
  await h.deps.registry.update("author", () => h.author(H9));
  await h.poll([h.pull(H9)]);
  expect(h.merges).toEqual([["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H9]]);
});

test("a merge lane's PR is held while paused like any other", async () => {
  const h = await harness();
  // The owner's claim is at another head; the merge lane claimed at H7 and stands in for it (D12).
  await h.deps.registry.update("author", () => h.author(sha("0")));
  const brief = join(h.dir, "merge.md");
  writeFileSync(brief, "Resolve the conflict.\n");
  await h.deps.registry.write({
    key: mergeLaneKey(h.pull()), title: "merge", thread: "t1", brief, done: `pr ${REPO} "feat-7"`, cwd: "/wt/app/merge", openedAt: new Date(T0 + 1000).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "pushed", emitted: true, pulls: [{ repo: REPO, number: 7, sha: H7 }] },
  });
  h.cli("pause", "--reason", REASON);
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.lines("MERGE_PAUSED")[0]).toContain(`lane=${mergeLaneKey(h.pull())}`);
  h.cli("resume");
  await h.poll();
  expect(h.merges).toEqual([MERGED_AT_H7]);
});

test("CLI round trip on a temp stateDir: status, pause (reason, since, who), pause again keeps the first, resume, status", async () => {
  const h = await harness();
  const file = join(h.dir, MERGE_PAUSE_FILE);
  expect(MERGE_PAUSE_FILE).toBe("review-merge-pause.json");
  expect(h.cli("status")).toBe(0);
  expect(h.cli("pause")).toBe(2);
  expect(h.cli("resume", "--reason", "x")).toBe(2);
  expect(h.cli("skip")).toBe(2);
  expect(existsSync(file)).toBe(false);
  expect(h.cli("pause", "--reason", REASON)).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ reason: REASON, since: new Date(T0).toISOString(), who: "lead (test)" });
  h.clock.at += 60_000;
  expect(h.cli("pause", "--reason", "another")).toBe(0);
  expect(readMergePause(h.dir)?.reason).toBe(REASON);
  expect(h.cli("status")).toBe(0);
  expect(h.cli("resume")).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(h.cli("resume")).toBe(0);
  expect(h.cli("status")).toBe(0);
  const detail = `merge paused: ${REASON} (since ${new Date(T0).toISOString()}, by lead (test))`;
  expect(h.out.filter((l) => !l.startsWith("ERR "))).toEqual([
    "MERGE_ACTIVE automatic merges run",
    `MERGE_PAUSED ${detail}`,
    `MERGE_PAUSED ${detail} (already paused)`,
    `MERGE_PAUSED ${detail}`,
    "MERGE_RESUMED merges go on at the next poll",
    "MERGE_NOT_PAUSED",
    "MERGE_ACTIVE automatic merges run",
  ]);
});

test("an unreadable pause file still pauses (fails closed)", async () => {
  const h = await harness();
  writeFileSync(join(h.dir, MERGE_PAUSE_FILE), "{not json");
  expect(readMergePause(h.dir)?.reason).toBe("pause file unparsable");
  expect(mergePauseHolds(h.dir, h.author())).toBe(true);
  await h.poll();
  await h.poll();
  expect(h.merges).toEqual([]);
});
