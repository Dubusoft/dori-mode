// Runner-side command validation: what the runner agrees to execute even for an authenticated supervisor.
// Pure apart from the optional config read in `loadPolicy`; path resolution is injected into `checkCommand`.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  isQueryType, ProtocolError, SUPERVISOR_COMMAND_TYPES, validateFrame, type AnySupervisorCommand, type AnySupervisorControl,
} from "./protocol.ts";

export const POLICY_FILE = "runner-config.json";

export type RunnerPolicy = {
  /** Profile name -> argv template. Only these profiles may be started. */
  readonly agents: Readonly<Record<string, readonly string[]>>;
  /** Directories under which every command cwd must resolve. */
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
};

const GUARD_KEYS = ["loadAlert", "loadOk", "memFreeMinPct", "memFreeCritPct", "swapFreeCritPct", "diskFreeMinGb", "panesMax"] as const;
type GuardKey = (typeof GUARD_KEYS)[number];

export const DEFAULT_POLICY: RunnerPolicy = { agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow" };

/** Rules beyond the protocol schema rules (which pass through under their own names, e.g. `unknown-field`). */
export type PolicyRule =
  | "not-a-command" | "agent-profile" | "cwd-outside-roots" | "cwd-missing" | "sandbox-required" | "sandbox-unavailable" | "command-not-argv" | "jobs-denied";

export type CheckResult = { readonly ok: true; readonly command: AnySupervisorCommand } | { readonly ok: false; readonly rule: string; readonly detail: string };

/** The `detail` a rejected command reports in its `cmd.result`. */
export const rejectionText = (rule: string): string => `RUNNER_CMD_REJECTED ${rule}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a policy from parsed JSON; unknown keys or wrong types throw. */
export function parsePolicy(value: unknown): RunnerPolicy {
  if (!isRecord(value)) throw new Error("runner-config must be a JSON object");
  const known = new Set(["agents", "allowedRoots", "sandbox", "jobs", "guard", "heavyKill", "sandboxCheck"]);
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
  if (value.sandbox !== undefined && value.sandbox !== "required" && value.sandbox !== "optional") throw new Error("runner-config: sandbox must be required|optional");
  if (value.jobs !== undefined && value.jobs !== "allow" && value.jobs !== "deny") throw new Error("runner-config: jobs must be allow|deny");
  if (value.heavyKill !== undefined && !strings(value.heavyKill)) throw new Error("runner-config: heavyKill must be a string array");
  if (value.sandboxCheck !== undefined && (!strings(value.sandboxCheck) || value.sandboxCheck.length === 0 || value.sandboxCheck[0] === "")) {
    throw new Error("runner-config: sandboxCheck must be a non-empty string array");
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
    agents,
    allowedRoots: (value.allowedRoots as string[] | undefined) ?? DEFAULT_POLICY.allowedRoots,
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

/** `cwd-missing` / `cwd-outside-roots` for `path` (absolute, resolving, under an allowed root), else undefined. */
const checkRootedPath = (policy: RunnerPolicy, path: string, realpath: (path: string) => string, missingOk = false): { readonly rule: string; readonly detail: string } | undefined => {
  if (!isAbsolute(path)) return { rule: "cwd-missing", detail: `${path} is not absolute` };
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
  const roots: string[] = [];
  for (const root of policy.allowedRoots) {
    try { roots.push(realpath(root)); } catch { /* a root that does not exist admits nothing */ }
  }
  if (!roots.some((root) => underRoot(root, resolved))) return { rule: "cwd-outside-roots", detail: resolved };
  return undefined;
};

/**
 * The same root check for a directory the runner learns only on its host, such as an adopted or target pane's
 * `foreground_cwd`/`cwd`: `cwd-missing` / `cwd-outside-roots` (symlinks resolved, path segments compared), else undefined.
 */
export const checkCwd = (policy: RunnerPolicy, path: string, realpath: (path: string) => string): { readonly rule: string; readonly detail: string } | undefined =>
  checkRootedPath(policy, path, realpath);

/**
 * Checks a parsed supervisor command frame against the policy. `realpath` resolves symlinks and throws when the
 * path does not exist (as `fs.realpathSync` does). Every `cwd` (`lane.start`, `lane.adopt`, `job.run`,
 * `wait.check`) and `lane.git.root` must be absolute, resolve and lie under `allowedRoots`.
 */
export function checkCommand(policy: RunnerPolicy, command: unknown, realpath: (path: string) => string): CheckResult {
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
