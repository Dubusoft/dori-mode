// Runner-side command validation: what the runner agrees to execute even for an authenticated supervisor.
// Pure apart from the optional config read in `loadPolicy`; path resolution is injected into `checkCommand`.

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  isQueryType, ProtocolError, SUPERVISOR_COMMAND_TYPES, validateFrame, type AnySupervisorCommand, type AnySupervisorControl,
} from "./protocol.ts";

export const POLICY_FILE = "runner-config.json";

export type RunnerPolicy = {
  /** Profile name -> argv template. Only these profiles may be started. */
  readonly agents: Readonly<Record<string, readonly string[]>>;
  /**
   * Directories under which every command cwd must resolve; parsePolicy appends `reposRoot` and the effective worktree
   * root, and derives the rest when the file lists none (derivedRoots).
   */
  readonly allowedRoots: readonly string[];
  /** Where a `lane.start` without `cwd` starts (absolute, a leading `~` already expanded); absent: the runner's home. */
  readonly defaultCwd?: string;
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
};

/** `worktreeRoot`, else `<reposRoot>/worktrees` when `reposRoot` is set, else undefined. */
export const effectiveWorktreeRoot = (policy: Pick<RunnerPolicy, "reposRoot" | "worktreeRoot">): string | undefined =>
  policy.worktreeRoot ?? (policy.reposRoot !== undefined ? join(policy.reposRoot, "worktrees") : undefined);

/** owner/repo as GitHub spells it. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The top-level keys runner-config.json may hold; parsePolicy throws on any other. */
export const RUNNER_POLICY_KEYS = [
  "agents", "allowedRoots", "defaultCwd", "sandbox", "jobs", "guard", "heavyKill", "sandboxCheck", "workspaces", "detectWorkspaces", "reposRoot", "worktreeRoot",
] as const;

export const GUARD_KEYS = ["loadAlert", "loadOk", "memFreeMinPct", "memFreeCritPct", "swapFreeCritPct", "diskFreeMinGb", "panesMax"] as const;
type GuardKey = (typeof GUARD_KEYS)[number];

export const DEFAULT_POLICY: RunnerPolicy = { agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow" };

/** Rules beyond the protocol schema rules (which pass through under their own names, e.g. `unknown-field`). */
export type PolicyRule =
  | "not-a-command" | "agent-profile" | "cwd-outside-roots" | "cwd-missing" | "sandbox-required" | "sandbox-unavailable" | "command-not-argv" | "jobs-denied";

export type CheckResult = { readonly ok: true; readonly command: AnySupervisorCommand } | { readonly ok: false; readonly rule: string; readonly detail: string };

/** The `detail` a rejected command reports in its `cmd.result`. */
export const rejectionText = (rule: string): string => `RUNNER_CMD_REJECTED ${rule}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `~` or `~/...` under `home`; any other path unchanged. */
const expandHome = (path: string, home: string): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

/**
 * The allowed roots of a runner-config.json without `allowedRoots` (or with `[]`), before `reposRoot` and the effective
 * worktree root are appended: the runner's temp directory, `defaultCwd` when set (so a `lane.start` without `cwd` can
 * start there), and the runner's home only when the file names neither `reposRoot` nor `worktreeRoot`, which leaves
 * the host no other place to work. Home is left out otherwise because it would widen the boundary to every file the
 * runner's user owns.
 */
const derivedRoots = (o: { readonly tmp: string; readonly home: string; readonly defaultCwd?: string; readonly hasRepoRoots: boolean }): string[] =>
  [...new Set([o.tmp, o.defaultCwd, o.hasRepoRoots ? undefined : o.home].filter((r): r is string => r !== undefined && r !== ""))];

/**
 * Reads a policy from parsed JSON (`home` expands a leading `~`; `home` and `tmp` feed derivedRoots); unknown keys or
 * wrong types throw.
 */
export function parsePolicy(value: unknown, home: string = homedir(), tmp: string = tmpdir()): RunnerPolicy {
  if (!isRecord(value)) throw new Error("runner-config must be a JSON object");
  const known = new Set<string>(RUNNER_POLICY_KEYS);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`runner-config: unknown key ${key}`);
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
  const defaultCwd = typeof value.defaultCwd === "string" ? expandHome(value.defaultCwd, home) : undefined;
  if (value.defaultCwd !== undefined && (defaultCwd === undefined || !isAbsolute(defaultCwd))) {
    throw new Error("runner-config: defaultCwd must be an absolute path or start with ~/");
  }
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
      const full = typeof path === "string" ? expandHome(path, home) : undefined;
      if (full === undefined || !isAbsolute(full)) throw new Error(`runner-config: workspaces.${repo} must be an absolute path or start with ~/`);
      workspaces[repo] = full;
    }
  }
  if (value.detectWorkspaces !== undefined && typeof value.detectWorkspaces !== "boolean") throw new Error("runner-config: detectWorkspaces must be true|false");
  const rootPath = (key: "reposRoot" | "worktreeRoot"): string | undefined => {
    const raw = value[key];
    if (raw === undefined) return undefined;
    const full = typeof raw === "string" ? expandHome(raw, home) : undefined;
    if (full === undefined || !isAbsolute(full)) throw new Error(`runner-config: ${key} must be an absolute path or start with ~/`);
    return full;
  };
  const reposRoot = rootPath("reposRoot");
  const worktreeRoot = rootPath("worktreeRoot");
  // Explicit roots stay as written (none listed: derivedRoots); reposRoot and the effective worktree root are appended
  // unless one already names the same directory.
  const explicit = (value.allowedRoots as string[] | undefined) ?? [];
  const base = explicit.length
    ? explicit
    : derivedRoots({ tmp, home, ...(defaultCwd !== undefined ? { defaultCwd } : {}), hasRepoRoots: reposRoot !== undefined || worktreeRoot !== undefined });
  const allowedRoots = [...base];
  for (const root of [reposRoot, effectiveWorktreeRoot({ reposRoot, worktreeRoot })]) {
    if (root !== undefined && !allowedRoots.some((r) => resolvePath(r) === resolvePath(root))) allowedRoots.push(root);
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
    ...(defaultCwd !== undefined ? { defaultCwd } : {}),
    ...(workspaces ? { workspaces } : {}),
    ...(value.detectWorkspaces !== undefined ? { detectWorkspaces: value.detectWorkspaces as boolean } : {}),
    ...(reposRoot !== undefined ? { reposRoot } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    agents,
    allowedRoots,
    sandbox: (value.sandbox as RunnerPolicy["sandbox"] | undefined) ?? DEFAULT_POLICY.sandbox,
    jobs: (value.jobs as RunnerPolicy["jobs"] | undefined) ?? DEFAULT_POLICY.jobs,
  };
}

/** Loads `<runnerDir>/runner-config.json`; an absent file yields the defaults (no agents, no roots). */
export function loadPolicy(runnerDir: string): RunnerPolicy {
  let text: string;
  try {
    text = readFileSync(join(runnerDir, POLICY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw error;
  }
  return parsePolicy(JSON.parse(text));
}

const underRoot = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
 * `cwd` gets `policy.defaultCwd`, else `home`, before that check; the returned command carries the filled `cwd`.
 */
export function checkCommand(policy: RunnerPolicy, command: unknown, realpath: (path: string) => string, home: string = homedir()): CheckResult {
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

  if (frame.type === "lane.start" && frame.body.cwd === undefined) frame = { ...frame, body: { ...frame.body, cwd: policy.defaultCwd ?? home } };
  const body = frame.body as Record<string, unknown>;
  if ((frame.type === "job.run" || frame.type === "wait.check" || frame.type === "lane.git") && policy.jobs === "deny") return reject("jobs-denied", frame.type);
  if (frame.type === "lane.start") {
    if (!Object.hasOwn(policy.agents, body.agentProfile as string)) return reject("agent-profile", String(body.agentProfile));
    if (body.sandbox === false && policy.sandbox === "required") return reject("sandbox-required", "sandbox:false");
  }
  const paths = [body.cwd, frame.type === "lane.git" ? body.root : undefined].filter((p): p is string => typeof p === "string");
  for (const path of paths) {
    const refused = checkRootedPath(policy, path, realpath);
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
