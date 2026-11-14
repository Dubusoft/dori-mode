import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReviewScope, prepareReviewSnapshot, releaseReviewSnapshot, reviewSnapshotPath } from "../src/review-snapshot.ts";
import type { Ran, Runner } from "../src/run.ts";

const run: Runner = async (argv, opts): Promise<Ran> => {
  const p = Bun.spawn([...argv], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};

let root: string;
let repo: string;
let head: string;
let snap: string;
let since: number;

const prep = async () => {
  const r = await prepareReviewSnapshot(run, { repoDir: repo, path: snap, headSha: head, jobId: "job1" });
  if (!r.ok) throw new Error(r.detail);
  since = r.startedAt;
};
const check = () => checkReviewScope(run, { path: snap, headSha: head, since });
/** Sets a file's mtime explicitly (seconds), well after `since`. */
const touchLater = (p: string) => { const t = (since + 60_000) / 1000; utimesSync(p, t, t); };

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "review-snap-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  await git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  head = await git(repo, "rev-parse", "HEAD");
  snap = reviewSnapshotPath(root, "repo", "job1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reviewSnapshotPath", () => {
  test("sanitizes the job id", () => {
    expect(reviewSnapshotPath("/wt", "dori", "a/b c:1")).toBe("/wt/dori-review-a_b_c_1");
    expect(reviewSnapshotPath("/wt/", "dori", "x.y-z_1")).toBe("/wt/dori-review-x.y-z_1");
  });
});

describe("prepareReviewSnapshot", () => {
  test("creates a detached locked worktree at head", async () => {
    await prep();
    expect(await git(snap, "rev-parse", "HEAD")).toBe(head);
    const list = await git(repo, "worktree", "list", "--porcelain");
    const block = list.split("\n\n").find((b) => b.includes(snap));
    expect(block).toContain("detached");
    expect(block).toContain("locked review:job1");
  });

  test("is idempotent", async () => {
    await prep();
    const again = await prepareReviewSnapshot(run, { repoDir: repo, path: snap, headSha: head, jobId: "job1" });
    expect(again.ok).toBe(true);
  });

  test("rejects a non-sha head and an unknown commit", async () => {
    expect((await prepareReviewSnapshot(run, { repoDir: repo, path: snap, headSha: "main", jobId: "j" })).ok).toBe(false);
    expect((await prepareReviewSnapshot(run, { repoDir: repo, path: snap, headSha: "0".repeat(40), jobId: "j" })).ok).toBe(false);
  });
});

describe("checkReviewScope", () => {
  test("ok on an untouched snapshot", async () => {
    await prep();
    expect(await check()).toEqual({ ok: true });
  });

  test("ok when only omo config files changed", async () => {
    await prep();
    mkdirSync(join(snap, ".omo"));
    writeFileSync(join(snap, ".omo", "omo.jsonc"), "{}\n");
    writeFileSync(join(snap, ".omo", "omo.jsonc.bak.123"), "{}\n");
    touchLater(join(snap, ".omo", "omo.jsonc"));
    touchLater(join(snap, ".omo", "omo.jsonc.bak.123"));
    expect(await check()).toEqual({ ok: true });
  });

  test("scope_violation on a modified tracked file", async () => {
    await prep();
    writeFileSync(join(snap, "a.txt"), "changed\n");
    const r = await check();
    expect(r).toMatchObject({ ok: false, code: "scope_violation" });
  });

  test("scope_violation on a new untracked file", async () => {
    await prep();
    writeFileSync(join(snap, "new.txt"), "x\n");
    expect(await check()).toMatchObject({ ok: false, code: "scope_violation" });
  });

  test("scope_violation next to an allowed omo file", async () => {
    await prep();
    mkdirSync(join(snap, ".omo"));
    writeFileSync(join(snap, ".omo", "omo.jsonc"), "{}\n");
    writeFileSync(join(snap, ".omo", "other.json"), "{}\n");
    expect(await check()).toMatchObject({ ok: false, code: "scope_violation" });
  });

  test("scope_violation when HEAD moved", async () => {
    await prep();
    await git(snap, "commit", "-q", "--allow-empty", "-m", "sneaky");
    const r = await check();
    expect(r).toMatchObject({ ok: false, code: "scope_violation" });
    if (!r.ok) expect(r.detail).toContain("HEAD");
  });

  test("scope_violation on a touched ignored file newer than since", async () => {
    await prep();
    const f = join(snap, "ignored.log");
    writeFileSync(f, "x\n");
    touchLater(f);
    const r = await check();
    expect(r).toMatchObject({ ok: false, code: "scope_violation" });
    if (!r.ok) expect(r.detail).toContain("ignored.log");
  });

  test("an ignored file older than since is fine", async () => {
    await prep();
    const f = join(snap, "ignored.log");
    writeFileSync(f, "x\n");
    const t = (since - 60_000) / 1000;
    utimesSync(f, t, t);
    expect(await check()).toEqual({ ok: true });
  });
});

describe("releaseReviewSnapshot", () => {
  test("removes a locked worktree and tolerates a missing path", async () => {
    await prep();
    expect(await releaseReviewSnapshot(run, { repoDir: repo, path: snap })).toEqual({ ok: true });
    expect(existsSync(snap)).toBe(false);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(snap);
    expect(await releaseReviewSnapshot(run, { repoDir: repo, path: snap })).toEqual({ ok: true });
  });
});
