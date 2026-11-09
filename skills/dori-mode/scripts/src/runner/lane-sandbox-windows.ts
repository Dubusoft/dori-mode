/**
 * lane-sandbox for Windows runners: runs a lane agent inside a Microsoft MXC ProcessContainer (Windows 11 BaseContainer)
 * through `wxc-exec.exe` and a JSON request (schema 1.0.0). It is the Windows counterpart of templates/lane-sandbox.sh
 * (bubblewrap) and templates/lane-sandbox-macos.sh (Seatbelt), with the same inputs: DORI_LANE_KEY (empty = passthrough,
 * the lead runs outside the sandbox), DORI_LANE_TOKEN_FILE, LANE_SANDBOX_RW, LANE_SANDBOX_NO_CWD and LANE_SANDBOX_VERIFY
 * (lists separated by `;`, the Windows PATH separator).
 *
 * `dori runner install` puts the pinned MXC executor in `<runner>\mxc\<version>\`, and the runner's sandboxed profile runs
 * `dori.ps1 lane-sandbox <agent argv>` in the lane's pane. MXC starts the agent suspended inside a kill-on-close job, so
 * every process it starts stays in the container. Writes are allowed only to the worktree (and its git common dir, hooks
 * excluded), the lane's TEMP, ~/.omo, %LOCALAPPDATA%\omo, ~/.cache, ~/.dori/state, ~/.dori/heavy and package caches; every
 * volume the lane touches is otherwise read-only. ~/.dori is denied except what a lane needs (config, dori itself, the runner's bin and bun,
 * the runner's sock directory, its own brief and token), and ~/.dori/env and ~/.ssh private keys are denied outright.
 *
 * MXC rewrites LOCALAPPDATA (and TEMP) to a per-container AppContainer folder no grant can name in advance, so the container
 * runs the runner's bun on a copy of `dori.js` in the lane's TEMP with the same `lane-sandbox <agent argv>`: seeing LANE_SANDBOX_ACTIVE=1 there, it restores
 * the host LOCALAPPDATA and the lane's TEMP from DORI_LANE_LOCALAPPDATA and DORI_LANE_TEMP, then starts the agent and exits
 * with its code.
 *
 * Hosts without MXC support are refused with the requirement named; there is no other Windows backend.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { run as realRun, type Runner } from "../run.ts";
import { defaultRunnerDir } from "./fs-safety.ts";
import { CLI_SOCKET } from "./cli-relay.ts";
import { CONTROL_SOCKET } from "./unix-transport.ts";

/** The MXC release `dori runner install` puts on a Windows runner: the npm package carrying `bin\x64\wxc-exec.exe`. */
export const MXC_PIN = {
  version: "1.0.1",
  url: "https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-1.0.1.tgz",
  sha256: "416d9607c9d4652395d95c3d9c5f5605f1f2f845da1a63228bee41b7392cef49",
} as const;

/** Where the pinned executor lives on a runner: `<runner>\mxc\<version>\wxc-exec.exe`. */
export const wxcExecPath = (runnerDir: string): string => win32.join(runnerDir, "mxc", MXC_PIN.version, "wxc-exec.exe");

/** What a host needs for MXC ProcessContainer lanes, as the refusal names it. */
export const MXC_REQUIREMENT =
  "Windows 11 24H2 (build 26100.9278) or 25H2 (26200.9278) with the 2026-08 cumulative update (KB5120998) or later, 26H2 (26300.9550) or 26H1 (28000.2804)";

/** The lowest update revision (UBR) each Windows 11 build needs for ProcessContainer (MXC os-version-support.md). */
const MIN_UBR: Readonly<Record<number, number>> = { 26100: 9278, 26200: 9278, 26300: 9550, 28000: 2804 };
const NEWEST_LISTED_BUILD = 28000;

export type WindowsBuild = { readonly build: number; readonly ubr: number };

/** The registry query whose output `parseWindowsBuild` reads. */
export const WINDOWS_BUILD_ARGV = ["reg.exe", "query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"] as const;

/** The build number and update revision from `reg query ...\CurrentVersion` output; undefined when either is missing. */
export const parseWindowsBuild = (output: string): WindowsBuild | undefined => {
  const build = /^\s*CurrentBuildNumber\s+REG_SZ\s+(\d+)\s*$/im.exec(output)?.[1];
  const ubr = /^\s*UBR\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(output)?.[1];
  if (build === undefined || ubr === undefined) return undefined;
  return { build: Number(build), ubr: Number.parseInt(ubr, 16) };
};

/**
 * Why this Windows build cannot run MXC lanes, or undefined when it can as far as the build tells. A build newer than
 * every listed release passes here and is left to the executor's probe; an unlisted older one is refused.
 */
export const mxcBuildRefusal = ({ build, ubr }: WindowsBuild): string | undefined => {
  if (build > NEWEST_LISTED_BUILD) return undefined;
  const min = MIN_UBR[build];
  if (min !== undefined && ubr >= min) return undefined;
  const why = min !== undefined ? `is missing the cumulative update that adds ProcessContainer (needs ${build}.${min} or later)` : "has no MXC ProcessContainer support";
  return `Windows build ${build}.${ubr} ${why}; sandboxed lanes need ${MXC_REQUIREMENT}`;
};

/**
 * Why `wxc-exec.exe --probe <request>` says the request cannot be enforced, or undefined when it can. The probe prints
 * one JSON object (`error` set when it cannot) and exits 1 for a request it cannot enforce; deny paths need
 * `probes.baseContainerSupportsDenyPaths` (PSE_SUPPORT_FS_DENY).
 */
export const mxcProbeRefusal = (code: number, out: string, err: string): string | undefined => {
  let parsed: { error?: unknown; probes?: { baseContainerApiPresent?: unknown; baseContainerSupportsDenyPaths?: unknown } } | undefined;
  try { parsed = JSON.parse(out) as typeof parsed; } catch { parsed = undefined; }
  if (typeof parsed?.error === "string" && parsed.error) return `MXC cannot enforce the lane policy here: ${parsed.error}`;
  if (code !== 0 || parsed === undefined) return `wxc-exec --probe failed (exit ${code}): ${(err || out).trim().replace(/\s+/g, " ") || "no output"}`;
  if (parsed.probes?.baseContainerApiPresent !== true) return `this Windows has no ProcessContainer (BaseContainer) API; sandboxed lanes need ${MXC_REQUIREMENT}`;
  if (parsed.probes.baseContainerSupportsDenyPaths !== true) return `this Windows cannot deny paths in a ProcessContainer (no PSE_SUPPORT_FS_DENY), so ~/.dori/env would be readable; sandboxed lanes need ${MXC_REQUIREMENT}`;
  return undefined;
};

/** One argument quoted for a Windows command line the way CommandLineToArgvW and the MSVC runtime read it back. */
export const quoteWindowsArg = (arg: string): string => {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { slashes++; continue; }
    out += ch === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
};

export const windowsCommandLine = (argv: readonly string[]): string => argv.map(quoteWindowsArg).join(" ");

/**
 * The `process.commandLine` MXC starts for the agent argv. MXC creates the process directly, so a program found on PATH
 * as a batch file runs through cmd.exe and a PowerShell script through powershell.exe -File. cmd.exe expands `%` and
 * cannot carry a `"` inside a quoted argument, so a batch program with such an argument is refused.
 */
export const agentCommandLine = (argv: readonly string[], which: (cmd: string) => string | null): string => {
  const launch = agentLaunch(argv, which);
  return launch.verbatim ? launch.argv.join(" ") : windowsCommandLine(launch.argv);
};

/**
 * The argv that starts the agent, resolved as `agentCommandLine` does. `verbatim` marks a preformatted cmd.exe line: its
 * words go to Bun.spawn with windowsVerbatimArguments, joined by spaces without further quoting.
 */
export const agentLaunch = (argv: readonly string[], which: (cmd: string) => string | null): { argv: string[]; verbatim: boolean } => {
  const [first, ...rest] = argv;
  if (!first) throw new Error("lane-sandbox: no command");
  const program = which(first);
  if (!program) throw new Error(`lane-sandbox: ${first} is not on PATH`);
  const ext = win32.extname(program).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const bad = rest.find((arg) => /["%\r\n]/.test(arg));
    if (bad !== undefined) throw new Error(`lane-sandbox: ${program} is a batch file and cmd.exe cannot pass the argument ${JSON.stringify(bad)} intact (it holds " or %)`);
    return { argv: ["cmd.exe", "/d", "/s", "/c", `"${windowsCommandLine([program, ...rest])}"`], verbatim: true };
  }
  if (ext === ".ps1") return { argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", program, ...rest], verbatim: false };
  return { argv: [program, ...rest], verbatim: false };
};

/** `name` from a Windows environment, matched without case. */
export const envValue = (env: Readonly<Record<string, string | undefined>>, name: string): string | undefined =>
  Object.entries(env).find(([k, v]) => v !== undefined && k.toUpperCase() === name.toUpperCase())?.[1];

/** omo's Windows state folder (its engine-trust store lives here), granted read-write to every lane. */
export const omoLocalDir = (localAppData: string): string => win32.join(localAppData, "omo");

/** Inputs of one lane's MXC request; every path is an absolute Windows path. */
export type PolicyInput = {
  readonly home: string;
  readonly cwd: string;
  /** The lane key, already reduced to [A-Za-z0-9._-]. */
  readonly key: string;
  readonly laneTmp: string;
  readonly systemDrive: string;
  readonly commandLine: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tokenFile?: string;
  readonly gitCommonDir?: string;
  /** Private keys under ~/.ssh to deny (MXC deny paths are concrete paths, not patterns). */
  readonly sshKeys?: readonly string[];
  readonly rw?: readonly string[];
  readonly noCwd?: readonly string[];
  readonly verify?: string;
};

export type MxcRequest = {
  readonly version: "1.0.0";
  readonly containment: "processcontainer";
  readonly containerId: string;
  readonly lifecycle: { readonly destroyOnExit: true; readonly preservePolicy: false };
  readonly process: { readonly commandLine: string; readonly cwd: string; readonly env: readonly string[]; readonly timeout: 0 };
  readonly filesystem: { readonly readwritePaths: readonly string[]; readonly readonlyPaths: readonly string[]; readonly deniedPaths: readonly string[] };
  readonly network: { readonly egress: { readonly default: "allow" }; readonly ingress: { readonly default: "deny"; readonly hostLoopback: "allow" } };
  readonly ui: { readonly disable: false; readonly clipboard: "none"; readonly injection: false };
  readonly telemetry: { readonly enabled: false };
};

/** A normalized absolute path without a trailing separator (a volume root keeps its own). */
const norm = (path: string): string => {
  const p = win32.normalize(path);
  return p.length > win32.parse(p).root.length ? p.replace(/[\\/]+$/, "") : p;
};
const same = (a: string, b: string): boolean => norm(a).toLowerCase() === norm(b).toLowerCase();
const unique = (paths: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths.map(norm)) {
    if (seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
};
/** The volume root of `path` (`C:\`), also for a bare drive such as SystemDrive's `C:`. */
const rootOf = (path: string): string => {
  const root = win32.parse(norm(path)).root;
  return /^[A-Za-z]:$/.test(root) ? `${root}\\` : root;
};

/** Whether `cwd` is too broad to make writable: a volume root, the profile, the folder holding profiles, or a listed directory. */
export const broadCwd = (cwd: string, home: string, noCwd: readonly string[] = []): boolean =>
  same(cwd, rootOf(cwd)) || same(cwd, home) || same(cwd, win32.dirname(norm(home))) || noCwd.some((p) => p !== "" && same(cwd, p));

/**
 * The environment block MXC gives the agent: the wrapper's own environment (one entry per name, compared without case
 * as Windows does), with TEMP, TMP and TMPDIR pointed at the lane's TEMP and LANE_SANDBOX_ACTIVE=1. MXC refuses a block
 * without SYSTEMROOT and LOCALAPPDATA. DORI_LANE_LOCALAPPDATA and DORI_LANE_TEMP carry the host values past MXC's rewrite
 * to the in-container `lane-sandbox` run.
 */
export const laneEnv = (env: Readonly<Record<string, string | undefined>>, laneTmp: string): string[] => {
  const byName = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(env)) if (value !== undefined && name !== "" && !name.includes("=")) byName.set(name.toUpperCase(), [name, value]);
  for (const name of ["TEMP", "TMP", "TMPDIR"]) byName.set(name, [name, laneTmp]);
  byName.set("LANE_SANDBOX_ACTIVE", ["LANE_SANDBOX_ACTIVE", "1"]);
  const missing = ["SYSTEMROOT", "LOCALAPPDATA"].filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`lane-sandbox: ${missing.join(" and ")} must be set: MXC refuses an environment without them`);
  byName.set("DORI_LANE_LOCALAPPDATA", ["DORI_LANE_LOCALAPPDATA", byName.get("LOCALAPPDATA")?.[1] ?? ""]);
  byName.set("DORI_LANE_TEMP", ["DORI_LANE_TEMP", laneTmp]);
  return [...byName.values()].map(([name, value]) => `${name}=${value}`);
};

/** The MXC create-and-run request (schema 1.0.0) that runs one lane's agent. */
export const mxcPolicy = (input: PolicyInput): MxcRequest => {
  const h = norm(input.home);
  const dori = win32.join(h, ".dori");
  const runner = win32.join(dori, "runner");
  const broad = broadCwd(input.cwd, h, input.noCwd);
  const work = broad ? [] : [input.cwd, ...(input.gitCommonDir ? [input.gitCommonDir] : [])];
  const localAppData = envValue(input.env, "LOCALAPPDATA");
  const readwritePaths = unique([
    win32.join(runner, "briefs", `${input.key}.out`),
    input.laneTmp,
    ...[".omo", ".cache", ".dori\\state", ".dori\\heavy", ".npm", ".bun\\install\\cache", ".cargo\\registry", ".cargo\\git"].map((p) => win32.join(h, p)),
    // omo's engine-trust store: %LOCALAPPDATA%\omo on Windows.
    ...(localAppData ? [omoLocalDir(localAppData)] : []),
    ...(input.rw ?? []).filter((p) => p !== ""),
    ...(input.verify ? [input.verify] : []),
    ...work,
    // Connecting to the lane socket needs write access. The grant names the directory: an AF_UNIX socket file is a reparse
    // point Windows cannot open, so naming it fails CreateProcessSecurityEnvironment with 0x80070780 (ERROR_CANT_ACCESS_FILE).
    // The runner's other sockets in it are denied below.
    win32.join(runner, "sock"),
  ]);
  const readonlyPaths = unique([
    // Every volume the lane starts on is readable (a read-only volume-root grant covers the whole volume).
    ...[input.systemDrive, h, input.cwd].map(rootOf),
    ...["config.json", "src", "bin"].map((p) => win32.join(dori, p)),
    // The runner's dori and the bun it runs with: the lane's `dori report` goes through them.
    win32.join(runner, "bin"),
    win32.join(runner, "bun"),
    win32.join(runner, "briefs", `${input.key}.md`),
    win32.join(runner, "briefs", `${input.key}.files`),
    ...(input.tokenFile ? [input.tokenFile] : []),
    // A hook written by a lane would run outside the sandbox at the next git command on the host.
    ...(!broad && input.gitCommonDir ? [win32.join(input.gitCommonDir, "hooks")] : []),
  ]);
  const deniedPaths = unique([
    dori, win32.join(dori, "env"), ...[CONTROL_SOCKET, CLI_SOCKET].map((s) => win32.join(runner, "sock", s)), ...(input.sshKeys ?? []),
  ]);
  return {
    version: "1.0.0",
    containment: "processcontainer",
    containerId: `dori-lane-${input.key}`,
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: { commandLine: input.commandLine, cwd: norm(input.cwd), env: laneEnv(input.env, norm(input.laneTmp)), timeout: 0 },
    filesystem: { readwritePaths, readonlyPaths, deniedPaths },
    // Lanes need the network (git, package registries, model APIs) and local servers on the host's loopback.
    network: { egress: { default: "allow" }, ingress: { default: "deny", hostLoopback: "allow" } },
    // PowerShell needs Win32k (ui.disable would turn it off); clipboard and input injection stay blocked.
    ui: { disable: false, clipboard: "none", injection: false },
    telemetry: { enabled: false },
  };
};

/** The lane key as the shell wrappers reduce it: [A-Za-z0-9._-] only, and never `.` or `..`. */
export const sandboxKey = (raw: string): string => {
  const key = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return key === "." || key === ".." ? `_${key}` : key;
};

/** The private keys under `sshDir`: `id_<name>` files without an extension (the `.pub` halves stay readable). */
export const sshPrivateKeys = (sshDir: string, names: readonly string[]): string[] =>
  names.filter((n) => /^id_[^.]+$/.test(n)).map((n) => win32.join(sshDir, n));

/** What runs the shipped dori.ps1 from a plain process (the runner's sandboxCheck); the script path follows it. */
export const WINDOWS_PS1_ARGV = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] as const;

/** The argv a runner's sandboxCheck runs on Windows: the shipped dori.ps1 with `lane-sandbox --check`. */
export const windowsSandboxCheckArgv = (runnerDir: string): string[] =>
  [...WINDOWS_PS1_ARGV, win32.join(runnerDir, "bin", "dori.ps1"), "lane-sandbox", "--check"];

export type SpawnOpts = { readonly env?: Readonly<Record<string, string | undefined>>; readonly verbatim?: boolean };

export type LaneSandboxDeps = {
  readonly out: (line: string) => void;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly runnerDir: string;
  readonly cwd: () => string;
  readonly run: Runner;
  readonly which: (cmd: string) => string | null;
  readonly exists: (path: string) => boolean;
  readonly listDir: (path: string) => string[];
  readonly mkdir: (path: string) => void;
  readonly writeFile: (path: string, text: string) => void;
  /** The file's text; throws when it is missing or unreadable. */
  readonly readFile: (path: string) => string;
  readonly copyFile: (from: string, to: string) => void;
  /**
   * Runs argv with the pane's console (stdin, stdout, stderr inherited) and resolves its exit code; `env` replaces the
   * environment and `verbatim` passes the words unquoted (windowsVerbatimArguments).
   */
  readonly spawn: (argv: readonly string[], cwd: string, opts?: SpawnOpts) => Promise<number>;
  readonly err: (line: string) => void;
};

const realDeps = (): LaneSandboxDeps => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  runnerDir: defaultRunnerDir(),
  cwd: () => process.cwd(),
  run: realRun,
  which: (cmd) => Bun.which(cmd),
  exists: existsSync,
  listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
  mkdir: (path) => { mkdirSync(path, { recursive: true }); },
  writeFile: (path, text) => { writeFileSync(path, text, { mode: 0o600 }); },
  readFile: (path) => readFileSync(path, "utf8"),
  copyFile: (from, to) => { copyFileSync(from, to); },
  spawn: async (argv, cwd, opts = {}) => {
    // Ctrl+C in the pane reaches every process on its console: the wrapper keeps waiting so the agent decides.
    const ignore = (): void => {};
    process.on("SIGINT", ignore);
    try {
      return await Bun.spawn([...argv], {
        cwd, stdio: ["inherit", "inherit", "inherit"],
        ...(opts.env ? { env: { ...opts.env } } : {}), ...(opts.verbatim ? { windowsVerbatimArguments: true } : {}),
      }).exited;
    } finally { process.off("SIGINT", ignore); }
  },
  err: (line) => { console.error(line); },
  out: (line) => { console.log(line); },
});

const USAGE = "usage: dori lane-sandbox <cmd> [args...] | dori lane-sandbox --check";

/** Why this host cannot start MXC lanes before any request is built: not Windows, an unsupported build, no executor. */
const hostRefusal = async (d: LaneSandboxDeps): Promise<string | undefined> => {
  if (d.platform !== "win32") return `the MXC lane sandbox runs only on Windows (this is ${d.platform})`;
  const reg = await d.run(WINDOWS_BUILD_ARGV, { timeoutMs: 15_000 });
  const build = reg.code === 0 ? parseWindowsBuild(reg.out) : undefined;
  if (!build) return `cannot read the Windows build (reg query exit ${reg.code}); sandboxed lanes need ${MXC_REQUIREMENT}`;
  const refused = mxcBuildRefusal(build);
  if (refused) return refused;
  const wxc = wxcExecPath(d.runnerDir);
  if (!d.exists(wxc)) return `${wxc} is missing; rerun dori runner install for this machine from the lead`;
  return undefined;
};

/** The request for `key` in `cwd` running `commandLine`, with the git common dir and ssh keys looked up on this host. */
const laneTmpDir = (home: string, key: string): string => win32.join(home, ".cache", "omo-tmp", "lane-sandbox", key);

const buildRequest = async (d: LaneSandboxDeps, key: string, cwd: string, commandLine: string): Promise<{ request: MxcRequest; laneTmp: string }> => {
  const laneTmp = laneTmpDir(d.home, key);
  d.mkdir(laneTmp);
  // MXC grants need existing paths; omo creates its engine-trust store under this one.
  const localAppData = envValue(d.env, "LOCALAPPDATA");
  if (localAppData) d.mkdir(omoLocalDir(localAppData));
  const list = (name: string): string[] => (d.env[name] ?? "").split(";").filter((p) => p !== "");
  const git = await d.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 15_000 });
  // git prints C:/... on Windows.
  const gcd = git.code === 0 && git.out.trim() ? win32.normalize(git.out.trim()) : "";
  const sshDir = win32.join(d.home, ".ssh");
  const request = mxcPolicy({
    home: d.home, cwd, key, laneTmp, commandLine, env: d.env,
    systemDrive: d.env.SystemDrive ?? d.env.SYSTEMDRIVE ?? "C:",
    rw: list("LANE_SANDBOX_RW"), noCwd: list("LANE_SANDBOX_NO_CWD"),
    sshKeys: sshPrivateKeys(sshDir, d.listDir(sshDir)),
    ...(d.env.LANE_SANDBOX_VERIFY ? { verify: d.env.LANE_SANDBOX_VERIFY } : {}),
    ...(d.env.DORI_LANE_TOKEN_FILE ? { tokenFile: d.env.DORI_LANE_TOKEN_FILE } : {}),
    ...(gcd && d.exists(gcd) ? { gitCommonDir: gcd } : {}),
  });
  return { request, laneTmp };
};

/**
 * `lane-sandbox <argv>` with LANE_SANDBOX_ACTIVE=1, run by the runner's bun inside the container: puts back the host LOCALAPPDATA and the
 * lane's TEMP that MXC rewrote, then runs the agent and exits with its code.
 */
const innerMain = async (d: LaneSandboxDeps, argv: readonly string[]): Promise<number> => {
  const env: Record<string, string | undefined> = { ...d.env };
  const set = (name: string, value: string): void => {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
    env[name] = value;
  };
  const localAppData = d.env.DORI_LANE_LOCALAPPDATA;
  const temp = d.env.DORI_LANE_TEMP;
  if (localAppData) set("LOCALAPPDATA", localAppData);
  if (temp) for (const name of ["TEMP", "TMP", "TMPDIR"]) set(name, temp);
  let launch: { argv: string[]; verbatim: boolean };
  try { launch = agentLaunch(argv, d.which); } catch (e) { d.err(e instanceof Error ? e.message : String(e)); return 3; }
  return d.spawn(launch.argv, d.cwd(), { env, verbatim: launch.verbatim });
};

/**
 * `dori lane-sandbox`: `--check` is the preflight `dori doctor` and the runner's sandboxCheck run (exit 3 when this host
 * cannot sandbox, with the reason on stderr); otherwise it runs the argv inside MXC and exits with its code, or runs it
 * bare when DORI_LANE_KEY is empty.
 */
export const laneSandboxWindowsMain = async (args: readonly string[], deps: Partial<LaneSandboxDeps> = {}): Promise<number> => {
  const d: LaneSandboxDeps = { ...realDeps(), ...deps };
  if (args[0] === "--check") {
    if (args.length > 1) { d.err(USAGE); return 2; }
    const refused = await hostRefusal(d);
    if (refused) { d.err(`lane-sandbox: ${refused}`); return 3; }
    let probe: string;
    try {
      const { request, laneTmp } = await buildRequest(d, "_check", d.home, "cmd.exe /d /c exit 0");
      probe = win32.join(laneTmp, "mxc-check.json");
      d.writeFile(probe, `${JSON.stringify(request, null, 2)}\n`);
    } catch (e) { d.err(e instanceof Error ? e.message : String(e)); return 3; }
    const ran = await d.run([wxcExecPath(d.runnerDir), "--probe", "--config", probe], { timeoutMs: 30_000 });
    const why = mxcProbeRefusal(ran.code, ran.out, ran.err);
    if (why) { d.err(`lane-sandbox: ${why}`); return 3; }
    d.out("DORI_LANE_FILES=1");
    return 0;
  }
  if (args.length === 0) { d.err(USAGE); return 2; }
  // Inside the container (laneEnv sets this): run the agent, never wrap it again.
  if (d.env.LANE_SANDBOX_ACTIVE === "1") return innerMain(d, args);
  if (!d.env.DORI_LANE_KEY) return d.spawn(args, d.cwd());
  const refused = await hostRefusal(d);
  if (refused) { d.err(`lane-sandbox: ${refused}`); return 3; }
  const bunTxt = win32.join(d.runnerDir, "bin", "bun.txt");
  let bunVersion = "";
  try { bunVersion = d.readFile(bunTxt).trim(); } catch { bunVersion = ""; }
  if (!bunVersion) { d.err(`lane-sandbox: cannot read ${bunTxt}; rerun dori runner install for this machine from the lead`); return 3; }
  const cwd = d.cwd();
  let config: string;
  try {
    // Resolved here only to refuse a missing program or a batch argument before MXC starts; the shim resolves it again.
    agentCommandLine(args, d.which);
    // bun cannot load a script under the denied ~/.dori inside the container (resolving it reads the parent folders and
    // gets EPERM), so the container runs a copy of the bundle in the lane's TEMP.
    const key = sandboxKey(d.env.DORI_LANE_KEY);
    const bundle = win32.join(laneTmpDir(d.home, key), "dori.js");
    const shim = windowsCommandLine([win32.join(d.runnerDir, "bun", bunVersion, "bun.exe"), bundle, "lane-sandbox", ...args]);
    const { request, laneTmp } = await buildRequest(d, key, cwd, shim);
    d.copyFile(win32.join(d.runnerDir, "bin", "dori.js"), bundle);
    if (broadCwd(cwd, d.home, (d.env.LANE_SANDBOX_NO_CWD ?? "").split(";"))) d.err(`lane-sandbox: warning: cwd ${cwd} is too broad; not making it writable`);
    config = win32.join(laneTmp, "mxc-policy.json");
    d.writeFile(config, `${JSON.stringify(request, null, 2)}\n`);
  } catch (e) { d.err(e instanceof Error ? e.message : String(e)); return 3; }
  return d.spawn([wxcExecPath(d.runnerDir), "--config", config], cwd);
};
