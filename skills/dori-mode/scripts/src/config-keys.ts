// The keys `dori setup` and `dori runner setup` manage: what each config file reads, pruning what it no longer reads,
// parsing `--set key=value` arguments, and asking keys interactively. Pure apart from the seen-keys file helpers.

import { readFileSync } from "node:fs";

import { CONFIG_FILE_KEYS, DEFAULT_LANE_SANDBOX, defaultConfig, HOOK_KEYS, LEGACY_RUNNER_KEYS } from "./config.ts";
import { DEFAULT_POLICY, effectiveWorktreeRoot, GUARD_KEYS, RUNNER_POLICY_KEYS } from "./runner/policy.ts";
import { writeFileAtomic } from "./setup.ts";

export type Json = Record<string, unknown>;
export type KeyKind = "string" | "list" | "json" | "enum" | "bool";
export type KeySpec = { readonly key: string; readonly required: boolean; readonly kind: KeyKind; readonly values?: readonly string[]; readonly describe: string };

const spec = (key: string, kind: KeyKind, describe: string, extra: { readonly required?: boolean; readonly values?: readonly string[] } = {}): KeySpec =>
  ({ key, required: extra.required ?? false, kind, describe, ...(extra.values ? { values: extra.values } : {}) });

/** One entry per CONFIG_FILE_KEYS member, same order. */
export const DORI_CONFIG_KEYS: readonly KeySpec[] = [
  spec("discord", "json", "Discord applicationId, guildId and ownerId", { required: true }),
  spec("stateDir", "string", "Where dori keeps its state", { required: true }),
  spec("leadCwd", "string", "Working directory of the lead session; local lanes started without --cwd start here too", { required: true }),
  spec("worktreeRoot", "string", "Only worktrees under this directory are removed by the closed-lane cleanup; empty uses the local runner's reported root, and with none the cleanup is off"),
  spec("agentCommand", "list", "Argv template that starts an agent session"),
  spec("defaultModel", "string", "Model lanes (and the lead, unless leadModel is set) run on", { required: true }),
  spec("leadModel", "string", "Model for the lead only; blank means defaultModel"),
  spec("leadThinking", "string", "--thinking level for the lead session only"),
  spec("leadArgs", "list", "Extra argv for the lead session only"),
  spec("discordChannels", "list", "Discord channel ids dori listens and reports in", { required: true }),
  spec("alertsChannel", "string", "Discord channel for system notices; blank means the first discordChannels entry"),
  spec("decisionsChannel", "string", "Discord channel where owner decisions open one thread each; blank posts them in the requesting channel"),
  spec("githubIssueAuthors", "list", "GitHub logins whose new or reopened issues wake the lead"),
  spec("ownerLanguage", "string", "Language the owner reads (e.g. Korean)"),
  spec("displayTimeZone", "string", "IANA time zone owner-facing system messages show times in (e.g. Asia/Seoul, shown as KST)"),
  spec("laneRules", "list", "Owner policy lines every new lane footer carries"),
  spec("laneSandbox", "json", "Argv prefix that wraps every new local lane's agent command"),
  spec("guardMachines", "json", "Remote guard: machine label -> ssh target"),
  spec("runners", "json", "Per-runner (machine label) lead-side settings"),
  spec("secrets", "json", "Store secrets each lane or repo may receive (names only, deny by default)"),
  spec("secretCommands", "json", "Proxy-execution ops for dori secret run: name -> argv, secrets, lanes, repos"),
  spec("placement", "json", "Which machine a launch runs on"),
  spec("buttonHooks", "json", "Owner-only Discord button hooks: name -> argv"),
  spec("hooks", "json", "Hook commands (threadReply, transcribe)"),
  spec("ciMergeBase", "string", "The only base branch the supervisor merges lane PRs into"),
  spec("ignorePanes", "list", "herdr panes the sweeps ignore"),
  spec("autopilot", "json", "Autopilot (always on; dori autopilot pause stops it): tickSec, quota threshold, merge base, executor (default false)"),
];

/** Runner-config keys `dori runner setup` never asks; `--set`/`--unset` still take them. */
export const RUNNER_UNASKED_KEYS: readonly string[] = ["detectWorkspaces", "grants"];

/** One entry per RUNNER_POLICY_KEYS member, same order. */
export const RUNNER_CONFIG_KEYS: readonly KeySpec[] = [
  spec("agents", "json", "Profile name -> argv template; only these profiles may be started", { required: true }),
  spec("allowedRoots", "list", "Directories under which every command cwd must resolve; absent: temp dir, and home only without reposRoot/worktreeRoot"),
  spec("sandbox", "enum", "Whether every lane must run sandboxed", { values: ["required", "optional"] }),
  spec("jobs", "enum", "deny refuses job.run, wait.check, lane.git and done inspections", { values: ["allow", "deny"] }),
  spec("guard", "json", "Guard thresholds for this host"),
  spec("heavyKill", "list", "Command-line patterns killed under critical memory pressure"),
  spec("sandboxCheck", "list", "Argv run before every sandboxed lane.start; non-zero refuses it"),
  spec("workspaces", "json", "The repos this host owns for placement: owner/repo -> checkout"),
  spec("detectWorkspaces", "bool", "Scan allowedRoots for git checkouts (set with --set; setup does not ask it)"),
  spec("reposRoot", "string", "Every checkout directly under it is a declared repo"),
  spec("worktreeRoot", "string", "Where this host's lane worktrees live; absent: <reposRoot>/worktrees"),
  spec("grants", "json", "Named path grants a lane may get with dori launch --grant: name -> {write: [dirs], read: [dirs]}; the owner edits it (set with --set; setup does not ask it)"),
];

export class ConfigKeyError extends Error {}

export type Pruned = { readonly next: Json; readonly removed: readonly string[] };

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` without the subkeys outside `kept` (each pushed to `removed` as `<key>.<sub>`). */
const pruneSub = (key: string, value: Json, keep: (sub: string) => boolean, removed: string[]): Json => {
  const out: Json = {};
  for (const [sub, v] of Object.entries(value)) {
    if (keep(sub)) out[sub] = v;
    else removed.push(`${key}.${sub}`);
  }
  return out;
};

/** config.json without the keys loadConfig no longer reads. Legacy pane keys are dropped too: migrate them first. */
export const pruneDoriConfig = (raw: Json): Pruned => {
  const kept = CONFIG_FILE_KEYS as readonly string[];
  const hooks = HOOK_KEYS as readonly string[];
  const next: Json = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!kept.includes(key)) removed.push(key);
    else if (key === "hooks" && isRecord(value)) next[key] = pruneSub(key, value, (sub) => hooks.includes(sub), removed);
    else if (key === "laneSandbox" && isRecord(value)) next[key] = pruneSub(key, value, (sub) => sub !== "default", removed);
    else if (key === "placement" && isRecord(value)) next[key] = pruneSub(key, value, (sub) => sub !== "workspaces", removed);
    else if (key === "runners" && Array.isArray(value)) removed.push(key);
    else if (key === "runners" && isRecord(value)) next[key] = pruneSub(key, value, (sub) => !LEGACY_RUNNER_KEYS.includes(sub), removed);
    else next[key] = value;
  }
  return { next, removed };
};

/** runner-config.json without the keys parsePolicy would refuse as unknown. */
export const pruneRunnerConfig = (raw: Json): Pruned => {
  const kept = RUNNER_POLICY_KEYS as readonly string[];
  const guard = GUARD_KEYS as readonly string[];
  const next: Json = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!kept.includes(key)) removed.push(key);
    else if (key === "guard" && isRecord(value)) next[key] = pruneSub(key, value, (sub) => guard.includes(sub), removed);
    else next[key] = value;
  }
  return { next, removed };
};

const tryJson = (text: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** `text` as the value `spec` takes; throws ConfigKeyError naming the key and the expected form. */
export const parseValue = (spec: KeySpec, text: string): unknown => {
  const t = text.trim();
  const fail = (form: string, why?: string) => new ConfigKeyError(`${spec.key} must be ${form}${why ? ` (${why})` : ""}`);
  switch (spec.kind) {
    case "list": {
      if (!t.startsWith("[")) return t.split(",").map((s) => s.trim()).filter((s) => s !== "");
      const parsed = tryJson(t);
      if (!parsed.ok) throw fail("a comma separated list or a JSON array", parsed.error);
      if (!Array.isArray(parsed.value)) throw fail("a comma separated list or a JSON array");
      return parsed.value;
    }
    case "json": {
      const parsed = tryJson(t);
      if (!parsed.ok) throw fail("JSON", parsed.error);
      return parsed.value;
    }
    case "bool": {
      const lower = t.toLowerCase();
      if (lower === "true" || lower === "yes") return true;
      if (lower === "false" || lower === "no") return false;
      throw fail("true|false|yes|no");
    }
    case "enum": {
      const values = spec.values ?? [];
      if (!values.includes(t)) throw fail(`one of ${values.join("|")}`);
      return t;
    }
    case "string": {
      if (t.startsWith("{") || t.startsWith("[")) {
        const parsed = tryJson(t);
        if (parsed.ok) return parsed.value;
      }
      return t;
    }
  }
};

/** `--set key=value` and `--unset key` arguments as a patch and an unset list; an empty value means unset. */
export const parseSetArgs = (specs: readonly KeySpec[], sets: readonly string[], unsets: readonly string[]): { readonly patch: Json; readonly unset: readonly string[] } => {
  const valid = () => `valid keys: ${specs.map((s) => s.key).join(", ")}`;
  const find = (key: string, arg: string): KeySpec => {
    const found = specs.find((s) => s.key === key);
    if (!found) throw new ConfigKeyError(`unknown key ${key} in ${arg}; ${valid()}`);
    return found;
  };
  const patch: Json = {};
  const unset: string[] = [];
  for (const arg of sets) {
    const eq = arg.indexOf("=");
    if (eq < 0) throw new ConfigKeyError(`--set ${arg} must be key=value; ${valid()}`);
    const key = arg.slice(0, eq).trim();
    const text = arg.slice(eq + 1);
    const s = find(key, `--set ${arg}`);
    if (text.trim() === "") {
      delete patch[key];
      if (!unset.includes(key)) unset.push(key);
    } else {
      patch[key] = parseValue(s, text);
    }
  }
  for (const raw of unsets) {
    const key = raw.trim();
    find(key, `--unset ${raw}`);
    if (key in patch) throw new ConfigKeyError(`${key} is both set and unset`);
    if (!unset.includes(key)) unset.push(key);
  }
  for (const key of unset) if (key in patch) throw new ConfigKeyError(`${key} is both set and unset`);
  return { patch, unset };
};

/** The value as the prompter shows it: "" when absent, a string list comma joined, other non-strings compact JSON. */
export const formatValue = (spec: KeySpec, value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (spec.kind === "list" && Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(",");
  return JSON.stringify(value);
};

export const keyLabel = (spec: KeySpec): "[required]" | "[optional]" => (spec.required ? "[required]" : "[optional]");

/** Shown once before the questions: how to keep, fall back to the default, and clear. */
export const KEY_INPUT_HINT = "Enter keeps the value in [brackets] (none shown: the default applies); type - to clear an optional key";

/** The value a key falls back to when it has no value, as the prompter shows it; undefined when nothing applies. */
export type KeyDefault = (key: string, next: Json) => string | undefined;

/** config.json's effective defaults (what loadConfig uses when the key is absent). */
export const doriConfigDefault = (home: string): KeyDefault => {
  const base = defaultConfig(home) as unknown as Json;
  return (key, next) => {
    const s = DORI_CONFIG_KEYS.find((k) => k.key === key);
    if (!s) return undefined;
    const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : undefined);
    const value = key === "leadModel" ? (hasValue(next.defaultModel) ? next.defaultModel : base.defaultModel)
      : key === "alertsChannel" ? first(next.discordChannels)
      : key === "decisionsChannel" ? undefined
      : key === "laneSandbox" ? DEFAULT_LANE_SANDBOX
      : base[key];
    return hasValue(value) ? formatValue(s, value) : undefined;
  };
};

/** runner-config.json's effective defaults (what parsePolicy and the runner use when the key is absent), with `platform`'s (the runner host's) path rules. */
export const runnerConfigDefault = (home?: string, platform?: NodeJS.Platform): KeyDefault => (key, next) => {
  switch (key) {
    case "sandbox": return DEFAULT_POLICY.sandbox;
    case "jobs": return DEFAULT_POLICY.jobs;
    case "detectWorkspaces": return "true";
    case "worktreeRoot": return typeof next.reposRoot === "string" && next.reposRoot ? effectiveWorktreeRoot({ reposRoot: next.reposRoot }, platform) : undefined;
    default: return undefined;
  }
};

/** Structurally a Prompter (setup.ts): `ask` returns `current` on Enter. */
export type KeyPrompter = {
  readonly ask: (question: string, current: string) => Promise<string>;
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>;
};

/** The keys recorded as already shown; a missing or malformed file reads as none. */
export const readSeenKeys = (path: string): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === "string")) : new Set();
  } catch {
    return new Set();
  }
};

export const writeSeenKeys = (path: string, keys: Iterable<string>): void => {
  writeFileAtomic(path, `${JSON.stringify([...new Set(keys)].sort())}\n`, 0o600);
};

export type ConfigureOptions = {
  readonly specs: readonly KeySpec[];
  readonly current: Json;
  readonly patch: Json;
  readonly unset: readonly string[];
  readonly prompt: KeyPrompter;
  readonly interactive: boolean;
  readonly seen: ReadonlySet<string>;
  readonly mode: "full" | "new";
  readonly skip?: readonly string[];
  /** Shown beside a key that has no value. */
  readonly defaults?: KeyDefault;
  /** The caller already logged KEY_INPUT_HINT. */
  readonly hinted?: boolean;
  readonly log: (line: string) => void;
};

export type Configured = { readonly next: Json; readonly shown: readonly string[]; readonly missingRequired: readonly string[] };

/** False for undefined, null, "", and an empty array or object. */
const hasValue = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(isRecord(v) && Object.keys(v).length === 0);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const question = (spec: KeySpec, fallback: string | undefined): string => {
  const hint = spec.kind === "enum" ? ` (one of ${(spec.values ?? []).join("|")})` : spec.kind === "list" ? " (comma separated)" : spec.kind === "json" ? " (JSON)" : "";
  return `${spec.key} ${keyLabel(spec)} ${spec.describe}${hint}${fallback ? ` (default: ${fallback})` : ""}`;
};

/** Applies the patch and unset list, then asks the keys `mode` selects (see ConfigureOptions); never asks patch/unset keys. */
export const configureKeys = async (o: ConfigureOptions): Promise<Configured> => {
  const next: Json = { ...o.current };
  const set = (key: string, value: unknown) => {
    if (key in next && same(next[key], value)) return;
    next[key] = value;
    o.log(`SETUP_KEY_SET ${key}`);
  };
  const remove = (key: string) => {
    if (!(key in next)) return;
    delete next[key];
    o.log(`SETUP_KEY_UNSET ${key}`);
  };
  for (const [key, value] of Object.entries(o.patch)) set(key, value);
  for (const key of o.unset) remove(key);

  const asked: string[] = [];
  let hinted = o.hinted ?? false;
  const ask = async (spec: KeySpec): Promise<void> => {
    asked.push(spec.key);
    if (!hinted) {
      o.log(`SETUP_KEYS_HINT ${KEY_INPUT_HINT}`);
      hinted = true;
    }
    for (;;) {
      const shown = formatValue(spec, next[spec.key]);
      const fallback = hasValue(next[spec.key]) ? undefined : o.defaults?.(spec.key, next);
      const answer = (await o.prompt.ask(question(spec, fallback), shown)).trim();
      if (answer === shown.trim()) return;
      if (answer === "-") {
        if (!spec.required) return remove(spec.key);
        o.log(`SETUP_KEY_REQUIRED ${spec.key}: it cannot be cleared`);
        continue;
      }
      try {
        return set(spec.key, parseValue(spec, answer));
      } catch (e) {
        if (!(e instanceof ConfigKeyError)) throw e;
        o.log(`SETUP_KEY_INVALID ${spec.key}: ${e.message}`);
      }
    }
  };

  if (o.interactive) {
    const excluded = new Set([...(o.skip ?? []), ...Object.keys(o.patch), ...o.unset]);
    const eligible = o.specs.filter((s) => !excluded.has(s.key));
    if (o.mode === "new") {
      for (const s of eligible) if (!o.seen.has(s.key) || (s.required && !hasValue(next[s.key]))) await ask(s);
    } else {
      const first = eligible.filter((s) => (s.required && !hasValue(next[s.key])) || !o.seen.has(s.key));
      for (const s of first) await ask(s);
      const rest = eligible.filter((s) => !first.includes(s));
      if (rest.length && (await o.prompt.confirm("Edit the other optional keys too?", false))) for (const s of rest) await ask(s);
    }
  }

  const shown = [...new Set([...asked, ...Object.keys(o.patch), ...o.unset])];
  const missingRequired = o.specs.filter((s) => s.required && !hasValue(next[s.key])).map((s) => s.key);
  return { next, shown, missingRequired };
};
