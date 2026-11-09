import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, watchTick } from "../src/done-flow.ts";
import { adoptLane, LaunchError } from "../src/launch.ts";
import type { Http } from "../src/messenger/http.ts";
import { statusOf } from "../src/registry.ts";
import { run, type Runner } from "../src/run.ts";
import { checkDone, checkSignal, doneSyntaxErrors, parseSignal, splitDone } from "../src/signals.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const state = withState();
afterAll(() => state.done());
const io = { cwd: state.dir, home: "/nonexistent-home" };

test("a command signal passes on exit 0 and runs the argv directly, so shell syntax stays literal", async () => {
  const ok = await checkSignal('command ["sh","-c","exit 0"]', run, io);
  expect(ok).toMatchObject({ ok: true, detail: "exit 0" });
  const literal = await checkSignal('command ["echo","$(id); rm -rf /"]', run, io);
  expect(literal).toMatchObject({ ok: true });
  const out = await checkSignal('command ["echo","$(id); rm -rf /"] stdout~"^\\\\$\\\\(id\\\\); rm -rf /$"', run, io);
  expect(out.ok).toBe(true);
});

test("a command signal fails on a non-zero exit, a missing program, or stdout that does not match", async () => {
  expect(await checkSignal('command ["sh","-c","echo broken >&2; exit 3"]', run, io)).toMatchObject({ ok: false, detail: "exit 3: broken" });
  expect((await checkSignal('command ["no-such-program-xyz"]', run, io)).ok).toBe(false);
  const mismatch = await checkSignal('command ["echo","3 failed"] stdout~"0 failed"', run, io);
  expect(mismatch.ok).toBe(false);
  expect(mismatch.detail).toStartWith("exit 0 but stdout does not match");
});

test("a command signal runs in the lane's directory", async () => {
  writeFileSync(join(state.dir, "marker.txt"), "here");
  expect((await checkSignal('command ["cat","marker.txt"] stdout~"here"', run, io)).ok).toBe(true);
});

test("a file signal checks existence, then sha256, then a JSON field, and says which one failed", async () => {
  const f = join(state.dir, "result.json");
  const content = JSON.stringify({ build: { status: "ok", tests: 41 }, list: ["a", "b"] });
  writeFileSync(f, content);
  const sha = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  expect((await checkSignal(`file ${f}`, run, io)).ok).toBe(true);
  expect((await checkSignal(`file result.json sha256=${sha}`, run, io)).ok).toBe(true);
  expect((await checkSignal('file result.json json:.build.status="ok"', run, io)).ok).toBe(true);
  expect((await checkSignal('file result.json json:.list.1="b"', run, io)).ok).toBe(true);
  expect(await checkSignal("file missing.json", run, io)).toMatchObject({ ok: false, detail: `missing: ${join(state.dir, "missing.json")}` });
  expect((await checkSignal(`file result.json sha256=${"0".repeat(64)}`, run, io)).detail).toStartWith("sha256");
  expect(await checkSignal("file result.json json:.build.tests=40", run, io)).toMatchObject({ ok: false, detail: ".build.tests is 41, want 40" });
  expect(await checkSignal('file result.json json:.build.owner="x"', run, io)).toMatchObject({ ok: false, detail: "no field .build.owner" });
});

test("a file signal does not take a string for a number: json values compare as JSON", async () => {
  writeFileSync(join(state.dir, "n.json"), JSON.stringify({ n: 3 }));
  expect((await checkSignal('file n.json json:.n="3"', run, io)).ok).toBe(false);
  expect((await checkSignal("file n.json json:.n=3", run, io)).ok).toBe(true);
});

test("a url signal checks the status and the body, and a network failure is a failed check, not a crash", async () => {
  const http: Http = async (req) => {
    if (req.url.includes("down")) throw new Error("ECONNREFUSED");
    if (req.url.endsWith("/health")) return { status: 200, headers: {}, body: '{"status":"ready"}' };
    return { status: 404, headers: {}, body: "not found" };
  };
  const web = { ...io, http };
  expect((await checkSignal('url http://localhost:3000/health body~"\\"ready\\""', run, web)).ok).toBe(true);
  expect(await checkSignal("url http://localhost:3000/other", run, web)).toMatchObject({ ok: false, detail: "status 404, want 200" });
  expect((await checkSignal("url http://localhost:3000/other status=404", run, web)).ok).toBe(true);
  expect((await checkSignal('url http://localhost:3000/health body~"starting"', run, web)).ok).toBe(false);
  expect((await checkSignal("url http://down.invalid/", run, web)).detail).toStartWith("request failed");
});

test("signals are split on top-level semicolons only, so a semicolon inside an argv or regex stays put", () => {
  expect(splitDone('Done = command ["sh","-c","a; b"]; file out.txt; closed acme/app#2')).toEqual(['command ["sh","-c","a; b"]', "file out.txt", "closed acme/app#2"]);
});

test("a Done line with a malformed signal is refused at launch, with the reason", async () => {
  const deps = depsFor(newWorld(), fakeClock(0), state.dir);
  const bad = ["two clean QA passes", "command bun test", 'command ["bun", 3]', "file x.json sha256=abc", "url ftp://host", 'command ["x"] stdout="y"', "file a.json json:.v~1"];
  for (const done of bad) expect(doneSyntaxErrors(done)).toHaveLength(1);
  await expect(adoptLane(deps, { key: "qa-lane", title: "qa", brief: "/b.md", done: "command bun test", pane: "w:p9" })).rejects.toBeInstanceOf(LaunchError);
  const lane = await adoptLane(deps, { key: "qa-lane", title: "qa", brief: "/b.md", done: 'command ["bun","test"] stdout~"0 fail"; file ~/qa/report.json json:.passed=true; url http://localhost:3000/health', pane: "w:p9" });
  expect(lane.done).toContain("command");
});

test("a QA-only lane's claim is re-checked at close time: the lane says done, but the command still fails, so it stays open", async () => {
  const world = newWorld();
  const clock = fakeClock(Date.parse("2026-01-01T00:00:00Z"));
  const flag = join(state.dir, "qa-passed");
  const own = withState();
  const fake = depsFor(world, clock, own.dir);
  // The Done checks run where the lane's runner runs them; here on this host, for real, in the lane's cwd.
  const ops: typeof fake.ops = {
    ...fake.ops,
    inspect: async (lane, want) => ({
      ...(await fake.ops.inspect(lane, { ...want, done: undefined })),
      ...(want.done !== undefined ? { done: { cwd: state.dir, fallback: false, checks: await checkDone(want.done, run, { cwd: state.dir }) } } : {}),
    }),
  };
  const deps = { ...fake, run, ops };
  // Adoption goes to the lane's runner (the fake facade), so the test never reaches the host's herdr.
  const lane = await adoptLane(fake, { key: "local-setup", title: "setup", brief: "/b.md", done: `command ["test","-f","${flag}"]`, pane: "w:p3", cwd: state.dir });
  await claimDone(deps, lane, "I ran the setup and it works");
  // The first pass hands the claim over; its window runs from there.
  await watchTick(deps);
  clock.at += 6 * 60_000;
  await watchTick(deps);
  const after = await deps.registry.read("local-setup");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons[0]).toContain("exit 1");
  own.done();
});

test("a pr signal names a repo and a branch; a branch may hold / and, when quoted, ; or spaces", () => {
  expect(parseSignal("pr acme/app feat/add-x-12")).toEqual({ kind: "pr", repo: "acme/app", branch: "feat/add-x-12" });
  expect(parseSignal('pr acme/app "odd;branch name"')).toEqual({ kind: "pr", repo: "acme/app", branch: "odd;branch name" });
  expect(splitDone('Done = pr acme/app "a;b"; closed acme/app#2')).toEqual(['pr acme/app "a;b"', "closed acme/app#2"]);
  expect(() => parseSignal("pr acme/app a;b")).toThrow("must be quoted");
  expect(() => parseSignal("pr feat/add-x-12")).toThrow("pr takes <owner/repo> <branch>");
  expect(() => parseSignal("pr acme/app")).toThrow("pr takes <owner/repo> <branch>");
  expect(() => parseSignal("pr acme/app main extra")).toThrow("pr takes only");
  expect(doneSyntaxErrors("pr acme/app feat;x")).toHaveLength(1);
});

const URL7 = "https://github.com/acme/app/pull/7";
const ghPrs = (out: unknown, code = 0) => {
  const calls: { argv: readonly string[]; cwd?: string }[] = [];
  const fake: Runner = async (argv, opts) => {
    calls.push({ argv, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    return code ? { code, out: "", err: "gh: HTTP 502" } : { code: 0, out: typeof out === "string" ? out : JSON.stringify(out), err: "" };
  };
  return { calls, fake };
};
const pr = (p: Record<string, unknown> = {}) => ({ number: 7, state: "OPEN", isDraft: false, isCrossRepository: false, url: URL7, createdAt: "2026-11-01T00:00:00Z", statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "SUCCESS" }, { conclusion: "SKIPPED" }], ...p });

test("a pr signal passes when the newest PR from the branch is merged, or open, not draft, and every check is green", async () => {
  const merged = ghPrs([pr({ state: "MERGED", statusCheckRollup: [] })]);
  expect(await checkSignal("pr acme/app feat/x", merged.fake, io)).toEqual({ signal: "pr acme/app feat/x", ok: true, detail: `MERGED ${URL7}` });
  expect(merged.calls).toEqual([{ argv: ["gh", "pr", "list", "--repo", "acme/app", "--head", "feat/x", "--state", "all", "--json", "number,state,isDraft,statusCheckRollup,isCrossRepository,url,createdAt"] }]);
  expect(await checkSignal("pr acme/app feat/x", ghPrs([pr()]).fake, io)).toMatchObject({ ok: true, detail: `OPEN, 3 checks green ${URL7}` });
});

test("a pr signal is not live while a check is pending, before any check exists, on a draft, closed or missing PR", async () => {
  const cases: [unknown, string][] = [
    [[pr({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "", status: "IN_PROGRESS" }] })], `OPEN, 1 of 2 checks not green ${URL7}`],
    [[pr({ statusCheckRollup: [{ conclusion: "FAILURE" }] })], `OPEN, 1 of 1 checks not green ${URL7}`],
    [[pr({ statusCheckRollup: [] })], `OPEN with no checks yet ${URL7}`],
    [[pr({ statusCheckRollup: null })], `OPEN with no checks yet ${URL7}`],
    [[pr({ isDraft: true })], `OPEN draft ${URL7}`],
    [[pr({ state: "CLOSED" })], `CLOSED ${URL7}`],
    [[], "no PR from feat/x"],
  ];
  for (const [out, detail] of cases) {
    const c = await checkSignal("pr acme/app feat/x", ghPrs(out).fake, io);
    expect(c).toEqual({ signal: "pr acme/app feat/x", ok: false, detail });
  }
});

test("a pr signal judges the newest PR, so an old merged PR from a reused branch name does not count", async () => {
  const newer = "https://github.com/acme/app/pull/9";
  const prs = [pr({ state: "MERGED", createdAt: "2026-10-01T00:00:00Z" }), pr({ number: 9, url: newer, createdAt: "2026-11-05T00:00:00Z", statusCheckRollup: [{ conclusion: "" }] })];
  expect(await checkSignal("pr acme/app feat/x", ghPrs(prs).fake, io)).toMatchObject({ ok: false, detail: `OPEN, 1 of 1 checks not green ${newer}` });
});

test("a pr signal reports an error, not an unmet condition, when gh fails, answers no JSON, or the PR comes from a fork", async () => {
  expect(await checkSignal("pr acme/app feat/x", ghPrs([], 1).fake, io)).toMatchObject({ ok: false, error: "gh: HTTP 502" });
  expect((await checkSignal("pr acme/app feat/x", ghPrs("<html>").fake, io)).error).toStartWith("gh answered no JSON");
  const fork = await checkSignal("pr acme/app feat/x", ghPrs([pr({ isCrossRepository: true, state: "MERGED" })]).fake, io);
  expect(fork).toMatchObject({ ok: false, error: `${URL7} comes from a fork; pr signals support same-repo branches only` });
});

test("a pr Done line is accepted at launch, and a pr signal without a repo is refused", async () => {
  // Its own state: the earlier qa-lane already holds the fake checkout in the shared one.
  const own = withState();
  const deps = depsFor(newWorld(), fakeClock(0), own.dir);
  await expect(adoptLane(deps, { key: "pr-lane", title: "pr", brief: "/b.md", done: "pr feat/x", pane: "w:p9" })).rejects.toBeInstanceOf(LaunchError);
  const lane = await adoptLane(deps, { key: "pr-lane", title: "pr", brief: "/b.md", done: "pr acme/app feat/x; closed acme/app#2", pane: "w:p9" });
  expect(lane.done).toBe("pr acme/app feat/x; closed acme/app#2");
  own.done();
});

test("checkDone reports every signal, so one passing signal never hides a failing one", async () => {
  writeFileSync(join(state.dir, "ok.txt"), "x");
  const checks = await checkDone('file ok.txt; command ["false"]', run, io);
  expect(checks.map((c) => c.ok)).toEqual([true, false]);
});
