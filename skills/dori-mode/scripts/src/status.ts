import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { DoriConfig } from "./config.ts";
import { eventClass, eventKind, type EventClass } from "./event-policy.ts";
import { readSourceStatus, SourceSpecs, type SourceView, sourceViews } from "./event-sources.ts";
import { type ScheduleRow, scheduleRow, type ScheduleSpec } from "./schedule.ts";
import { githubSummary } from "./github-events.ts";
import { gatewayView, readGatewayStatus, type GatewayView } from "./gateway-status.ts";
import { type LaneReport, latestLaneReports } from "./lane-reports.ts";
import { pendingLeadRestart, type LeadRestartRequest } from "./lead-restart.ts";
import { listPanes } from "./panes.ts";
import type { RecoveryLane } from "./recover.ts";
import { type Lane, type Registry, statusOf } from "./registry.ts";
import { Repos } from "./repos.ts";
import type { Clock, Runner } from "./run.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { readStoreView, readWakes } from "./store.ts";

export const SERVICES = ["herdr-server.service", "dori-supervisor.service"] as const;
export const LEGACY_PRESENCE = "dori-presence.service";

export type UnitState = { readonly name: string; readonly enabled: string; readonly active: string };

/** Read-only: is-enabled / is-active never change a unit. */
export const unitState = async (run: Runner, name: string): Promise<UnitState> => {
  const [enabled, active] = await Promise.all([
    run(["systemctl", "--user", "is-enabled", name], { timeoutMs: 5_000 }),
    run(["systemctl", "--user", "is-active", name], { timeoutMs: 5_000 }),
  ]);
  return { name, enabled: enabled.out.split("\n")[0] || "unknown", active: active.out.split("\n")[0] || "unknown" };
};

export type LeadState = {
  readonly pane: string;
  readonly state: "warm" | "cold" | "missing" | "unknown";
  readonly idleMin?: number;
  readonly tokens?: number;
  readonly note?: string;
};

export type Status = {
  readonly at: string;
  readonly services: readonly UnitState[];
  readonly lead: LeadState & { readonly cacheTtlMin: number; readonly capTokens: number; readonly pendingRestart?: LeadRestartRequest };
  readonly lanes: readonly {
    readonly key: string; readonly model?: string; readonly ageMin: number; readonly progress?: string; readonly repo?: string; readonly pr?: number;
    /** recoveryPending: "exhausted" after every recovery attempt failed (LANE_RECOVERY_EXHAUSTED), else "pending". */
    readonly recovery?: "pending" | "exhausted";
    /** The lane's latest `dori report` row (highest seq), routed or not. */
    readonly report?: LaneReport;
  }[];
  readonly waits: readonly { readonly key: string; readonly until: string; readonly deadline?: string; readonly note?: string }[];
  readonly github: {
    readonly repos: readonly string[];
    readonly lastPollAt?: string;
    readonly failures: readonly { readonly repo: string; readonly at: string }[];
    /** Logins whose new issues wake the lead, and repos whose issues have a baseline. */
    readonly issueAuthors: readonly string[];
    readonly issueRepos: readonly string[];
  };
  readonly gateway: GatewayView;
  /** Owner messages the lead was handed and reminded about (ACK_MISSING) without acking them yet. */
  readonly unacked: number;
  /** Finished lanes (LANE_CLOSED, CI_MERGED) the lead has not reported to the owner with dori reported, oldest first. */
  readonly unreported?: readonly { readonly lane: string; readonly since: string }[];
  readonly events: EventStats;
  /** Every event source with its last event and error, and a sources.json that does not read. */
  readonly sources?: { readonly sources: readonly SourceView[]; readonly error?: string };
  /** Every scheduled job with its next run, its last run and how that ended. */
  readonly schedules?: readonly ScheduleRow[];
};

/** The scheduled jobs in sources.json with their next run; none when it does not read (dori status shows that error). */
export const scheduleRows = (stateDir: string, now: number): ScheduleRow[] => {
  let specs: ScheduleSpec[] = [];
  try { specs = new SourceSpecs(stateDir).list().filter((spec): spec is ScheduleSpec => spec.type === "schedule"); } catch { return []; }
  const status = readSourceStatus(stateDir)?.sources ?? {};
  return specs.map((spec) => scheduleRow(spec, status[spec.name], now));
};

/** Per event kind over the last `hours`: events journaled, lead wakes it triggered and the model calls of those wakes. */
export type KindStats = {
  readonly kind: string;
  /** Absent for a trigger with no event line, such as "(restart)". */
  readonly cls?: EventClass;
  readonly events: number;
  readonly wakes: number;
  /** Wakes closed with a readable call count, and their calls: calls per wake is calls / measured. */
  readonly measured: number;
  readonly calls: number;
};
export type EventStats = {
  readonly hours: number;
  readonly wakes: number;
  readonly measured: number;
  readonly calls: number;
  /** Most wakes first, then most events. A wake triggered by several kinds counts once for each. */
  readonly kinds: readonly KindStats[];
};

export const STATS_HOURS = 24;

const eventStats = (config: DoriConfig, now: number): EventStats => {
  const since = now - STATS_HOURS * 3_600_000;
  const policy = config.eventPolicy;
  const lines = readStoreView(config.stateDir, {
    json: (journal) => (Array.isArray(journal.events) ? journal.events : []).filter((event) => (event.at ?? 0) >= since).map((event) => event.line),
    sqlite: (db) => (db.query("SELECT line FROM events WHERE at >= ?").all(since) as { line: string }[]).map((row) => row.line),
  }) ?? [];
  const kinds = new Map<string, { cls?: EventClass; events: number; wakes: number; measured: number; calls: number }>();
  const of = (kind: string) => {
    let entry = kinds.get(kind);
    if (!entry) kinds.set(kind, entry = { events: 0, wakes: 0, measured: 0, calls: 0 });
    return entry;
  };
  for (const line of lines) {
    const entry = of(eventKind(line, policy));
    entry.cls ??= eventClass(line, policy);
    entry.events++;
  }
  const wakes = readWakes(config.stateDir, since);
  let measured = 0;
  let calls = 0;
  for (const wake of wakes) {
    if (wake.calls !== undefined) { measured++; calls += wake.calls; }
    for (const kind of wake.trigger) {
      const entry = of(kind);
      entry.wakes++;
      if (wake.calls !== undefined) { entry.measured++; entry.calls += wake.calls; }
    }
  }
  return {
    hours: STATS_HOURS, wakes: wakes.length, measured, calls,
    kinds: [...kinds].map(([kind, s]) => ({ kind, ...s })).sort((a, b) => b.wakes - a.wakes || b.events - a.events || a.kind.localeCompare(b.kind)),
  };
};

export type StatusDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly config: DoriConfig;
  readonly registry: Registry;
};

const lastTokens = (file: string): number => {
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n").reverse()) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = (entry as { message?: { usage?: { totalTokens?: unknown } } } | null)?.message?.usage;
    if (usage && typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) return usage.totalTokens;
  }
  return 0;
};

const leadState = async (d: StatusDeps): Promise<LeadState> => {
  const pane = d.config.leadPane;
  try {
    const found = (await listPanes(d.run)).find((p) => p.pane_id === pane);
    if (!found) return { pane, state: "missing", note: "pane not found in herdr" };
    if (!found.agent) return { pane, state: "cold", note: "no agent running in the lead pane" };
    const cwd = found.cwd ?? d.config.defaultCwd;
    const hit = await resolveSession(pane, cwd, await procTable(d.run), { run: d.run, sessionsDir: d.config.sessionsDir });
    if (!hit.id) return { pane, state: "unknown", note: "cannot resolve the lead session" };
    const dir = sessionDirFor(d.config.sessionsDir, cwd);
    const files = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: dir, absolute: true, onlyFiles: true }));
    const started = existsSync(hit.id) ? hit.id :
      files.find((path) => path.endsWith(`_${hit.id}.jsonl`) || path.endsWith(`/${hit.id}.jsonl`));
    if (!started) return { pane, state: "unknown", note: "lead session file not found" };
    // The omo process keeps the session id it was launched with, and /new opens a newer session file in the same directory.
    // File names start with their creation time, so the current lead session is the latest-written file created after the launch one.
    const file = files.filter((path) => basename(path) > basename(started))
      .reduce((best, path) => statSync(path).mtimeMs > statSync(best).mtimeMs ? path : best, started);
    const idleMs = d.clock.now() - statSync(file).mtimeMs;
    return { pane, state: idleMs < d.config.cacheTtlMin * 60_000 ? "warm" : "cold", idleMin: Math.floor(idleMs / 60_000), tokens: lastTokens(file) };
  } catch (e) {
    return { pane, state: "unknown", note: e instanceof Error ? e.message.slice(0, 80) : "lookup failed" };
  }
};

const readWaits = (stateDir: string): Status["waits"] => {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, "waits.json"), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((w: unknown) => {
      const r = w as { key?: unknown; until?: unknown; deadline?: unknown; note?: unknown };
      return typeof r.key === "string" && typeof r.until === "string"
        ? [{ key: r.key, until: r.until, ...(typeof r.deadline === "number" && Number.isFinite(r.deadline) ? { deadline: new Date(r.deadline).toISOString() } : {}), ...(typeof r.note === "string" && r.note.trim() ? { note: r.note } : {}) }]
        : [];
    });
  } catch {
    return [];
  }
};

const readUnacked = (stateDir: string): number => readStoreView(stateDir, {
  json: (journal) => Array.isArray(journal.awaitingAck) ? journal.awaitingAck.filter((entry: { reminded?: unknown }) => entry?.reminded === true).length : 0,
  sqlite: (db) => (db.query("SELECT count(*) AS n FROM owner_messages WHERE reminded = 1").get() as { n: number }).n,
}) ?? 0;

const readUnreported = (stateDir: string): NonNullable<Status["unreported"]> => {
  const owed = (outcomes: unknown) => (Array.isArray(outcomes) ? outcomes : [])
    .filter((entry: { lane?: unknown; since?: unknown; reportedAt?: unknown }) => typeof entry?.lane === "string" && typeof entry.since === "number" && entry.reportedAt === undefined)
    .map((entry: { lane: string; since: number }) => ({ lane: entry.lane, since: new Date(entry.since).toISOString() }))
    .sort((a, b) => a.since.localeCompare(b.since));
  return readStoreView(stateDir, {
    json: (journal) => owed(journal.outcomes),
    sqlite: (db) => {
      const row = db.query("SELECT outcomes FROM lead_state").get() as { outcomes?: string | null } | null;
      return owed(row?.outcomes ? JSON.parse(row.outcomes) : []);
    },
  }) ?? [];
};

/** Cheap, offline guess at a lane's repo (owner/name from a gh -R in its Done signal, else the worktree directory) and PR number. */
const laneRepoPr = (l: Lane): { repo?: string; pr?: number } => {
  const text = `${l.done} ${l.title}`;
  const repo = /"-R"\s*,\s*"([\w.-]+\/[\w.-]+)"/.exec(text)?.[1] ?? /(?:^|\s)-R\s+([\w.-]+\/[\w.-]+)/.exec(text)?.[1]
    ?? /\/worktrees\/([^/]+)\//.exec(l.worktrees?.[0] ?? l.cwd ?? "")?.[1];
  // Only explicit PR references: a "(#N)" in a title may be a task or issue id, not a PR.
  const m = /\/pull\/(\d+)|\bpr\s+(?:view|checks|merge)\s+"?(\d+)/i.exec(l.done);
  const pr = m ? Number(m[1] ?? m[2]) : undefined;
  return { ...(repo ? { repo } : {}), ...(pr !== undefined ? { pr } : {}) };
};

/** Read-only and no LLM: unit states, files under stateDir, one herdr pane list. */
export const collectStatus = async (d: StatusDeps): Promise<Status> => {
  const now = d.clock.now();
  const [services, lead, open] = await Promise.all([
    Promise.all([...SERVICES, LEGACY_PRESENCE].map((name) => unitState(d.run, name))),
    leadState(d),
    existsSync(d.registry.dir) ? d.registry.open() : Promise.resolve([]),
  ]);
  const gh = githubSummary(d.config.stateDir);
  const pendingRestart = pendingLeadRestart(d.config.stateDir);
  let repos: string[] = [];
  try { repos = new Repos(d.config.stateDir).list(); } catch { /* unreadable list: show none */ }
  const reports = latestLaneReports(d.config);
  return {
    at: new Date(now).toISOString(),
    services,
    lead: { ...lead, cacheTtlMin: d.config.cacheTtlMin, capTokens: d.config.leadContextCapTokens, ...(pendingRestart ? { pendingRestart } : {}) },
    lanes: open.filter((l) => statusOf(l) === "working").map((l) => ({
      key: l.key, ...(l.model ? { model: l.model } : {}), ...laneRepoPr(l),
      ageMin: Math.max(0, Math.floor((now - Date.parse(l.openedAt)) / 60_000)),
      ...(l.lastProgressPost ?? l.lastPostedReport ? { progress: l.lastProgressPost ?? l.lastPostedReport } : {}),
      ...(l.recoveryPending ? { recovery: (l as RecoveryLane).recoveryExhausted ? "exhausted" as const : "pending" as const } : {}),
      ...(reports.has(l.key) ? { report: reports.get(l.key) } : {}),
    })),
    waits: readWaits(d.config.stateDir),
    github: {
      repos,
      ...(gh.polledAt !== undefined ? { lastPollAt: new Date(gh.polledAt).toISOString() } : {}),
      failures: Object.entries(gh.failures).map(([repo, at]) => ({ repo, at: new Date(at).toISOString() })),
      issueAuthors: d.config.githubIssueAuthors,
      issueRepos: gh.issueRepos,
    },
    gateway: gatewayView(readGatewayStatus(d.config.stateDir), now),
    unacked: readUnacked(d.config.stateDir),
    unreported: readUnreported(d.config.stateDir),
    events: eventStats(d.config, now),
    sources: sourceViews(d.config.stateDir),
    schedules: scheduleRows(d.config.stateDir, now),
  };
};

/** Whitespace (newlines included) collapsed, so every item stays on one line. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
/** One line of at most n characters, cut at a word when one is near and marked "...", never inside a surrogate pair. */
const clip = (s: string, n: number): string => {
  const t = flat(s);
  if (t.length <= n) return t;
  const room = Math.max(1, n - 3);
  const cut = t.slice(0, room).replace(/[\uD800-\uDBFF]$/, "");
  const space = cut.lastIndexOf(" ");
  return `${(space >= room / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Whole items joined by `sep`: at most `count` of them in about `max` characters, then "+N more". */
const list = (items: readonly string[], count: number, max: number, sep = ", "): string => {
  const shown: string[] = [];
  let size = 0;
  for (const item of items.slice(0, count)) {
    if (shown.length && size + item.length + sep.length > max - 12) break;
    const one = shown.length ? item : clip(item, max - 12);
    shown.push(one);
    size += one.length + sep.length;
  }
  const hidden = items.length - shown.length;
  return `${shown.join(sep)}${hidden ? `${sep}+${hidden} more` : ""}`;
};
const kilo = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const dur = (min: number): string => (min < 120 ? `${min}m` : min < 2880 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`);
const ago = (iso: string | undefined, now: number): string => {
  if (!iso) return "never";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return min < 1 ? "just now" : `${dur(min)} ago`;
};

const KST_MS = 9 * 3_600_000;
const two = (n: number): string => String(n).padStart(2, "0");
/** Fixed +09:00 (Asia/Seoul has no DST): "10-21 09:53". */
export const kst = (ms: number): string => {
  const d = new Date(ms + KST_MS);
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

/** "anthropic-subscription/claude-opus-5-5" -> "opus-5-5"; other ids keep their readable tail. */
export const shortModel = (model: string): string =>
  model.replace(/^.*\//, "").replace(/\[.*\]$/, "").replace(/^claude-/, "").replace(/-\d{8}$/, "") || model;

const EPOCH_SIGNAL = /\[\s*\$\(\s*date\s+\+%s\s*\)\s*-ge\s+(\d{9,11})\s*\]/;
/** When the wait fires, from a `[ $(date +%s) -ge N ]` signal; else null. The `deadline` field is the timeout, not this. */
export const waitFireMs = (w: Status["waits"][number]): number | null => {
  const m = EPOCH_SIGNAL.exec(w.until);
  return m ? Number(m[1]) * 1000 : null;
};
const waitTimeoutMs = (w: Status["waits"][number]): number | null => {
  const ms = w.deadline ? Date.parse(w.deadline) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const left = (ms: number, now: number): string => {
  const min = Math.round(Math.abs(ms - now) / 60_000);
  return ms >= now ? `in ${dur(min)}` : `${dur(min)} overdue`;
};

const RUN_WORDS: Readonly<Record<string, string>> = { active: "running", inactive: "stopped", failed: "failed", activating: "starting", deactivating: "stopping", reloading: "reloading" };
const unitWords = (u: UnitState): string => {
  const run = RUN_WORDS[u.active] ?? u.active;
  if (u.name === LEGACY_PRESENCE) return `${run} (legacy, should be off)`;
  return u.enabled === "enabled" ? run : `${run}, ${u.enabled === "disabled" ? "not started at boot" : `boot setting ${u.enabled}`}`;
};
const unitName = (u: UnitState): string => u.name.replace(/\.service$/, "");

type Problem = { readonly label: string; readonly line: string };
const problems = (s: Status, now: number): Problem[] => {
  const out: Problem[] = [];
  const bad = s.services.filter((u) => (u.name === LEGACY_PRESENCE ? u.active === "active" : u.active !== "active" || u.enabled !== "enabled"));
  for (const u of bad) out.push({ label: `${unitName(u)} ${RUN_WORDS[u.active] ?? u.active}`, line: `Service ${unitName(u)}: ${unitWords(u)}` });
  if (s.gateway.state !== "live") out.push({ label: `gateway ${s.gateway.state}`, line: `Discord gateway: ${s.gateway.text}` });
  const g = s.github;
  if (g.failures.length) out.push({ label: "github poll failing", line: `GitHub poll failing: ${list(g.failures.map((f) => `${f.repo} ${ago(f.at, now)}`), 4, 200)}` });
  if (!g.issueAuthors.length) out.push({ label: "no trusted issue authors", line: "No trusted issue authors (githubIssueAuthors): new issues never wake the lead" });
  if (s.lead.state === "missing" || s.lead.state === "unknown") out.push({ label: `lead ${s.lead.state}`, line: "" });
  if (s.unacked > 0) out.push({ label: `unacked ${s.unacked}`, line: `${plural(s.unacked, "owner message")} handed to the lead and still not acked (dori ack) after ACK_MISSING` });
  const owed = s.unreported ?? [];
  if (owed.length) {
    out.push({
      label: `unreported ${owed.length}`,
      line: `Finished lanes not reported to the owner yet (dori reported <key> --text TEXT): ${list(owed.map((o) => `${o.lane} ${ago(o.since, now)}`), 6, 300)}`,
    });
  }
  const recovering = (kind: "pending" | "exhausted") => s.lanes.filter((lane) => lane.recovery === kind).map((lane) => lane.key);
  const exhausted = recovering("exhausted");
  const pending = recovering("pending");
  if (exhausted.length) out.push({ label: `recovery exhausted ${exhausted.length}`, line: `Lane recovery gave up (not relaunched or nudged): ${list(exhausted, 10, 300)}` });
  if (pending.length) out.push({ label: `recovery pending ${pending.length}`, line: `Lane recovery pending (not nudged): ${list(pending, 10, 300)}` });
  if (s.sources?.error) out.push({ label: "sources.json invalid", line: `sources.json does not read: ${clip(s.sources.error, 160)}` });
  for (const src of s.sources?.sources.filter((source) => source.failing) ?? []) {
    out.push({ label: `source ${src.name} failing`, line: `Source ${src.name} failing since ${ago(iso(src.lastErrorAt), now)}: ${clip(src.lastError ?? "?", 160)}` });
  }
  return out;
};

type Limits = { readonly lanes: number; readonly waits: number; readonly progress: number; readonly kinds: number };
const LIMITS: readonly Limits[] = [
  { lanes: 8, waits: 6, progress: 200, kinds: 10 }, { lanes: 8, waits: 6, progress: 120, kinds: 8 }, { lanes: 5, waits: 4, progress: 80, kinds: 6 },
  { lanes: 3, waits: 3, progress: 50, kinds: 4 }, { lanes: 2, waits: 2, progress: 30, kinds: 3 }, { lanes: 1, waits: 1, progress: 20, kinds: 2 },
];

const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

/** "- Event sources: discord 2m ago, github no events yet, deploys (poll) 1h ago FAILING": each source's last event age. */
const sourceLine = (s: Status, now: number, max: number): string[] => {
  if (!s.sources) return [];
  const parts = s.sources.sources.map((src) => {
    const last = src.lastEventAt === undefined ? "no events yet" : `${src.lastKind ?? "?"} ${ago(iso(src.lastEventAt), now)}`;
    return `${src.name}${src.type === "builtin" ? "" : ` (${src.type})`} ${last}${src.failing ? " FAILING" : ""}`;
  });
  return parts.length ? [`- Event sources: ${list(parts, max, 400)}`] : [];
};

/** "- brief: next 10-24 09:00 KST (in 20h)", "- backup: next ... last run failed exit 1": one line per scheduled job. */
const scheduleLines = (s: Status, now: number): string[] => (s.schedules ?? []).map((job) => {
  const next = job.waiting ? `waiting for a ${job.waiting}` : job.nextRunAt === undefined ? "no next run" : `next ${kst(job.nextRunAt)} KST (${left(job.nextRunAt, now)})`;
  return clip(`- ${job.name}: ${next}${job.lastResult && job.lastResult !== "ok" && job.lastResult !== "emitted" ? `, last run ${job.lastResult}` : ""}`, 200);
});

const perWake = (calls: number, measured: number): string => (measured ? (calls / measured).toFixed(1) : "?");

/** "- Lead woke 12 times, 8.3 model calls per wake" and "- Busiest: INBOUND 20 events, 5 wakes; ..." (wakes only for kinds that woke the lead). */
const eventLines = (e: EventStats, max: number): string[] => {
  if (!e.kinds.length) return [];
  const head = `- Lead woke ${plural(e.wakes, "time")}${e.wakes ? `, ${perWake(e.calls, e.measured)} model calls per wake` : ""}`;
  const shown = e.kinds.map((k) => `${k.kind} ${plural(k.events, "event")}${k.wakes ? `, ${plural(k.wakes, "wake")}` : ""}`);
  return [head, `- Busiest: ${list(shown, Math.min(max, 5), 220, "; ")}`];
};
/** Discord's limit is 2000 including the code fence the command adds; stay well inside. */
export const STATUS_MAX_CHARS = 1900;

type Lanes = Status["lanes"];
/** "- ops (27m, opus-5-5, dori-mode #55): Full run"; a lane in recovery starts with "[recovery gave up]" or "[recovery pending]". */
const laneLine = (lane: Lanes[number], progress: number): string => {
  const where = [lane.repo, lane.pr !== undefined ? `#${lane.pr}` : ""].filter(Boolean).join(" ");
  const facts = [dur(lane.ageMin), lane.model ? shortModel(lane.model) : "", where].filter(Boolean).join(", ");
  const flag = lane.recovery ? `[recovery ${lane.recovery === "exhausted" ? "gave up" : "pending"}] ` : "";
  return `- ${flag}${lane.key} (${facts})${lane.progress ? `: ${clip(lane.progress, progress)}` : ""}`;
};

const LEAD_WORDS: Readonly<Record<LeadState["state"], string>> = { warm: "active", cold: "idle", missing: "missing", unknown: "unknown" };
const leadLine = (l: Status["lead"]): string => {
  const state = l.state === "cold" && l.idleMin === undefined ? "stopped" : LEAD_WORDS[l.state];
  const parts = [
    `${state}${l.idleMin !== undefined ? ` (last turn ${l.idleMin < 1 ? "just now" : `${dur(l.idleMin)} ago`}, prompt cache ${l.state})` : ""}`,
    ...(l.tokens !== undefined ? [`context ${kilo(l.tokens)} of ${kilo(l.capTokens)} tokens`] : []),
  ];
  return `- ${l.pane || "(no leadPane)"}: ${parts.join(", ")}${l.note ? ` - ${clip(l.note, 100)}` : ""}`;
};

/** The line under page 1's lanes naming how many more there are (and, paged, where). */
type More = (hidden: number) => string;
const plainMore: More = (hidden) => `+${hidden} more`;

/** Short titled sections: a two-line summary, then problems, services, lead, lanes, waits, schedules, gateway and repos, activity. */
const build = (s: Status, lim: Limits, more: More = plainMore): string => {
  const now = Date.parse(s.at);
  const probs = problems(s, now);
  const counts = `${plural(s.lanes.length, "lane")} working, ${s.waits.length ? plural(s.waits.length, "wait") : "no waits"}.`;
  const lines = [
    `Dori status - ${kst(now)} KST`,
    probs.length ? `Needs attention: ${probs.slice(0, 3).map((p) => p.label).join(", ")}${probs.length > 3 ? ` +${probs.length - 3} more` : ""}. ${counts}` : `All good. ${counts}`,
  ];
  const section = (title: string, items: readonly string[]) => { if (items.length) lines.push("", title, ...items); };

  section("Problems", probs.filter((p) => p.line).map((p) => `- ${p.line}`));
  section("Services", s.services.filter((u) => u.name !== LEGACY_PRESENCE || u.active === "active").map((u) => `- ${unitName(u)}: ${unitWords(u)}`));

  const l = s.lead;
  section("Lead", [
    leadLine(l),
    ...(l.pendingRestart ? [clip(`- Restart ${l.pendingRestart.id} pending: ${l.pendingRestart.models.map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> ")}, at the next idle moment`, 300)] : []),
  ]);

  section(`Lanes (${s.lanes.length})`, s.lanes.length ? [
    ...s.lanes.slice(0, lim.lanes).map((lane) => laneLine(lane, lim.progress)),
    ...(s.lanes.length > lim.lanes ? [`- ${more(s.lanes.length - lim.lanes)}`] : []),
  ] : ["- none"]);

  section(`Waits (${s.waits.length})`, s.waits.length ? [
    ...s.waits.slice(0, lim.waits).map((w) => {
      const fire = waitFireMs(w);
      const timeout = waitTimeoutMs(w);
      const when = fire !== null ? `fires ${kst(fire)} KST (${left(fire, now)})`
        : timeout !== null ? `on signal, times out ${kst(timeout)} KST (${left(timeout, now)})`
        : `until ${clip(w.until, 50)}`;
      return `- ${w.key}: ${when}${w.note ? ` - ${clip(w.note, lim.progress)}` : ""}`;
    }),
    ...(s.waits.length > lim.waits ? [`- +${s.waits.length - lim.waits} more`] : []),
  ] : ["- none"]);

  section("Schedules", scheduleLines(s, now));

  const g = s.github;
  section("Gateway and repos", [
    `- Discord gateway: ${s.gateway.state === "live" ? "connected" : clip(s.gateway.text, 120)}`,
    `- GitHub: ${plural(g.repos.length, "repo")} watched, last poll ${ago(g.lastPollAt, now)}${g.failures.length ? `, ${plural(g.failures.length, "repo")} failing` : ""}`,
    g.issueAuthors.length ? `- Issues: watching ${plural(g.issueRepos.length, "repo")}` : "- Issues: off (no trusted authors)",
    ...sourceLine(s, now, lim.kinds),
  ]);

  section(`Activity (last ${s.events.hours}h)`, eventLines(s.events, lim.kinds));
  return lines.join("\n");
};

/** Over the limit even at the tightest LIMITS row: drop whole lines from the end, never part of one. */
const bounded = (text: string): string => {
  if (text.length <= STATUS_MAX_CHARS) return text;
  const note = "(rest not shown)";
  const lines = text.split("\n");
  let size = text.length;
  while (lines.length > 1 && size + note.length + 1 > STATUS_MAX_CHARS) size -= lines.pop()!.length + 1;
  const kept = lines.length === 1 ? [clip(lines[0]!, STATUS_MAX_CHARS - note.length - 1)] : lines;
  return [...kept, note].join("\n");
};

/** The first LIMITS row whose page 1 fits, and that text. */
const fit = (s: Status, more: More): { readonly text: string; readonly lim: Limits } => {
  for (const lim of LIMITS) {
    const text = build(s, lim, more);
    if (text.length <= STATUS_MAX_CHARS) return { text, lim };
  }
  const lim = LIMITS[LIMITS.length - 1]!;
  return { text: bounded(build(s, lim, more)), lim };
};

/** Plain text (no fence; the Discord command adds it), at most STATUS_MAX_CHARS, in short titled sections. */
export const renderStatus = (s: Status): string => fit(s, plainMore).text;

/** Lane lines on pages 2+: progress clipped like the roomiest page 1, and a line never longer than this. */
const PAGE_PROGRESS = 120;
const PAGE_LINE_MAX = 300;
/** Room left on a page for its header and its "next" line. */
const PAGE_BODY_MAX = STATUS_MAX_CHARS - 120;

/**
 * `/status` as pages, each at most STATUS_MAX_CHARS: page 1 is renderStatus (the report with its first lanes) naming the
 * pages that hold the rest, and pages 2.. list the remaining lanes in order, as many as fit, under a short header.
 */
export const statusPages = (s: Status): string[] => {
  // Choose page 1's limits with the longest "more" line it can get, so the real one never pushes it over.
  const { lim } = fit(s, (hidden) => `+${hidden} more on pages 2-99999`);
  const rest = s.lanes.slice(lim.lanes);
  if (!rest.length) return [renderStatus(s)];
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const lane of rest) {
    const line = clip(laneLine(lane, PAGE_PROGRESS), PAGE_LINE_MAX);
    if (chunk.length && size + line.length + 1 > PAGE_BODY_MAX) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(line);
    size += line.length + 1;
  }
  chunks.push(chunk);
  const total = chunks.length + 1;
  const now = kst(Date.parse(s.at));
  const first = bounded(build(s, lim, (hidden) => `+${hidden} more on page${total > 2 ? `s 2-${total}` : " 2"}`));
  return [first, ...chunks.map((lines, i) => [
    `Dori lanes - page ${i + 2} of ${total} - ${now} KST`,
    "",
    `Lanes (${s.lanes.length}), continued`,
    ...lines,
    ...(i + 2 < total ? ["", `Next: page ${i + 3}`] : []),
  ].join("\n"))];
};

/** One page of `/status` (1-based); a page past the end says how many there are. */
export const statusPage = (s: Status, page: number): string => {
  const pages = statusPages(s);
  return pages[page - 1] ?? `Dori status has ${plural(pages.length, "page")}; there is no page ${page}.`;
};

/** The /status slash command text: page 1 unless the command named another. */
export const lookupStatus = (d: StatusDeps) => async (_signal?: AbortSignal, page = 1): Promise<string> => statusPage(await collectStatus(d), page);
