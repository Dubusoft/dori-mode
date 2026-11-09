import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_EVENT_POLICY, type EventPolicy } from "./event-policy.ts";
import { DEFAULT_RESOLVE_KINDS } from "./decision-obligations.ts";
import { legacyPaneKeys, managedPanesPath, resolveManagedPanes } from "./managed-panes.ts";
import { redactSecrets } from "./redact.ts";
import type { StoreKind } from "./store.ts";
import type { ToodoEventsConfig } from "./toodo-events.ts";

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
  /** The lead's omo memory repo (holds system/human.md); blank finds omo's repo for `defaultCwd` under ~/.omo/memory/agents. */
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
  /** Workspace -> machine. Key: an absolute path prefix matched against --cwd, an owner/repo matched (case-insensitive) against the Done line's repos, or "*" for every other workspace task. Value: "local" or a machine label. */
  readonly workspaces: Readonly<Record<string, string>>;
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
  /** The workspaces the sweeps watch: the lanes workspace (empty: every workspace). Derived, not configured. */
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  /** The lead's herdr pane, from dori state (managed-panes.ts) or DORI_LEAD_PANE; the supervisor creates and records it. */
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  /** Model for the lead only; absent or blank means `defaultModel`. */
  readonly leadModel?: LeadModelEntry;
  /** `--thinking` level for the lead session only; absent or blank keeps whatever `agentCommand` carries. */
  readonly leadThinking?: string;
  /** Extra argv for the lead session only (after the executable), e.g. ["--approve"]. */
  readonly leadArgs: ArgvTemplate;
  /** Start the lead with a slimmer omo context (no skills list, LEAD_DIET_EXCLUDED_TOOLS removed, chat prompt surface). Lanes are unaffected. */
  readonly leadDiet: boolean;
  readonly cacheTtlMin: number;
  readonly leadContextCapTokens: number;
  readonly leadContextHardCapTokens: number;
  readonly discordChannels: readonly string[];
  /** Owner-only Discord button hooks: name ([a-z0-9-]{1,20}) -> argv run on a `dori:hook:<name>:...` click. */
  readonly buttonHooks?: Readonly<Record<string, ArgvTemplate>>;
  readonly discordSafetyPollSeconds: number;
  /** Messages fetched (one REST page, 1-100) the first time a Discord channel is caught up with no saved cursor. */
  readonly discordFirstSeenLimit: number;
  readonly githubPollSeconds: number;
  readonly githubTimeoutMs: number;
  /** GitHub logins whose new or reopened issues wake the lead as GH_ISSUE; anyone else is digest only. */
  readonly githubIssueAuthors: readonly string[];
  /** The toodo-server event stream the supervisor follows for task status changes and readiness (toodo-events.ts). */
  readonly toodoEvents: ToodoEventsConfig;
  /** Opening keywords of a `--mode ulw` lane (the default): clear, contained work. */
  readonly launchKeywords: string;
  /** Opening keywords of a `--mode mass-ulw` lane: wide changes or vague instructions that need investigation first. */
  readonly massLaunchKeywords: string;
  /** `--thinking` level for lanes; absent or blank keeps whatever `agentCommand` carries. The lead never reads it. */
  readonly laneThinking?: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  /**
   * Minutes an idle lane may stay silent after its freshness nudge before the lead hears urgent IDLE-ESCALATE; each
   * further one for the same silence waits twice as long. Must be positive.
   */
  readonly idleEscalateMin: number;
  readonly closeAfterMin: number;
  /**
   * Minutes after a claim's window starts that the claim keeps waiting for the supervisor's merge, when its only failing
   * Done signals are `merged` PRs it bound at their still-current head with no failed check and no conflict.
   */
  readonly mergeWaitMaxMin: number;
  /**
   * Minutes an open lane PR may stay unmergeable for a reason only a person fixes (claimed but no checks, review or
   * draft; green and clean but its lane never claimed at that head) before the lead hears urgent MERGE_STALLED once.
   */
  readonly mergeStallMin: number;
  /** Only worktrees under this directory are removed by the closed-lane cleanup sweep; empty turns the sweep off. */
  readonly worktreeRoot: string;
  /** Free-text language the owner reads (e.g. "Korean"). Unset or blank: lanes get no language instruction. */
  readonly ownerLanguage?: string;
  /** Owner policy lines every new lane footer carries (merge policy, CI policy, ...); absent or empty adds none. */
  readonly laneRules?: readonly string[];
  /**
   * Argv prefix that wraps every new local lane's agent command (e.g. ["lane-sandbox"]). Absent from the file: DEFAULT_LANE_SANDBOX.
   * The lead is never wrapped.
   */
  readonly laneSandbox?: LaneSandbox;
  /** Digest events wait for an urgent one, but never longer than this. */
  readonly digestMaxDelayMin: number;
  /** Posted once in the owner's channel or thread when the lead has not received their message within a minute. */
  readonly ownerDelayNotice: string;
  /** Seconds the lead has to ack (`dori ack`) an owner message it was handed before it is reminded (push delivery re-pushes it); twice this posts `ackMissingNotice`. */
  readonly ackTimeoutSec: number;
  /** Posted once in the owner's channel or thread when the lead got their message but has not acked it after two windows. */
  readonly ackMissingNotice: string;
  /** Minutes after reading an owner message to link all tasks with dori handled; a second window notifies the owner. */
  readonly handledTimeoutMin: number;
  readonly unhandledNotice: string;
  /** Minutes after a lane claimed done or finished (LANE_DONE_CLAIMED, LANE_CLOSED, CI_MERGED) for the lead to tell the owner and run dori reported before UNREPORTED. */
  readonly reportTimeoutMin: number;
  /** Event kinds (eventPolicy syntax) that open a decision obligation, closed by dori resolved <eventId> (decision-obligations.ts). */
  readonly resolveKinds: readonly string[];
  /** Minutes after a decision event for the lead to run dori resolved <eventId> before UNRESOLVED. */
  readonly resolveTimeoutMin: number;
  readonly heavySlots: number;
  /** Critical memory pressure kills processes whose full command line contains any of these substrings. */
  readonly heavyKill: readonly string[];
  readonly heavyMaxLoad: number;
  /** Remote guard: machine label -> ssh target, for machines herdr does not list (overrides a herdr entry of the same label). */
  readonly guardMachines: Readonly<Record<string, string>>;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly memoryCheck: MemoryCheckConfig;
  readonly hooks: Hooks;
  /** Default limit in ms for every external call (herdr, git, df, ...) that sets none itself; 0 turns it off. */
  readonly runTimeoutMs: number;
  /** The path whose filesystem the disk guard checks; blank means `stateDir`. */
  readonly diskGuardPath: string;
  /** A wait without --timeout whose check errors or times out this many times in a row ends as WAIT_FAILED. */
  readonly waitMaxFailures: number;
  /** Minutes a working/blocked lead may leave owner messages unread before it is cold-restarted with them; 0 turns it off. */
  readonly leadStuckRestartMin: number;
  /**
   * Minutes an owner message may stay unacked while the lead sits inside one tool call, or idle (an Esc-paused session
   * holds its monitor events), before the lead is cold-restarted with it. Must be positive.
   */
  readonly leadUnreadRestartMin: number;
  /**
   * Minutes an idle lead whose omo session still waits on its own children (subagents, child tasks, background cells)
   * keeps a lead-restart request or a cold/context-cap restart deferred, counted from when it began waiting. Must be positive.
   * 60 is kept: a deferred lead still gets its events in place, and push-ladder and stuck restarts never wait for it.
   */
  readonly leadChildWaitMaxMin: number;
  /** Per machine, no herdr call of a sweep round starts later than this many ms after the round began. */
  readonly sweepMachineDeadlineMs: number;
  /** Where the supervisor journal lives: "json" (supervisor.json) or "sqlite" (supervisor.sqlite, after `dori store import`). */
  readonly store: StoreKind;
  /** How each event kind is delivered (event-policy.ts); a config's `kinds` are laid over the default table. */
  readonly eventPolicy: EventPolicy;
  /** Minutes a lane message may stay unconfirmed (queued or delivered without an ack) before the lead hears of it. */
  readonly ciConfirmMin: number;
  /** The only base branch the supervisor merges lane PRs into; `main` is refused whatever this says. */
  readonly ciMergeBase: string;
  /** How events reach the lead: pushed pointers with take receipts. */
  readonly delivery: DeliveryConfig;
  /** Which machine a launch runs on. */
  readonly placement: PlacementConfig;
  /** Lane drift signals (LANE_DRIFT). */
  readonly drift: DriftConfig;
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

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic-subscription/claude-opus-5-5",
  leadArgs: [],
  leadDiet: true,
  cacheTtlMin: 5,
  leadContextCapTokens: 150_000,
  leadContextHardCapTokens: 300_000,
  discordChannels: [],
  discordSafetyPollSeconds: 300,
  discordFirstSeenLimit: 100,
  githubPollSeconds: 90,
  githubTimeoutMs: 30_000,
  githubIssueAuthors: [],
  toodoEvents: { enabled: true, url: "http://127.0.0.1:47616", tokenFile: join(home, ".local", "share", "toodo-server", "web-token") },
  launchKeywords: "ulw set goal and work",
  massLaunchKeywords: "/mass-ulw set goal and work",
  laneThinking: "medium",
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  idleEscalateMin: 30,
  closeAfterMin: 5,
  mergeWaitMaxMin: 60,
  mergeStallMin: 15,
  worktreeRoot: "/data/repos/worktrees",
  digestMaxDelayMin: 60,
  ownerDelayNotice: "메시지를 받았습니다. 리드 세션이 아직 메시지를 받지 못하고 있어 대기열에 보관해 두었고, 리드가 돌아오는 대로 답변드립니다.",
  ackTimeoutSec: 60,
  ackMissingNotice: "메시지가 리드 세션에 전달됐지만 아직 읽었다는 확인이 없습니다. 리드에게 다시 알렸고, 이곳으로 답변드립니다.",
  handledTimeoutMin: 30,
  unhandledNotice: "메시지는 읽혔지만 요청하신 일 가운데 아직 작업이나 답변으로 이어지지 않은 것이 있습니다. 리드에게 처리하라고 다시 알렸습니다.",
  reportTimeoutMin: 5,
  resolveKinds: DEFAULT_RESOLVE_KINDS,
  resolveTimeoutMin: 15,
  heavySlots: 1,
  heavyKill: ["qemu-system", "emulator", "expo export"],
  heavyMaxLoad: 80,
  guardMachines: {},
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 20 },
  memoryCheck: { repo: "", maxKb: 15 },
  hooks: {},
  runTimeoutMs: 60_000,
  diskGuardPath: "",
  waitMaxFailures: 30,
  leadStuckRestartMin: 30,
  leadUnreadRestartMin: 5,
  leadChildWaitMaxMin: 60,
  sweepMachineDeadlineMs: 20_000,
  store: "json",
  eventPolicy: DEFAULT_EVENT_POLICY,
  ciConfirmMin: 20,
  ciMergeBase: "dev",
  delivery: {
    tailMonitor: true, restartMaxPerHour: 3,
    push: { ackSec: 45, retries: 2, escalateMin: 5, maxChars: 200, pasteCheckMs: 3_000, toWorking: true, takeMaxBytes: 16_384 },
  },
  placement: { defaultMachine: "local", workspaces: {}, fallback: [] },
  drift: DEFAULT_DRIFT,
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

/** Used when the config has no `laneSandbox`: new local lanes run behind `lane-sandbox` on PATH, and pass through when it is missing. */
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
  if (raw === undefined) return { defaultMachine: "local", workspaces: {}, fallback: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("placement must be an object");
  const o = raw as Record<string, unknown>;
  const fallback = o.fallback ?? [];
  if (!Array.isArray(fallback) || fallback.some((m) => typeof m !== "string" || !m.trim())) throw new TypeError("placement.fallback must be an array of machine names");
  return {
    defaultMachine: typeof o.defaultMachine === "string" && o.defaultMachine.trim() ? o.defaultMachine.trim() : "local",
    workspaces: Object.fromEntries(Object.entries(stringRecord(o.workspaces)).map(([key, machine]) => [key, machine.trim()])),
    fallback: (fallback as string[]).map((m) => m.trim()),
  };
};

/**
 * The only top-level keys read from config.json: who the owner is and where things live on this machine. Every other
 * tunable is a built-in constant (defaultConfig), so a config written by any dori version loads on any other.
 */
export const CONFIG_FILE_KEYS = [
  "discord", "stateDir", "defaultCwd", "sessionsDir", "worktreeRoot", "agentCommand", "defaultModel", "leadModel", "leadThinking",
  "laneThinking", "leadArgs", "discordChannels", "githubIssueAuthors", "ownerLanguage", "laneRules", "laneSandbox", "guardMachines",
  "placement", "buttonHooks", "hooks", "ciMergeBase", "memoryCheck", "store", "diskGuardPath", "ignorePanes", "toodoEvents",
] as const;

/** The config's `toodoEvents` laid over the default: `url` (http or https), `tokenFile` (`~` expanded) and `enabled`. */
const toodoEventsConfig = (raw: unknown, base: ToodoEventsConfig, home: string): ToodoEventsConfig => {
  if (raw === undefined) return base;
  const bad = (what: string) => new TypeError(`toodoEvents.${what}`);
  if (!isRecord(raw)) throw new TypeError("toodoEvents must be an object");
  const { url, tokenFile, enabled } = raw;
  if (url !== undefined && (typeof url !== "string" || !/^https?:\/\/\S+$/.test(url))) throw bad("url must be an http(s) URL");
  if (tokenFile !== undefined && (typeof tokenFile !== "string" || !tokenFile.trim())) throw bad("tokenFile must be a path");
  if (enabled !== undefined && typeof enabled !== "boolean") throw bad("enabled must be true or false");
  return {
    url: url ?? base.url,
    tokenFile: typeof tokenFile === "string" ? expandHome(tokenFile.trim(), home) : base.tokenFile,
    enabled: enabled ?? base.enabled,
  };
};

/** `hooks` entries that are read; any other (e.g. the removed threadDone) is ignored. */
const HOOK_KEYS = ["threadReply", "transcribe"] as const;

let warnedIgnoredKeys = false;
let warnedLeadArray = false;
let warnedPaneKeys = false;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const loaded = (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : {};
  const paneKeys = legacyPaneKeys(loaded);
  const kept = CONFIG_FILE_KEYS as readonly string[];
  const ignored = Object.keys(loaded).filter((key) => !kept.includes(key) && !paneKeys.includes(key));
  const raw = Object.fromEntries(Object.entries(loaded).filter(([key]) => kept.includes(key))) as Record<string, unknown>;
  const rawHooks = isRecord(raw.hooks) ? raw.hooks : {};
  ignored.push(...Object.keys(rawHooks).filter((key) => !(HOOK_KEYS as readonly string[]).includes(key)).map((key) => `hooks.${key}`));
  const rawMemory = isRecord(raw.memoryCheck) ? raw.memoryCheck : {};
  ignored.push(...Object.keys(rawMemory).filter((key) => key !== "repo").map((key) => `memoryCheck.${key}`));
  if (isRecord(raw.laneSandbox) && "default" in raw.laneSandbox) ignored.push("laneSandbox.default");
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
  const memoryRepo = typeof rawMemory.repo === "string" ? rawMemory.repo : base.memoryCheck.repo;
  const fromFile = raw as Partial<DoriConfig>;
  const stateDir = expandHome(process.env.DORI_STATE_DIR ?? fromFile.stateDir ?? base.stateDir, home);
  const panes = resolveManagedPanes(stateDir, loaded);
  if (paneKeys.length && !warnedPaneKeys) {
    warnedPaneKeys = true;
    console.error(panes.migrated?.saved
      ? `CONFIG_PANE_KEYS_MIGRATED ${paneKeys.join(", ")} in ${path}: copied into ${managedPanesPath(stateDir)}; the supervisor manages the lead pane and lanes workspace from now on, and the keys are ignored and can be deleted`
      : `CONFIG_PANE_KEYS_IGNORED ${paneKeys.join(", ")} in ${path}: the supervisor manages the lead pane and lanes workspace in ${managedPanesPath(stateDir)}; the keys can be deleted`);
  }
  const merged: DoriConfig = { ...base, ...fromFile, hooks: { ...base.hooks, ...hooks } };
  return {
    ...merged,
    laneRules: laneRules(raw.laneRules),
    laneSandbox: laneSandbox(raw.laneSandbox),
    guardMachines: stringRecord(raw.guardMachines),
    placement: placement(raw.placement),
    toodoEvents: toodoEventsConfig(raw.toodoEvents, base.toodoEvents, home),
    buttonHooks: buttonHooks(raw.buttonHooks, path),
    memoryCheck: { ...base.memoryCheck, repo: expandHome(memoryRepo, home) },
    stateDir,
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env.DORI_LEAD_PANE ?? panes.leadPane,
    laneWorkspace: panes.laneWorkspace,
    workspaces: panes.laneWorkspace ? [panes.laneWorkspace] : [],
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
