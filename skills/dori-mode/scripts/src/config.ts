import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { type AutopilotConfig, DEFAULT_AUTOPILOT, parseAutopilotConfig } from "./autopilot.ts";
import { DEFAULT_DISPLAY_TIME_ZONE, validTimeZone } from "./display-time.ts";
import { legacyPaneKeys, managedPanesPath, resolveManagedPanes } from "./managed-panes.ts";
import { CONFIG_SCHEMA_KEY } from "./config-schema.ts";
import { redactSecrets } from "./redact.ts";
import { SECRET_NAME } from "./secret-name.ts";
import { type StoreKind, storeOnDisk } from "./store.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  /** Critical stage: memory free below this percent. */
  readonly memFreeCritPct: number;
  /** Critical stage: swap free below this percent of swap total (only when swap exists). */
  readonly swapFreeCritPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

/** `dori memory check` and the supervisor's daily memory sweep. Read-only: the memory repo is never written. */
export type MemoryCheckConfig = {
  /** The lead's omo memory repo (holds system/human.md); blank finds omo's repo for `leadCwd` under ~/.omo/memory/agents. */
  readonly repo: string;
  /** human.md above this many KB (1024 bytes) needs condensing. */
  readonly maxKb: number;
};

/**
 * How events reach the lead (supervise-push.ts): the supervisor types a short `[dori]` pointer into the lead pane and
 * counts events as delivered only once the lead takes them (`dori inbox take`). There is no mode switch.
 */

export type PushConfig = {
  /** Untaken this long after a push: push again. */
  readonly ackSec: number;
  /** Pushes after the first before LEAD_PUSH_UNTAKEN; later pushes back off, doubling up to 10 min. */
  readonly retries: number;
  /** Idle lead: minutes untaken before a cold restart. Working lead: the one-tool-call restart clock. */
  readonly escalateMin: number;
  /** Longest pointer line typed into the lead pane. */
  readonly maxChars: number;
  /** After a push that did not visibly start a turn, the input line is checked again this many ms later. */
  readonly pasteCheckMs: number;
  /**
   * Push into a working lead too (its pointer is queued into the running turn): only once its due events waited ackSec,
   * and only into an empty input box. On by default, so owner messages do not wait for the turn to end.
   */
  readonly toWorking: boolean;
  /** Default for `dori inbox take --max-bytes`. */
  readonly takeMaxBytes: number;
};

export type DeliveryConfig = {
  /** The startup prompt also arms the tail monitor; while on, only an unacked owner message escalates an idle lead. */
  readonly tailMonitor: boolean;
  /** Forced restarts per rolling hour; past it, the push ladder refuses unread-driven restarts. */
  readonly restartMaxPerHour: number;
  readonly push: PushConfig;
};

/** The supervisor's delivery tick: the push step runs at most once per tick. */
export const DELIVERY_TICK_SEC = 5;

/** Why `delivery` cannot run, or undefined when it can. */
export const deliveryConfigError = (delivery: DeliveryConfig): string | undefined => {
  const { push } = delivery;
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (typeof delivery.tailMonitor !== "boolean") return "delivery.tailMonitor must be true or false";
  if (!Number.isInteger(delivery.restartMaxPerHour) || delivery.restartMaxPerHour < 1) return "delivery.restartMaxPerHour must be an integer of at least 1";
  if (!Number.isFinite(push.ackSec) || push.ackSec < 2 * DELIVERY_TICK_SEC) return `delivery.push.ackSec must be at least ${2 * DELIVERY_TICK_SEC} (twice the delivery tick)`;
  if (!Number.isInteger(push.retries) || push.retries < 0) return "delivery.push.retries must be a non-negative integer";
  if (!positive(push.escalateMin)) return "delivery.push.escalateMin must be positive";
  if (push.escalateMin * 60 <= push.ackSec * (push.retries + 1)) {
    return "delivery.push.escalateMin * 60 must exceed ackSec * (retries + 1), so every re-push happens before an escalation";
  }
  if (!Number.isInteger(push.maxChars) || push.maxChars < MIN_POINTER_CHARS || push.maxChars > MAX_POINTER_CHARS) {
    return `delivery.push.maxChars must be an integer from ${MIN_POINTER_CHARS} to ${MAX_POINTER_CHARS}`;
  }
  if (!Number.isFinite(push.pasteCheckMs) || push.pasteCheckMs < 0) return "delivery.push.pasteCheckMs must be zero or positive";
  if (typeof push.toWorking !== "boolean") return "delivery.push.toWorking must be true or false";
  if (!Number.isInteger(push.takeMaxBytes) || push.takeMaxBytes < 1) return "delivery.push.takeMaxBytes must be a positive integer";
  return undefined;
};

/** Lane drift signals (drift.ts): urgent LANE_DRIFT for a working lane that misses milestones or keeps failing CI. */
export type DriftConfig = {
  /** Off: no LANE_DRIFT line is raised. */
  readonly enabled: boolean;
  /** Minutes a working lane may go without a milestone report (since its last one, or its open) before milestone-overdue. */
  readonly milestoneOverdueMin: number;
  /** Failing head SHAs in a row (no green between) of a lane PR before ci-failing. */
  readonly ciFailStreak: number;
};

export const DEFAULT_DRIFT: DriftConfig = { enabled: true, milestoneOverdueMin: 90, ciFailStreak: 3 };

/** The shortest pointer (kinds cut to `+N more`) fits in MIN_POINTER_CHARS; omo kept 800 typed chars in one input. */
export const MIN_POINTER_CHARS = 140;
export const MAX_POINTER_CHARS = 800;

/** Where `dori launch` starts a lane (placement.ts): "local" is this host, anything else a machine label. */
export type PlacementConfig = {
  /** Machine for workspace-less launches: "local" (default) or a machine label. */
  readonly defaultMachine: string;
  /** Machines tried in order when the target machine is HOLD; only for workspace-less launches without an explicit --machine. Empty (default): wait in the HOLD queue. */
  readonly fallback: readonly string[];
};

export type DiscordConfig = {
  readonly applicationId: string;
  readonly guildId: string;
  readonly ownerId: string;
};

export type DoriConfig = {
  readonly discord?: DiscordConfig;
  readonly stateDir: string;
  /** The herdr workspace new local lane tabs open in, from dori state (managed-panes.ts); never read from the config file after migration. */
  readonly laneWorkspace: string;
  readonly ignorePanes: readonly string[];
  /** The lead's herdr pane, from dori state (managed-panes.ts) or DORI_LEAD_PANE; the supervisor creates and records it. */
  readonly leadPane: string;
  /** The lead session's working directory (config key `leadCwd`, formerly `defaultCwd`); local lanes started without --cwd start here too. */
  readonly leadCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  /** Model for the lead only; absent or blank means `defaultModel`. */
  readonly leadModel?: LeadModelEntry;
  /** `--thinking` level for the lead session only; absent or blank keeps whatever `agentCommand` carries. */
  readonly leadThinking?: string;
  /** Extra argv for the lead session only (after the executable), e.g. ["--approve"]. */
  readonly leadArgs: ArgvTemplate;
  readonly discordChannels: readonly string[];
  /**
   * The Discord channel for the supervisor's system notices (alertsChannelOf). Absent: those go to `discordChannels[0]`.
   * Read where it is used, so a config reload applies it live.
   */
  readonly alertsChannel?: string;
  /**
   * The Discord channel where each owner decision (owner-decisions.ts) opens one thread. Absent: a decision goes to the
   * channel it was asked from, else `discordChannels[0]`. Watched like a configured channel; read where it is used.
   */
  readonly decisionsChannel?: string;
  /** Owner-only Discord button hooks: name ([a-z0-9-]{1,20}) -> argv run on a `dori:hook:<name>:...` click. */
  readonly buttonHooks?: Readonly<Record<string, ArgvTemplate>>;
  /** GitHub logins whose new or reopened issues wake the lead as GH_ISSUE; anyone else is digest only. */
  readonly githubIssueAuthors: readonly string[];
  /**
   * Only worktrees under this directory are removed by the closed-lane cleanup sweep. Empty (the default): the local
   * runner's reported root (runner-config `worktreeRoot`, else `<reposRoot>/worktrees`) is used, and without one the
   * sweep is off.
   */
  readonly worktreeRoot: string;
  /** Free-text language the owner reads (e.g. "Korean"). Unset or blank: lanes get no language instruction. */
  readonly ownerLanguage?: string;
  /** IANA time zone owner-facing system messages show times in, labelled with its abbreviation (display-time.ts). */
  readonly displayTimeZone: string;
  /** Owner policy lines every new lane footer carries (merge policy, CI policy, ...); absent or empty adds none. */
  readonly laneRules?: readonly string[];
  /** Store secrets a lane may receive, by name; a secret with no rule (or an empty one) goes to no lane. */
  readonly secrets: Readonly<Record<string, SecretRule>>;
  /** Proxy-execution ops (`dori secret run <op>`): the supervisor host runs argv with the listed secrets in its env, outside any lane. */
  readonly secretCommands: Readonly<Record<string, SecretCommand>>;
  /**
   * Argv prefix that wraps every new local lane's agent command (e.g. ["lane-sandbox"]). Absent from the file: DEFAULT_LANE_SANDBOX.
   * The lead is never wrapped.
   */
  readonly laneSandbox?: LaneSandbox;
  /**
   * Per-runner (machine label) lead-side settings. `allowUnsandboxed: true` is the only way a lane runs without a sandbox:
   * remote lanes on that machine start unsandboxed (SANDBOX_SKIPPED, posted to the owner) instead of being refused.
   */
  readonly runners?: Readonly<Record<string, RunnerConfig>>;
  readonly heavySlots: number;
  /** Critical memory pressure kills processes whose full command line contains any of these substrings. */
  readonly heavyKill: readonly string[];
  readonly heavyMaxLoad: number;
  /** Remote guard: machine label -> ssh target, for machines herdr does not list (overrides a herdr entry of the same label). */
  readonly guardMachines: Readonly<Record<string, string>>;
  readonly guard: GuardThresholds;
  readonly memoryCheck: MemoryCheckConfig;
  readonly hooks: Hooks;
  /** Default limit in ms for every external call (herdr, git, df, ...) that sets none itself; 0 turns it off. */
  readonly runTimeoutMs: number;
  /** Minutes a working/blocked lead may leave owner messages unread before it is cold-restarted with them; 0 turns it off. */
  readonly leadStuckRestartMin: number;
  /**
   * Minutes an idle lead whose omo session still waits on its own children (subagents, child tasks, background cells)
   * keeps a lead-restart request or a cold/context-cap restart deferred, counted from when it began waiting. Must be positive.
   * 60 is kept: a deferred lead still gets its events in place, and push-ladder and stuck restarts never wait for it.
   */
  readonly leadChildWaitMaxMin: number;
  /** Where the supervisor journal lives: "json" (supervisor.json) or "sqlite" (supervisor.sqlite, after `dori store import`); read from `stateDir` (storeOnDisk). */
  readonly store: StoreKind;
  /** The only base branch the supervisor merges lane PRs into; `main` is refused whatever this says. */
  readonly ciMergeBase: string;
  /** Which machine a launch runs on. */
  readonly placement: PlacementConfig;
  /** Lane drift signals (LANE_DRIFT). */
  readonly drift: DriftConfig;
  /** `dori autopilot`: which owner-approved toodo tasks may run unattended, and its limits (always on; `dori autopilot pause` stops it). */
  readonly autopilot: AutopilotConfig;
};

/** Tools the lead never uses; with `leadDiet` they are excluded from its omo session (`--exclude-tools`). */
export const LEAD_DIET_EXCLUDED_TOOLS: readonly string[] = [
  "task", "task_output", "task_send", "task_cancel", "workpool", "show_html_page", "ask_user_question",
  "create_goal", "get_goal", "update_goal",
  "codegraph_callers", "codegraph_callees", "codegraph_explore", "codegraph_files", "codegraph_impact", "codegraph_node", "codegraph_search", "codegraph_status",
  "lsp_diagnostics", "lsp_find_references", "lsp_goto_definition", "lsp_prepare_rename", "lsp_rename", "lsp_symbols",
  "mcp_list_resources", "mcp_read_resource",
];

/** Lead-only launch additions for `leadDiet`: the env assignments and the omo flags. */
export const LEAD_DIET_ENV = ["SENPI_PROMPT_SURFACE=chat"] as const;
export const LEAD_DIET_ARGS = ["--no-skills", "--exclude-tools", LEAD_DIET_EXCLUDED_TOOLS.join(",")] as const;

/** One lead model: "provider/model", or an object whose `thinking` replaces `leadThinking` for this model only. */
export type LeadModelEntry = string | { readonly model: string; readonly thinking?: string };

export type LeadModel = { readonly model: string; readonly thinking?: string };

/** omo's agent session directory; not configurable (session-id.ts depends on its layout). */
export const omoSessionsDir = (home = homedir()): string => join(home, ".omo", "agent", "sessions");

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  ignorePanes: [],
  leadPane: "",
  leadCwd: join(home, ".dori", "lead"),
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic-subscription/claude-opus-5-5",
  leadArgs: [],
  discordChannels: [],
  githubIssueAuthors: [],
  secrets: {},
  secretCommands: {},
  worktreeRoot: "",
  heavySlots: 1,
  heavyKill: ["qemu-system", "emulator", "expo export"],
  heavyMaxLoad: 80,
  guardMachines: {},
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 20 },
  memoryCheck: { repo: "", maxKb: 15 },
  hooks: {},
  runTimeoutMs: 60_000,
  leadStuckRestartMin: 30,
  leadChildWaitMaxMin: 60,
  store: "json",
  ciMergeBase: "dev",
  displayTimeZone: DEFAULT_DISPLAY_TIME_ZONE,
  placement: { defaultMachine: "local", fallback: [] },
  drift: DEFAULT_DRIFT,
  autopilot: DEFAULT_AUTOPILOT,
});

/** The one-line instruction that lanes write their reports and todo items in the owner's language; "" when none is configured. */
export const languageInstruction = (ownerLanguage: string | undefined): string => {
  const language = typeof ownerLanguage === "string" ? ownerLanguage.trim() : "";
  return language ? `Write every dori report text and every todo item in ${language}; code, commands, commit messages and PR text follow the repo convention.` : "";
};

/** The config's `laneRules`, whitespace collapsed, blanks dropped; throws TypeError unless absent or an array of strings. */
const laneRules = (raw: unknown): readonly string[] => {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.some((rule) => typeof rule !== "string")) throw new TypeError("laneRules must be an array of strings");
  return (raw as string[]).map((rule) => rule.replace(/\s+/g, " ").trim()).filter(Boolean);
};

export type LaneSandbox = { readonly command: readonly string[] };

/** A GitHub App installation token minted per lane repo instead of a stored value; `keySecret` names the App private key (PEM) in the store. */
export type GithubAppMint = {
  readonly kind: "github-app";
  readonly appId: string;
  readonly installationId: string;
  readonly keySecret: string;
  readonly permissions: Readonly<Record<string, "read" | "write">>;
};

/** Which lanes (exact key or `prefix-*`) and repos match a rule; both lists empty match nothing. */
export type SecretLaneMatch = { readonly lanes: readonly string[]; readonly repos: readonly string[] };

/**
 * Which lanes (exact key or `prefix-*`) and repos may receive one store secret; both lists empty grants nothing. `as`
 * absent means env; `ssh-key` and `file` hand the lane a 0600 file path instead of the value; `mint` replaces the stored
 * value with a minted token. `put` lists the lanes that may store a value under the name (`dori secret put`): a separate
 * write-only permission that grants no read.
 */
export type SecretRule = SecretLaneMatch & {
  readonly as?: "env" | "ssh-key" | "file";
  readonly mint?: GithubAppMint;
  readonly put?: SecretLaneMatch;
};

const RULE_SHAPE = `{ "lanes": [strings], "repos": [strings], "as"?: "env" | "ssh-key" | "file", "mint"?: { "kind": "github-app", "appId", "installationId", "keySecret", "permissions" }, "put"?: { "lanes": [strings], "repos": [strings] } }`;

/** A list-of-strings field; absent is empty, anything else throws `bad(path)`. */
const stringList = (value: unknown, bad: (what: string) => TypeError, path: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw bad(path);
  return value as string[];
};

/** The config's `secrets` allowlist; throws TypeError unless absent or { <SECRET_NAME>: { lanes?, repos?, as?, mint? } } (see RULE_SHAPE). */
const secrets = (raw: unknown): Readonly<Record<string, SecretRule>> => {
  if (raw == null) return {};
  const bad = (what: string) => new TypeError(`secrets${what} must be { "<SECRET_NAME>": ${RULE_SHAPE} }; \`mint\` goes with neither a file \`as\` nor \`put\``);
  if (!isRecord(raw)) throw bad("");
  const mintOf = (value: unknown, path: string): GithubAppMint => {
    const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";
    if (!isRecord(value) || Object.keys(value).some((key) => !["kind", "appId", "installationId", "keySecret", "permissions"].includes(key))) throw bad(path);
    const { kind, appId, installationId, keySecret, permissions } = value;
    if (kind !== "github-app" || !nonEmpty(appId) || !nonEmpty(installationId) || typeof keySecret !== "string" || !SECRET_NAME.test(keySecret)) throw bad(path);
    if (!isRecord(permissions) || Object.keys(permissions).length === 0) throw bad(`${path}.permissions`);
    for (const [perm, level] of Object.entries(permissions)) if (!/^[a-z_]+$/.test(perm) || (level !== "read" && level !== "write")) throw bad(`${path}.permissions.${perm}`);
    return { kind, appId: appId as string, installationId: installationId as string, keySecret, permissions: permissions as Record<string, "read" | "write"> };
  };
  return Object.fromEntries(Object.entries(raw).map(([name, rule]) => {
    if (!SECRET_NAME.test(name) || !isRecord(rule) || Object.keys(rule).some((key) => !["lanes", "repos", "as", "mint", "put"].includes(key))) throw bad(`.${name}`);
    const { as, mint, put } = rule;
    if (as !== undefined && as !== "env" && as !== "ssh-key" && as !== "file") throw bad(`.${name}.as`);
    // A minted name has no stored value to hand over as a file or to replace.
    if (mint !== undefined && (as === "ssh-key" || as === "file" || put !== undefined)) throw bad(`.${name}.mint`);
    if (put !== undefined && (!isRecord(put) || Object.keys(put).some((key) => key !== "lanes" && key !== "repos"))) throw bad(`.${name}.put`);
    return [name, {
      lanes: stringList(rule.lanes, bad, `.${name}.lanes`),
      repos: stringList(rule.repos, bad, `.${name}.repos`),
      ...(as !== undefined ? { as } : {}),
      ...(mint !== undefined ? { mint: mintOf(mint, `.${name}.mint`) } : {}),
      ...(isRecord(put) ? { put: { lanes: stringList(put.lanes, bad, `.${name}.put.lanes`), repos: stringList(put.repos, bad, `.${name}.put.repos`) } } : {}),
    }];
  }));
};

/** Who a granted rule adds: one lane key, or every lane of one repo ("owner/repo"). */
export type SecretGrantTarget = { readonly lane: string } | { readonly repo: string };

/**
 * Adds `to` to the `secrets` rule of each of `names` in the config file at `path` (a missing rule is created with that
 * one entry; one already listed is left alone), keeping every other key as it is. The result is checked like loadConfig
 * checks `secrets` (TypeError, nothing written) and written atomically with mode 0600. Returns the names whose rule
 * changed. The supervisor and runners read config per secret request, so the next request sees it without a restart.
 */
export const grantSecretRule = (path: string, names: readonly string[], to: SecretGrantTarget): string[] => {
  const loaded: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!isRecord(loaded)) throw new TypeError(`${path} is not a JSON object`);
  const current = loaded.secrets ?? {};
  if (!isRecord(current)) throw new TypeError("secrets must be an object");
  const [field, value] = "lane" in to ? ["lanes", to.lane] as const : ["repos", to.repo] as const;
  const next: Record<string, unknown> = { ...current };
  const changed: string[] = [];
  for (const name of names) {
    const rule = isRecord(next[name]) ? next[name] as Record<string, unknown> : {};
    const list = Array.isArray(rule[field]) ? rule[field] as unknown[] : [];
    if (list.includes(value)) continue;
    next[name] = { ...rule, [field]: [...list, value] };
    changed.push(name);
  }
  if (!changed.length) return [];
  secrets(next);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...loaded, secrets: next }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return changed;
};

/** The longest `secretCommands.<op>.timeoutSec` may be; the op is killed then, so its answer comes no later. */
export const SECRET_COMMAND_MAX_TIMEOUT_SEC = 3600;

/** One proxy-execution op: argv runs on the supervisor host with `secrets` in env for lanes/repos that match (same rules as `secrets`). */
export type SecretCommand = {
  readonly argv: readonly string[];
  readonly secrets: readonly string[];
  readonly lanes: readonly string[];
  readonly repos: readonly string[];
  /** Kill after this many seconds; 1..3600, default 300. */
  readonly timeoutSec: number;
  /** Absolute working directory; absent means the host user's home. */
  readonly cwd?: string;
};

/** The config's `secretCommands`; throws TypeError unless absent or { <op>: { argv, secrets, lanes, repos, timeoutSec?, cwd? } }. */
const secretCommands = (raw: unknown): Readonly<Record<string, SecretCommand>> => {
  if (raw == null) return {};
  const bad = (what: string) => new TypeError(`secretCommands${what} must be { "<op>": { "argv": [non-empty strings], "secrets": [SECRET_NAMEs], "lanes": [strings], "repos": [strings], "timeoutSec"?: 1..3600, "cwd"?: absolute path } } with op matching ^[a-z][a-z0-9-]{0,63}$`);
  if (!isRecord(raw)) throw bad("");
  return Object.fromEntries(Object.entries(raw).map(([op, rule]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(op) || !isRecord(rule) || Object.keys(rule).some((key) => !["argv", "secrets", "lanes", "repos", "timeoutSec", "cwd"].includes(key))) throw bad(`.${op}`);
    const argv = stringList(rule.argv, bad, `.${op}.argv`);
    if (argv.length === 0 || argv.some((part) => part === "")) throw bad(`.${op}.argv`);
    const names = stringList(rule.secrets, bad, `.${op}.secrets`);
    if (names.some((name) => !SECRET_NAME.test(name))) throw bad(`.${op}.secrets`);
    const { timeoutSec, cwd } = rule;
    if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > SECRET_COMMAND_MAX_TIMEOUT_SEC)) throw bad(`.${op}.timeoutSec`);
    if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd))) throw bad(`.${op}.cwd`);
    return [op, {
      argv, secrets: names, lanes: stringList(rule.lanes, bad, `.${op}.lanes`), repos: stringList(rule.repos, bad, `.${op}.repos`),
      timeoutSec: (timeoutSec as number | undefined) ?? 300,
      ...(cwd !== undefined ? { cwd } : {}),
    }];
  }));
};

/** Lead-side settings for one runner (config `runners.<label>`). */
export type RunnerConfig = { readonly allowUnsandboxed?: boolean };

/**
 * Keys an older dori's `runners` section carried (the shadow runner's listen address, modes, restart circuit). They are
 * ignored and named in CONFIG_KEYS_IGNORED, never read as machine labels, so an old config keeps loading.
 */
export const LEGACY_RUNNER_KEYS: readonly string[] = ["listen", "mode", "restartCircuit"];

/** The `runners` keys loadConfig ignores: the legacy ones, or the whole section when it is an (old) array. */
const ignoredRunnerKeys = (raw: unknown): string[] =>
  Array.isArray(raw) ? ["runners"] : isRecord(raw) ? Object.keys(raw).filter((key) => LEGACY_RUNNER_KEYS.includes(key)).map((key) => `runners.${key}`) : [];

/**
 * The config's `runners` without its legacy keys; undefined when no machine entry is left. Throws TypeError unless absent,
 * an old array, or { <label>: { allowUnsandboxed?: boolean } }.
 */
const runners = (raw: unknown): Readonly<Record<string, RunnerConfig>> | undefined => {
  if (raw == null || Array.isArray(raw)) return undefined;
  const bad = (what: string) => new TypeError(`runners${what} must be { "<machine label>": { "allowUnsandboxed": true|false } }`);
  if (!isRecord(raw)) throw bad("");
  const entries = Object.entries(raw).filter(([label]) => !LEGACY_RUNNER_KEYS.includes(label));
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([label, entry]) => {
    if (!isRecord(entry) || (entry.allowUnsandboxed !== undefined && typeof entry.allowUnsandboxed !== "boolean")) throw bad(`.${label}`);
    return [label, entry.allowUnsandboxed === undefined ? {} : { allowUnsandboxed: entry.allowUnsandboxed }];
  }));
};

/** Used when the config has no `laneSandbox`: new local lanes run behind `lane-sandbox` on PATH, and are refused (SANDBOX_MISSING) when it is missing. */
export const DEFAULT_LANE_SANDBOX: LaneSandbox = { command: ["lane-sandbox"] };

/**
 * The config's `laneSandbox`, or DEFAULT_LANE_SANDBOX when absent; throws TypeError unless { command: non-empty string[] }.
 * The removed `default` key (the sandbox is always on) is ignored and named in CONFIG_KEYS_IGNORED, whatever its value.
 */
const laneSandbox = (raw: unknown): LaneSandbox => {
  if (raw == null) return DEFAULT_LANE_SANDBOX;
  const bad = () => new TypeError("laneSandbox must be { \"command\": [non-empty strings, at least one] }");
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const { command } = raw as Record<string, unknown>;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part.trim())) throw bad();
  return { command: command as string[] };
};

/**
 * Writes `patch` into `config` in place. The supervisor holds one config object per role and hands it to every part, so
 * a hot reload (config-watch.ts) and a recreated lead pane reach all of them through this one write.
 */
export const assignConfig = (config: DoriConfig, patch: Partial<DoriConfig>): void => {
  Object.assign(config as { -readonly [K in keyof DoriConfig]: DoriConfig[K] }, patch);
};

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? join(home, path.slice(2)) : path);

/** An object's string-valued entries; anything else is no entries. */
const stringRecord = (v: unknown): Record<string, string> =>
  typeof v !== "object" || v === null || Array.isArray(v) ? {}
    : Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));

/** The config's `buttonHooks`: entries with a valid name and a non-empty string argv; the rest dropped with one warning. */
const buttonHooks = (raw: unknown, path: string): Readonly<Record<string, ArgvTemplate>> | undefined => {
  if (raw === undefined) return undefined;
  const object = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  const entries = object ? Object.entries(raw) : [];
  const valid = entries.filter(([name, argv]) => /^[a-z0-9-]{1,20}$/.test(name) && Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === "string") && String(argv[0]).trim() !== "");
  const invalid = object ? entries.filter((entry) => !valid.includes(entry)).map(([name]) => `buttonHooks.${name}`) : ["buttonHooks"];
  if (invalid.length) {
    console.error(`CONFIG_BUTTON_HOOKS_INVALID ${invalid.join(", ")} in ${path}: buttonHooks must map names of 1-20 lowercase letters, digits or dashes to non-empty argv arrays of strings; these entries are ignored`);
  }
  return Object.fromEntries(valid) as Record<string, string[]>;
};

/** The config's `placement` (absent: the default); throws TypeError on a non-object or a malformed `fallback`. */
const placement = (raw: unknown): PlacementConfig => {
  if (raw === undefined) return { defaultMachine: "local", fallback: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("placement must be an object");
  const o = raw as Record<string, unknown>;
  const fallback = o.fallback ?? [];
  if (!Array.isArray(fallback) || fallback.some((m) => typeof m !== "string" || !m.trim())) throw new TypeError("placement.fallback must be an array of machine names");
  return {
    defaultMachine: typeof o.defaultMachine === "string" && o.defaultMachine.trim() ? o.defaultMachine.trim() : "local",
    fallback: (fallback as string[]).map((m) => m.trim()),
  };
};

/**
 * The only top-level keys read from config.json: who the owner is and where things live on this machine. Every other
 * tunable is a built-in constant (BUILT_IN in tunables.ts), so a config written by any dori version loads on any other.
 */
export const CONFIG_FILE_KEYS = [
  "discord", "stateDir", "leadCwd", "worktreeRoot", "agentCommand", "defaultModel", "leadModel", "leadThinking",
  "leadArgs", "discordChannels", "alertsChannel", "decisionsChannel", "githubIssueAuthors", "ownerLanguage", "displayTimeZone", "laneRules", "laneSandbox", "guardMachines",
  "runners", "secrets", "secretCommands", "placement", "buttonHooks", "hooks", "ciMergeBase", "ignorePanes", "autopilot",
] as const;

/** The config's `displayTimeZone`, trimmed; absent or blank is UTC. Throws TypeError unless it is a zone name `Intl` knows. */
const displayTimeZone = (raw: unknown): string => {
  if (raw == null || (typeof raw === "string" && !raw.trim())) return DEFAULT_DISPLAY_TIME_ZONE;
  if (typeof raw !== "string" || !validTimeZone(raw.trim())) throw new TypeError(`displayTimeZone must be an IANA time zone name such as Asia/Seoul or UTC, not ${JSON.stringify(raw)}`);
  return raw.trim();
};

/** The config's `alertsChannel`: a trimmed channel id, undefined when absent or blank; throws TypeError on a non-string. */
const alertsChannel = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new TypeError("alertsChannel must be a Discord channel id string");
  return raw.trim() || undefined;
};

/** The config's `decisionsChannel`: a trimmed channel id, undefined when absent or blank; throws TypeError on a non-string. */
const decisionsChannel = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new TypeError("decisionsChannel must be a Discord channel id string");
  return raw.trim() || undefined;
};

/**
 * Where the supervisor's system notices go (lead stuck or restart-capped, SUPERVISOR_STUCK, TASK_STALLED, a failed
 * unit, and what the lead posts with `dori send --to alerts`): `alertsChannel` when set, else `discordChannels[0]`.
 * Lane reports, owner replies and closed-thread redirects keep using `discordChannels[0]`.
 */
export const alertsChannelOf = (config: Pick<DoriConfig, "alertsChannel" | "discordChannels">): string | undefined =>
  config.alertsChannel?.trim() || config.discordChannels[0];

/** `hooks` entries that are read; any other (e.g. the removed threadDone) is ignored. */
export const HOOK_KEYS = ["threadReply", "transcribe"] as const;

/** `leadCwd`'s former name: still read while a file has no `leadCwd`, until `dori setup` renames it. */
export const LEGACY_LEAD_CWD_KEY = "defaultCwd";

let warnedIgnoredKeys = false;
let warnedLegacyLeadCwd = false;
let warnedLeadArray = false;
let warnedPaneKeys = false;
let warnedAutopilot = false;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const loaded = (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : {};
  const paneKeys = legacyPaneKeys(loaded);
  const kept = CONFIG_FILE_KEYS as readonly string[];
  const ignored = Object.keys(loaded).filter((key) => !kept.includes(key) && !paneKeys.includes(key) && key !== CONFIG_SCHEMA_KEY && key !== LEGACY_LEAD_CWD_KEY);
  const raw = Object.fromEntries(Object.entries(loaded).filter(([key]) => kept.includes(key))) as Record<string, unknown>;
  if (LEGACY_LEAD_CWD_KEY in loaded) {
    if (!("leadCwd" in loaded)) raw.leadCwd = loaded[LEGACY_LEAD_CWD_KEY];
    if (!warnedLegacyLeadCwd) {
      warnedLegacyLeadCwd = true;
      console.error(`CONFIG_KEY_RENAMED ${LEGACY_LEAD_CWD_KEY} -> leadCwd in ${path}: ${"leadCwd" in loaded ? "leadCwd is set, so defaultCwd is ignored" : "still read as leadCwd for now"}; run dori setup to rename it`);
    }
  }
  const rawHooks = isRecord(raw.hooks) ? raw.hooks : {};
  ignored.push(...Object.keys(rawHooks).filter((key) => !(HOOK_KEYS as readonly string[]).includes(key)).map((key) => `hooks.${key}`));
  if (isRecord(raw.laneSandbox) && "default" in raw.laneSandbox) ignored.push("laneSandbox.default");
  if (isRecord(raw.placement) && "workspaces" in raw.placement) ignored.push("placement.workspaces");
  ignored.push(...ignoredRunnerKeys(raw.runners));
  if (ignored.length && !warnedIgnoredKeys) {
    warnedIgnoredKeys = true;
    console.error(`CONFIG_KEYS_IGNORED ${ignored.join(", ")} in ${path}: these keys are no longer read from config.json; they can be deleted`);
  }
  if (Array.isArray(raw.leadModel)) {
    if (!warnedLeadArray) {
      warnedLeadArray = true;
      console.error(`CONFIG_LEAD_CHAIN_REMOVED leadModel in ${path}: only the first valid entry is used; replace the array with that entry`);
    }
    raw.leadModel = modelEntries(raw.leadModel, undefined)[0];
  }
  const hooks = Object.fromEntries(Object.entries(rawHooks).filter(([key]) => (HOOK_KEYS as readonly string[]).includes(key))) as Hooks;
  const fromFile = raw as Partial<DoriConfig>;
  const stateDir = expandHome(process.env.DORI_STATE_DIR ?? fromFile.stateDir ?? base.stateDir, home);
  const panes = resolveManagedPanes(stateDir, loaded);
  if (paneKeys.length && !warnedPaneKeys) {
    warnedPaneKeys = true;
    console.error(panes.migrated?.saved
      ? `CONFIG_PANE_KEYS_MIGRATED ${paneKeys.join(", ")} in ${path}: copied into ${managedPanesPath(stateDir)}; the supervisor manages the lead pane and lanes workspace from now on, and the keys are ignored and can be deleted`
      : `CONFIG_PANE_KEYS_IGNORED ${paneKeys.join(", ")} in ${path}: the supervisor manages the lead pane and lanes workspace in ${managedPanesPath(stateDir)}; the keys can be deleted`);
  }
  const { runners: rawRunners, ...rest } = fromFile;
  const machineRunners = runners(rawRunners);
  const { alertsChannel: rawAlerts, decisionsChannel: rawDecisions, ...fileValues } = rest;
  const alerts = alertsChannel(rawAlerts);
  const decisions = decisionsChannel(rawDecisions);
  const merged: DoriConfig = { ...base, ...fileValues, ...(machineRunners ? { runners: machineRunners } : {}), hooks: { ...base.hooks, ...hooks } };
  return {
    ...merged,
    ...(alerts ? { alertsChannel: alerts } : {}),
    ...(decisions ? { decisionsChannel: decisions } : {}),
    laneRules: laneRules(raw.laneRules),
    secrets: secrets(raw.secrets),
    secretCommands: secretCommands(raw.secretCommands),
    displayTimeZone: displayTimeZone(raw.displayTimeZone),
    laneSandbox: laneSandbox(raw.laneSandbox),
    guardMachines: stringRecord(raw.guardMachines),
    placement: placement(raw.placement),
    autopilot: parseAutopilotConfig(raw.autopilot, (line) => {
      if (warnedAutopilot) return;
      warnedAutopilot = true;
      console.error(`CONFIG_AUTOPILOT_KEYS_IGNORED ${line} in ${path}`);
    }),
    buttonHooks: buttonHooks(raw.buttonHooks, path),
    stateDir,
    store: storeOnDisk(stateDir),
    leadCwd: expandHome(merged.leadCwd, home),
    leadPane: process.env.DORI_LEAD_PANE ?? panes.leadPane,
    laneWorkspace: panes.laneWorkspace,
  };
};

/** `fill` for the thread hooks: their `text` and `title` leave the host, so secrets are masked on the way out. */
export const fillHook = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  fill(template, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, name === "text" || name === "title" ? redactSecrets(value) : value])));

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));

/**
 * The lead's single model. A string entry uses `leadThinking`; an object entry's own `thinking` wins.
 * Blank or malformed entries are skipped; nothing usable means one entry, `defaultModel`.
 */
export const leadModels = (config: DoriConfig): LeadModel[] => {
  const shared = config.leadThinking?.trim() || undefined;
  const raw: readonly unknown[] = Array.isArray(config.leadModel) ? config.leadModel : [config.leadModel];
  const chain = modelEntries(raw, shared);
  return chain.length ? chain.slice(0, 1) : [{ model: config.defaultModel, ...(shared ? { thinking: shared } : {}) }];
};

const modelEntries = (raw: readonly unknown[], shared: string | undefined): LeadModel[] =>
  raw.flatMap((entry): LeadModel[] => {
    if (typeof entry === "string") return entry.trim() ? [{ model: entry.trim(), ...(shared ? { thinking: shared } : {}) }] : [];
    if (typeof entry !== "object" || entry === null || !("model" in entry) || typeof entry.model !== "string" || !entry.model.trim()) return [];
    const own = "thinking" in entry && typeof entry.thinking === "string" ? entry.thinking.trim() : "";
    const thinking = own || shared;
    return [{ model: entry.model.trim(), ...(thinking ? { thinking } : {}) }];
  });

/** The provider part of "provider/model", or undefined for a bare model name. */
export const providerOf = (model: string): string | undefined => {
  const at = model.indexOf("/");
  return at > 0 ? model.slice(0, at) : undefined;
};

/**
 * `model` as "provider/model". A bare name takes the provider of `running` (the "provider/model" a session runs) when
 * that is the same model, else the first provider found in `fallbacks`; with no provider anywhere it stays bare.
 */
export const qualifiedModel = (model: string, running: string | undefined, fallbacks: readonly (string | undefined)[]): string => {
  if (providerOf(model)) return model;
  const provider = running ? providerOf(running) : undefined;
  if (running && provider && running.slice(provider.length + 1) === model) return running;
  const fallback = fallbacks.map((entry) => entry && providerOf(entry)).find(Boolean);
  return fallback ? `${fallback}/${model}` : model;
};

/**
 * The lead's agent argv: `agentCommand` filled with its single model. Its thinking
 * level replaces the template's `--thinking` value, or is inserted right after the `--model` pair when the template has
 * none. Lanes keep `agentCommand` and `defaultModel` untouched.
 */
export const leadCommand = (config: DoriConfig, prompt: string): string[] => {
  const lead = leadModels(config)[0] ?? { model: config.defaultModel };
  return withThinking(config.agentCommand, { model: lead.model, prompt }, lead.thinking);
};

/**
 * `template` filled with `values`; a thinking level replaces the template's `--thinking` value, or goes right after
 * the `--model` pair when the template has none. No level leaves the filled template as it is.
 */
export const withThinking = (template: ArgvTemplate, values: Readonly<Record<string, string>>, thinking: string | undefined): string[] => {
  const argv = fill(template, values);
  if (!thinking) return argv;
  // fill maps element by element, so template indices are argv indices.
  const at = template.findIndex((part) => part === "--thinking" || part.startsWith("--thinking="));
  if (at >= 0) {
    if (template[at] === "--thinking") argv.splice(at + 1, 1, thinking);
    else argv[at] = `--thinking=${thinking}`;
    return argv;
  }
  const model = template.findIndex((part) => part === "--model" || part.startsWith("--model="));
  argv.splice(model < 0 ? 1 : template[model] === "--model" ? model + 2 : model + 1, 0, "--thinking", thinking);
  return argv;
};
