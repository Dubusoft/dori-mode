import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { INTENDED, SENSITIVE } from "../src/doctor.ts";
import { CREDENTIAL_DENY, installedLaneSandbox, LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE, laneSandboxScript, refreshLaneSandbox } from "../src/lane-sandbox-install.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-sandbox-"));
  dirs.push(d);
  return d;
};

/** Runs the shipped template with a recording `bwrap` first on PATH and returns the argv it would have run bwrap with. */
const sandboxArgv = async (home: string, env: Record<string, string>, work = join(home, "work")): Promise<string[]> => {
  const bin = join(home, "fake-bin");
  const out = join(home, "bwrap-argv");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(bin, "bwrap"), 0o755);
  mkdirSync(work, { recursive: true });
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "true"], { cwd: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  expect({ code: await child.exited, err: await new Response(child.stderr).text() }).toEqual({ code: 0, err: "" });
  return readFileSync(out, "utf8").split("\n");
};

test("the real BrowserSkill home is bound read-only, including an explicit BSK_HOME", async () => {
  const home = join(tempDir(), "home");
  const bskHome = join(home, ".bsk");
  mkdirSync(bskHome, { recursive: true });
  const bind = (argv: string[], path: string) => argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === path && argv[i + 2] === path);
  const readWriteNames = (argv: string[], path: string) => argv.some((a, i) => (a === "--bind" || a === "--bind-try") && (argv[i + 1] === path || argv[i + 2] === path));

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });
  expect(bind(argv, bskHome)).toBeGreaterThan(-1);
  expect(readWriteNames(argv, bskHome)).toBe(false);

  const customBskHome = tempDir();
  const customArgv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", BSK_HOME: customBskHome });
  expect(bind(customArgv, customBskHome)).toBeGreaterThan(-1);
  expect(readWriteNames(customArgv, customBskHome)).toBe(false);
});

test("a sandboxed lane gets its own token file, the runner's lane socket, its brief and the runner's bin (read-only), its own lanes/<key> mount point, and nothing else of the runner dir or the env file", async () => {
  const home = join(tempDir(), "home");
  const runner = join(home, ".dori", "runner");
  mkdirSync(join(runner, "briefs"), { recursive: true });
  mkdirSync(join(runner, "sock"), { recursive: true });
  const own = join(runner, "briefs", "lane-a.2.token");
  for (const f of [own, join(runner, "briefs", "lane-b.1.token"), join(runner, "briefs", "lane-a.md"), join(runner, "briefs", "lane-b.md"), join(home, ".dori", "env")]) writeFileSync(f, "x");

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: own });

  const tokenBind = argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === own && argv[i + 2] === own);
  const runnerRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === runner);
  expect(tokenBind).toBeGreaterThan(-1);
  // The token's mount point has to exist before the runner dir's tmpfs turns read-only.
  expect(tokenBind).toBeLessThan(runnerRo);
  expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === runner)).toBeGreaterThan(-1);
  const runnerPaths = [...new Set(argv.filter((a) => a.startsWith(runner)))].sort();
  expect(runnerPaths).toEqual([runner, join(runner, "bin"), join(runner, "briefs", "lane-a.2.token"), join(runner, "briefs", "lane-a.files"), join(runner, "briefs", "lane-a.md"), join(runner, "briefs", "lane-a.out"), join(runner, "lanes", "lane-a"), join(runner, "sock"), join(runner, "sock", "herdr.d", "lane-a"), join(runner, "sock", "herdr.d", "lane-a", "herdr"), join(runner, "sock", "lane.d")]);
  // sock itself is only a mount point (--dir); the lane socket's directory is the one thing bound into it. A directory,
  // not the socket file: a restarted runner's new socket at the same path shows through a directory bind only.
  expect(argv.flatMap((a, i) => (argv[i + 1] === join(runner, "sock") ? [a] : []))).toEqual(["--dir"]);
  const laneDir = join(runner, "sock", "lane.d");
  expect(argv.flatMap((a, i) => (argv[i + 1] === laneDir && argv[i + 2] === laneDir ? [a] : []))).toEqual(["--ro-bind-try"]);
  const input = join(runner, "briefs", "lane-a.files"), output = join(runner, "briefs", "lane-a.out");
  expect(argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === input && argv[i + 2] === input)).toBeLessThan(runnerRo);
  expect(argv.findIndex((a, i) => a === "--dir" && argv[i + 1] === output)).toBeLessThan(runnerRo);
  expect(argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === output && argv[i + 2] === output)).toBeGreaterThan(runnerRo);
  // A worker host's dori lives in bin: bound read-only, never read-write, so a lane cannot rewrite what the runner runs.
  const bin = join(runner, "bin");
  expect(argv.flatMap((a, i) => (argv[i + 1] === bin && argv[i + 2] === bin ? [a] : []))).toEqual(["--ro-bind-try"]);
  // The env file shows only as hidden: /dev/null over it, after the runner dir.
  const env = join(home, ".dori", "env");
  expect(argv.flatMap((a, i) => (argv[i + 2] === env ? [`${a} ${argv[i + 1]}`] : []))).toEqual(["--ro-bind /dev/null"]);
  expect(argv.indexOf(env)).toBeGreaterThan(runnerRo);
});

test("a lane reaches herdr only through its own report socket directory, read-only, named by HERDR_SOCKET_PATH", async () => {
  const home = join(tempDir(), "home");
  const own = join(home, ".dori", "runner", "sock", "herdr.d", "lane-a");

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", HERDR_SOCKET_PATH: join(home, ".config", "herdr", "herdr.sock") });

  const herdrDirs = [...new Set(argv.filter((a) => a.includes("herdr.d")))].sort();
  expect(herdrDirs).toEqual([own, join(own, "herdr")]);
  expect(argv.flatMap((a, i) => (argv[i + 1] === own && argv[i + 2] === own ? [a] : []))).toEqual(["--ro-bind-try"]);
  // The directory's mount point has to exist before the runner dir's tmpfs turns read-only.
  expect(argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === own)).toBeLessThan(argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === join(home, ".dori", "runner")));
  const setenv = argv.flatMap((a, i) => (a === "--setenv" && argv[i + 1] === "HERDR_SOCKET_PATH" ? [argv[i + 2]] : []));
  expect(setenv).toEqual([join(own, "herdr")]);
  expect(argv.some((a) => a.startsWith(join(home, ".config", "herdr")))).toBe(false);
});

test("the D-Bus session bus and the systemd user manager's sockets are covered, so a lane cannot start a unit outside the sandbox", async () => {
  const home = join(tempDir(), "home");
  const run = join(home, "..", "run-user");
  mkdirSync(join(run, "systemd"), { recursive: true });
  mkdirSync(join(run, "at-spi"));
  const servers = [join(run, "bus"), join(run, "at-spi", "bus")].map((path) => Bun.listen({ unix: path, socket: { data() {} } }));
  try {
    const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", XDG_RUNTIME_DIR: run });
    const over = (p: string) => argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === p);
    expect(over(join(run, "bus"))).toBeGreaterThan(-1);
    expect(over(join(run, "at-spi", "bus"))).toBeGreaterThan(-1);
    expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === join(run, "systemd"))).toBeGreaterThan(-1);
    expect(argv.findIndex((a, i) => a === "--unsetenv" && argv[i + 1] === "DBUS_SESSION_BUS_ADDRESS")).toBeGreaterThan(-1);
  } finally {
    for (const s of servers) s.stop(true);
  }
});

test("~/.config is hidden after every read-write bind, with only gh, git and an ssh agent socket under it bound back", async () => {
  const home = join(tempDir(), "home");
  const config = join(home, ".config");
  mkdirSync(join(config, "gcloud"), { recursive: true });
  const agent = join(config, "herdr", "herdr.sock.agent");
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", SSH_AUTH_SOCK: agent });
  expect([...new Set(argv.filter((a) => a.startsWith(config)))].sort()).toEqual([config, join(config, "gh"), join(config, "git"), agent]);
  const hide = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === config);
  expect(hide).toBeGreaterThan(argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === join(home, "work")));
  expect(argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === config)).toBeGreaterThan(argv.indexOf(agent));
  // An agent socket outside $HOME is visible through the host's own binds already.
  const outside = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", SSH_AUTH_SOCK: "/run/user/1/openssh_agent" });
  expect(outside).not.toContain("/run/user/1/openssh_agent");
});

test("no ssh private key is bound, even when the ssh agent holds no identities", async () => {
  const home = join(tempDir(), "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  for (const f of ["id_rsa", "id_ed25519", "known_hosts"]) writeFileSync(join(home, ".ssh", f), "x");
  const bin = join(home, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ssh-add"), "#!/bin/sh\necho 'The agent has no identities.'\nexit 1\n");
  chmodSync(join(bin, "ssh-add"), 0o755);
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });
  expect(argv.filter((a) => a.startsWith(join(home, ".ssh", "id_")))).toEqual([]);
  expect(argv).toContain(join(home, ".ssh", "known_hosts"));
});

test("each existing path in ~/.dori/lane-sandbox-hide is covered after every bind, a cwd or LANE_SANDBOX_RW under it included", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const backup = join(root, "backup"), copy = join(root, "env-copy");
  mkdirSync(join(backup, "snap"), { recursive: true });
  mkdirSync(join(home, ".dori"), { recursive: true });
  writeFileSync(copy, "x");
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `# backups\n  ${backup}  \n${copy} # a stray copy\n${join(root, "missing")}\n${join(home, ".dori", "env")}\n\n`);
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_RW: join(backup, "snap") });

  const dir = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === backup);
  const file = argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === copy);
  const rw = argv.findIndex((a, i) => a === "--bind-try" && argv[i + 1] === join(backup, "snap"));
  expect(rw).toBeGreaterThan(-1);
  expect(dir).toBeGreaterThan(rw);
  expect(file).toBeGreaterThan(rw);
  expect(argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === backup)).toBeGreaterThan(dir);
  // A missing path is skipped (bwrap would create it), under ~/.dori too.
  expect(argv).not.toContain(join(root, "missing"));
  expect(argv).not.toContain(join(home, ".dori", "env"));
});

/** The argv index of the last read-write bind other than the private TMPDIR's (which is bound after every hide). */
const lastReadWrite = (argv: string[], home: string): number => argv.findLastIndex((a, i) => (a === "--bind" || a === "--bind-try") && argv[i + 2] !== join(home, ".lane-tmp"));

test("~/.dori/secrets is hidden after every read-write bind, even with no ~/.dori/lane-sandbox-hide file", async () => {
  const home = join(tempDir(), "home");
  const secrets = join(home, ".dori", "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "NPM_TOKEN.cred"), "x");

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  expect(existsSync(join(home, ".dori", "lane-sandbox-hide"))).toBe(false);
  expect(argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === join(home, ".dori"))).toBeGreaterThan(-1);
  const hide = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === secrets && argv[i + 2] === "--remount-ro" && argv[i + 3] === secrets);
  expect(hide).toBeGreaterThan(lastReadWrite(argv, home));
  expect(argv.filter((a) => a === secrets || a.startsWith(`${secrets}/`))).toEqual([secrets, secrets]);
});

test("~/.dori is the host's, read-only, with the state dir hidden; every read-write mount in the runner dir has its mount point created before that tmpfs turns read-only", async () => {
  const home = join(tempDir(), "home");
  const dori = join(home, ".dori"), runner = join(dori, "runner");
  mkdirSync(join(dori, "state"), { recursive: true });

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  expect(argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === dori && argv[i + 2] === dori)).toBeGreaterThan(-1);
  // bwrap cannot mkdir a mount point in the read-only host bind, so the wrapper makes the heavy dir on the host.
  expect(existsSync(join(dori, "heavy"))).toBe(true);
  const rwInDori = argv.flatMap((a, i) => ((a === "--bind" || a === "--bind-try") && argv[i + 2]?.startsWith(`${dori}/`) ? [argv[i + 2]] : []));
  expect(rwInDori).toContain(join(dori, "heavy"));
  // The state dir (supervisor key, registry, decisions) is hidden after every read-write bind.
  const state = join(dori, "state");
  expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === state && argv[i + 2] === "--remount-ro" && argv[i + 3] === state)).toBeGreaterThan(lastReadWrite(argv, home));
  // bwrap cannot mkdir a missing mount point on the read-only tmpfs (EROFS), so each one is a --dir before the remount.
  const runnerRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === runner);
  expect(runnerRo).toBeGreaterThan(-1);
  const createdBefore = argv.slice(0, runnerRo).flatMap((a, i, before) => (a === "--dir" ? [before[i + 1]] : []));
  const rwInRunner = rwInDori.filter((p) => p?.startsWith(`${runner}/`));
  expect(rwInRunner).toEqual([join(runner, "briefs", "lane-a.out")]);
  expect(rwInRunner.filter((p) => !createdBefore.includes(p))).toEqual([]);
});

test("a cwd-less lane's cwd under the runner dir is bound read-write into that dir's tmpfs, once", async () => {
  const home = realpathSync(join(tempDir()));
  const cwd = join(home, ".dori", "runner", "lanes", "lane-a");
  mkdirSync(cwd, { recursive: true });

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" }, cwd);

  const runnerRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === join(home, ".dori", "runner"));
  expect(argv.flatMap((a, i) => (argv[i + 1] === cwd && (argv[i + 2] === cwd || a === "--dir") ? [a] : []))).toEqual(["--dir", "--dir", "--bind"]);
  expect(argv.findLastIndex((a, i) => a === "--dir" && argv[i + 1] === cwd)).toBeLessThan(runnerRo);
  expect(argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === cwd)).toBeGreaterThan(runnerRo);
});

test("a hidden path under ~/.dori is hidden too; inside a hidden subtree only a path under an entry bound back gets its own cover", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const research = join(home, ".dori", "research", "lane-x"), gh = join(home, ".config", "gh"), gcloud = join(home, ".config", "gcloud");
  for (const d of [research, gh, gcloud, join(home, ".ssh")]) mkdirSync(d, { recursive: true });
  for (const f of [join(research, "report.md"), join(research, "secret.txt"), join(gh, "hosts.yml"), join(home, ".ssh", "id_ed25519"), join(home, ".gitconfig")]) writeFileSync(f, "x");
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${join(research, "secret.txt")}\n${join(gh, "hosts.yml")}\n${join(home, ".ssh", "id_ed25519")}\n`);

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });
  const over = (p: string) => argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === p);

  expect(over(join(research, "secret.txt"))).toBeGreaterThan(lastReadWrite(argv, home));
  expect(argv).not.toContain(join(research, "report.md"));
  // Bound back with gh, so covered on its own after that bind.
  expect(over(join(gh, "hosts.yml"))).toBeGreaterThan(argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === gh));
  // Hidden with its subtree: no mount point there to cover (bwrap would fail on the read-only tmpfs).
  expect(argv).not.toContain(join(home, ".ssh", "id_ed25519"));
  expect(argv).not.toContain(gcloud);

  // A review lane keeps no git config: the host's is covered, and neither gh nor git is bound back.
  const review = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_PROFILE: "review" });
  expect(review.findIndex((a, i) => a === "--ro-bind" && review[i + 1] === "/dev/null" && review[i + 2] === join(home, ".gitconfig"))).toBeGreaterThan(-1);
  expect(review).not.toContain(gh);
});

test("a glob in the hide list or the shared credential list hides each existing match, dotfiles and ~/.dori entries included, and --explain lists each", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const keys = join(root, "keys"), research = join(home, ".dori", "research");
  for (const d of [join(keys, "sub"), join(research, "ap-1-1")]) mkdirSync(d, { recursive: true });
  for (const f of [join(keys, "a.pem"), join(keys, ".b.pem"), join(keys, "c.txt"), join(keys, "sub", "d.pem"), join(research, "secret-x"), join(research, "ap-1-1", "report.md"), join(home, ".zsh_history"), join(home, ".node_repl_history")]) writeFileSync(f, "x");
  // dir/.* never matches the directory itself or its parent; a glob matching nothing adds nothing.
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${join(keys, "*.pem")}\n${join(keys, ".*")}\n${join(root, "none", "*.key")}\n${join(research, "secret-x")}\n`);
  const env = { DORI_LANE_KEY: "lane-a" };

  const argv = await sandboxArgv(home, env);
  const after = (p: string) => argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === p) > lastReadWrite(argv, home);
  for (const p of [join(keys, "a.pem"), join(keys, ".b.pem"), join(research, "secret-x"), join(home, ".zsh_history"), join(home, ".node_repl_history")]) expect({ p, hidden: after(p) }).toEqual({ p, hidden: true });
  const hides = argv.flatMap((a, i) => (a === "--tmpfs" ? [argv[i + 1]] : a === "--ro-bind" && argv[i + 1] === "/dev/null" ? [argv[i + 2]] : []));
  for (const p of [keys, root, home, join(keys, "c.txt"), join(keys, "sub", "d.pem"), join(research, "ap-1-1", "report.md")]) expect({ p, hidden: hides.includes(p) }).toEqual({ p, hidden: false });
  expect(argv.some((a) => a.includes("*"))).toBe(false);

  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "--explain"], { cwd: join(home, "work"), env: { PATH: `${join(home, "fake-bin")}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  for (const p of [join(keys, "a.pem"), join(keys, ".b.pem"), join(research, "secret-x"), join(home, ".zsh_history"), join(home, ".node_repl_history")]) expect(explainRows(out)).toContain(`hide ${p}`);
});

test("the top-level directory holding $HOME is the sandbox's own, not a read-only bind of the host's root-owned one", async () => {
  // Under TMPDIR (/tmp, /dev/shm) the top-level entry is skipped anyway; next to this file it is one the script binds.
  const home = mkdtempSync(join(import.meta.dir, ".sandbox-home-"));
  dirs.push(home);
  const top = `/${home.split("/")[1]}`;

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  // A host bind shows root as the overflow uid inside the user namespace, and omo refuses that trust ancestor.
  expect(argv.filter((a, i) => a.startsWith("--") && argv[i + 1] === top)).toEqual([]);
});

test("LANE_SANDBOX_VERIFY binds nothing: a lane's only output path is DORI_LANE_OUT", async () => {
  const home = join(tempDir(), "home");
  const state = join(home, "..", "ws", "state");
  const verify = join(state, "verify");
  mkdirSync(verify, { recursive: true });

  const rw = (argv: string[]) => argv.flatMap((a, i) => (a === "--bind" || a === "--bind-try" ? [argv[i + 2] ?? ""] : []));
  const bound = rw(await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_VERIFY: verify }));
  expect(bound).not.toContain(verify);
  expect(bound).not.toContain(state);
  expect(bound).not.toContain(join(state, ".."));
});

test("a cwd-less lane gets the worktree root and each repo's .git under the repos root read-write, but no repo's hooks, working tree or the repos root itself", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const repos = join(root, "repos"), worktrees = join(root, "worktrees");
  for (const d of [join(repos, "app", ".git", "hooks"), join(repos, "lib", ".git"), join(repos, "plain"), join(repos, "wt"), worktrees]) mkdirSync(d, { recursive: true });
  // A worktree checked out under the repos root has a .git file, not a directory: nothing to bind there.
  writeFileSync(join(repos, "wt", ".git"), "gitdir: elsewhere\n");
  mkdirSync(join(home, ".dori"), { recursive: true });
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${join(repos, "lib", ".git")}\n`);

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_REPOS: `${repos}/`, LANE_SANDBOX_WORKTREES: worktrees });

  const rw = argv.flatMap((a, i) => (a === "--bind" || a === "--bind-try" ? [argv[i + 2] ?? ""] : []));
  expect(rw).toContain(worktrees);
  expect(rw.filter((p) => p.startsWith(`${repos}/`) || p === repos).sort()).toEqual([join(repos, "app", ".git"), join(repos, "lib", ".git")]);
  const at = (flag: string, p: string) => argv.findIndex((a, i) => a === flag && argv[i + 1] === p && argv[i + 2] === p);
  const hooks = join(repos, "app", ".git", "hooks");
  expect(at("--ro-bind-try", hooks)).toBeGreaterThan(at("--bind", join(repos, "app", ".git")));
  expect(at("--ro-bind-try", hooks)).toBeGreaterThan(at("--bind", join(repos, "lib", ".git")));
  // A hidden .git stays hidden: the hide list comes after the repos binds.
  expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === join(repos, "lib", ".git"))).toBeGreaterThan(at("--bind", join(repos, "lib", ".git")));

  const without = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });
  expect(without.flatMap((a, i) => (a === "--bind" || a === "--bind-try" ? [without[i + 2] ?? ""] : [])).filter((p) => p.startsWith(repos) || p.startsWith(worktrees))).toEqual([]);
});

test("refreshLaneSandbox replaces an outdated install, keeps the old copy, and leaves a current or missing one alone", () => {
  const home = tempDir();
  const installed = installedLaneSandbox(home);
  expect(refreshLaneSandbox(home)).toBeUndefined();
  expect(existsSync(installed)).toBe(false);

  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(installed, "#!/bin/sh\nold sandbox\n");
  expect(refreshLaneSandbox(home)).toStartWith(`LANE_SANDBOX_UPDATED ${installed}`);
  expect(readFileSync(installed)).toEqual(readFileSync(LANE_SANDBOX_TEMPLATE));
  expect(statSync(installed).mode & 0o777).toBe(0o755);
  expect(readFileSync(`${installed}.bak`, "utf8")).toBe("#!/bin/sh\nold sandbox\n");

  expect(refreshLaneSandbox(home)).toBeUndefined();
});

/** Runs `lane-sandbox --check` with PATH limited to `bin` (plus the dirs bash needs) and DORI_LANE_KEY unset, like the lead. */
const check = async (bin: string) => {
  const child = Bun.spawn([Bun.which("bash") ?? "bash", LANE_SANDBOX_TEMPLATE, "--check"], { env: { PATH: bin, HOME: bin }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
};
const fakeBwrap = (dir: string, body: string): string => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "bwrap"), 0o755);
  return bin;
};

test("--check exits 3 with one stderr line when bwrap is not on PATH", async () => {
  const empty = join(tempDir(), "empty");
  mkdirSync(empty);
  const r = await check(empty);
  expect(r.code).toBe(3);
  expect(r.err.trim().split("\n")).toEqual(["lane-sandbox: bwrap not found on PATH"]);
});

test("--check exits 0 when bwrap --ro-bind / / true succeeds, even without DORI_LANE_KEY", async () => {
  const dir = tempDir();
  const bin = fakeBwrap(dir, `[ "$*" = "--ro-bind / / true" ] || exit 9`);
  expect(await check(bin)).toEqual({ code: 0, out: "DORI_LANE_FILES=1\n", err: "" });
});

test("--check exits 3 with bwrap's reason on one line when bwrap cannot create a sandbox", async () => {
  const bin = fakeBwrap(tempDir(), 'echo "bwrap: No permissions to create new namespace" >&2; exit 1');
  const r = await check(bin);
  expect(r.code).toBe(3);
  expect(r.err.trim().split("\n")).toEqual(["lane-sandbox: bwrap cannot create a sandbox: bwrap: No permissions to create new namespace"]);
});

// macOS (Seatbelt) wrapper. sandbox-exec does not exist here, so the template runs with a recording one in place of
// /usr/bin/sandbox-exec, and the profile it would have been given is evaluated below with SBPL's last-match-wins rule.

type Seatbelt = { profile: string; params: Record<string, string>; command: string[]; env: Record<string, string>; err: string };

/** Runs the macOS template with `sbx` as its sandbox-exec, in `cwd`, with only `env` (plus PATH and HOME). */
const runMacos = async (home: string, cwd: string, args: string[], env: Record<string, string>, sbx: string) => {
  const script = join(home, "..", "lane-sandbox-macos.sh");
  writeFileSync(script, readFileSync(LANE_SANDBOX_MACOS_TEMPLATE, "utf8").replace(/^SBX=.*$/m, `SBX=${sbx}`).replace(/^CERTS=.*$/m, `CERTS=${join(home, "..", "cert.pem")}`));
  const child = Bun.spawn(["bash", script, ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
};

/** The sandbox-exec argv and environment a lane in `cwd` would get. */
const seatbelt = async (home: string, cwd: string, env: Record<string, string>): Promise<Seatbelt> => {
  const out = join(home, "..", "sbx-argv");
  const sbx = join(home, "..", "fake-sandbox-exec");
  writeFileSync(sbx, `#!/bin/sh\nprintf '%s\\0' "$@" > "${out}"\nprintf 'TMPDIR=%s\\0LANE_SANDBOX_ACTIVE=%s\\0SSL_CERT_FILE=%s\\0OMO_PROFILE=%s\\0HERDR_SOCKET_PATH=%s\\0' "$TMPDIR" "$LANE_SANDBOX_ACTIVE" "$SSL_CERT_FILE" "$OMO_PROFILE" "$HERDR_SOCKET_PATH" > "${out}.env"\n`);
  chmodSync(sbx, 0o755);
  const r = await runMacos(home, cwd, ["omo", "--model", "m"], env, sbx);
  expect(r.code).toBe(0);
  const argv = readFileSync(out, "utf8").split("\0").slice(0, -1);
  expect(argv[0]).toBe("-p");
  const params: Record<string, string> = {};
  let i = 2;
  for (; argv[i] === "-D"; i += 2) {
    const kv = argv[i + 1] ?? "";
    params[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
  }
  expect(argv[i]).toBe("--");
  const envOut = Object.fromEntries(readFileSync(`${out}.env`, "utf8").split("\0").slice(0, -1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  return { profile: argv[1] ?? "", params, command: argv.slice(i + 1), env: envOut, err: r.err };
};

type Sexp = string | { raw: string } | Sexp[];
const parseSbpl = (text: string): Sexp[] => {
  const tokens = text.match(/#"(?:[^"\\]|\\.)*"|"(?:[^"\\]|\\.)*"|[()]|[^\s()]+/g) ?? [];
  let pos = 0;
  const read = (): Sexp => {
    const t = tokens[pos++] as string;
    if (t === "(") {
      const list: Sexp[] = [];
      while (tokens[pos] !== ")") list.push(read());
      pos++;
      return list;
    }
    if (t.startsWith('#"')) return { raw: t.slice(2, -1) };
    if (t.startsWith('"')) return { raw: t.slice(1, -1) };
    return t;
  };
  const all: Sexp[] = [];
  while (pos < tokens.length) all.push(read());
  return all;
};

/**
 * Whether the profile lets `op` reach `path`: the last matching rule wins. "network-outbound" is a connect to the unix
 * socket at `path` (Seatbelt checks it apart from file reads).
 */
const allows = (sb: Seatbelt, op: "file-read-data" | "file-write-data" | "network-outbound", path: string): boolean => {
  const str = (x: Sexp): string => {
    if (Array.isArray(x) && x[0] === "param") return sb.params[(x[1] as { raw: string }).raw] ?? "\0unset";
    return (x as { raw: string }).raw;
  };
  const matches = (filter: Sexp): boolean => {
    if (!Array.isArray(filter)) throw new Error(`unexpected filter ${JSON.stringify(filter)}`);
    const [kind, arg] = filter;
    if (kind === "remote" && filter[1] === "unix-socket") return matches(filter[2] as Sexp);
    if (kind === "path-literal") return path === str(arg as Sexp);
    if (kind === "subpath") return path === str(arg as Sexp) || path.startsWith(`${str(arg as Sexp)}/`);
    if (kind === "literal") return path === str(arg as Sexp);
    if (kind === "regex") return new RegExp(str(arg as Sexp)).test(path);
    throw new Error(`unexpected filter ${String(kind)}`);
  };
  let verdict: boolean | undefined;
  for (const rule of parseSbpl(sb.profile)) {
    if (!Array.isArray(rule) || (rule[0] !== "allow" && rule[0] !== "deny")) continue;
    const opName = rule[1] as string;
    const hit = opName === "default" || opName === op || (opName.endsWith("*") && op.startsWith(opName.slice(0, -1)));
    if (!hit) continue;
    const filters = rule.slice(2);
    if (filters.length === 0 || filters.some(matches)) verdict = rule[0] === "allow";
  }
  if (verdict === undefined) throw new Error("profile has no default rule");
  return verdict;
};

/** A home with a runner dir, two lanes' briefs and tokens, the env file and ssh keys; a git worktree beside it. */
const macHome = () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const runner = join(home, ".dori", "runner");
  mkdirSync(join(runner, "briefs"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  for (const f of ["briefs/lane-a.2.token", "briefs/lane-b.1.token", "briefs/lane-a.md", "briefs/lane-b.md"]) writeFileSync(join(runner, f), "x");
  writeFileSync(join(home, ".dori", "env"), "SECRET=1");
  const wt = join(root, "wt");
  mkdirSync(wt);
  const git = Bun.spawnSync(["git", "init", "-q", wt]);
  expect(git.exitCode).toBe(0);
  return { root, home, runner, wt, token: join(runner, "briefs", "lane-a.2.token") };
};

test("macOS: a lane may write its worktree, TMPDIR and caches, but nothing else, and cannot read ~/.dori/env, ssh keys or another lane's token", async () => {
  const { home, runner, wt, token } = macHome();
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: token });
  const lt = join(home, ".cache", "omo-tmp", "lane-sandbox", "lane-a");

  expect(sb.command).toEqual(["omo", "--model", "m"]);
  expect(sb.env).toEqual({ TMPDIR: lt, LANE_SANDBOX_ACTIVE: "1", SSL_CERT_FILE: "", OMO_PROFILE: "dori-lane", HERDR_SOCKET_PATH: join(runner, "sock", "herdr.d", "lane-a", "herdr") });
  expect(statSync(lt).mode & 0o777).toBe(0o700);
  expect(sb.err).toBe("");

  const write = (p: string) => allows(sb, "file-write-data", p);
  const read = (p: string) => allows(sb, "file-read-data", p);
  expect(read(join(runner, "briefs/lane-a.files/input.bin"))).toBe(true);
  expect(write(join(runner, "briefs/lane-a.files/input.bin"))).toBe(false);
  expect(read(join(runner, "briefs/lane-a.out/report.md"))).toBe(true);
  expect(write(join(runner, "briefs/lane-a.out/report.md"))).toBe(true);
  expect(read(join(runner, "briefs/lane-b.files/input.bin"))).toBe(false);
  expect(write(join(runner, "briefs/lane-b.out/report.md"))).toBe(false);
  for (const ok of [join(wt, "src", "a.ts"), join(wt, ".git", "index"), join(lt, "x"), join(home, ".omo", "x"), join(home, ".cache", "x"), join(home, ".dori", "heavy", "x"), join(home, ".npm", "x"), "/tmp/x", "/dev/null"]) {
    expect({ ok, write: write(ok) }).toEqual({ ok, write: true });
  }
  for (const no of [join(home, "probe"), join(home, ".dori", "config.json"), join(home, ".dori", "env"), join(home, ".dori", "state", "x"), join(home, ".dori", "state", "runner-keys", "supervisor.key"), join(home, ".dori", "src", "x"), join(runner, "bin", "dori"), join(home, ".zshrc"), join(home, ".ssh", "authorized_keys"), join(wt, ".git", "hooks", "pre-commit"), "/etc/hosts"]) {
    expect({ no, write: write(no) }).toEqual({ no, write: false });
  }
  for (const ok of [token, join(runner, "briefs", "lane-a.md"), join(runner, "bin", "dori"), join(runner, "sock", "lane.d", "lane"), join(home, ".dori", "config.json"), join(home, ".dori", "src", "cli.ts"), join(home, ".dori", "research", "ap-1-1", "report.md"), join(home, ".dori", "lead", "notes.md"), join(home, ".dori", "heavy", "x"), join(home, ".ssh", "id_ed25519.pub"), join(home, ".ssh", "known_hosts"), join(home, ".ssh", "config"), "/etc/hosts", join(wt, "README.md")]) {
    expect({ ok, read: read(ok) }).toEqual({ ok, read: true });
  }
  for (const no of [join(home, ".dori", "env"), join(home, ".dori", "env", "x"), join(home, ".dori", "secrets", "NPM_TOKEN.cred"), join(home, ".dori", "lane-sandbox-hide"), join(home, ".dori", "gateway-locks", "x"), join(home, ".dori", "state", "runners.sqlite"), join(home, ".dori", "state", "runner-keys", "supervisor.key"), join(home, ".ssh", "id_ed25519"), join(home, ".ssh", "id_rsa"), join(home, ".ssh", "github_deploy"), join(home, ".ssh", "keys", "work.pem"), join(home, ".ssh", "config.d", "x"), join(home, ".ssh", "x.pub", "y"), join(runner, "briefs", "lane-b.1.token"), join(runner, "briefs", "lane-b.md"), join(runner, "keys", "runner.key"), join(runner, "state.sqlite"), join(runner, "runner.json")]) {
    expect({ no, read: read(no) }).toEqual({ no, read: false });
  }
});

test("macOS: a read grant never re-opens ~/.dori/runner, ~/.ssh or a credential store: their refusals come after every grant", async () => {
  const { home, runner, wt, token } = macHome();
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: token, LANE_SANDBOX_RO: [join(home, ".dori"), join(home, ".ssh"), join(home, ".aws"), join(home, ".config")].join(":") });
  const read = (p: string) => allows(sb, "file-read-data", p);

  for (const ok of [join(home, ".dori", "research", "x"), token, join(home, ".ssh", "known_hosts"), join(home, ".config", "gh", "config.yml")]) {
    expect({ ok, read: read(ok) }).toEqual({ ok, read: true });
  }
  for (const no of [join(home, ".dori", "env"), join(home, ".dori", "secrets", "x"), join(home, ".dori", "state", "x"), join(home, ".dori", "lane-sandbox-hide"), join(home, ".dori", "gateway-locks", "x"), join(runner, "briefs", "lane-b.1.token"), join(runner, "keys", "runner.key"), join(home, ".ssh", "id_ed25519"), join(home, ".aws", "credentials"), join(home, ".config", "herdr", "config.toml")]) {
    expect({ no, read: read(no) }).toEqual({ no, read: false });
  }
});

test("macOS: of the runner's sockets only the lane socket can be dialed, and of ~/.config only gh, git and the ssh agent socket are reachable", async () => {
  const { home, runner, wt } = macHome();
  const agent = join(home, ".config", "herdr", "herdr.sock.agent");
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", SSH_AUTH_SOCK: agent });
  const dial = (p: string) => allows(sb, "network-outbound", p);
  const read = (p: string) => allows(sb, "file-read-data", p);

  expect(dial(join(runner, "sock", "lane.d", "lane"))).toBe(true);
  expect(read(join(runner, "sock", "lane.d", "lane"))).toBe(true);
  expect(dial(join(runner, "sock", "herdr.d", "lane-a", "herdr"))).toBe(true);
  for (const no of [join(runner, "sock", "lane"), join(runner, "sock", "control"), join(runner, "sock", "cli"), join(runner, "sock", "herdr.d", "lane-b", "herdr"), join(home, ".config", "herdr", "herdr.sock")]) {
    expect({ no, dial: dial(no) }).toEqual({ no, dial: false });
  }
  expect(dial(agent)).toBe(true);
  expect(dial("/private/tmp/com.apple.launchd.x/Listeners")).toBe(true);
  for (const ok of [join(home, ".config", "gh", "hosts.yml"), join(home, ".config", "git", "ignore")]) {
    expect({ ok, read: read(ok) }).toEqual({ ok, read: true });
  }
  for (const no of [join(home, ".config", "cloudflare", "x"), join(home, ".config", "herdr", "config.toml")]) {
    expect({ no, read: read(no) }).toEqual({ no, read: false });
  }
});

test("macOS: each path in ~/.dori/lane-sandbox-hide is refused for reads, writes and socket connects, even as the cwd", async () => {
  const { root, home } = macHome();
  const backup = join(root, "backup");
  const cwd = join(backup, "wt");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `# backups\n  ${backup}  \n`);
  const sb = await seatbelt(home, cwd, { DORI_LANE_KEY: "lane-a" });

  expect(allows(sb, "file-read-data", join(backup, "snap", ".dori", "env"))).toBe(false);
  expect(allows(sb, "file-write-data", join(cwd, "a"))).toBe(false);
  expect(allows(sb, "network-outbound", join(backup, "s.sock"))).toBe(false);
  expect(allows(sb, "file-read-data", join(root, "other"))).toBe(true);
  expect(sb.profile).not.toContain(root);
});

test("macOS: a glob in the hide list or the shared credential list refuses every path it matches, now or later, and ~/.dori entries are refused too", async () => {
  const { root, home, wt } = macHome();
  const keys = join(root, "keys"), research = join(home, ".dori", "research");
  mkdirSync(keys);
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${join(keys, "*.pem")}\n${join(keys, "id_[!x]?")}\n${join(research, "secret-x")}\n`);
  const env = { DORI_LANE_KEY: "lane-a" };
  const sb = await seatbelt(home, wt, env);
  const read = (p: string) => allows(sb, "file-read-data", p);

  for (const no of [join(keys, "a.pem"), join(keys, ".b.pem"), join(keys, "a.pem", "x"), join(keys, "id_ab"), join(research, "secret-x"), join(research, "secret-x", "y"), join(home, ".zsh_history"), join(home, ".node_repl_history")]) {
    expect({ no, read: read(no) }).toEqual({ no, read: false });
  }
  expect(allows(sb, "file-write-data", join(keys, "a.pem"))).toBe(false);
  for (const ok of [join(keys, "c.txt"), join(keys, "sub", "d.pem"), join(keys, "a.pem.bak"), join(keys, "id_xb"), join(keys, "id_abc"), join(research, "secret-xy"), join(research, "ap-1-1", "report.md"), join(home, ".zsh_historyx")]) {
    expect({ ok, read: read(ok) }).toEqual({ ok, read: true });
  }

  const explained = await runMacos(home, wt, ["--explain"], env, join(root, "no-sandbox-exec"));
  expect({ code: explained.code, err: explained.err }).toEqual({ code: 0, err: "" });
  for (const row of [`hide ${join(keys, "*.pem")}`, `hide ${join(research, "secret-x")}`, `hide ${join(home, ".*_history")}`]) expect(explainRows(explained.out)).toContain(row);
}, 30_000);

test("macOS: the credential stores under $HOME (cloud, kube, gpg, docker and git logins) are refused for reads", async () => {
  const { home, wt } = macHome();
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" });
  const read = (p: string) => allows(sb, "file-read-data", p);
  for (const no of [".aws/credentials", ".azure/msal_token_cache.json", ".oci/config", ".gnupg/private-keys-v1.d/k.key", ".password-store/a.gpg", ".kube/config", ".docker/config.json",
    ".netrc", ".git-credentials", ".vault-token", ".terraform.d/credentials.tfrc.json", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml",
    ".secrets/x", ".local/share/toodo-server/mcp-token", ".m2/settings.xml", ".zsh_history"]) {
    expect({ no, read: read(join(home, no)) }).toEqual({ no, read: false });
  }
  for (const ok of [".docker/cli-plugins/x", ".cargo/registry/index/x", ".gitconfig", ".config/gh/hosts.yml"]) {
    expect({ ok, read: read(join(home, ok)) }).toEqual({ ok, read: true });
  }
});

test("both templates carry the shared credential list as rendered, the same set doctor probes, and Linux hides each listed store", async () => {
  const credentials = (template: string) => new Set(/^CREDENTIALS="([^"]*)"/m.exec(readFileSync(template, "utf8"))?.[1]?.split(/\s+/).filter(Boolean));
  const doctorDeny = new Set(SENSITIVE.filter((p) => !INTENDED.has(p)));
  for (const template of [LANE_SANDBOX_TEMPLATE, LANE_SANDBOX_MACOS_TEMPLATE]) {
    expect(readFileSync(template, "utf8")).toBe(laneSandboxScript(template));
    expect(credentials(template)).toEqual(doctorDeny);
  }

  const home = join(realpathSync(tempDir()), "home");
  for (const d of [".cargo", ".aws", ".dori"]) mkdirSync(join(home, d), { recursive: true });
  for (const f of [".cargo/credentials.toml", ".aws/credentials", ".zsh_history", ".dori/env"]) writeFileSync(join(home, f), "x");
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });
  const at = (...seq: string[]) => argv.findIndex((_, i) => seq.every((s, j) => argv[i + j] === s));
  const rw = lastReadWrite(argv, home);
  expect(at("--ro-bind", "/dev/null", join(home, ".cargo/credentials.toml"))).toBeGreaterThan(rw);
  expect(at("--tmpfs", join(home, ".aws"), "--remount-ro", join(home, ".aws"))).toBeGreaterThan(rw);
  expect(at("--ro-bind", "/dev/null", join(home, ".zsh_history"))).toBeGreaterThan(rw);
  expect(at("--ro-bind", "/dev/null", join(home, ".dori/env"))).toBeGreaterThan(rw);
});

test("macOS: ~/.dori/secrets is refused for reads, writes and socket connects with no hide file", async () => {
  const { home, wt } = macHome();
  const secrets = join(home, ".dori", "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "NPM_TOKEN.cred"), "x");

  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" });

  expect(sb.params.DORI_SECRETS).toBe(secrets);
  expect(sb.profile).toContain('(deny file-read* (subpath (param "DORI_SECRETS")))');
  expect(sb.profile).toContain('(deny file-write* (subpath (param "DORI_SECRETS")))');
  expect(sb.profile).toContain('(deny network-outbound (remote unix-socket (subpath (param "DORI_SECRETS"))))');
  for (const op of ["file-read-data", "file-write-data", "network-outbound"] as const) {
    expect({ op, ok: allows(sb, op, join(secrets, "NPM_TOKEN.cred")) }).toEqual({ op, ok: false });
  }
});

test("macOS: a lane may rewrite its own login keychain and Claude Code's lock dir, but no other keychain file", async () => {
  const { root, home, wt } = macHome();
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" });
  const kc = join(home, "Library", "Keychains");
  const write = (p: string) => allows(sb, "file-write-data", p);

  for (const ok of [join(kc, "login.keychain-db"), join(kc, "login.keychain-db.sb-d1fd7dce-8dNHuB"), join(home, ".local", "state", "claude", "locks", "x.lock")]) {
    expect({ ok, write: write(ok) }).toEqual({ ok, write: true });
  }
  for (const no of [join(kc, "login.keychain-db-journal"), join(kc, "login.keychain-db-wal"), join(kc, "login.keychain-db.sb-x", "y"), join(kc, "metadata.keychain-db"), join(kc, ".fl34AC2A0A"), join(kc, "78D2CB8D", "keychain-2.db"), join(root, "other", "Library", "Keychains", "login.keychain-db"), join(root, "other", "Library", "Keychains", "login.keychain-db.sb-x"), join(home, ".local", "state", "other")]) {
    expect({ no, write: write(no) }).toEqual({ no, write: false });
  }
  expect(sb.profile).not.toContain(root);
});

test("macOS: a cwd-less lane may write the worktree root and each repo's .git under the repos root, but no repo's hooks or working tree", async () => {
  const { root, home, runner } = macHome();
  const cwd = join(runner, "lanes", "lane-a");
  mkdirSync(cwd, { recursive: true });
  const repos = join(root, "work.repos"), worktrees = join(root, "worktrees");
  mkdirSync(join(repos, "app", ".git"), { recursive: true });
  const sb = await seatbelt(home, cwd, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_REPOS: repos, LANE_SANDBOX_WORKTREES: worktrees });
  const write = (p: string) => allows(sb, "file-write-data", p);

  for (const ok of [join(worktrees, "app-lane-a", "src", "a.ts"), join(repos, "app", ".git"), join(repos, "app", ".git", "FETCH_HEAD"), join(repos, "app", ".git", "refs", "heads", "feat", "x"), join(repos, "app", ".git", "worktrees", "app-lane-a", "HEAD")]) {
    expect({ ok, write: write(ok) }).toEqual({ ok, write: true });
  }
  for (const no of [join(repos, "app", "src", "a.ts"), join(repos, "app", ".git", "hooks"), join(repos, "app", ".git", "hooks", "pre-commit"), join(repos, "app", ".gitignore"), join(repos, "app", "vendor", ".git", "x"), join(repos, "probe"), join(`${repos}x`, "app", ".git", "x"), join(root, "workXrepos", "app", ".git", "x")]) {
    expect({ no, write: write(no) }).toEqual({ no, write: false });
  }
  expect(allows(sb, "file-read-data", join(home, ".dori", "env"))).toBe(false);
  expect(sb.profile).not.toContain(root);
});

test("macOS: a lane's tools get the system root bundle as SSL_CERT_FILE, and one already set is kept", async () => {
  const { root, home, wt } = macHome();
  writeFileSync(join(root, "cert.pem"), "");
  expect((await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" })).env.SSL_CERT_FILE).toBe(join(root, "cert.pem"));
  expect((await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", SSL_CERT_FILE: "/opt/corp.pem" })).env.SSL_CERT_FILE).toBe("/opt/corp.pem");
});

test("macOS: a lane's omo runs under the dori-lane profile, and an OMO_PROFILE already set is kept", async () => {
  const { home, wt } = macHome();
  expect((await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" })).env.OMO_PROFILE).toBe("dori-lane");
  expect((await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", OMO_PROFILE: "mine" })).env.OMO_PROFILE).toBe("mine");
});

test("macOS: a cwd-less lane may list the directories above its cwd (realpath opens them), but read nothing under them", async () => {
  const { home, runner } = macHome();
  const cwd = join(runner, "lanes", "lane-a");
  mkdirSync(join(runner, "lanes", "lane-b"), { recursive: true });
  mkdirSync(cwd);
  const sb = await seatbelt(home, cwd, { DORI_LANE_KEY: "lane-a" });
  const read = (p: string) => allows(sb, "file-read-data", p);

  for (const ok of [join(home, ".dori"), runner, join(runner, "lanes"), join(cwd, "x")]) {
    expect({ ok, read: read(ok) }).toEqual({ ok, read: true });
  }
  for (const no of [join(home, ".dori", "env"), join(runner, "lanes", "lane-b"), join(runner, "lanes", "lane-b", "x"), join(runner, "keys"), join(runner, "briefs")]) {
    expect({ no, read: read(no) }).toEqual({ no, read: false });
  }
});

test("refresh selects the maintained macOS or Linux template from the injected native platform", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const home = tempDir(), installed = installedLaneSandbox(home);
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(installed, "old");
    expect(refreshLaneSandbox(home, undefined, platform)).toContain(platform === "darwin" ? "lane-sandbox-macos.sh" : "lane-sandbox.sh");
    expect(readFileSync(installed)).toEqual(readFileSync(platform === "darwin" ? LANE_SANDBOX_MACOS_TEMPLATE : LANE_SANDBOX_TEMPLATE));
    expect(readFileSync(installed, "utf8")).toContain("DORI_LANE_FILES=1");
  }
});

test("Linux non-try input binding refuses a missing managed source", async () => {
  const home = tempDir(), work = join(home, "work");
  mkdirSync(work);
  const bin = fakeBwrap(home, 'while [ "$#" -gt 0 ]; do case "$1" in --ro-bind) case "$2" in *.files) [ -d "$2" ] || exit 9 ;; esac ;; esac; shift; done');
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "true"], {
    cwd: work, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, DORI_LANE_KEY: "lane-a" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(9);
  expect(await new Response(child.stderr).text()).toBe("");
});

test("macOS: every path reaches the profile resolved (as /var does to /private/var), and only as a -D parameter", async () => {
  const { root, home, wt } = macHome();
  // Reached through symlinks, the way macOS reaches /private/var/folders through /var.
  symlinkSync(home, join(root, "home-link"));
  symlinkSync(wt, join(root, "wt-link"));
  const extra = join(root, "extra");
  const sb = await seatbelt(join(root, "home-link"), join(root, "wt-link"), { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_RW: `${join(root, "home-link", "rw")}:${extra}`, LANE_SANDBOX_VERIFY: join(root, "verify") });

  expect(allows(sb, "file-write-data", join(wt, "a"))).toBe(true);
  expect(allows(sb, "file-write-data", join(home, "rw", "a"))).toBe(true);
  expect(allows(sb, "file-write-data", join(extra, "a"))).toBe(true);
  expect(allows(sb, "file-write-data", join(root, "verify", "a"))).toBe(false);
  expect(allows(sb, "file-write-data", join(root, "a"))).toBe(false);
  expect(allows(sb, "file-read-data", join(home, ".dori", "env"))).toBe(false);
  expect(Object.values(sb.params).filter((p) => p.includes("-link"))).toEqual([]);
  // No host path is written into the profile text itself.
  expect(sb.profile).not.toContain(root);
});

test("macOS: a cwd as broad as $HOME is not made writable", async () => {
  const { home } = macHome();
  const sb = await seatbelt(home, home, { DORI_LANE_KEY: "lane-a" });
  expect(sb.err).toBe(`lane-sandbox: warning: cwd ${home} is too broad; not making it writable\n`);
  expect(allows(sb, "file-write-data", join(home, "probe"))).toBe(false);
});

test("macOS: without DORI_LANE_KEY the command runs as is, and --check names a missing or failing sandbox-exec", async () => {
  const { root, home, wt } = macHome();
  const never = join(root, "never-called");
  writeFileSync(never, "#!/bin/sh\nexit 99\n");
  chmodSync(never, 0o755);
  expect(await runMacos(home, wt, ["echo", "plain"], {}, never)).toEqual({ code: 0, out: "plain\n", err: "" });

  const missing = await runMacos(home, wt, ["--check"], {}, join(root, "no-such-sandbox-exec"));
  expect({ code: missing.code, err: missing.err }).toEqual({ code: 3, err: `lane-sandbox: ${join(root, "no-such-sandbox-exec")} not found\n` });

  const failing = join(root, "failing-sandbox-exec");
  writeFileSync(failing, "#!/bin/sh\necho 'sandbox-exec: syntax error' >&2\necho 'line 2' >&2\nexit 65\n");
  chmodSync(failing, 0o755);
  const bad = await runMacos(home, wt, ["--check"], { DORI_LANE_KEY: "lane-a" }, failing);
  expect({ code: bad.code, err: bad.err }).toEqual({ code: 3, err: "lane-sandbox: sandbox-exec cannot create a sandbox: sandbox-exec: syntax error line 2\n" });

  // A passing check runs /usr/bin/true under the same profile a lane gets.
  const argvFile = join(root, "check-argv");
  const passing = join(root, "passing-sandbox-exec");
  writeFileSync(passing, `#!/bin/sh\nprintf '%s\\0' "$@" > "${argvFile}"\n`);
  chmodSync(passing, 0o755);
  expect(await runMacos(home, wt, ["--check"], {}, passing)).toEqual({ code: 0, out: "DORI_LANE_FILES=1\n", err: "" });
  const argv = readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
  expect(argv[0]).toBe("-p");
  expect(argv[1]).toContain("(deny file-write*)");
  expect(argv.at(-1)).toBe("/usr/bin/true");
});

test("a granted lane gets its runner's write grants read-write and read grants read-only, before its cwd; an ungranted lane names neither", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const runs = join(root, "blog-writer", "runs"), notes = join(home, "notes");
  mkdirSync(runs, { recursive: true });
  mkdirSync(notes, { recursive: true });
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_RW: runs, LANE_SANDBOX_RO: notes });

  const rw = argv.findIndex((a, i) => a === "--bind-try" && argv[i + 1] === runs && argv[i + 2] === runs);
  const ro = argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === notes && argv[i + 2] === notes);
  const cwd = argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === join(home, "work"));
  expect(rw).toBeGreaterThan(-1);
  expect(ro).toBeGreaterThan(-1);
  // A read grant above a writable path must not shadow it: the read-write re-binds, grants and cwd come after it.
  const out = join(home, ".dori", "runner", "briefs", "lane-a.out");
  expect(ro).toBeLessThan(argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === out));
  expect(rw).toBeGreaterThan(ro);
  expect(cwd).toBeGreaterThan(ro);
  expect(argv.some((a, i) => (a === "--bind" || a === "--bind-try") && argv[i + 1] === notes)).toBe(false);

  const plain = await sandboxArgv(home, { DORI_LANE_KEY: "lane-b" });
  expect(plain.some((a) => a.startsWith(runs) || a.startsWith(notes))).toBe(false);
});

test("the hide list wins over a lane's grants: a granted path under a hidden one is covered after it is bound", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const hidden = join(root, "private");
  const runs = join(hidden, "runs"), notes = join(hidden, "notes");
  mkdirSync(runs, { recursive: true });
  mkdirSync(notes, { recursive: true });
  mkdirSync(join(home, ".dori"), { recursive: true });
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${hidden}\n`);
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_RW: runs, LANE_SANDBOX_RO: notes });

  const hide = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === hidden);
  expect(hide).toBeGreaterThan(argv.findIndex((a, i) => a === "--bind-try" && argv[i + 1] === runs));
  expect(hide).toBeGreaterThan(argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === notes));
});

test("macOS: a granted lane may write its write grants and read its read grants; the hide list still wins, and an ungranted lane may not write there", async () => {
  const { root, home, wt } = macHome();
  const runs = join(root, "blog-writer", "runs"), notes = join(root, "notes");
  mkdirSync(runs, { recursive: true });
  mkdirSync(notes, { recursive: true });
  const granted = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_RW: runs, LANE_SANDBOX_RO: notes });
  expect(allows(granted, "file-write-data", join(runs, "topic.lock"))).toBe(true);
  expect(allows(granted, "file-read-data", join(notes, "a.md"))).toBe(true);
  expect(allows(granted, "file-write-data", join(notes, "a.md"))).toBe(false);

  const plain = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" });
  expect(allows(plain, "file-write-data", join(runs, "topic.lock"))).toBe(false);

  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${join(root, "blog-writer")}\n${notes}\n`);
  const hidden = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_RW: runs, LANE_SANDBOX_RO: notes });
  expect(allows(hidden, "file-write-data", join(runs, "topic.lock"))).toBe(false);
  expect(allows(hidden, "file-read-data", join(notes, "a.md"))).toBe(false);
});

/** The `<mode> <path>` lines a template's --explain prints, comments dropped. */
const explainRows = (out: string): string[] => out.split("\n").filter((l) => l !== "" && !l.startsWith("#"));

/**
 * The mounts bwrap makes from `argv`, as --explain rows in mount order: a bind is rw or ro (ro over /dev/null hides the
 * path), a tmpfs other than the root that is remounted read-only later hides its path and any other tmpfs starts empty;
 * a -try bind of a missing source is skipped, as bwrap skips it.
 */
const mountTable = (argv: string[]): string[] => {
  const rows: string[] = [];
  const withTwo = new Set(["--bind", "--bind-try", "--ro-bind", "--ro-bind-try", "--ro-bind-data", "--symlink", "--setenv"]);
  for (let i = 0; i < argv.length && argv[i] !== "--";) {
    const o = argv[i] as string;
    if (withTwo.has(o)) {
      const src = argv[i + 1] as string, dst = argv[i + 2] as string;
      i += 3;
      if (o.endsWith("-try") && !existsSync(src)) continue;
      if (o === "--bind" || o === "--bind-try") rows.push(`rw ${dst}`);
      else if (o === "--ro-bind-data") rows.push(`ro ${dst}`);
      else if (o === "--ro-bind" || o === "--ro-bind-try") rows.push(`${src === "/dev/null" ? "hide" : "ro"} ${dst}`);
    } else if (o === "--tmpfs") {
      const p = argv[i + 1] as string;
      i += 2;
      const end = argv.indexOf("--");
      const later = argv.slice(i, end < 0 ? undefined : end).some((a, j, rest) => a === "--remount-ro" && rest[j + 1] === p);
      rows.push(`${p !== "/" && later ? "hide" : "empty"} ${p}`);
    } else i += o === "--unshare-pid" || o === "--die-with-parent" ? 1 : 2;
  }
  return rows;
};

test("--explain prints the mount table bwrap gets, grants, repos, hide list and the hidden sockets included", async () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const hidden = join(root, "private"), runs = join(root, "runs"), notes = join(root, "notes"), underHidden = join(hidden, "granted");
  const repos = join(root, "repos"), worktrees = join(root, "worktrees");
  for (const d of [hidden, runs, notes, underHidden, join(repos, "app", ".git", "hooks"), worktrees, join(home, ".dori", "runner", "briefs")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(hidden, "key"), "x");
  writeFileSync(join(home, ".gitconfig"), "x");
  const token = join(home, ".dori", "runner", "briefs", "lane-a.1.token");
  writeFileSync(token, "x");
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `# private\n${hidden}\n${join(hidden, "key")}\n${join(root, "missing")}\n`);
  const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: token, LANE_SANDBOX_RW: `${runs}:${underHidden}`, LANE_SANDBOX_RO: notes, LANE_SANDBOX_REPOS: repos, LANE_SANDBOX_WORKTREES: worktrees };

  const argv = await sandboxArgv(home, env);
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "--explain"], { cwd: join(home, "work"), env: { PATH: `${join(home, "fake-bin")}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });

  const rows = explainRows(out);
  expect(rows).toEqual(mountTable(argv));
  for (const row of [`rw ${runs}`, `ro ${notes}`, `rw ${worktrees}`, `rw ${join(repos, "app", ".git")}`, `ro ${join(repos, "app", ".git", "hooks")}`, `ro ${token}`, `ro ${home}`, `ro ${join(home, ".dori")}`, `hide ${join(home, ".dori", "runner")}`, `rw ${join(home, ".lane-tmp")}`]) expect(rows).toContain(row);
  // The hide list comes after every grant, so a granted path under a hidden one stays covered.
  expect(rows.indexOf(`hide ${hidden}`)).toBeGreaterThan(rows.indexOf(`rw ${underHidden}`));
  expect(rows).toContain(`hide ${join(hidden, "key")}`);
  // A missing -try source (an absent dotfile) is not listed: bwrap skips it.
  expect(rows.some((r) => r.endsWith("/.zshrc"))).toBe(false);
});

test("--explain regression: every credential store, ssh key and other lane's token is hidden, and the writable set is exactly the expected one", async () => {
  // /tmp is bound read-write after $HOME, so a fake home under it would read as writable: keep it outside /tmp.
  const base = realpathSync(process.env.TMPDIR ?? "/tmp");
  const parent = base === "/tmp" || base.startsWith("/tmp/") ? join(homedir(), ".cache") : base;
  mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(join(parent, "dori-explain-")));
  dirs.push(root);
  const home = join(root, "home");
  const R = join(home, ".dori", "runner");
  const runs = join(root, "runs"), repos = join(root, "repos"), worktrees = join(root, "worktrees");
  for (const d of [runs, join(repos, "app", ".git", "hooks"), worktrees, join(R, "briefs", "lane-a.files"), join(R, "sock", "lane.d")]) mkdirSync(d, { recursive: true });
  // The read-write caches a lane gets, so each -try bind of them is listed.
  for (const d of [".omo", ".cache", ".npm", ".bun/install/cache", ".cargo/registry", ".cargo/git"]) mkdirSync(join(home, d), { recursive: true });
  const secrets = [...CREDENTIAL_DENY, ".ssh/id_ed25519", ".dori/runner/briefs/x.1.token", ".dori/runner/briefs/x.md"];
  for (const p of secrets) {
    mkdirSync(join(home, p, ".."), { recursive: true });
    writeFileSync(join(home, p), p.endsWith("lane-sandbox-hide") ? "# nothing extra\n" : "secret\n");
  }
  for (const f of [".ssh/known_hosts", ".dori/runner/briefs/lane-a.md"]) writeFileSync(join(home, f), "x\n");
  const token = join(R, "briefs", "lane-a.1.token");
  writeFileSync(token, "own\n");
  const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: token, LANE_SANDBOX_RW: runs, LANE_SANDBOX_REPOS: repos, LANE_SANDBOX_WORKTREES: worktrees };

  const argv = await sandboxArgv(home, env);
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "--explain"], { cwd: join(home, "work"), env: { PATH: `${join(home, "fake-bin")}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  const rows = explainRows(out);
  expect(rows).toEqual(mountTable(argv));
  const table = rows.map((l) => ({ mode: l.slice(0, l.indexOf(" ")), path: l.slice(l.indexOf(" ") + 1) }));
  // A later row wins at and below its path.
  const verdict = (p: string) => table.findLast((r) => p === r.path || p.startsWith(`${r.path}/`))?.mode;

  // Each secret is hidden by its own row or by a hidden subtree over it (~/.config, ~/.ssh, ~/.dori/runner).
  expect(secrets.map((p) => [p, verdict(join(home, p))]).filter(([, mode]) => mode !== "hide")).toEqual([]);
  // The lane's own files still show.
  for (const p of [token, join(R, "briefs", "lane-a.md"), join(home, ".ssh", "known_hosts"), join(home, ".zshrc")]) expect([p, verdict(p)]).toEqual([p, "ro"]);
  // No row names another lane's token or brief, so nothing re-exposes it.
  expect(table.filter((r) => r.path.startsWith(join(R, "briefs")) && !r.path.startsWith(join(R, "briefs", "lane-a.")))).toEqual([]);
  // The writable set, pinned: a new read-write bind (or a lost one) changes it.
  expect(table.filter((r) => r.mode === "rw").map((r) => r.path).sort()).toEqual([
    "/tmp",
    join(home, ".bun", "install", "cache"), join(home, ".cache"), join(home, ".cargo", "git"), join(home, ".cargo", "registry"),
    join(home, ".dori", "heavy"), join(R, "briefs", "lane-a.out"), join(home, ".lane-tmp"), join(home, ".npm"), join(home, ".omo"),
    join(home, "work"), join(repos, "app", ".git"), runs, worktrees,
  ].sort());
  // ...and none of it is a hidden path.
  expect(table.filter((r) => r.mode === "rw" && verdict(r.path) !== "rw")).toEqual([]);
});

test("macOS: --explain lists every path the profile names, each with the access the profile gives it", async () => {
  const { root, home, wt, token } = macHome();
  const hidden = join(root, "private"), runs = join(root, "runs"), notes = join(root, "notes"), repos = join(root, "repos"), worktrees = join(root, "worktrees");
  for (const d of [hidden, runs, notes, join(repos, "app", ".git"), worktrees]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${hidden}\n`);
  const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: token, LANE_SANDBOX_RW: runs, LANE_SANDBOX_RO: notes, LANE_SANDBOX_REPOS: repos, LANE_SANDBOX_WORKTREES: worktrees, SSH_AUTH_SOCK: join(home, ".config", "herdr", "agent") };

  const sb = await seatbelt(home, wt, env);
  const explained = await runMacos(home, wt, ["--explain"], env, join(root, "no-sandbox-exec"));
  expect({ code: explained.code, err: explained.err }).toEqual({ code: 0, err: "" });
  const rows = explainRows(explained.out).map((l) => ({ mode: l.slice(0, l.indexOf(" ")), path: l.slice(l.indexOf(" ") + 1) }));

  // Every path parameter the profile's file rules use is a row (sockets, /dev and the keychain's temp copies are not paths).
  const named = Object.entries(sb.params).filter(([k]) => /^(W|R|O|CRED|HIDE)\d+$|^(DORI_RUNNER|DORI_SECRETS|CONFIG|CONFIG_GH|CONFIG_GIT|HOOKS|KEYCHAIN|SSH|SSH_CONFIG|SSH_KNOWN_HOSTS)$/.test(k)).map(([, v]) => v);
  // A glob's parameter is its regex, which the row's pattern (as listed) matches.
  expect(named.filter((p) => !rows.some((r) => r.path === p || (p.startsWith("^") && new RegExp(p).test(r.path))))).toEqual([]);
  expect(sb.params.REPOS_GIT).toBeDefined();
  expect(rows).toContainEqual({ mode: "rw", path: `${repos}/*/.git` });

  // A row's path pattern, * standing for one component, covers the path itself and everything below it.
  const covers = (pattern: string, p: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}(/|$)`).test(p);
  const verdict = (p: string) => rows.findLast((r) => covers(r.path, p))?.mode;
  const kc = sb.params.KEYCHAIN;
  for (const row of rows) {
    const at = row.path.replace(/\*/g, "app");
    // ~/.dori/runner itself may be listed (omo resolves a cwd-less lane's parents); the keychain and the readable ssh
    // files are single files.
    const probes = row.path === sb.params.DORI_RUNNER ? [join(at, "x")] : row.path === kc || row.path.startsWith(`${sb.params.SSH}/`) ? [at] : [at, join(at, "x")];
    for (const p of probes) {
      const mode = verdict(p);
      const got = { p, read: allows(sb, "file-read-data", p), write: allows(sb, "file-write-data", p) };
      expect(got).toEqual({ p, read: mode !== "hide", write: mode === "rw" });
    }
  }
});
