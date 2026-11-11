import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installedLaneSandbox, LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE, refreshLaneSandbox } from "../src/lane-sandbox-install.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-sandbox-"));
  dirs.push(d);
  return d;
};

/** Runs the shipped template with a recording `bwrap` first on PATH and returns the argv it would have run bwrap with. */
const sandboxArgv = async (home: string, env: Record<string, string>): Promise<string[]> => {
  const bin = join(home, "fake-bin");
  const out = join(home, "bwrap-argv");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(bin, "bwrap"), 0o755);
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "true"], { cwd: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  expect({ code: await child.exited, err: await new Response(child.stderr).text() }).toEqual({ code: 0, err: "" });
  return readFileSync(out, "utf8").split("\n");
};

test("a sandboxed lane gets its own token file, the runner's lane socket, its brief and the runner's bin (read-only), its own lanes/<key> mount point, and nothing else of the runner dir or the env file", async () => {
  const home = join(tempDir(), "home");
  const runner = join(home, ".dori", "runner");
  mkdirSync(join(runner, "briefs"), { recursive: true });
  mkdirSync(join(runner, "sock"), { recursive: true });
  const own = join(runner, "briefs", "lane-a.2.token");
  for (const f of [own, join(runner, "briefs", "lane-b.1.token"), join(runner, "briefs", "lane-a.md"), join(runner, "briefs", "lane-b.md"), join(home, ".dori", "env")]) writeFileSync(f, "x");

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: own });

  const tokenBind = argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === own && argv[i + 2] === own);
  const doriRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === join(home, ".dori"));
  expect(tokenBind).toBeGreaterThan(-1);
  // The token's mount point has to exist before ~/.dori's tmpfs turns read-only.
  expect(tokenBind).toBeLessThan(doriRo);
  expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === join(home, ".dori"))).toBeGreaterThan(-1);
  const runnerPaths = [...new Set(argv.filter((a) => a.startsWith(runner)))].sort();
  expect(runnerPaths).toEqual([join(runner, "bin"), join(runner, "briefs", "lane-a.2.token"), join(runner, "briefs", "lane-a.files"), join(runner, "briefs", "lane-a.md"), join(runner, "briefs", "lane-a.out"), join(runner, "browser", "lane-a"), join(runner, "lanes", "lane-a"), join(runner, "sock"), join(runner, "sock", "lane")]);
  // sock itself is only a mount point (--dir); the lane socket is the one thing bound into it.
  expect(argv.flatMap((a, i) => (argv[i + 1] === join(runner, "sock") ? [a] : []))).toEqual(["--dir"]);
  const input = join(runner, "briefs", "lane-a.files"), output = join(runner, "briefs", "lane-a.out");
  expect(argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === input && argv[i + 2] === input)).toBeLessThan(doriRo);
  expect(argv.findIndex((a, i) => a === "--dir" && argv[i + 1] === output)).toBeLessThan(doriRo);
  expect(argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === output && argv[i + 2] === output)).toBeGreaterThan(doriRo);
  // A worker host's dori lives in bin: bound read-only, never read-write, so a lane cannot rewrite what the runner runs.
  const bin = join(runner, "bin");
  expect(argv.flatMap((a, i) => (argv[i + 1] === bin && argv[i + 2] === bin ? [a] : []))).toEqual(["--ro-bind-try"]);
  expect(argv.some((a) => a.startsWith(join(home, ".dori", "env")))).toBe(false);
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

test("of ~/.config only gh, git and an ssh agent socket under it are bound", async () => {
  const home = join(tempDir(), "home");
  const agent = join(home, ".config", "herdr", "herdr.sock.agent");
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", SSH_AUTH_SOCK: agent });
  const config = [...new Set(argv.filter((a) => a.startsWith(join(home, ".config"))))].sort();
  expect(config).toEqual([join(home, ".config", "gh"), join(home, ".config", "git"), agent]);
  // An agent socket outside $HOME is visible through the host's own binds already.
  const outside = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", SSH_AUTH_SOCK: "/run/user/1/openssh_agent" });
  expect(outside).not.toContain("/run/user/1/openssh_agent");
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
  // A missing path is skipped (bwrap would create it), and ~/.dori is hidden already.
  expect(argv).not.toContain(join(root, "missing"));
  expect(argv).not.toContain(join(home, ".dori", "env"));
});

test("~/.dori/secrets is never bound, even with no ~/.dori/lane-sandbox-hide file", async () => {
  const home = join(tempDir(), "home");
  const secrets = join(home, ".dori", "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "NPM_TOKEN.cred"), "x");

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  expect(existsSync(join(home, ".dori", "lane-sandbox-hide"))).toBe(false);
  expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === join(home, ".dori"))).toBeGreaterThan(-1);
  expect(argv.filter((a) => a === secrets || a.startsWith(`${secrets}/`))).toEqual([]);
});

test("every read-write mount under ~/.dori has its mount point created before ~/.dori turns read-only", async () => {
  const home = join(tempDir(), "home");
  const dori = join(home, ".dori");
  mkdirSync(join(dori, "state"), { recursive: true });

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  const doriRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === dori);
  expect(doriRo).toBeGreaterThan(-1);
  const rwInDori = argv.flatMap((a, i) => ((a === "--bind" || a === "--bind-try") && argv[i + 2]?.startsWith(`${dori}/`) ? [argv[i + 2]] : []));
  expect(rwInDori).toContain(join(dori, "heavy"));
  // bwrap cannot mkdir a missing mount point on the read-only tmpfs (EROFS), so each one is a --dir before the remount.
  const createdBefore = argv.slice(0, doriRo).flatMap((a, i, before) => (a === "--dir" ? [before[i + 1]] : []));
  expect(rwInDori.filter((p) => !createdBefore.includes(p))).toEqual([]);
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

test("LANE_SANDBOX_VERIFY is bound read-write on its own, leaving its parent directories unbound", async () => {
  const home = join(tempDir(), "home");
  const state = join(home, "..", "ws", "state");
  const verify = join(state, "verify");
  mkdirSync(verify, { recursive: true });

  const rw = (argv: string[]) => argv.flatMap((a, i) => (a === "--bind" || a === "--bind-try" ? [argv[i + 2] ?? ""] : []));
  const bound = rw(await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_VERIFY: verify }));
  expect(bound).toContain(verify);
  expect(bound).not.toContain(state);
  expect(bound).not.toContain(join(state, ".."));

  expect(rw(await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" }))).not.toContain(verify);
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
  writeFileSync(sbx, `#!/bin/sh\nprintf '%s\\0' "$@" > "${out}"\nprintf 'TMPDIR=%s\\0LANE_SANDBOX_ACTIVE=%s\\0SSL_CERT_FILE=%s\\0' "$TMPDIR" "$LANE_SANDBOX_ACTIVE" "$SSL_CERT_FILE" > "${out}.env"\n`);
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
 * socket at `path` (Seatbelt checks it apart from file reads). A `path` of the form `tcp:localhost:<port>` is a tcp connect
 * instead, matched only by `(remote tcp "localhost:<port>")`.
 */
const allows = (sb: Seatbelt, op: "file-read-data" | "file-write-data" | "network-outbound", path: string): boolean => {
  const tcp = path.startsWith("tcp:");
  const str = (x: Sexp): string => {
    if (Array.isArray(x) && x[0] === "param") return sb.params[(x[1] as { raw: string }).raw] ?? "\0unset";
    return (x as { raw: string }).raw;
  };
  const matches = (filter: Sexp): boolean => {
    if (!Array.isArray(filter)) throw new Error(`unexpected filter ${JSON.stringify(filter)}`);
    const [kind, arg] = filter;
    if (kind === "remote" && filter[1] === "unix-socket") return !tcp && matches(filter[2] as Sexp);
    if (kind === "remote" && filter[1] === "tcp") return tcp && path.slice(4) === str(filter[2] as Sexp);
    if (tcp) return false;
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
  expect(sb.env).toEqual({ TMPDIR: lt, LANE_SANDBOX_ACTIVE: "1", SSL_CERT_FILE: "" });
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
  for (const ok of [join(wt, "src", "a.ts"), join(wt, ".git", "index"), join(lt, "x"), join(home, ".omo", "x"), join(home, ".cache", "x"), join(home, ".dori", "state", "x"), join(home, ".dori", "heavy", "x"), join(home, ".npm", "x"), "/tmp/x", "/dev/null"]) {
    expect({ ok, write: write(ok) }).toEqual({ ok, write: true });
  }
  for (const no of [join(home, "probe"), join(home, ".dori", "config.json"), join(home, ".dori", "env"), join(home, ".dori", "src", "x"), join(runner, "bin", "dori"), join(home, ".zshrc"), join(home, ".ssh", "authorized_keys"), join(wt, ".git", "hooks", "pre-commit"), "/etc/hosts"]) {
    expect({ no, write: write(no) }).toEqual({ no, write: false });
  }
  for (const ok of [token, join(runner, "briefs", "lane-a.md"), join(runner, "bin", "dori"), join(home, ".dori", "config.json"), join(home, ".dori", "src", "cli.ts"), join(home, ".ssh", "id_ed25519.pub"), join(home, ".ssh", "known_hosts"), "/etc/hosts", join(wt, "README.md")]) {
    expect({ ok, read: read(ok) }).toEqual({ ok, read: true });
  }
  for (const no of [join(home, ".dori", "env"), join(home, ".ssh", "id_ed25519"), join(home, ".ssh", "id_rsa"), join(runner, "briefs", "lane-b.1.token"), join(runner, "briefs", "lane-b.md"), join(runner, "keys", "runner.key")]) {
    expect({ no, read: read(no) }).toEqual({ no, read: false });
  }
});

test("macOS: of the runner's sockets only the lane socket can be dialed, and of ~/.config only gh, git and the ssh agent socket are reachable", async () => {
  const { home, runner, wt } = macHome();
  const agent = join(home, ".config", "herdr", "herdr.sock.agent");
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", SSH_AUTH_SOCK: agent });
  const dial = (p: string) => allows(sb, "network-outbound", p);
  const read = (p: string) => allows(sb, "file-read-data", p);

  expect(dial(join(runner, "sock", "lane"))).toBe(true);
  expect(read(join(runner, "sock", "lane"))).toBe(true);
  for (const no of [join(runner, "sock", "control"), join(runner, "sock", "cli"), join(home, ".config", "herdr", "herdr.sock")]) {
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
  expect(allows(sb, "file-write-data", join(root, "verify", "a"))).toBe(true);
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

/** A real BrowserSkill home under `dir` with a daemon.json carrying `port`, and a lane-a / lane-b proxy dir under the runner. */
const bskFixture = (dir: string, runner: string, port: string): void => {
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(dir, "daemon.json"), `{"pid":1,"sock_path":"${join(dir, "run", "daemon.sock")}","ws_port":${port}}`);
  for (const k of ["lane-a", "lane-b"]) {
    mkdirSync(join(runner, "browser", k), { recursive: true });
    writeFileSync(join(runner, "browser", k, "daemon.json"), "{}");
  }
};

test("macOS: the raw BrowserSkill daemon's socket, files and ws_port are refused, and only the lane's own proxy dir and socket are reachable", async () => {
  const { home, runner, wt } = macHome();
  bskFixture(join(home, ".bsk"), runner, "40123");
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a" });
  const dial = (p: string) => allows(sb, "network-outbound", p);
  const read = (p: string) => allows(sb, "file-read-data", p);

  expect(dial(join(home, ".bsk", "run", "daemon.sock"))).toBe(false);
  expect(read(join(home, ".bsk", "daemon.json"))).toBe(false);
  expect(allows(sb, "file-write-data", join(home, ".bsk", "x"))).toBe(false);
  expect(dial("tcp:localhost:40123")).toBe(false);
  expect(dial("tcp:localhost:40124")).toBe(true);

  const own = join(runner, "browser", "lane-a");
  expect(dial(join(own, "daemon.sock"))).toBe(true);
  expect(read(join(own, "daemon.json"))).toBe(true);
  expect(allows(sb, "file-write-data", join(own, "daemon.json"))).toBe(false);
  const other = join(runner, "browser", "lane-b");
  expect(dial(join(other, "daemon.sock"))).toBe(false);
  expect(read(join(other, "daemon.json"))).toBe(false);
  // The own proxy socket is reachable by its own key only, and the lane socket rule is untouched.
  expect(dial(join(runner, "sock", "lane"))).toBe(true);
});

test("macOS: LANE_SANDBOX_BSK_HOME names the real BrowserSkill home, and a ws_port that is not 1-65535 adds no tcp rule", async () => {
  const { root, home, runner, wt } = macHome();
  const real = join(root, "real-bsk");
  bskFixture(real, runner, "41000");
  bskFixture(join(home, ".bsk"), runner, "42000");
  const sb = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_BSK_HOME: real, BSK_HOME: join(runner, "browser", "lane-a") });
  expect(allows(sb, "network-outbound", join(real, "run", "daemon.sock"))).toBe(false);
  expect(allows(sb, "file-read-data", join(real, "daemon.json"))).toBe(false);
  expect(allows(sb, "network-outbound", "tcp:localhost:41000")).toBe(false);
  // ~/.bsk is not the real home here, and BSK_HOME (the proxy dir) is never mistaken for it.
  expect(allows(sb, "file-read-data", join(home, ".bsk", "daemon.json"))).toBe(true);
  expect(allows(sb, "network-outbound", "tcp:localhost:42000")).toBe(true);
  expect(allows(sb, "file-read-data", join(runner, "browser", "lane-a", "daemon.json"))).toBe(true);

  for (const bad of ["0", "65536", "123456", "\"80\""]) {
    bskFixture(real, runner, bad);
    const s = await seatbelt(home, wt, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_BSK_HOME: real });
    expect(s.profile).not.toContain("remote tcp");
    expect(Object.values(s.params).some((v) => v.includes("localhost"))).toBe(false);
  }
});

test("Linux: only the lane's own browser proxy dir is bound (read-only, before ~/.dori turns read-only), and no ~/.bsk path is", async () => {
  const home = join(tempDir(), "home");
  const runner = join(home, ".dori", "runner");
  mkdirSync(join(home, ".bsk", "run"), { recursive: true });
  bskFixture(join(home, ".bsk"), runner, "40123");
  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_BSK_HOME: join(home, ".bsk") });
  const own = join(runner, "browser", "lane-a");
  const bind = argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === own && argv[i + 2] === own);
  const doriRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === join(home, ".dori"));
  expect(bind).toBeGreaterThan(-1);
  expect(argv.findIndex((a, i) => a === "--dir" && argv[i + 1] === own)).toBeLessThan(bind);
  expect(bind).toBeLessThan(doriRo);
  expect(argv.some((a) => a.startsWith(join(runner, "browser", "lane-b")))).toBe(false);
  expect(argv.some((a) => a.startsWith(join(runner, "browser")) && !a.startsWith(own))).toBe(false);
  expect(argv.some((a) => a.startsWith(join(home, ".bsk")))).toBe(false);
});
