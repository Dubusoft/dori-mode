import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE } from "../src/lane-sandbox-install.ts";
import type { Ran } from "../src/run.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { localPolicy } from "../src/runner/local-policy.ts";
import { fakeClock } from "./fakes.ts";

// The review lane profile (LANE_SANDBOX_PROFILE=review): the snapshot worktree, its git common dir, the worktree root
// and every repo .git are never writable, and no git or gh credential reaches the lane. bwrap cannot create namespaces
// in a lane, so the evidence is the argv the template would hand bwrap and its --explain table.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "review-lane-")));
  dirs.push(d);
  return d;
};

const git = (...args: string[]): void => {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

/** A home with every credential and cache the default mode binds, a repo under a repos root and a snapshot worktree of it. */
const fixture = () => {
  const root = scratch();
  const home = join(root, "home");
  const repos = join(root, "repos"), worktrees = join(root, "worktrees"), grantRw = join(root, "grant-rw"), grantRo = join(root, "grant-ro");
  for (const d of [".omo", ".cache", ".npm", ".bun/install/cache", ".cargo/registry", ".cargo/git", ".config/gh", ".config/git", ".config/herdr", ".dori/runner/briefs/lane-a.files"]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  for (const f of [".gitconfig", ".git-credentials", ".config/herdr/agent"]) writeFileSync(join(home, f), "x");
  for (const d of [worktrees, grantRw, grantRo, repos]) mkdirSync(d, { recursive: true });
  const repo = join(repos, "app");
  git("init", "-q", repo);
  git("-C", repo, "commit", "-q", "--allow-empty", "-m", "base");
  const snap = join(worktrees, "review-snap");
  git("-C", repo, "worktree", "add", "-q", "--detach", snap);
  const env = {
    DORI_LANE_KEY: "lane-a", LANE_SANDBOX_WORKTREES: worktrees, LANE_SANDBOX_REPOS: repos, LANE_SANDBOX_RW: grantRw, LANE_SANDBOX_RO: grantRo,
    SSH_AUTH_SOCK: join(home, ".config", "herdr", "agent"),
  };
  return { root, home, repos, worktrees, grantRw, grantRo, repo, gitDir: join(repo, ".git"), snap, env };
};

/** Runs the Linux template in `cwd` with a recording bwrap; returns the exit code, stderr and the bwrap argv. */
const runLinux = async (home: string, cwd: string, args: string[], env: Record<string, string>) => {
  const bin = join(home, "..", "fake-bin");
  const out = join(home, "..", "bwrap-argv");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(bin, "bwrap"), 0o755);
  rmSync(out, { force: true });
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, ...args], { cwd, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let argv: string[] = [];
  try { argv = readFileSync(out, "utf8").split("\n"); } catch { /* bwrap never ran */ }
  return { code, stdout, err, argv };
};

/** The read-write mount targets of a bwrap argv; a -try bind whose source is missing is skipped, as bwrap does. */
const rwTargets = (argv: string[]): string[] => argv.flatMap((a, i) => {
  if (a !== "--bind" && a !== "--bind-try") return [];
  const src = argv[i + 1] ?? "";
  if (a === "--bind-try" && Bun.spawnSync(["test", "-e", src]).exitCode !== 0) return [];
  return [argv[i + 2] ?? ""];
});

const pairs = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [`${argv[i + 1]}=${argv[i + 2]}`] : []));
const singles = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));

test("review profile: only briefs/<key>.out, ~/.omo, ~/.cache and the private TMPDIR are writable; the snapshot, its .git, the worktree root, repo .git dirs and RW grants are not", async () => {
  const f = fixture();
  const r = await runLinux(f.home, f.snap, ["true"], { ...f.env, LANE_SANDBOX_PROFILE: "review" });
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  const rw = rwTargets(r.argv);
  for (const p of [f.snap, f.gitDir, f.worktrees, f.grantRw, f.repos, "/tmp"]) expect(rw).not.toContain(p);
  // Exactly these writable host paths (omo tolerates its failed omo.jsonc backup, so no cwd file is bound rw).
  expect(new Set(rw)).toEqual(new Set([join(f.home, ".dori", "runner", "briefs", "lane-a.out"), join(f.home, ".omo"), join(f.home, ".cache"), join(f.home, ".lane-tmp")]));
  // Read-only: the snapshot and its common dir (git log/diff/show), the worktree root, the repo .git, the RO grant.
  const ro = r.argv.flatMap((a, i) => (a === "--ro-bind" || a === "--ro-bind-try" ? [r.argv[i + 2] ?? ""] : []));
  for (const p of [f.snap, f.gitDir, f.worktrees, f.grantRo]) expect(ro).toContain(p);
  // No credential: gh and git config and the ssh agent socket are not in the argv at all (~/.config is hidden); the git
  // config and git credentials, readable through the read-only $HOME otherwise, only as targets of a /dev/null bind.
  for (const p of [".config/gh", ".config/git", ".config/herdr/agent"]) expect(r.argv).not.toContain(join(f.home, p));
  for (const p of [join(f.home, ".git-credentials"), join(f.home, ".gitconfig")]) {
    expect(r.argv.flatMap((a, i) => (a === p ? [r.argv.slice(i - 2, i + 1).join(" ")] : []))).toEqual([`--ro-bind /dev/null ${p}`]);
  }
  expect(pairs(r.argv, "--setenv")).toEqual(expect.arrayContaining(["GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1"]));
  expect(singles(r.argv, "--unsetenv")).toEqual(expect.arrayContaining(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]));
  expect(singles(r.argv, "--tmpfs")).toContain("/tmp");
});

test("default profile still binds the snapshot, its .git, the worktree root and RW grants read-write, with credentials", async () => {
  const f = fixture();
  const r = await runLinux(f.home, f.snap, ["true"], f.env);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  const rw = rwTargets(r.argv);
  for (const p of [f.snap, f.gitDir, f.worktrees, f.grantRw, "/tmp", join(f.home, ".npm")]) expect(rw).toContain(p);
  expect(r.argv).toContain(join(f.home, ".config", "gh"));
  expect(pairs(r.argv, "--setenv")).not.toContain("GIT_CONFIG_GLOBAL=/dev/null");
});

test("lane-sandbox --explain comparison: default lists the snapshot, its .git and the worktree root rw; review lists them ro only", async () => {
  const f = fixture();
  const def = await runLinux(f.home, f.snap, ["--explain"], f.env);
  const rev = await runLinux(f.home, f.snap, ["--explain"], { ...f.env, LANE_SANDBOX_PROFILE: "review" });
  expect({ code: def.code, err: def.err }).toEqual({ code: 0, err: "" });
  expect({ code: rev.code, err: rev.err }).toEqual({ code: 0, err: "" });
  const defRows = def.stdout.trim().split("\n");
  const revRows = rev.stdout.trim().split("\n");
  expect(defRows[0]).toBe(`# lane-sandbox --explain (bwrap) for lane lane-a in ${f.snap}: a later line wins at and below its path`);
  expect(revRows[0]).toBe(`# lane-sandbox --explain (bwrap) for lane lane-a in ${f.snap} (profile review): a later line wins at and below its path`);
  for (const p of [f.worktrees, f.gitDir, f.snap, f.grantRw]) {
    expect(defRows).toContain(`rw ${p}`);
    expect(revRows).not.toContain(`rw ${p}`);
  }
  for (const p of [f.worktrees, f.gitDir, f.snap]) expect(revRows).toContain(`ro ${p}`);
  expect(revRows.filter((row) => row.startsWith("rw ")).sort()).toEqual(
    [join(f.home, ".dori", "runner", "briefs", "lane-a.out"), join(f.home, ".omo"), join(f.home, ".cache"), join(f.home, ".lane-tmp")].map((p) => `rw ${p}`).sort());
});

test("an unknown LANE_SANDBOX_PROFILE, or review without a lane key, exits 2 and runs nothing", async () => {
  const f = fixture();
  const bogus = await runLinux(f.home, f.snap, ["true"], { ...f.env, LANE_SANDBOX_PROFILE: "reviewer" });
  expect(bogus.code).toBe(2);
  expect(bogus.err).toContain("unknown LANE_SANDBOX_PROFILE 'reviewer'");
  expect(bogus.argv).toEqual([]);
  const keyless = await runLinux(f.home, f.snap, ["true"], { LANE_SANDBOX_PROFILE: "review" });
  expect(keyless.code).toBe(2);
  expect(keyless.argv).toEqual([]);
});

test("macOS: any LANE_SANDBOX_PROFILE is refused with exit 2 and one error line", async () => {
  const home = join(scratch(), "home");
  mkdirSync(home, { recursive: true });
  for (const args of [["omo"], ["--explain"], ["--check"]]) {
    const child = Bun.spawn(["bash", LANE_SANDBOX_MACOS_TEMPLATE, ...args], { cwd: home, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, DORI_LANE_KEY: "lane-a", LANE_SANDBOX_PROFILE: "review" }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, out }).toEqual({ code: 2, out: "" });
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toContain("not supported on macOS");
  }
});

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

/** A local RunnerLanes over localPolicy with repos/worktree roots and a write grant; `shell` is what herdr reports. */
const reviewRunner = (shell: "posix" | "pwsh" = "posix") => {
  const home = scratch();
  const repo = join(home, "repos", "app"), snap = join(home, "worktrees", "snap"), grant = join(home, "grant");
  for (const d of [repo, snap, grant]) mkdirSync(d, { recursive: true });
  const runnerDir = join(home, ".dori", "runner");
  mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
  const policy = {
    ...localPolicy({ ...defaultConfig(home), leadCwd: repo, worktreeRoot: join(home, "worktrees") }, { home, tmp: home }),
    reposRoot: join(home, "repos"), grants: { notes: { write: [grant], read: [] } },
  };
  const calls: string[][] = [];
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(0), policy, token: () => "tok", publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "lane-sandbox" && argv.includes("--check")) return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      if (shell === "pwsh" && argv.slice(0, 3).join(" ") === "herdr pane process-info") {
        return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 7, foreground_processes: [{ pid: 7, name: "pwsh.exe" }] } } }), err: "" } as Ran;
      }
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  const start = {
    cmdId: "lane-start:lane-r:1", key: "lane-r", briefText: "# brief\n", done: "x", thread: "none", cwd: snap, agentProfile: "review",
    mode: "ulw", model: "m1", sandbox: false, expectedLaneGen: 0, files: FILES, grants: ["notes"],
  };
  return { home, policy, lanes, calls, start };
};

test("localPolicy's review profile is the sandboxed argv", () => {
  const policy = localPolicy({ ...defaultConfig("/home/u"), leadCwd: "/home/u/repo", worktreeRoot: "", laneSandbox: { command: ["lane-sandbox", "--strict"] } }, { home: "/home/u", tmp: "/tmp" });
  expect(policy.agents.review).toEqual(policy.agents.sandboxed);
});

test("a review lane.start runs the sandbox check (even with sandbox: false) and launches with LANE_SANDBOX_PROFILE=review and no rw roots", async () => {
  const { lanes, calls, start } = reviewRunner();
  await lanes.start(start);
  expect(calls[0]).toEqual(["lane-sandbox", "--check"]);
  const command = calls.find((a) => a[1] === "pane" && a[2] === "run")?.[4] ?? "";
  expect(command).toContain("LANE_SANDBOX_PROFILE=review ");
  expect(command).toContain(" lane-sandbox omo ");
  for (const name of ["LANE_SANDBOX_REPOS", "LANE_SANDBOX_WORKTREES", "LANE_SANDBOX_RW"]) expect(command).not.toContain(name);
  // The unsandboxed branch's outside rules never apply to a review lane.
  expect(command).toContain(" --permission-preset full-access ");
  expect(command).not.toContain(" --permission ");
  expect(lanes.records()["lane-r"]?.profile).toBe("review");

  // The same runner's sandboxed lane keeps the roots and grants: only the review profile drops them.
  calls.length = 0;
  await lanes.start({ ...start, cmdId: "lane-start:lane-s:1", key: "lane-s", agentProfile: "sandboxed", sandbox: true });
  const sandboxed = calls.find((a) => a[1] === "pane" && a[2] === "run")?.[4] ?? "";
  for (const name of ["LANE_SANDBOX_REPOS=", "LANE_SANDBOX_WORKTREES=", "LANE_SANDBOX_RW="]) expect(sandboxed).toContain(name);
  expect(sandboxed).not.toContain("LANE_SANDBOX_PROFILE");
});

test("a review lane.start on a PowerShell pane is refused, its tab closed and nothing typed", async () => {
  const { lanes, calls, start } = reviewRunner("pwsh");
  await expect(lanes.start(start)).rejects.toThrow("RUNNER_LANE_REVIEW_UNSANDBOXED lane-r");
  expect(calls.some((a) => a[1] === "pane" && a[2] === "run")).toBe(false);
  expect(calls).toContainEqual(["herdr", "tab", "close", "t1"]);
  expect(lanes.records()).toEqual({});
});
