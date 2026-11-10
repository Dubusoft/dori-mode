import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configureKeys, DORI_CONFIG_KEYS, doriConfigDefault, formatValue, KEY_INPUT_HINT, keyLabel, pruneDoriConfig, readSeenKeys, writeSeenKeys } from "./config-keys.ts";
import { defaultConfig, expandHome, type DiscordConfig } from "./config.ts";
import type { Http } from "./messenger/http.ts";
import { LANES_WORKSPACE, LEAD_WORKSPACE, LEGACY_PANE_KEYS, managedPanesPath, resolveManagedPanes, saveManagedPanes } from "./managed-panes.ts";
import { listPanes } from "./panes.ts";
import { Repos } from "./repos.ts";
import type { Runner } from "./run.ts";

export class SetupError extends Error {}

export const TOKEN_KEY = "DORI_DISCORD_TOKEN";
export const UNITS = ["herdr-server.service", "dori-supervisor.service"] as const;
export const BOOT_PREP = "dori-boot-prep.sh";
/** Started by OnFailure= of the units above; never enabled itself. */
export const NOTIFY_UNIT = "dori-failure-notify@.service";
export const FAILURE_NOTIFY = "dori-failure-notify.sh";

/** How setup asks. The non-interactive prompter answers every question with its default. */
export type Prompter = {
  readonly ask: (question: string, current: string) => Promise<string>;
  /** Reads a secret without echo. An empty answer keeps the stored one. */
  readonly secret: (question: string, isSet: boolean) => Promise<string>;
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>;
};

export type SetupDeps = {
  readonly run: Runner;
  readonly http: Http;
  readonly prompt: Prompter;
  readonly log: (line: string) => void;
  readonly interactive: boolean;
  readonly home: string;
  readonly user: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly unitDir: string;
  readonly templatesDir: string;
  readonly bins: { readonly dori: string; readonly herdr?: string; readonly shell: string };
};

export type SetupInput = {
  readonly token?: string;
  readonly channels?: readonly string[];
  readonly model?: string;
  readonly cwd?: string;
  readonly stateDir?: string;
  /** GitHub logins whose new issues start work (githubIssueAuthors). */
  readonly issueAuthors?: readonly string[];
  /** Create or reuse the herdr lead pane and lanes workspace (default yes). */
  readonly herdr?: boolean;
  /** Install and enable the systemd user units (default no). */
  readonly autostart?: boolean;
  /** `--set key=value` values: applied as given, never asked. */
  readonly patch?: Json;
  /** `--unset key` keys: deleted, never asked. */
  readonly unset?: readonly string[];
  /** Prune obsolete keys and ask only keys never shown before; no token, Discord, herdr or autostart steps. */
  readonly migrate?: boolean;
};

type Json = Record<string, unknown>;

/** In `<stateDir>`: the config keys setup has already shown, so a later run asks only new ones. */
export const SETUP_KEYS_FILE = "setup-keys.json";
/** The config keys the core setup questions own; the generic key pass skips them. */
export const SETUP_CORE_KEYS = ["discord", "discordChannels", "defaultModel", "leadModel", "defaultCwd", "stateDir", "githubIssueAuthors", "ignorePanes"] as const;

const labelOf = (key: string): string => {
  const spec = DORI_CONFIG_KEYS.find((s) => s.key === key);
  return spec ? keyLabel(spec) : "[optional]";
};

/**
 * `config` without the keys config.json no longer reads. Legacy pane keys are migrated into `stateDir` first; when anything
 * is removed the previous file is copied to `<configPath>.bak` and each removed key logged.
 */
export const pruneObsolete = (d: Pick<SetupDeps, "configPath" | "log">, stateDir: string, config: Json): Json => {
  resolveManagedPanes(stateDir, config);
  const { next, removed } = pruneDoriConfig(config);
  if (!removed.length) return next;
  const backup = `${d.configPath}.bak`;
  const hasFile = existsSync(d.configPath);
  if (hasFile) writeFileAtomic(backup, readFileSync(d.configPath, "utf8"), 0o600);
  for (const key of removed) d.log(`SETUP_KEY_REMOVED ${key} (no longer read from config.json)`);
  if (hasFile) d.log(`SETUP_CONFIG_BACKUP ${backup}`);
  return next;
};

/** Seams for `renameWithRetry`: the platform (default `process.platform`), the rename itself, and the pause between tries. */
export type RenameDeps = {
  readonly platform?: NodeJS.Platform;
  readonly rename?: (from: string, to: string) => void;
  readonly sleep?: (ms: number) => void;
};

/** Retries after the first failed rename on Windows, where antivirus and the indexer briefly hold files open. */
export const RENAME_RETRIES = 5;
export const RENAME_RETRY_MS = 50;
const RENAME_BUSY: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * `renameSync(from, to)`. On win32 an `EPERM`, `EACCES` or `EBUSY` failure is retried up to `RENAME_RETRIES` times,
 * `RENAME_RETRY_MS` apart; any other error, or the last one, is thrown. Elsewhere it is a plain rename.
 */
export const renameWithRetry = (from: string, to: string, deps: RenameDeps = {}): void => {
  const rename = deps.rename ?? renameSync;
  if ((deps.platform ?? process.platform) !== "win32") {
    rename(from, to);
    return;
  }
  const sleep = deps.sleep ?? Bun.sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= RENAME_RETRIES || !code || !RENAME_BUSY.has(code)) throw error;
      sleep(RENAME_RETRY_MS);
    }
  }
};

export const writeFileAtomic = (path: string, content: string, mode: number, deps: RenameDeps = {}): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", mode);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, mode);
  renameWithRetry(tmp, path, deps);
};

export const readConfigObject = (path: string): Json => {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SetupError(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it or move it away, then run setup again`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SetupError(`${path} must hold a JSON object`);
  return parsed as Json;
};

export const mergeConfig = (existing: Json, patch: Json): Json => {
  const out: Json = { ...existing };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out;
};

export const saveConfig = (path: string, existing: Json, next: Json): boolean => {
  if (existsSync(path) && JSON.stringify(existing) === JSON.stringify(next)) return false;
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return true;
};

const envLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);

export const envGet = (text: string, key: string): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const m = envLine(key).exec(line);
    if (m) return (m[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
};

export const envSet = (text: string, key: string, value: string): string => {
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const at = lines.findIndex((l) => envLine(key).test(l));
  const entry = `${key}=${value}`;
  if (at >= 0) lines[at] = entry;
  else lines.push(entry);
  return `${lines.join("\n")}\n`;
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

export type ChannelCheck = { readonly id: string; readonly ok: boolean; readonly detail: string };

export const verifyChannel = async (http: Http, token: string, id: string): Promise<ChannelCheck> => {
  if (!/^\d{15,22}$/.test(id)) return { id, ok: false, detail: "not a channel id (Discord ids are 17-20 digits; right-click the channel, Copy Channel ID)" };
  try {
    const r = await http({ method: "GET", url: `https://discord.com/api/v10/channels/${id}`, headers: { Authorization: `Bot ${token}` } });
    if (r.status === 200) {
      const name = (JSON.parse(r.body) as { name?: string }).name;
      return { id, ok: true, detail: name ? `#${name}` : "readable" };
    }
    const why: Record<number, string> = {
      401: "the bot token was rejected (401); check the token in the Developer Portal",
      403: "the bot cannot see this channel (403 Missing Access); invite it to the server and allow View Channel and Read Message History",
      404: "no such channel (404), or it is in a server the bot is not in",
    };
    return { id, ok: false, detail: why[r.status] ?? `Discord answered HTTP ${r.status}` };
  } catch (e) {
    return { id, ok: false, detail: `request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
};

export const parseChannels = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

const herdrJson = async (run: Runner, argv: readonly string[]): Promise<Json> => {
  const r = await run(["herdr", ...argv]);
  if (r.code !== 0) throw new SetupError(`herdr ${argv.join(" ")} failed: ${r.err || r.out}`);
  try {
    return JSON.parse(r.out) as Json;
  } catch {
    return {};
  }
};

const workspaceByLabel = async (run: Runner, label: string): Promise<string | undefined> => {
  const list = (await herdrJson(run, ["workspace", "list"])) as { result?: { workspaces?: { label?: string; workspace_id?: string }[] } };
  return list.result?.workspaces?.find((w) => w.label === label)?.workspace_id;
};

export const ensureWorkspace = async (run: Runner, label: string): Promise<{ id: string; created: boolean }> => {
  const found = await workspaceByLabel(run, label);
  if (found) return { id: found, created: false };
  await herdrJson(run, ["workspace", "create", "--label", label, "--no-focus"]);
  const id = await workspaceByLabel(run, label);
  if (!id) throw new SetupError(`cannot create herdr workspace ${label}`);
  return { id, created: true };
};

const exists = async (run: Runner, kind: "pane" | "workspace", id: string): Promise<boolean> => Boolean(id) && (await run(["herdr", kind, "get", id])).code === 0;

export type HerdrResult = { readonly patch: Json; readonly lines: string[] };

/**
 * The supervisor's own steps, run once ahead of it: keep the lead pane and lanes workspace recorded in dori state (or,
 * before the first migration, named by the config) when they still exist, otherwise create them, and record both in
 * `stateDir`. The patch carries only config keys: a new lanes workspace starts with a shell pane that is not a lane, so it
 * goes on ignorePanes.
 */
export const ensureHerdr = async (run: Runner, current: Json, leadCwd: string, stateDir: string): Promise<HerdrResult> => {
  const lines: string[] = [];
  const patch: Json = {};
  const recorded = resolveManagedPanes(stateDir, current);
  const lead = recorded.leadPane;
  let leadPane = lead;
  if (lead && (await exists(run, "pane", lead))) lines.push(`SETUP herdr lead pane ${lead} reused`);
  else {
    const ws = await ensureWorkspace(run, LEAD_WORKSPACE);
    const tab = (await herdrJson(run, ["tab", "create", "--workspace", ws.id, "--cwd", leadCwd, "--label", "dori-lead", "--no-focus"])) as { result?: { root_pane?: { pane_id?: string } } };
    const pane = tab.result?.root_pane?.pane_id;
    if (!pane) throw new SetupError("herdr tab create returned no pane id for the lead");
    leadPane = pane;
    lines.push(`SETUP herdr lead pane ${pane} created in workspace ${LEAD_WORKSPACE} (${ws.id})${lead ? `; ${lead} was gone` : ""}`);
  }
  const oldLanes = recorded.laneWorkspace;
  const ignore = strings(current.ignorePanes);
  let lanes = oldLanes;
  if (oldLanes && (await exists(run, "workspace", oldLanes))) lines.push(`SETUP herdr lanes workspace ${oldLanes} reused`);
  else {
    const ws = await ensureWorkspace(run, LANES_WORKSPACE);
    lanes = ws.id;
    if (ws.created) {
      const shells = (await listPanes(run)).filter((p) => p.workspace_id === lanes).map((p) => p.pane_id);
      patch.ignorePanes = [...new Set([...ignore, ...shells])];
    }
    lines.push(`SETUP herdr lanes workspace ${lanes} ${ws.created ? "created" : "found by label"}${oldLanes ? `; ${oldLanes} was gone` : ""}`);
  }
  saveManagedPanes(stateDir, { leadPane, laneWorkspace: lanes, migrated: true });
  lines.push(`SETUP herdr ids recorded in ${managedPanesPath(stateDir)}`);
  if (patch.ignorePanes === undefined && !Array.isArray(current.ignorePanes)) patch.ignorePanes = ignore;
  return { patch, lines };
};

export const renderTemplate = (text: string, values: Readonly<Record<string, string>>): string =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined) throw new SetupError(`template value {{${name}}} is missing`);
    if (/[\n\r]/.test(v)) throw new SetupError(`template value {{${name}}} spans lines`);
    return v;
  });

export const templateValues = (d: SetupDeps, workDir: string): Record<string, string> => {
  if (!d.bins.herdr) throw new SetupError("herdr is not on PATH; install it (https://herdr.dev) before turning on autostart");
  const bins = [dirname(d.bins.dori), dirname(d.bins.herdr), join(d.home, ".bun", "bin"), join(d.home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    HOME: d.home,
    PATH: [...new Set(bins)].join(":"),
    SHELL: d.bins.shell,
    DORI_BIN: d.bins.dori,
    HERDR_BIN: d.bins.herdr,
    ENV_FILE: d.envPath,
    CONFIG: d.configPath,
    WORK_DIR: workDir,
    BOOT_PREP: join(dirname(d.envPath), BOOT_PREP),
    FAILURE_NOTIFY: join(dirname(d.envPath), FAILURE_NOTIFY),
  };
};

export const renderAutostart = (d: SetupDeps, workDir: string): Map<string, { content: string; mode: number }> => {
  const values = templateValues(d, workDir);
  const out = new Map<string, { content: string; mode: number }>();
  for (const unit of [...UNITS, NOTIFY_UNIT]) out.set(join(d.unitDir, unit), { content: renderTemplate(readFileSync(join(d.templatesDir, unit), "utf8"), values), mode: 0o644 });
  out.set(values.BOOT_PREP as string, { content: renderTemplate(readFileSync(join(d.templatesDir, BOOT_PREP), "utf8"), values), mode: 0o755 });
  out.set(values.FAILURE_NOTIFY as string, { content: renderTemplate(readFileSync(join(d.templatesDir, FAILURE_NOTIFY), "utf8"), values), mode: 0o755 });
  return out;
};

const str = (v: unknown): string => (typeof v === "string" && !v.startsWith("<") ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !x.startsWith("<")) : []);

const askToken = async (d: SetupDeps, stored: string | undefined, given: string | undefined): Promise<string | undefined> => {
  const typed = (await d.prompt.secret("Discord bot token [required]", Boolean(given ?? stored))).trim();
  const token = typed || given || stored;
  if (token && !/^[\w.-]+$/.test(token)) throw new SetupError("the bot token has characters a Discord token never has (spaces, quotes or newlines); paste it again");
  return token;
};

/** `given` channels (from a flag or --set) are verified but never asked. */
const askChannels = async (d: SetupDeps, token: string | undefined, initial: readonly string[], given: boolean): Promise<string[]> => {
  let current = [...initial];
  for (;;) {
    const channels = given ? current : parseChannels(await d.prompt.ask(`Main Discord channel id(s), comma separated ${labelOf("discordChannels")}`, current.join(",")));
    if (!channels.length || !token) {
      if (channels.length) d.log("SETUP channels not verified: no bot token yet");
      return channels;
    }
    const checks = await Promise.all(channels.map((id) => verifyChannel(d.http, token, id)));
    for (const c of checks) d.log(`SETUP channel ${c.id} ${c.ok ? "ok" : "FAILED"}: ${c.detail}`);
    if (checks.every((c) => c.ok)) return channels;
    if (d.interactive && (await d.prompt.confirm("Keep these channels anyway?", false))) return channels;
    if (!d.interactive || given) throw new SetupError(`the bot cannot read channel(s) ${checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}; nothing was written`);
    current = channels;
  }
};

const askDiscord = async (d: SetupDeps, token: string, channel: string, existing: unknown): Promise<DiscordConfig> => {
  const metadata = async (path: string): Promise<Json> => {
    let result;
    try {
      result = await d.http({ method: "GET", url: `https://discord.com/api/v10${path}`, headers: { Authorization: `Bot ${token}` } });
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      throw new SetupError(`cannot read Discord ${path}; nothing was written`);
    }
    if (result.status !== 200) throw new SetupError(`Discord ${path} answered HTTP ${result.status}; nothing was written`);
    const value: unknown = JSON.parse(result.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SetupError(`Discord ${path} returned invalid metadata`);
    return value as Json;
  };
  const app = await metadata("/oauth2/applications/@me");
  const room = await metadata(`/channels/${channel}`);
  const prior = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Json : {};
  const owner = app.owner && typeof app.owner === "object" && "id" in app.owner ? str(app.owner.id) : "";
  const applicationId = str(prior.applicationId) || str(app.id);
  const guildId = str(prior.guildId) || str(room.guild_id);
  const ownerId = (await d.prompt.ask(`Discord owner user id for slash commands ${labelOf("discord")}`, str(prior.ownerId) || owner)).trim();
  if (![applicationId, guildId, ownerId].every((id) => /^\d{15,22}$/.test(id))) {
    throw new SetupError("Discord application, guild and owner ids must be snowflakes; use a server channel and a Discord owner user id");
  }
  return { applicationId, guildId, ownerId };
};

/** Logs each required key with no value; true when any is missing. */
const reportMissing = (d: SetupDeps, missing: readonly string[]): boolean => {
  for (const key of missing) d.log(`SETUP_KEY_MISSING ${key} [required]`);
  return missing.length > 0;
};

/** `dori setup --migrate`: prune obsolete keys and ask only keys never shown before. */
const runMigrate = async (d: SetupDeps, input: SetupInput): Promise<number> => {
  if (!existsSync(d.configPath)) {
    d.log(`SETUP_MIGRATE_SKIPPED no config at ${d.configPath}; run dori setup`);
    return 0;
  }
  const raw = readConfigObject(d.configPath);
  const stateDir = expandHome(str(raw.stateDir) || "~/.dori/state", d.home);
  const seenPath = join(stateDir, SETUP_KEYS_FILE);
  const seen = readSeenKeys(seenPath);
  const configured = await configureKeys({
    specs: DORI_CONFIG_KEYS, current: pruneObsolete(d, stateDir, raw), patch: input.patch ?? {}, unset: input.unset ?? [],
    prompt: d.prompt, interactive: d.interactive, seen, mode: "new", defaults: doriConfigDefault(d.home), log: d.log,
  });
  d.log(`SETUP config ${saveConfig(d.configPath, raw, configured.next) ? "written" : "unchanged"}: ${d.configPath}`);
  if (d.interactive) writeSeenKeys(seenPath, [...seen, ...configured.shown]);
  if (reportMissing(d, configured.missingRequired)) {
    d.log("SETUP_MIGRATE_DONE with problems: config");
    return 2;
  }
  d.log("SETUP_MIGRATE_DONE");
  return 0;
};

export const runSetup = async (d: SetupDeps, input: SetupInput = {}): Promise<number> => {
  if (input.migrate) return runMigrate(d, input);
  const problems: string[] = [];
  const raw = readConfigObject(d.configPath);
  const envText = existsSync(d.envPath) ? readFileSync(d.envPath, "utf8") : "";
  const base = defaultConfig(d.home);
  const patch = input.patch ?? {};
  const unset = input.unset ?? [];
  // Core keys whose question was shown (recorded as seen) and core keys taken from --set (not passed on to configureKeys).
  const asked: string[] = [];
  const consumed: string[] = [];
  const given = (key: string): string | undefined => {
    if (!(key in patch)) return undefined;
    consumed.push(key);
    const spec = DORI_CONFIG_KEYS.find((s) => s.key === key);
    return spec ? formatValue(spec, patch[key]) : String(patch[key]);
  };
  const givenList = (key: string): string[] | undefined => {
    if (!(key in patch)) return undefined;
    consumed.push(key);
    return strings(patch[key]);
  };
  /** `-` clears an optional key; a required one is asked again. */
  const ask = async (key: string, question: string, current: string, fallback?: string): Promise<string> => {
    if (unset.includes(key)) return "";
    asked.push(key);
    for (;;) {
      const answer = (await d.prompt.ask(`${question} ${labelOf(key)}${fallback && !current ? ` (default: ${fallback})` : ""}`, current)).trim();
      if (answer !== "-") return answer;
      if (labelOf(key) === "[optional]") return "";
      d.log(`SETUP_KEY_REQUIRED ${key}: it cannot be cleared`);
    }
  };
  if (d.interactive) d.log(`SETUP ${KEY_INPUT_HINT}`);

  const storedToken = envGet(envText, TOKEN_KEY) || undefined;
  const token = await askToken(d, storedToken, input.token);
  const givenChannels = input.channels ?? givenList("discordChannels");
  if (!givenChannels && !unset.includes("discordChannels")) asked.push("discordChannels");
  const channels = unset.includes("discordChannels") ? [] : await askChannels(d, token, givenChannels ?? strings(raw.discordChannels), Boolean(givenChannels));
  let discord: unknown;
  if ("discord" in patch) {
    consumed.push("discord");
    discord = patch.discord;
  } else if (token && channels[0] && !unset.includes("discord")) {
    asked.push("discord");
    discord = await askDiscord(d, token, channels[0], raw.discord);
  }
  const defaultModel = (input.model ?? given("defaultModel") ?? await ask("defaultModel", "Default model for lanes (and the lead unless a lead model is set)", str(raw.defaultModel) || base.defaultModel)).trim();
  // A legacy leadModel array (or object) is kept as written; the config loader uses its first entry and warns.
  const leadStored = "leadModel" in patch ? patch.leadModel : raw.leadModel;
  const chain = typeof leadStored === "object" && leadStored !== null ? leadStored : undefined;
  if (chain && "leadModel" in patch) consumed.push("leadModel");
  const leadModel = chain ? "" : given("leadModel") ?? await ask("leadModel", "Lead model", str(raw.leadModel), defaultModel);
  const defaultCwd = (input.cwd ?? given("defaultCwd") ?? await ask("defaultCwd", "Working directory of the lead session (local lanes started without --cwd start here too)", str(raw.defaultCwd) || "~")).trim();
  const stateDir = (input.stateDir ?? given("stateDir") ?? await ask("stateDir", "State directory", str(raw.stateDir) || "~/.dori/state")).trim() || "~/.dori/state";
  const repos = new Repos(expandHome(stateDir, d.home));
  const watchedRepos = (await d.prompt.ask("GitHub repos to watch (owner/repo, comma separated) [optional]", repos.list().join(",")))
    .split(/[\s,]+/).filter(Boolean);
  const givenAuthors = input.issueAuthors ?? givenList("githubIssueAuthors");
  const issueAuthors = parseChannels((givenAuthors ? givenAuthors.join(",") : await ask(
    "githubIssueAuthors",
    "GitHub accounts whose new issues start work automatically (comma separated)",
    strings(raw.githubIssueAuthors).join(","),
  )).toLowerCase());
  const badAuthor = issueAuthors.find((a) => !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(a));
  if (badAuthor) throw new SetupError(`${badAuthor} is not a GitHub login; nothing was written`);
  const workDir = expandHome(defaultCwd, d.home);
  for (const dir of [workDir, expandHome(stateDir, d.home)]) ensureDir(d, dir);
  repos.replace(watchedRepos);

  if (token) {
    const next = envSet(envText, TOKEN_KEY, token);
    const changed = next !== envText || !existsSync(d.envPath) || modeOf(d.envPath) !== 0o600;
    if (changed) writeFileAtomic(d.envPath, next, 0o600);
    d.log(`SETUP env ${TOKEN_KEY} ${token === storedToken ? "kept" : "saved"} in ${d.envPath} (mode 600)${changed ? "" : ", unchanged"}`);
  } else d.log(`SETUP env no bot token; set ${TOKEN_KEY} later by running dori setup again`);

  const merged = mergeConfig(raw, {
    discordChannels: channels, defaultModel, leadModel: chain ?? (leadModel || undefined), defaultCwd, stateDir, discord,
    // Keep configs that never set it byte-identical.
    githubIssueAuthors: issueAuthors.length || Array.isArray(raw.githubIssueAuthors) ? issueAuthors : undefined,
  });
  for (const key of new Set(consumed)) if (JSON.stringify(raw[key]) !== JSON.stringify(merged[key])) d.log(`SETUP_KEY_SET ${key}`);
  const stateAbs = expandHome(stateDir, d.home);
  const seenPath = join(stateAbs, SETUP_KEYS_FILE);
  const seen = readSeenKeys(seenPath);
  const configured = await configureKeys({
    specs: DORI_CONFIG_KEYS, current: pruneObsolete(d, stateAbs, merged),
    patch: Object.fromEntries(Object.entries(patch).filter(([key]) => !consumed.includes(key))), unset,
    prompt: d.prompt, interactive: d.interactive, seen, mode: "full", skip: SETUP_CORE_KEYS, defaults: doriConfigDefault(d.home), hinted: true, log: d.log,
  });
  let config = configured.next;
  d.log(`SETUP config ${saveConfig(d.configPath, raw, config) ? "written" : "unchanged"}: ${d.configPath}`);
  if (d.interactive) writeSeenKeys(seenPath, [...seen, ...configured.shown, ...asked, ...Object.keys(patch), ...unset]);
  if (reportMissing(d, configured.missingRequired)) problems.push("config");
  const alertsChannel = str(config.alertsChannel).trim();
  d.log(alertsChannel
    ? `SETUP alertsChannel ${alertsChannel}: system notices go there`
    : `SETUP alertsChannel unset: system notices go to the first discordChannels entry; optional, add "alertsChannel": "<channel id>" to ${d.configPath} to send them elsewhere`);

  let serverUp = false;
  if (await d.prompt.confirm("Create or reuse the herdr lead pane and lanes workspace?", input.herdr ?? true)) {
    if (!d.bins.herdr) {
      problems.push("herdr");
      d.log("SETUP herdr not found on PATH; install it (https://herdr.dev) and run dori setup again");
    } else if ((await d.run(["herdr", "workspace", "list"])).code !== 0) {
      problems.push("herdr");
      d.log("SETUP herdr server not reachable; start `herdr server` (or the herdr-server unit) and run dori setup again");
    } else {
      serverUp = true;
      try {
        const h = await ensureHerdr(d.run, config, workDir, expandHome(stateDir, d.home));
        for (const l of h.lines) d.log(l);
        const before = config;
        // The herdr ids live in dori state; setup drops the legacy keys from the config.
        config = Object.fromEntries(Object.entries(mergeConfig(config, h.patch)).filter(([key]) => !(LEGACY_PANE_KEYS as readonly string[]).includes(key)));
        d.log(`SETUP config ${saveConfig(d.configPath, before, config) ? "updated" : "unchanged"} for herdr`);
      } catch (e) {
        problems.push("herdr");
        d.log(`SETUP herdr failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else d.log("SETUP herdr skipped");

  if (await d.prompt.confirm("Start herdr and the supervisor automatically at boot (systemd user units)?", input.autostart ?? false)) {
    problems.push(...(await autostart(d, workDir, serverUp)));
  } else d.log("SETUP autostart skipped");

  d.log(problems.length ? `SETUP_DONE with problems: ${[...new Set(problems)].join(", ")}` : "SETUP_DONE");
  return problems.length ? 2 : 0;
};

const ensureDir = (d: SetupDeps, dir: string): void => {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  d.log(`SETUP created ${dir}`);
};

const autostart = async (d: SetupDeps, workDir: string, serverUp: boolean): Promise<string[]> => {
  const problems: string[] = [];
  const files = renderAutostart(d, workDir);
  if (!(await d.prompt.confirm(`Write ${UNITS.join(", ")} to ${d.unitDir} and the boot prep script?`, true))) {
    d.log("SETUP autostart units not written; stopping autostart here");
    return problems;
  }
  ensureDir(d, d.unitDir);
  for (const [path, f] of files) {
    const same = existsSync(path) && readFileSync(path, "utf8") === f.content && modeOf(path) === f.mode;
    if (!same) writeFileAtomic(path, f.content, f.mode);
    d.log(`SETUP wrote ${path}${same ? " (unchanged)" : ""}`);
  }
  const step = async (question: string, argv: string[]): Promise<void> => {
    if (!(await d.prompt.confirm(`${question}\n  runs: ${argv.join(" ")}`, true))) {
      d.log(`SETUP skipped: ${argv.join(" ")}`);
      return;
    }
    const r = await d.run(argv);
    if (r.code === 0) d.log(`SETUP ran: ${argv.join(" ")}`);
    else {
      problems.push(argv[0] ?? "step");
      d.log(`SETUP FAILED (${r.code}): ${argv.join(" ")}: ${(r.err || r.out).slice(0, 300)}`);
    }
  };
  const linger = await d.run(["loginctl", "show-user", d.user, "--property=Linger"]);
  if (linger.code === 0 && linger.out.includes("Linger=yes")) d.log(`SETUP linger already on for ${d.user}`);
  else await step("Turn on linger so your user units run after boot without a login?", ["loginctl", "enable-linger", d.user]);
  await step("Reload systemd user units?", ["systemctl", "--user", "daemon-reload"]);
  const legacy = "dori-presence.service";
  const probe = ["systemctl", "--user", "list-unit-files", legacy, "--no-legend", "--no-pager"];
  const installed = await d.run(probe);
  if (installed.code !== 0) {
    d.log(`SETUP FAILED (${installed.code}): ${probe.join(" ")}: ${(installed.err || installed.out).slice(0, 300)}`);
    return [...problems, "systemctl"];
  }
  if (installed.out.split(/\s+/).includes(legacy)) {
    await step("Disable and stop the legacy presence unit? The supervisor now owns Discord presence and slash commands.", ["systemctl", "--user", "disable", "--now", legacy]);
  }
  await step("Enable the units so they start at boot?", ["systemctl", "--user", "enable", ...UNITS]);
  if (serverUp) {
    d.log("SETUP herdr server is already running (started by hand?); herdr-server.service is enabled but not started so it does not fight for the socket");
    d.log(`SETUP start the rest now with: systemctl --user start ${UNITS.filter((u) => u !== "herdr-server.service").join(" ")}`);
  } else d.log(`SETUP start them now with: systemctl --user start ${UNITS.join(" ")}`);
  return problems;
};
