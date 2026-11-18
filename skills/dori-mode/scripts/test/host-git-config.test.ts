import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostGitEnv, run } from "../src/run.ts";

const root = mkdtempSync(join(tmpdir(), "host-git-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A script that creates `marker` when anything runs it. */
const trap = (path: string, marker: string): string => {
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
};

const plain = async (argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> =>
  Bun.spawn(argv, { env: { ...env }, stdout: "ignore", stderr: "ignore" }).exited;

/**
 * A repo whose `.git/config` (written the way a lane can) points core.hooksPath at a hook dir, core.fsmonitor at a
 * command and core.sshCommand at a wrapper, each of which leaves a marker file when git runs it.
 */
const laneRepo = async (name: string) => {
  const dir = join(root, name);
  const repo = join(dir, "repo");
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  const markers = { hook: join(dir, "hook-ran"), fsmonitor: join(dir, "fsmonitor-ran"), ssh: join(dir, "ssh-ran") };
  const g = (...args: string[]) => plain(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args]);
  expect(await plain(["git", "init", "-q", repo])).toBe(0);
  writeFileSync(join(repo, "f"), "x\n");
  expect(await g("add", "f")).toBe(0);
  expect(await g("commit", "-q", "-m", "f")).toBe(0);
  trap(join(hooks, "reference-transaction"), markers.hook);
  trap(join(hooks, "post-checkout"), markers.hook);
  expect(await g("config", "core.hooksPath", hooks)).toBe(0);
  expect(await g("config", "core.fsmonitor", trap(join(dir, "fsmonitor"), markers.fsmonitor))).toBe(0);
  expect(await g("config", "core.sshCommand", trap(join(dir, "ssh"), markers.ssh))).toBe(0);
  expect(await g("remote", "add", "origin", "ssh://git@lane.invalid/acme/app.git")).toBe(0);
  return { repo, markers };
};

/** The host git calls the runner makes in a lane's checkout, each of which reaches one of the three settings. */
const hostCalls = (repo: string): string[][] => [
  ["git", "-C", repo, "status", "--porcelain"],
  ["git", "-C", repo, "update-ref", "refs/heads/probe", "HEAD"],
  ["git", "-C", repo, "worktree", "add", "--detach", `${repo}-wt`, "HEAD"],
  ["git", "-C", repo, "ls-remote", "--heads", "origin"],
];

test("the lane's repo config does run commands when git starts without the host env (the trap is live)", async () => {
  const { repo, markers } = await laneRepo("bare-git");
  for (const argv of hostCalls(repo)) await plain(argv);
  expect({ hook: existsSync(markers.hook), fsmonitor: existsSync(markers.fsmonitor), ssh: existsSync(markers.ssh) })
    .toEqual({ hook: true, fsmonitor: true, ssh: true });
});

test("host git through run() never runs core.hooksPath, core.fsmonitor or core.sshCommand from the lane's repo", async () => {
  const { repo, markers } = await laneRepo("host-run");
  const codes: number[] = [];
  for (const argv of hostCalls(repo)) codes.push((await run(argv, { timeoutMs: 20_000 })).code);
  // The local steps still work; only the remote one fails (no such host).
  expect(codes.slice(0, 3)).toEqual([0, 0, 0]);
  expect({ hook: existsSync(markers.hook), fsmonitor: existsSync(markers.fsmonitor), ssh: existsSync(markers.ssh) })
    .toEqual({ hook: false, fsmonitor: false, ssh: false });
});

test("hostGitEnv appends its pairs after the ones the environment already has", () => {
  const env = hostGitEnv({ PATH: "/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", UNSET: undefined });
  expect(env).toEqual({
    PATH: "/bin", GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.sshCommand", GIT_CONFIG_VALUE_3: "ssh",
  });
});
