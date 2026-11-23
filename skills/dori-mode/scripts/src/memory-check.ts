import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readJsonState, replaceFileDurable } from "./durable-write.ts";
import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Repos } from "./repos.ts";
import type { Runner } from "./run.ts";

/**
 * Read-only check of the lead's omo memory: system/human.md against `memoryLimits.humanMaxKb`, the whole system/
 * projection against omo's advisory token budget (`memoryLimits.systemMaxTokens`), and Open items that still
 * reference finished work (a closed lane, a merged PR). Detection only; condensing stays with the lead.
 */

export class MemoryCheckError extends Error {}

export const MEMORY_FILE = join("system", "human.md");
export const MEMORY_CHECK_EVERY_MS = 24 * 60 * 60_000;
/** Growth of human.md (or of system/) since the last MEMORY_CHECK or MEMORY_SIZE that is worth another one. */
export const MEMORY_CHECK_GROWTH_BYTES = 1024;

/** The system memory omo projects into every prompt, sized the way omo sizes it. */
export type SystemMemory = { readonly bytes: number; readonly tokens: number; readonly files: number };

export type OpenItem = { readonly index: number; readonly label: string; readonly text: string };
export type StaleItem = { readonly item: OpenItem; readonly refs: readonly string[] };
export type MemoryReport = {
  readonly file: string;
  readonly bytes: number;
  readonly limitBytes: number;
  /** Undefined when git could not read the repo's HEAD; the reason is in `unchecked`. */
  readonly system?: SystemMemory;
  readonly systemMaxTokens: number;
  readonly items: number;
  readonly stale: readonly StaleItem[];
  readonly unchecked: readonly string[];
};

/**
 * The lead's memory repo: `memoryCheck.repo`, else omo's per-cwd repo for the lead's cwd (`leadCwd`), found as
 * <home>/.omo/memory/agents/<slug>-<first 8 hex of sha256(cwd)>/repo. Undefined when neither exists.
 */
export const resolveMemoryRepo = (config: DoriConfig, home: string): string | undefined => {
  if (config.memoryCheck.repo.trim()) return config.memoryCheck.repo.trim();
  const agents = join(home, ".omo", "memory", "agents");
  const suffix = `-${createHash("sha256").update(config.leadCwd).digest("hex").slice(0, 8)}`;
  let names: string[];
  try { names = readdirSync(agents); } catch { return undefined; }
  const hit = names.filter((name) => name.endsWith(suffix)).sort().find((name) => existsSync(join(agents, name, MEMORY_FILE)) || existsSync(join(agents, name, "repo", MEMORY_FILE)));
  return hit ? join(agents, hit, "repo") : undefined;
};

/** Top-level bullets under the `## Open` heading; indented lines belong to the bullet above. */
export const openItems = (text: string): OpenItem[] => {
  const items: string[] = [];
  let inOpen = false;
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line)) { inOpen = /^##\s+Open\b/i.test(line); continue; }
    if (!inOpen) continue;
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (items.length && line.trim()) items[items.length - 1] += `\n${line}`;
  }
  return items.map((body, i) => {
    const first = body.split("\n")[0] ?? "";
    return { index: i + 1, label: first.length > 60 ? `${first.slice(0, 57)}...` : first, text: body };
  });
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string): RegExp => new RegExp(`(?<![\\w-])${escape(s)}(?![\\w-])`, "i");

export type Refs = {
  readonly lanes: readonly string[];
  /** owner/repo#N, resolved; bare PR numbers whose repo is not clear go to `unresolved`. */
  readonly prs: readonly string[];
  readonly unresolved: readonly string[];
};

/**
 * What an Open item points at. Lane keys match whole words. PRs: owner/repo#N, a github.com pull URL, or "PR #N" when
 * the item names exactly one repo as owner/repo (a known repo, or any repo of a known owner). A bare repo name is not
 * enough ("app #188" is not the app repo).
 */
export const itemRefs = (text: string, closedLanes: Iterable<string>, repos: readonly string[]): Refs => {
  const lanes = [...closedLanes].filter((key) => word(key).test(text));
  const prs = new Set<string>();
  for (const m of text.matchAll(/(?<![\w./-])([A-Za-z0-9][\w.-]*\/[\w.-]*[\w])#(\d+)/g)) prs.add(`${m[1]?.toLowerCase()}#${m[2]}`);
  for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) prs.add(`${m[1]?.toLowerCase()}#${m[2]}`);
  const owners = new Set(repos.map((repo) => repo.split("/")[0]));
  const named = [...new Set([...text.matchAll(/(?<![\w./~-])([A-Za-z0-9][\w-]*)\/([\w.-]*[\w])(?![\w/#-])/g)]
    .map((m) => `${m[1]}/${m[2]}`.toLowerCase())
    .filter((slug) => repos.includes(slug) || owners.has(slug.split("/")[0])))];
  const unresolved: string[] = [];
  for (const m of text.matchAll(/\bPRs?\s*#(\d+)/gi)) {
    if (named.length === 1) prs.add(`${named[0]}#${m[1]}`);
    else unresolved.push(`PR #${m[1]}`);
  }
  return { lanes, prs: [...prs], unresolved: [...new Set(unresolved)] };
};

/**
 * Keys of closed lanes: the archive (by file name, no lane file is read: this runs every sweep round) and the files
 * hand-moved to the old <stateDir>/lanes-closed (now lanes-archive/legacy); never an open key.
 */
export const closedLaneKeys = async (deps: FlowDeps): Promise<string[]> => {
  const open = new Set((await deps.registry.open()).map((l) => l.key));
  const keys = new Set(deps.registry.archivedKeys());
  for (const [path, file] of deps.registry.legacyFiles()) {
    let key: unknown;
    try { key = (JSON.parse(readFileSync(path, "utf8")) as { key?: unknown }).key; } catch { key = undefined; }
    const named = typeof key === "string" && key ? key : file.split(".")[0];
    if (named) keys.add(named);
  }
  return [...keys].filter((key) => !open.has(key)).sort();
};

/** Repos a bare "PR #N" may mean: this machine's watched repos and every repo a lane's Done signal names. */
const knownRepos = async (deps: FlowDeps): Promise<string[]> => {
  const repos = new Set(new Repos(deps.config.stateDir).list());
  for (const lane of await deps.registry.list()) {
    for (const m of lane.done.matchAll(/(?:"-R",\s*"|-R\s+)([\w.-]+\/[\w.-]+)/g)) if (m[1]) repos.add(m[1].toLowerCase());
    for (const m of lane.done.matchAll(/([\w.-]+\/[\w.-]+)#\d+/g)) if (m[1]) repos.add(m[1].toLowerCase());
  }
  return [...repos].sort();
};

const T = { timeoutMs: 20_000 };

/**
 * omo's own estimate (its memory status check): every committed system/**\/*.md blob at HEAD, UTF-8 bytes summed,
 * divided by 4 and floored. Read from git, not the working tree, so the number is the one omo warns with.
 */
export const systemMemory = async (run: Runner, repo: string): Promise<SystemMemory> => {
  const r = await run(["git", "-C", repo, "ls-tree", "-r", "-l", "-z", "HEAD", "--", "system"], T);
  if (r.code !== 0) throw new MemoryCheckError(`git ls-tree HEAD in ${repo}: ${(r.err || r.out).trim().split("\n")[0]?.slice(0, 120) || `exit ${r.code}`}`);
  let bytes = 0;
  let files = 0;
  for (const entry of r.out.split("\0")) {
    const m = /^\S+ blob \S+\s+(\d+)\t(.+)$/.exec(entry);
    if (!m || !m[2]?.endsWith(".md")) continue;
    bytes += Number(m[1]);
    files += 1;
  }
  return { bytes, tokens: Math.floor(bytes / 4), files };
};

const systemOrError = async (run: Runner, repo: string): Promise<{ readonly system?: SystemMemory; readonly error?: string }> => {
  try { return { system: await systemMemory(run, repo) }; }
  catch (e) {
    if (e instanceof MemoryCheckError) return { error: e.message };
    throw e;
  }
};

/** The memory repo and its human.md; throws MemoryCheckError when either is missing. */
const memoryFile = (deps: FlowDeps, home: string): { readonly repo: string; readonly file: string } => {
  const repo = resolveMemoryRepo(deps.config, home);
  if (!repo) throw new MemoryCheckError(`lead memory repo not found: memoryCheck.repo is unset and no omo memory repo exists for ${deps.config.leadCwd} under ${join(home, ".omo", "memory", "agents")}`);
  return { repo, file: join(repo, MEMORY_FILE) };
};

const prState = async (run: Runner, ref: string): Promise<{ readonly state?: string; readonly error?: string }> => {
  const [repo = "", number = ""] = ref.split("#");
  const r = await run(["gh", "pr", "view", number, "-R", repo, "--json", "state"], T);
  if (r.code !== 0) return { error: (r.err || r.out).trim().split("\n")[0]?.slice(0, 120) || `gh exit ${r.code}` };
  try { return { state: String((JSON.parse(r.out) as { state?: unknown }).state ?? "").toLowerCase() }; }
  catch { return { error: "gh printed no JSON" }; }
};

/** Reads only: the memory files, the memory repo's HEAD, the registry and gh. Throws MemoryCheckError when the memory file is missing. */
export const checkMemory = async (deps: FlowDeps, home: string): Promise<MemoryReport> => {
  const { repo, file } = memoryFile(deps, home);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new MemoryCheckError(`${file} is missing or unreadable`); }
  const bytes = statSync(file).size;
  const items = openItems(text);
  const closed = await closedLaneKeys(deps);
  const repos = await knownRepos(deps);
  const refs = items.map((item) => ({ item, refs: itemRefs(item.text, closed, repos) }));
  const prs = [...new Set(refs.flatMap((r) => r.refs.prs))];
  const unchecked: string[] = [];
  const { system, error } = await systemOrError(deps.run, repo);
  if (error) unchecked.push(`system memory: ${error}`);
  const prStates = new Map(await Promise.all(prs.map(async (ref) => [ref, await prState(deps.run, ref)] as const)));
  for (const [ref, s] of prStates) if (s.error) unchecked.push(`PR ${ref}: ${s.error}`);
  for (const { item, refs: r } of refs) for (const pr of r.unresolved) unchecked.push(`item ${item.index}: ${pr} (repo unclear; write owner/repo#N)`);
  const stale = refs.flatMap(({ item, refs: r }): StaleItem[] => {
    const found = [
      ...r.lanes.map((key) => `closed lane ${key}`),
      ...r.prs.filter((ref) => prStates.get(ref)?.state === "merged").map((ref) => `merged PR ${ref}`),
    ];
    return found.length ? [{ item, refs: found }] : [];
  });
  return {
    file, bytes, limitBytes: Math.round(deps.config.memoryLimits.humanMaxKb * 1024), ...(system ? { system } : {}),
    systemMaxTokens: deps.config.memoryLimits.systemMaxTokens, items: items.length, stale, unchecked,
  };
};

const systemOver = (r: MemoryReport): boolean => r.system !== undefined && r.system.tokens > r.systemMaxTokens;

export const needsAction = (r: MemoryReport): boolean => r.bytes > r.limitBytes || systemOver(r) || r.stale.length > 0;

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`;

/** One line for the lead's event log; empty when nothing needs doing. */
export const memoryEvent = (r: MemoryReport): string => {
  if (!needsAction(r)) return "";
  const parts = [
    ...(r.bytes > r.limitBytes ? [`human.md is ${kb(r.bytes)}, over the ${kb(r.limitBytes)} limit`] : []),
    ...(systemOver(r) ? [`system memory is ~${r.system?.tokens} tokens, over omo's ${r.systemMaxTokens} advisory`] : []),
    ...(r.stale.length ? [`${r.stale.length} Open item(s) reference finished work: ${r.stale.map((s) => `#${s.item.index} ${s.refs.join(", ")}`).join("; ")}`] : []),
  ];
  const line = `MEMORY_CHECK ${parts.join("; ")}`;
  const tail = " (run dori memory check, then condense or delete them)";
  return `${line.length > 600 ? `${line.slice(0, 597)}...` : line}${tail}`;
};

export const renderMemoryReport = (r: MemoryReport): string => [
  `MEMORY_FILE ${r.file}`,
  `SIZE ${r.bytes} bytes (${kb(r.bytes)}), limit ${kb(r.limitBytes)}: ${r.bytes > r.limitBytes ? `OVER by ${kb(r.bytes - r.limitBytes)}` : "ok"}`,
  r.system
    ? `SYSTEM ~${r.system.tokens} tokens (${r.system.bytes} bytes in ${r.system.files} system/*.md at HEAD, bytes/4), advisory ${r.systemMaxTokens}: ${systemOver(r) ? `OVER by ${r.system.tokens - r.systemMaxTokens}` : "ok"}`
    : "SYSTEM unknown (see UNCHECKED)",
  `OPEN_ITEMS ${r.items}`,
  ...r.stale.map((s) => `STALE #${s.item.index} ${JSON.stringify(s.item.label)}: ${s.refs.join("; ")}`),
  ...r.unchecked.map((u) => `UNCHECKED ${u}`),
  needsAction(r) ? "MEMORY_CHECK action needed: condense human.md and the system/ blocks and delete or shrink the STALE Open items" : "MEMORY_CHECK clean",
].join("\n");

/**
 * `at`: the last daily check. `bytes`/`over`/`stale`: what the last MEMORY_CHECK said, lowered to what later checks
 * still find (a condensed file or a deleted item resets the baseline). Absent after a clean check.
 */
type SweepState = {
  readonly at?: number;
  readonly bytes?: number;
  readonly over?: boolean;
  /** system/ bytes at HEAD, and whether they were over the advisory. */
  readonly system?: number;
  readonly systemOver?: boolean;
  readonly stale?: readonly string[];
  /** Pre-daily-only state: a fingerprint of the last line sent. Read once, so an upgrade does not repeat it. */
  readonly sent?: string;
};

const fieldIs = (v: Record<string, unknown>, key: string, type: "number" | "boolean" | "string"): boolean => v[key] === undefined || typeof v[key] === type;
const isSweepState = (v: unknown): v is SweepState =>
  isRecord(v) && fieldIs(v, "at", "number") && fieldIs(v, "bytes", "number") && fieldIs(v, "over", "boolean") && fieldIs(v, "system", "number") &&
  fieldIs(v, "systemOver", "boolean") && fieldIs(v, "sent", "string") && (v.stale === undefined || (Array.isArray(v.stale) && v.stale.every((s) => typeof s === "string")));

const saveState = (path: string, state: SweepState): void => {
  replaceFileDurable(path, JSON.stringify(state), 0o600, `${path}.${process.pid}.tmp`);
};

/**
 * The supervisor's daily memory sweep (the size trigger, memorySizeTrigger, is its own sweep, so a failure here never
 * costs its line): one check every MEMORY_CHECK_EVERY_MS. A finding becomes one MEMORY_CHECK line only when there was
 * no earlier one, human.md or system/ grew by MEMORY_CHECK_GROWTH_BYTES or went over its limit since it, or a STALE
 * reference it did not name appears. human.md and the Open items share one baseline, system/ keeps its own, and a
 * day git cannot size system/ leaves that baseline as it was. State lives in <stateDir>/memory-check.json. The run is
 * recorded before checking, so a failure waits for the next daily turn.
 */
export const memorySweep = async (deps: FlowDeps, home: string): Promise<string[]> => {
  const path = join(deps.config.stateDir, "memory-check.json");
  const now = deps.clock.now();
  // A corrupt state is moved aside and read as empty: the check runs now and a standing finding is said again.
  const state = readJsonState(path, "MEMORY_CHECK", isSweepState, "no memory check baseline") ?? {};
  if (now - (state.at ?? -Infinity) < MEMORY_CHECK_EVERY_MS) return [];
  const kept: SweepState = state.systemOver ? { system: state.system, systemOver: true } : {};
  const base: SweepState = state.bytes === undefined ? kept : { bytes: state.bytes, over: state.over, stale: state.stale, ...kept };
  saveState(path, { ...base, at: now });
  let report: MemoryReport;
  try { report = await checkMemory(deps, home); }
  catch (e) {
    if (e instanceof MemoryCheckError) return [`MEMORY_CHECK_WARN ${e.message}`];
    throw e;
  }
  const line = memoryEvent(report);
  const over = report.bytes > report.limitBytes;
  const stale = [...new Set(report.stale.flatMap((s) => s.refs))].sort();
  const system = report.system?.bytes;
  const sysOver = systemOver(report);
  // system/: said when newly over or grown 1 KB past what was said; unknown (git failed) keeps the baseline.
  const sendSystem = sysOver && system !== undefined && (!kept.systemOver || system - (kept.system ?? 0) >= MEMORY_CHECK_GROWTH_BYTES);
  const systemState: SweepState = system === undefined ? kept
    : !sysOver ? {}
    : sendSystem ? { system, systemOver: true } : { system: Math.min(kept.system ?? system, system), systemOver: true };
  // human.md and Open items: a clean check forgets the last finding, so the same finding coming back later is said
  // again. An old state's fingerprint means a line went out already: take today's findings as its baseline.
  const found = over || stale.length > 0;
  const last: SweepState | undefined = base.bytes !== undefined ? base : state.sent !== undefined ? { bytes: report.bytes, over, stale } : undefined;
  const said = new Set(last?.stale ?? []);
  const sendHuman = found && (!last || report.bytes - (last.bytes ?? 0) >= MEMORY_CHECK_GROWTH_BYTES || (over && !last.over) || stale.some((ref) => !said.has(ref)));
  const send = line !== "" && (sendHuman || sendSystem);
  const humanState: SweepState = !found ? {}
    : send || !last ? { bytes: report.bytes, over, stale }
    : { bytes: Math.min(last.bytes ?? report.bytes, report.bytes), over: over && last.over === true, stale: stale.filter((ref) => said.has(ref)) };
  saveState(path, { at: now, ...humanState, ...systemState });
  return send ? [line] : [];
};

/** Per measure, the size the last MEMORY_SIZE named it at, lowered while it shrinks; absent while under its trigger. */
type TriggerState = { readonly human?: number; readonly system?: number };
const isTriggerState = (v: unknown): v is TriggerState => isRecord(v) && fieldIs(v, "human", "number") && fieldIs(v, "system", "number");

/**
 * The size trigger, every sweep round: human.md over `triggerPct` of `humanMaxKb`, or system/ over `triggerPct` of
 * `systemMaxTokens`, wakes the lead with one urgent MEMORY_SIZE line before omo's own advisory is reached. The same
 * measure is named again only after it grows MEMORY_CHECK_GROWTH_BYTES past the last line (or drops under its trigger
 * and crosses it again). Reads the human.md size and the repo's HEAD only; a repo git cannot read skips the system
 * measure (the daily check reports it as UNCHECKED), a missing human.md is the daily check's MEMORY_CHECK_WARN. State
 * lives in <stateDir>/memory-size.json.
 */
export const memorySizeTrigger = async (deps: FlowDeps, home: string): Promise<string[]> => {
  let paths: { readonly repo: string; readonly file: string };
  try { paths = memoryFile(deps, home); }
  catch (e) {
    if (e instanceof MemoryCheckError) return [];
    throw e;
  }
  if (!existsSync(paths.file)) return [];
  const m = deps.config.memoryLimits;
  const pct = m.triggerPct / 100;
  const human = { bytes: statSync(paths.file).size, trigger: Math.round(m.humanMaxKb * 1024 * pct) };
  const { system } = await systemOrError(deps.run, paths.repo);
  const systemTrigger = Math.floor(m.systemMaxTokens * pct);
  const path = join(deps.config.stateDir, "memory-size.json");
  // A corrupt state is moved aside and read as empty: a measure over its trigger is named again.
  const state = readJsonState(path, "MEMORY_SIZE", isTriggerState, "no memory size baseline") ?? {};
  // Per measure: whether it fires, and its next baseline (undefined: under its trigger). Unmeasured keeps the baseline.
  const step = (value: number | undefined, over: boolean, last: number | undefined): { readonly fire: boolean; readonly next?: number } => {
    if (value === undefined) return { fire: false, ...(last !== undefined ? { next: last } : {}) };
    if (!over) return { fire: false };
    if (last === undefined || value - last >= MEMORY_CHECK_GROWTH_BYTES) return { fire: true, next: value };
    return { fire: false, next: Math.min(last, value) };
  };
  const h = step(human.bytes, human.bytes > human.trigger, state.human);
  const s = step(system?.bytes, system !== undefined && system.tokens > systemTrigger, state.system);
  const next: TriggerState = { ...(h.next !== undefined ? { human: h.next } : {}), ...(s.next !== undefined ? { system: s.next } : {}) };
  if (JSON.stringify(next) !== JSON.stringify(state)) saveState(path, next);
  if (!h.fire && !s.fire) return [];
  const parts = [
    ...(s.next !== undefined && system && system.tokens > systemTrigger ? [`system memory ~${system.tokens} tokens, over ${systemTrigger} (${m.triggerPct}% of omo's ${m.systemMaxTokens} advisory)`] : []),
    ...(h.next !== undefined ? [`human.md ${kb(human.bytes)}, over ${kb(human.trigger)} (${m.triggerPct}% of the ${kb(Math.round(m.humanMaxKb * 1024))} limit)`] : []),
  ];
  return [`MEMORY_SIZE ${parts.join("; ")} (run dori memory check, then condense now)`];
};
