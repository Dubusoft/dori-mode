// Runner-side command validation: what the runner agrees to execute even for an authenticated supervisor.
// Pure apart from the optional config read in `loadPolicy`; path resolution is injected into `checkCommand`.

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve as resolvePath, sep, win32 } from "node:path";
import { defaultRunnerDir, RUNNER_PATHS } from "./fs-safety.ts";
import { validateFileKey } from "./lane-files.ts";
import {
  isQueryType, ProtocolError, SUPERVISOR_COMMAND_TYPES, validateFrame, type AnySupervisorCommand, type AnySupervisorControl,
} from "./protocol.ts";

export const POLICY_FILE = "runner-config.json";

export type RunnerPolicy = {
  /** Profile name -> argv template. Only these profiles may be started. */
  readonly agents: Readonly<Record<string, readonly string[]>>;
  /**
   * Directories under which every command cwd must resolve; parsePolicy appends the lanes directory, `reposRoot` and
   * the effective worktree root, and derives the rest when the file lists none (derivedRoots).
   */
  readonly allowedRoots: readonly string[];
  readonly sandbox: "required" | "optional";
  /**
   * Argv run before every `lane.start` with `sandbox: true` (e.g. `["lane-sandbox", "--check"]`); a non-zero exit refuses
   * the start `sandbox-unavailable` with its stderr, so a host whose wrapper cannot sandbox never opens the lane's pane.
   */
  readonly sandboxCheck?: readonly string[];
  /** `deny` refuses `job.run`, `wait.check`, `lane.git` and a `q.lane.inspect` with a `done` section. */
  readonly jobs: "allow" | "deny";
  /** Guard thresholds for this host; each one absent falls back to the runner's config defaults. */
  readonly guard?: Readonly<Partial<Record<GuardKey, number>>>;
  /** Command-line patterns killed under critical memory pressure; absent falls back to the config's `heavyKill`. */
  readonly heavyKill?: readonly string[];
  /**
   * The repos this host owns for placement: owner/repo -> its checkout (absolute, a leading `~` already expanded). The
   * runner checks each path against allowedRoots and sends the valid ones in its hello (workspaces.ts).
   */
  readonly workspaces?: Readonly<Record<string, string>>;
  /** `false` turns off the scan of allowedRoots for git checkouts (hello `detected`); default on. */
  readonly detectWorkspaces?: boolean;
  /** Every checkout directly under it is a declared repo, keyed by its origin (absolute, `~` expanded; workspaces.ts). Added to allowedRoots automatically. */
  readonly reposRoot?: string;
  /** Where this host's lane worktrees live (absolute, `~` expanded); absent: `<reposRoot>/worktrees` (effectiveWorktreeRoot). Added to allowedRoots automatically. */
  readonly worktreeRoot?: string;
  /**
   * Named path grants a `lane.start` may ask for by name (`grants`): each one's `write` directories become writable for
   * that lane (LANE_SANDBOX_RW) and its `read` directories readable (LANE_SANDBOX_RO). Absolute, `~` expanded, checked by
   * grantPathRefusal; the wrapper's hide list still wins over every grant.
   */
  readonly grants?: Readonly<Record<string, PathGrant>>;
};

/** One named entry of runner-config `grants`. */
export type PathGrant = { readonly write: readonly string[]; readonly read: readonly string[] };

/** A grant name: what `dori launch --grant` and a `lane.start` `grants` entry spell. */
export const GRANT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The path rules of the runner host's platform: a runner-config.json is judged by them, not by the machine reading it
 * (`dori runner setup` on a Linux lead checks a Windows runner's `C:\...` paths with win32 rules).
 */
export const runnerPaths = (platform: NodeJS.Platform = process.platform): typeof posix => (platform === "win32" ? win32 : posix);

/** `worktreeRoot`, else `<reposRoot>/worktrees` when `reposRoot` is set, else undefined; joined by `platform`'s rules. */
export const effectiveWorktreeRoot = (policy: Pick<RunnerPolicy, "reposRoot" | "worktreeRoot">, platform?: NodeJS.Platform): string | undefined =>
  policy.worktreeRoot ?? (policy.reposRoot !== undefined ? runnerPaths(platform).join(policy.reposRoot, "worktrees") : undefined);

/** owner/repo as GitHub spells it. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `<runnerDir>/lanes`: every lane started without `cwd` gets its own directory here (laneCwd). */
export const lanesDir = (runnerDir: string): string => join(runnerDir, RUNNER_PATHS.lanes);

/** Where a `lane.start` without `cwd` starts: `<runnerDir>/lanes/<key>`, created by the start (lanes.ts). */
export const laneCwd = (runnerDir: string, key: string): string => join(lanesDir(runnerDir), key);

/** The top-level keys runner-config.json may hold; parsePolicy throws on any other (RETIRED_POLICY_KEYS aside). */
export const RUNNER_POLICY_KEYS = [
  "agents", "allowedRoots", "sandbox", "jobs", "guard", "heavyKill", "sandboxCheck", "workspaces", "detectWorkspaces", "reposRoot", "worktreeRoot", "grants",
] as const;

/**
 * Keys an older runner-config.json may still hold: parsePolicy ignores them with one `RUNNER_CONFIG_KEY_IGNORED` warning
 * instead of refusing the file, and `dori runner setup` removes them (with a backup).
 */
export const RETIRED_POLICY_KEYS: Readonly<Record<string, string>> = {
  defaultCwd: "a lane.start without cwd now starts in its own directory under <runnerDir>/lanes",
};

export const GUARD_KEYS = ["loadAlert", "loadOk", "memFreeMinPct", "memFreeCritPct", "swapFreeCritPct", "diskFreeMinGb", "panesMax"] as const;
type GuardKey = (typeof GUARD_KEYS)[number];

export const DEFAULT_POLICY: RunnerPolicy = { agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow" };

/** Rules beyond the protocol schema rules (which pass through under their own names, e.g. `unknown-field`). */
export type PolicyRule =
  | "not-a-command" | "agent-profile" | "cwd-outside-roots" | "cwd-missing" | "sandbox-required" | "sandbox-unavailable" | "command-not-argv" | "jobs-denied"
  | "grant-unknown" | "grant-unsandboxed" | "grant-path";

export type CheckResult = { readonly ok: true; readonly command: AnySupervisorCommand } | { readonly ok: false; readonly rule: string; readonly detail: string };

/** The `detail` a rejected command reports in its `cmd.result`. */
export const rejectionText = (rule: string): string => `RUNNER_CMD_REJECTED ${rule}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `~` or `~/...` (also `~\...` on win32) under `home`; any other path unchanged. */
const expandHome = (path: string, home: string, p: typeof posix): string =>
  path === "~" ? home : path.startsWith("~/") || (p === win32 && path.startsWith("~\\")) ? p.join(home, path.slice(2)) : path;

/**
 * The allowed roots of a runner-config.json without `allowedRoots` (or with `[]`), before the lanes directory,
 * `reposRoot` and the effective worktree root are appended: the runner's temp directory, and the runner's home only
 * when the file names neither `reposRoot` nor `worktreeRoot`, which leaves the host no other place to work. Home is
 * left out otherwise because it would widen the boundary to every file the runner's user owns.
 */
const derivedRoots = (o: { readonly tmp: string; readonly home: string; readonly hasRepoRoots: boolean }): string[] =>
  [...new Set([o.tmp, o.hasRepoRoots ? undefined : o.home].filter((r): r is string => r !== undefined && r !== ""))];

/**
 * Why `path` may not be in a grant, else undefined. Refused: a relative path or one holding `:` (the wrapper lists are
 * colon-separated); `/`, the home directory or any directory above it; anything that holds or lies under ~/.dori (the
 * runner directory, the state dir, secrets), ~/.config (credentials, herdr's control socket) or the user runtime
 * directory (/run/user, XDG_RUNTIME_DIR: the D-Bus session bus and the systemd user manager). A host directory whose
 * scripts the host runs (a checkout) is refused at lane start (resolveGrants), where the filesystem is read.
 */
export const grantPathRefusal = (
  path: string, o: { readonly home: string; readonly runtimeDir?: string }, p: typeof posix = posix,
): string | undefined => {
  if (!p.isAbsolute(path)) return "is not absolute";
  if (path.includes(":")) return "holds ':'";
  const full = p.resolve(path);
  if (underRoot(full, p.resolve(o.home), p)) return "covers the home directory";
  const off = [p.join(o.home, ".dori"), p.join(o.home, ".config"), "/run/user", o.runtimeDir].filter((d): d is string => d !== undefined && d !== "");
  for (const dir of off) {
    const d = p.resolve(dir);
    if (underRoot(d, full, p) || underRoot(full, d, p)) return `overlaps ${d}`;
  }
  return undefined;
};

export type ParsePolicyOptions = {
  /** The runner directory whose `lanes` directory joins allowedRoots; absent: `~/.dori/runner` under `home`. */
  readonly runnerDir?: string;
  /** Receives one `RUNNER_CONFIG_KEY_IGNORED <key>: <why>` line per retired key the file still holds. */
  readonly warn?: (line: string) => void;
  /** The runner host's platform, whose path rules judge the file (runnerPaths); absent: this process's. */
  readonly platform?: NodeJS.Platform;
  /** The runner's XDG_RUNTIME_DIR when set, refused in grants like /run/user (grantPathRefusal). */
  readonly runtimeDir?: string;
};

/**
 * Reads a policy from parsed JSON (`home` expands a leading `~`; `home` and `tmp` feed derivedRoots); unknown keys or
 * wrong types throw, a retired key (RETIRED_POLICY_KEYS) is ignored with a warning.
 */
export function parsePolicy(value: unknown, home: string = homedir(), tmp: string = tmpdir(), options: ParsePolicyOptions = {}): RunnerPolicy {
  if (!isRecord(value)) throw new Error("runner-config must be a JSON object");
  const p = runnerPaths(options.platform);
  const known = new Set<string>(RUNNER_POLICY_KEYS);
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(RETIRED_POLICY_KEYS, key)) options.warn?.(`RUNNER_CONFIG_KEY_IGNORED ${key}: ${RETIRED_POLICY_KEYS[key]}; remove it from runner-config.json (dori runner setup does)`);
    else if (!known.has(key)) throw new Error(`runner-config: unknown key ${key}`);
  }
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  const agents: Record<string, readonly string[]> = {};
  if (value.agents !== undefined) {
    if (!isRecord(value.agents)) throw new Error("runner-config: agents must be an object");
    for (const [name, argv] of Object.entries(value.agents)) {
      if (!strings(argv)) throw new Error(`runner-config: agents.${name} must be a string array`);
      agents[name] = argv;
    }
  }
  if (value.allowedRoots !== undefined && !strings(value.allowedRoots)) throw new Error("runner-config: allowedRoots must be a string array");
  if (value.sandbox !== undefined && value.sandbox !== "required" && value.sandbox !== "optional") throw new Error("runner-config: sandbox must be required|optional");
  if (value.jobs !== undefined && value.jobs !== "allow" && value.jobs !== "deny") throw new Error("runner-config: jobs must be allow|deny");
  if (value.heavyKill !== undefined && !strings(value.heavyKill)) throw new Error("runner-config: heavyKill must be a string array");
  if (value.sandboxCheck !== undefined && (!strings(value.sandboxCheck) || value.sandboxCheck.length === 0 || value.sandboxCheck[0] === "")) {
    throw new Error("runner-config: sandboxCheck must be a non-empty string array");
  }
  let workspaces: Record<string, string> | undefined;
  if (value.workspaces !== undefined) {
    if (!isRecord(value.workspaces)) throw new Error("runner-config: workspaces must be an object of owner/repo -> path");
    workspaces = {};
    for (const [repo, path] of Object.entries(value.workspaces)) {
      if (!REPO_PATTERN.test(repo)) throw new Error(`runner-config: workspaces key ${repo} must be owner/repo`);
      const full = typeof path === "string" ? expandHome(path, home, p) : undefined;
      if (full === undefined || !p.isAbsolute(full)) throw new Error(`runner-config: workspaces.${repo} must be an absolute path or start with ~/`);
      workspaces[repo] = full;
    }
  }
  if (value.detectWorkspaces !== undefined && typeof value.detectWorkspaces !== "boolean") throw new Error("runner-config: detectWorkspaces must be true|false");
  const rootPath = (key: "reposRoot" | "worktreeRoot"): string | undefined => {
    const raw = value[key];
    if (raw === undefined) return undefined;
    const full = typeof raw === "string" ? expandHome(raw, home, p) : undefined;
    if (full === undefined || !p.isAbsolute(full)) throw new Error(`runner-config: ${key} must be an absolute path or start with ~/`);
    return full;
  };
  const reposRoot = rootPath("reposRoot");
  const worktreeRoot = rootPath("worktreeRoot");
  let grants: Record<string, PathGrant> | undefined;
  if (value.grants !== undefined) {
    if (!isRecord(value.grants)) throw new Error("runner-config: grants must be an object of name -> {write, read}");
    grants = {};
    for (const [name, entry] of Object.entries(value.grants)) {
      if (!GRANT_NAME.test(name)) throw new Error(`runner-config: grants key ${name} must match ${GRANT_NAME.source}`);
      if (!isRecord(entry)) throw new Error(`runner-config: grants.${name} must be an object with write and/or read`);
      for (const key of Object.keys(entry)) if (key !== "write" && key !== "read") throw new Error(`runner-config: unknown key grants.${name}.${key}`);
      const list = (kind: "write" | "read"): string[] => {
        const raw = entry[kind];
        if (raw === undefined) return [];
        if (!strings(raw)) throw new Error(`runner-config: grants.${name}.${kind} must be a string array`);
        return raw.map((path) => {
          const full = expandHome(path, home, p);
          const why = grantPathRefusal(full, { home, ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {}) }, p);
          if (why) throw new Error(`runner-config: grants.${name}.${kind} ${path} ${why}`);
          return full;
        });
      };
      const write = list("write");
      const read = list("read");
      if (!write.length && !read.length) throw new Error(`runner-config: grants.${name} names no path`);
      grants[name] = { write, read };
    }
  }
  // Explicit roots stay as written (none listed: derivedRoots); the lanes directory is appended unless a root already
  // holds it, then reposRoot and the effective worktree root unless one already names the same directory.
  const explicit = (value.allowedRoots as string[] | undefined) ?? [];
  const base = explicit.length ? explicit : derivedRoots({ tmp, home, hasRepoRoots: reposRoot !== undefined || worktreeRoot !== undefined });
  const allowedRoots = [...base];
  const lanes = p.join(options.runnerDir ?? p.join(home, ".dori", "runner"), RUNNER_PATHS.lanes);
  if (!allowedRoots.some((r) => underRoot(p.resolve(r), p.resolve(lanes), p))) allowedRoots.push(lanes);
  for (const root of [reposRoot, effectiveWorktreeRoot({ reposRoot, worktreeRoot }, options.platform)]) {
    if (root !== undefined && !allowedRoots.some((r) => p.resolve(r) === p.resolve(root))) allowedRoots.push(root);
  }
  let guard: Partial<Record<GuardKey, number>> | undefined;
  if (value.guard !== undefined) {
    if (!isRecord(value.guard)) throw new Error("runner-config: guard must be an object");
    guard = {};
    for (const [key, n] of Object.entries(value.guard)) {
      if (!(GUARD_KEYS as readonly string[]).includes(key)) throw new Error(`runner-config: unknown key guard.${key}`);
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`runner-config: guard.${key} must be a number`);
      guard[key as GuardKey] = n;
    }
  }
  return {
    ...(guard ? { guard } : {}),
    ...(value.heavyKill !== undefined ? { heavyKill: value.heavyKill as string[] } : {}),
    ...(value.sandboxCheck !== undefined ? { sandboxCheck: value.sandboxCheck as string[] } : {}),
    ...(workspaces ? { workspaces } : {}),
    ...(value.detectWorkspaces !== undefined ? { detectWorkspaces: value.detectWorkspaces as boolean } : {}),
    ...(reposRoot !== undefined ? { reposRoot } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    ...(grants ? { grants } : {}),
    agents,
    allowedRoots,
    sandbox: (value.sandbox as RunnerPolicy["sandbox"] | undefined) ?? DEFAULT_POLICY.sandbox,
    jobs: (value.jobs as RunnerPolicy["jobs"] | undefined) ?? DEFAULT_POLICY.jobs,
  };
}

/** Loads `<runnerDir>/runner-config.json`; an absent file yields the defaults (no agents, no roots). */
export function loadPolicy(runnerDir: string, warn?: (line: string) => void): RunnerPolicy {
  let text: string;
  try {
    text = readFileSync(join(runnerDir, POLICY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw error;
  }
  return parsePolicy(JSON.parse(text), homedir(), tmpdir(), { runnerDir, ...(warn ? { warn } : {}), ...runtimeDirOption() });
}

/** `{runtimeDir}` from this process's XDG_RUNTIME_DIR, else nothing. */
export const runtimeDirOption = (): { readonly runtimeDir?: string } =>
  process.env.XDG_RUNTIME_DIR ? { runtimeDir: process.env.XDG_RUNTIME_DIR } : {};

/**
 * The sandbox lists of `names` under `policy`: each write and read path resolved (`realpath`; a missing one is kept as
 * written, the wrapper skips it) and checked again on its real form, so a symlink cannot point a grant at a refused
 * place. A write path that is a git checkout (`isCheckout`) is refused too: the host runs that checkout's scripts and
 * hooks, so a lane gets a data directory inside it instead. Throws `RUNNER_CMD_REJECTED grant-unknown|grant-path ...`.
 */
export const resolveGrants = (
  policy: Pick<RunnerPolicy, "grants">, names: readonly string[],
  o: { readonly home: string; readonly runtimeDir?: string; readonly realpath: (path: string) => string; readonly isCheckout: (path: string) => boolean },
): { readonly write: string[]; readonly read: string[] } => {
  const write: string[] = [];
  const read: string[] = [];
  for (const name of names) {
    const grant = policy.grants?.[name];
    if (!grant) throw new Error(`${rejectionText("grant-unknown")} ${name}`);
    for (const [kind, paths, into] of [["write", grant.write, write], ["read", grant.read, read]] as const) {
      for (const path of paths) {
        let real = path;
        try { real = o.realpath(path); } catch { /* missing: the wrapper's -try bind skips it */ }
        const why = grantPathRefusal(real, o) ?? (kind === "write" && o.isCheckout(real) ? "is a git checkout the host runs scripts from" : undefined);
        if (why) throw new Error(`${rejectionText("grant-path")} ${name}.${kind} ${path} ${why}`);
        if (!into.includes(real)) into.push(real);
      }
    }
  }
  return { write, read };
};

const underRoot = (root: string, path: string, p: typeof posix = runnerPaths()): boolean => {
  const rel = p.relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
};

/**
 * `cwd-missing` / `cwd-outside-roots` for `path` (absolute, resolving, under an allowed root), else undefined.
 * A lexical pre-check runs first: a path whose `path.resolve` form is under neither a root's normalized nor its
 * real form is refused with no filesystem access, because `realpath` on a macOS TCC-protected folder (~/Documents)
 * blocks the launchd-run runner instead of failing. Only a lexically admitted path is then realpath'd and re-checked
 * against the real roots, so a symlink inside a root that escapes it is still refused.
 */
const checkRootedPath = (policy: RunnerPolicy, path: string, realpath: (path: string) => string, missingOk = false): { readonly rule: string; readonly detail: string } | undefined => {
  if (!isAbsolute(path)) return { rule: "cwd-missing", detail: `${path} is not absolute` };
  // Roots are safe to resolve (the operator chose them); $TMPDIR-style roots resolve elsewhere (/var -> /private/var) and a path may use either form.
  const roots: string[] = [];
  const lexicalRoots: string[] = [];
  for (const root of policy.allowedRoots) {
    lexicalRoots.push(resolvePath(root));
    try { const real = realpath(root); roots.push(real); lexicalRoots.push(real); } catch { /* a root that does not exist admits nothing */ }
  }
  const normalized = resolvePath(path);
  if (!lexicalRoots.some((root) => underRoot(root, normalized))) return { rule: "cwd-outside-roots", detail: normalized };
  let resolved: string;
  try {
    resolved = realpath(path);
  } catch {
    if (!missingOk) return { rule: "cwd-missing", detail: path };
    // A path to be created (git worktree add): resolve its nearest existing ancestor and re-append the normalized rest.
    let head = resolvePath(path);
    const tail: string[] = [];
    for (;;) {
      try { resolved = join(realpath(head), ...tail); break; } catch {
        const parent = dirname(head);
        if (parent === head) return { rule: "cwd-missing", detail: path };
        tail.unshift(basename(head));
        head = parent;
      }
    }
  }
  if (!roots.some((root) => underRoot(root, resolved))) return { rule: "cwd-outside-roots", detail: resolved };
  return undefined;
};

/**
 * The same root check for a directory the runner learns only on its host, such as an adopted or target pane's
 * `foreground_cwd`/`cwd`: `cwd-missing` / `cwd-outside-roots` (lexical pre-check without touching the path, then symlinks
 * resolved, path segments compared), else undefined.
 */
export const checkCwd = (policy: RunnerPolicy, path: string, realpath: (path: string) => string): { readonly rule: string; readonly detail: string } | undefined =>
  checkRootedPath(policy, path, realpath);

/**
 * Checks a parsed supervisor command frame against the policy. `realpath` resolves symlinks and throws when the
 * path does not exist (as `fs.realpathSync` does). Every `cwd` (`lane.start`, `lane.adopt`, `job.run`,
 * `wait.check`) and `lane.git.root` must be absolute, resolve and lie under `allowedRoots`. A `lane.start` without
 * `cwd` gets its own `laneCwd(runnerDir, key)` before that check, which may not exist yet (the start creates it); the
 * returned command carries the filled `cwd`.
 */
export function checkCommand(policy: RunnerPolicy, command: unknown, realpath: (path: string) => string, runnerDir: string = defaultRunnerDir()): CheckResult {
  const reject = (rule: string, detail: string): CheckResult => ({ ok: false, rule, detail });
  // A shell string is reported by its own rule rather than as a generic type error.
  if (isRecord(command) && command.type === "job.run" && isRecord(command.body) && command.body.command !== undefined) {
    const argv = command.body.command;
    if (!Array.isArray(argv) || !argv.every((s) => typeof s === "string")) return reject("command-not-argv", "command must be an argv string array");
  }
  let frame: AnySupervisorCommand;
  try {
    const checked = validateFrame(command, "supervisor");
    if (!(SUPERVISOR_COMMAND_TYPES as readonly string[]).includes(checked.type)) return reject("not-a-command", checked.type);
    frame = checked as AnySupervisorCommand;
  } catch (error) {
    if (error instanceof ProtocolError) return reject(error.rule, error.detail);
    throw error;
  }

  let laneDir: string | undefined;
  if (frame.type === "lane.start" && frame.body.cwd === undefined) {
    try { validateFileKey(frame.body.key); } catch { return reject("cwd-missing", `lane key ${frame.body.key} cannot name a directory`); }
    laneDir = laneCwd(runnerDir, frame.body.key);
    frame = { ...frame, body: { ...frame.body, cwd: laneDir } };
  }
  const body = frame.body as Record<string, unknown>;
  if ((frame.type === "job.run" || frame.type === "wait.check" || frame.type === "lane.git") && policy.jobs === "deny") return reject("jobs-denied", frame.type);
  if (frame.type === "lane.start") {
    if (!Object.hasOwn(policy.agents, body.agentProfile as string)) return reject("agent-profile", String(body.agentProfile));
    if (body.sandbox === false && policy.sandbox === "required") return reject("sandbox-required", "sandbox:false");
    const grants = (body.grants as readonly string[] | undefined) ?? [];
    for (const name of grants) if (!policy.grants || !Object.hasOwn(policy.grants, name)) return reject("grant-unknown", name);
    // A grant widens what the wrapper binds; an unsandboxed lane has no wrapper to narrow it to those paths.
    if (grants.length && body.sandbox !== true) return reject("grant-unsandboxed", grants.join(","));
  }
  const paths = [body.cwd, frame.type === "lane.git" ? body.root : undefined].filter((p): p is string => typeof p === "string");
  for (const path of paths) {
    const refused = checkRootedPath(policy, path, realpath, path === laneDir);
    if (refused) return reject(refused.rule, refused.detail);
  }
  // A lane.git path is under the allowed roots too; worktree-add's does not exist yet.
  if (frame.type === "lane.git" && typeof body.path === "string") {
    const refused = checkRootedPath(policy, body.path, realpath, body.op === "worktree-add");
    if (refused) return reject(refused.rule, refused.detail);
  }
  return { ok: true, command: frame };
}

export type QueryCheckResult = { readonly ok: true; readonly query: AnySupervisorControl } | { readonly ok: false; readonly rule: string; readonly detail: string };

/**
 * Checks a parsed `q.*` query frame: the protocol schema, and under `jobs: "deny"` a `q.lane.inspect` with a `done`
 * section (its Done signal commands would run on the host) is refused `jobs-denied`. Queries are read-only otherwise,
 * so no path is checked against `allowedRoots`.
 */
export function checkQuery(policy: RunnerPolicy, query: unknown): QueryCheckResult {
  const reject = (rule: string, detail: string): QueryCheckResult => ({ ok: false, rule, detail });
  let frame: AnySupervisorControl;
  try {
    const checked = validateFrame(query, "supervisor");
    if (!isQueryType(checked.type)) return reject("not-a-command", checked.type);
    frame = checked as AnySupervisorControl;
  } catch (error) {
    if (error instanceof ProtocolError) return reject(error.rule, error.detail);
    throw error;
  }
  if (frame.type === "q.lane.inspect" && frame.body.done !== undefined && policy.jobs === "deny") return reject("jobs-denied", "q.lane.inspect done");
  return { ok: true, query: frame };
}

/** `RUNNER_CMD_REJECTED <rule>` for a failed check, else undefined. */
export const rejection = (result: CheckResult): string | undefined => (result.ok ? undefined : rejectionText(result.rule));
