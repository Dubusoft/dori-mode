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
import { WAKE_SOURCES, wakeSource, type WakeSource } from "./lead-wakes.ts";
import { listPanes } from "./panes.ts";
import type { RecoveryLane } from "./recover.ts";
import { type Lane, type Registry, statusOf } from "./registry.ts";
import { Repos } from "./repos.ts";
import type { Clock, Runner } from "./run.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { readStoreView, readWakes } from "./store.ts";
import { readRunnerRows, RUNNER_OFFLINE_MS, RUNNER_STALE_MS, type RunnerMachine, type RunnerRow } from "./runner/hub.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { probe as probeRunner, type Verdict } from "./runner/health.ts";
import { openOperations } from "./operations.ts";

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
  /** `laneWorkspace`: the supervisor-managed herdr workspace new local lane tabs open in ("" when none is recorded yet). */
  readonly lead: LeadState & { readonly cacheTtlMin: number; readonly capTokens: number; readonly pendingRestart?: LeadRestartRequest; readonly laneWorkspace: string };
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
  /** Owner messages the lead was handed and reminded about after the ack window, without acking them yet. */
  readonly unacked: number;
  /** Finished lanes (LANE_CLOSED, CI_MERGED) the lead has not reported to the owner with dori reported, oldest first. */
  readonly unreported?: readonly { readonly lane: string; readonly since: string }[];
  readonly events: EventStats;
  /** Every event source with its last event and error, and a sources.json that does not read. */
  readonly sources?: { readonly sources: readonly SourceView[]; readonly error?: string };
  /** Every scheduled job with its next run, its last run and how that ended. */
  readonly schedules?: readonly ScheduleRow[];
  /** Every runner in the hub's table (`runners.sqlite`), and always the local runner (offline until it first says hello). */
  readonly runners?: readonly RunnerView[];
};

/** One runner as `dori status` shows it. Fields the hub does not track yet are absent and print `-`. */
export type RunnerView = {
  readonly label: string;
  readonly state: "connected" | "stale" | "offline" | "lost" | "revoked";
  readonly proto?: number;
  readonly version?: string;
  readonly gen: number;
  /** Seconds since the last heartbeat the supervisor recorded. */
  readonly heartbeatAgeSec?: number;
  readonly outbox?: { readonly unacked: number; readonly oldestAgeSec: number };
  /** Commands issued and not yet acknowledged (cmdSeq - cmdAck). */
  readonly cmds: number;
  readonly restarts1h?: number;
  /** Open registry lanes on the runner's machine (see runnerLaneCount). */
  readonly lanes?: number;
  /** The machine's herdr as the runner's guard samples showed it, and since when (wall ms); absent: unknown. */
  readonly herdr?: "up" | "down" | "hung";
  readonly herdrSince?: number;
  /** The machine's readings from the runner's last guard sample (CPU load, free memory, disk, swap), and how old they are. */
  readonly machine?: Omit<RunnerMachine, "at"> & { readonly sampledAt: string; readonly ageSec: number };
  /**
   * The local runner only: its process as the supervisor's child, from the health file it writes
   * (`<runnerDir>/health`, the same reading as `dori runner probe`).
   */
  readonly child?: { readonly verdict: Verdict; readonly pid?: number; readonly healthAgeSec?: number };
};

/** The local runner child's state from its health file in `runnerDir`. */
export const localChildState = (runnerDir: string, now: number): NonNullable<RunnerView["child"]> => {
  const p = probeRunner({ runnerDir, now: () => now });
  return {
    verdict: p.verdict,
    ...(p.pid !== undefined ? { pid: p.pid } : {}),
    ...(p.healthAgeMs !== undefined ? { healthAgeSec: Math.floor(p.healthAgeMs / 1000) } : {}),
  };
};

/**
 * Every runner row, the local runner always first: an install whose supervisor never opened the hub (or whose local
 * runner never said hello) still shows `RUNNER local offline`, and `child` adds the local child's own state.
 */
export const runnerViews = (rows: readonly RunnerRow[], now: number, opts: {
  readonly restarts?: (label: string) => number | undefined; readonly lanes?: (label: string) => number; readonly child?: RunnerView["child"];
} = {}): RunnerView[] => {
  const local = rows.find((r) => r.label === LOCAL_RUNNER) ?? { label: LOCAL_RUNNER, eventAck: 0, maxGen: 0, cmdSeq: 0, cmdAck: 0 };
  return [local, ...rows.filter((r) => r.label !== LOCAL_RUNNER)].map((row) => {
    const view = runnerView(row, now, opts.restarts?.(row.label), opts.lanes?.(row.label));
    return row.label === LOCAL_RUNNER && opts.child ? { ...view, child: opts.child } : view;
  });
};

/**
 * A runner's view from its persisted row. `connected` while the last heartbeat is younger than RUNNER_STALE_MS and the
 * connection has not closed since; `stale` up to RUNNER_OFFLINE_MS; otherwise (or never heard from) `offline`. The
 * heartbeat time is the supervisor's own wall clock, written by the hub on this host.
 */
/** Restarts the liveness monitor planned for `label` in the last hour (operations rows `runner:<label>/restart/...`). */
const runnerRestarts = (config: Parameters<typeof openOperations>[0], label: string, now: number): number | undefined => {
  try {
    const ops = openOperations(config);
    try { return ops.list({ lane: `runner:${label}` }).filter((op) => op.action === "restart" && now - op.at < 60 * 60_000).length; }
    finally { ops.close(); }
  } catch { return undefined; }
};

/**
 * The open lanes on runner `label`'s machine, read from the registry so the count follows every launch and close: the
 * lanes it owns, and the unowned lanes on its host (no machine for the local runner, else `machine` is the label).
 */
export const runnerLaneCount = (lanes: readonly Lane[], label: string): number =>
  lanes.filter((l) => !l.closedAt && (l.runner ? l.runner === label : label === LOCAL_RUNNER ? !l.machine : l.machine === label)).length;

export const runnerView = (row: RunnerRow, now: number, restarts1h?: number, lanes?: number): RunnerView => {
  const hb = row.lastHeartbeatAt;
  const age = hb === undefined ? undefined : Math.max(0, now - hb);
  const closed = hb === undefined || (row.disconnectedAt !== undefined && row.disconnectedAt >= hb);
  const state = closed || age === undefined || age >= RUNNER_OFFLINE_MS ? "offline" : age >= RUNNER_STALE_MS ? "stale" : "connected";
  return {
    label: row.label, state, gen: row.maxGen, cmds: Math.max(0, row.cmdSeq - row.cmdAck),
    ...(row.proto !== undefined ? { proto: row.proto } : {}),
    ...(row.version !== undefined ? { version: row.version } : {}),
    ...(age !== undefined ? { heartbeatAgeSec: Math.floor(age / 1000) } : {}),
    ...(row.outbox ? { outbox: { unacked: row.outbox.unacked, oldestAgeSec: Math.floor(row.outbox.oldestAgeMs / 1000) } } : {}),
    ...(lanes !== undefined ? { lanes } : {}),
    ...(restarts1h !== undefined ? { restarts1h } : {}),
    ...(row.herdr ? { herdr: row.herdr } : {}),
    ...(row.herdrSince !== undefined ? { herdrSince: row.herdrSince } : {}),
    ...(row.machine ? { machine: machineView(row.machine, now) } : {}),
  };
};

const machineView = ({ at, ...rest }: RunnerMachine, now: number): NonNullable<RunnerView["machine"]> =>
  ({ ...rest, sampledAt: new Date(at).toISOString(), ageSec: Math.max(0, Math.floor((now - at) / 1000)) });

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
  /** The wakes by who they were for (lead-wakes.ts wakeSource); they add up to `wakes`. */
  readonly sources: Readonly<Record<WakeSource, number>>;
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
  const sources = Object.fromEntries(WAKE_SOURCES.map((source) => [source, 0])) as Record<WakeSource, number>;
  for (const wake of wakes) {
    sources[wakeSource(wake.trigger)]++;
    if (wake.calls !== undefined) { measured++; calls += wake.calls; }
    for (const kind of wake.trigger) {
      const entry = of(kind);
      entry.wakes++;
      if (wake.calls !== undefined) { entry.measured++; entry.calls += wake.calls; }
    }
  }
  return {
    hours: STATS_HOURS, wakes: wakes.length, sources, measured, calls,
    kinds: [...kinds].map(([kind, s]) => ({ kind, ...s })).sort((a, b) => b.wakes - a.wakes || b.events - a.events || a.kind.localeCompare(b.kind)),
  };
};

export type StatusDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly config: DoriConfig;
  readonly registry: Registry;
  /** The runner directory whose health file tells the local runner child's state; without it no child state is shown. */
  readonly runnerDir?: string;
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
    lead: { ...lead, cacheTtlMin: d.config.cacheTtlMin, capTokens: d.config.leadContextCapTokens, laneWorkspace: d.config.laneWorkspace, ...(pendingRestart ? { pendingRestart } : {}) },
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
    runners: runnerViews(readRunnerRows(d.config.stateDir), now, {
      restarts: (label) => runnerRestarts(d.config, label, now), lanes: (label) => runnerLaneCount(open, label),
      ...(d.runnerDir ? { child: localChildState(d.runnerDir, now) } : {}),
    }),
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
/** "레인 3개": a count with its counter word. */
const count = (n: number, word: string, unit = "개"): string => `${word} ${n}${unit}`;
/** Whole items joined by `sep`: at most `count` of them in about `max` characters, then "외 N개". */
const list = (items: readonly string[], limit: number, max: number, sep = ", "): string => {
  const shown: string[] = [];
  let size = 0;
  for (const item of items.slice(0, limit)) {
    if (shown.length && size + item.length + sep.length > max - 12) break;
    const one = shown.length ? item : clip(item, max - 12);
    shown.push(one);
    size += one.length + sep.length;
  }
  const hidden = items.length - shown.length;
  return `${shown.join(sep)}${hidden ? `${sep}외 ${hidden}개` : ""}`;
};
const kilo = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** "27분", "3시간", "2일". */
const dur = (min: number): string => (min < 120 ? `${min}분` : min < 2880 ? `${Math.round(min / 60)}시간` : `${Math.round(min / 1440)}일`);
const ago = (iso: string | undefined, now: number): string => {
  if (!iso) return "없음";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return min < 1 ? "방금" : `${dur(min)} 전`;
};
/** "40초 전", "5분 전": an age in seconds. */
const agoSec = (sec: number): string => (sec < 60 ? `${sec}초 전` : `${dur(Math.round(sec / 60))} 전`);

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
/** "21시간 후" or "5분 지남". */
const left = (ms: number, now: number): string => {
  const min = Math.round(Math.abs(ms - now) / 60_000);
  return ms >= now ? `${dur(min)} 후` : `${dur(min)} 지남`;
};

const RUN_WORDS: Readonly<Record<string, string>> = { active: "실행 중", inactive: "중지됨", failed: "실패", activating: "시작 중", deactivating: "중지 중", reloading: "다시 읽는 중", unknown: "알 수 없음" };
const unitWords = (u: UnitState): string => {
  const run = RUN_WORDS[u.active] ?? u.active;
  if (u.name === LEGACY_PRESENCE) return `${run} (예전 유닛, 꺼야 함)`;
  return u.enabled === "enabled" ? run : `${run}, ${u.enabled === "disabled" ? "부팅 시 자동 시작 안 함" : `부팅 설정 ${u.enabled === "unknown" ? "알 수 없음" : u.enabled}`}`;
};
const unitName = (u: UnitState): string => u.name.replace(/\.service$/, "");

const GATEWAY_WORDS: Readonly<Record<string, string>> = { missing: "상태 파일 없음", stale: "응답 끊김", disconnected: "연결 안 됨", "no-content": "메시지 내용 권한 없음" };
const gatewayWords = (g: GatewayView): string => GATEWAY_WORDS[g.state] ?? g.state;
/** The gateway's state with the heartbeat age its English text carries, in Korean. */
const gatewayDetail = (g: GatewayView): string => {
  const sec = /(\d+)s ago/.exec(g.text)?.[1];
  const beat = sec === undefined ? "" : ` (하트비트 ${agoSec(Number(sec))})`;
  switch (g.state) {
    case "missing": return "상태 파일 없음 (수퍼바이저가 꺼져 있거나 예전 빌드)";
    case "stale": return `응답 끊김${beat}`;
    case "disconnected": return `연결 안 됨${beat}`;
    case "no-content": return `메시지 내용 권한 없이 연결됨, REST로 대신 읽음${beat}`;
    default: return clip(g.text, 120);
  }
};

const RUNNER_WORDS: Readonly<Record<RunnerView["state"], string>> = { connected: "연결됨", stale: "응답 늦음", offline: "오프라인", lost: "끊김", revoked: "해지됨" };
const HERDR_WORDS: Readonly<Record<NonNullable<RunnerView["herdr"]>, string>> = { up: "정상", down: "다운", hung: "멈춤" };
const CHILD_WORDS: Readonly<Record<Verdict, string>> = { healthy: "정상", stalled: "멈춤", dead: "없음" };
const LEVEL_WORDS: Readonly<Record<RunnerMachine["level"], string>> = { ok: "정상", alert: "경고", critical: "위험" };

/** "120GB", "8.5GB": free space or memory in GB, one decimal under 10. */
const gb = (n: number): string => `${n < 10 ? n.toFixed(1) : Math.round(n)}GB`;

/**
 * One runner's machine as two lines:
 * "- local (linux): 연결됨 · 레인 3개 · herdr 정상" and
 * "  CPU 부하 1.2 · 메모리 여유 35% · 디스크 여유 120GB · 스왑 여유 2.0/4.0GB (1분 전 측정)".
 * The first line adds only what needs a look (an old heartbeat, a backlog, restarts, a local child that is not healthy).
 */
export const machineLines = (r: RunnerView): string[] => {
  const m = r.machine;
  const level = m && m.level !== "ok" ? `[${LEVEL_WORDS[m.level]}] ` : "";
  const head = [
    RUNNER_WORDS[r.state],
    ...(r.state !== "connected" && r.heartbeatAgeSec !== undefined ? [`마지막 응답 ${agoSec(r.heartbeatAgeSec)}`] : []),
    ...(r.lanes !== undefined ? [count(r.lanes, "레인")] : []),
    `herdr ${r.herdr ? HERDR_WORDS[r.herdr] : "미확인"}`,
    ...(r.outbox && r.outbox.unacked > 0 ? [`미전달 이벤트 ${r.outbox.unacked}개 (가장 오래된 것 ${agoSec(r.outbox.oldestAgeSec)})`] : []),
    ...(r.cmds > 0 ? [`응답 대기 명령 ${r.cmds}개`] : []),
    ...(r.restarts1h ? [`최근 1시간 재시작 ${r.restarts1h}회`] : []),
    ...(r.child && r.child.verdict !== "healthy" ? [`러너 프로세스 ${CHILD_WORDS[r.child.verdict]}`] : []),
    ...(r.version ? [`버전 ${r.version.slice(0, 7)}`] : []),
  ];
  const os = m?.os ? ` (${m.os})` : "";
  const first = `- ${level}${r.label}${os}: ${head.join(" · ")}`;
  if (!m) return [first, "  머신 샘플 없음"];
  const known = (n: number | undefined): n is number => n !== undefined && n >= 0;
  const facts = [
    ...(known(m.load1) ? [`CPU 부하 ${m.load1.toFixed(1)}`] : []),
    ...(known(m.memFreePct) ? [`메모리 여유 ${m.memFreePct}%`] : []),
    ...(known(m.diskFreeGb) ? [`디스크 여유 ${gb(m.diskFreeGb)}`] : []),
    ...(m.swapTotalGb === 0 ? ["스왑 없음"] : known(m.swapTotalGb) && known(m.swapFreeGb) ? [`스왑 여유 ${m.swapFreeGb.toFixed(1)}/${m.swapTotalGb.toFixed(1)}GB`] : []),
    ...(m.lanesRssKb !== undefined && m.lanesRssKb > 0 ? [`레인 메모리 ${gb(m.lanesRssKb / 1_048_576)}`] : []),
  ];
  return [first, `  ${facts.length ? facts.join(" · ") : "읽은 값 없음"} (${agoSec(m.ageSec)} 측정)`];
};

const LEAD_NOTES: Readonly<Record<string, string>> = {
  "pane not found in herdr": "herdr에 리드 패널이 없음",
  "no agent running in the lead pane": "리드 패널에 실행 중인 에이전트 없음",
  "cannot resolve the lead session": "리드 세션을 찾지 못함",
  "lead session file not found": "리드 세션 파일 없음",
};
const LEAD_WORDS: Readonly<Record<LeadState["state"], string>> = { warm: "활동 중", cold: "쉬는 중", missing: "없음", unknown: "알 수 없음" };

type Problem = { readonly label: string; readonly line: string };
const problems = (s: Status, now: number): Problem[] => {
  const out: Problem[] = [];
  const bad = s.services.filter((u) => (u.name === LEGACY_PRESENCE ? u.active === "active" : u.active !== "active" || u.enabled !== "enabled"));
  for (const u of bad) out.push({ label: `${unitName(u)} ${RUN_WORDS[u.active] ?? u.active}`, line: `서비스 ${unitName(u)}: ${unitWords(u)}` });
  if (s.gateway.state !== "live") out.push({ label: `게이트웨이 ${gatewayWords(s.gateway)}`, line: `Discord 게이트웨이: ${gatewayDetail(s.gateway)}` });
  const g = s.github;
  if (g.failures.length) out.push({ label: "GitHub 폴링 실패", line: `GitHub 폴링 실패: ${list(g.failures.map((f) => `${f.repo} ${ago(f.at, now)}`), 4, 200)}` });
  if (!g.issueAuthors.length) out.push({ label: "신뢰 이슈 작성자 없음", line: "신뢰하는 이슈 작성자 없음 (githubIssueAuthors): 새 이슈가 리드를 깨우지 않음" });
  if (s.lead.state === "missing" || s.lead.state === "unknown") out.push({ label: `리드 ${LEAD_WORDS[s.lead.state]}`, line: "" });
  if (s.unacked > 0) out.push({ label: `미확인 메시지 ${s.unacked}`, line: `리드에 넘긴 오너 메시지 ${s.unacked}개가 확인 시간이 지나도 ack 안 됨 (dori ack)` });
  const owed = s.unreported ?? [];
  if (owed.length) {
    out.push({
      label: `미보고 레인 ${owed.length}`,
      line: `끝났지만 오너에게 아직 보고 안 한 레인 (dori reported <key> --text TEXT): ${list(owed.map((o) => `${o.lane} ${ago(o.since, now)}`), 6, 300)}`,
    });
  }
  const recovering = (kind: "pending" | "exhausted") => s.lanes.filter((lane) => lane.recovery === kind).map((lane) => lane.key);
  const exhausted = recovering("exhausted");
  const pending = recovering("pending");
  if (exhausted.length) out.push({ label: `복구 포기 ${exhausted.length}`, line: `레인 복구 포기 (재실행·넛지 안 함): ${list(exhausted, 10, 300)}` });
  if (pending.length) out.push({ label: `복구 대기 ${pending.length}`, line: `레인 복구 대기 (넛지 안 함): ${list(pending, 10, 300)}` });
  for (const r of s.runners ?? []) {
    const m = r.machine;
    if (!m || m.level === "ok") continue;
    out.push({ label: `머신 ${r.label} ${LEVEL_WORDS[m.level]}`, line: `머신 ${r.label} ${LEVEL_WORDS[m.level]}: ${clip(m.reasons.join(", ") || "이유 없음", 200)}` });
  }
  if (s.sources?.error) out.push({ label: "sources.json 오류", line: `sources.json 읽기 실패: ${clip(s.sources.error, 160)}` });
  for (const src of s.sources?.sources.filter((source) => source.failing) ?? []) {
    out.push({ label: `소스 ${src.name} 실패`, line: `소스 ${src.name} 실패 (${ago(iso(src.lastErrorAt), now)}부터): ${clip(src.lastError ?? "?", 160)}` });
  }
  return out;
};

type Limits = { readonly lanes: number; readonly waits: number; readonly progress: number; readonly kinds: number };
const LIMITS: readonly Limits[] = [
  { lanes: 8, waits: 6, progress: 200, kinds: 10 }, { lanes: 8, waits: 6, progress: 120, kinds: 8 }, { lanes: 5, waits: 4, progress: 80, kinds: 6 },
  { lanes: 3, waits: 3, progress: 50, kinds: 4 }, { lanes: 2, waits: 2, progress: 30, kinds: 3 }, { lanes: 1, waits: 1, progress: 20, kinds: 2 },
];

const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

/** "- 이벤트 소스: discord INBOUND 2분 전, github 이벤트 없음, deploys (poll) ... 실패": each source's last event age. */
const sourceLine = (s: Status, now: number, max: number): string[] => {
  if (!s.sources) return [];
  const parts = s.sources.sources.map((src) => {
    const last = src.lastEventAt === undefined ? "이벤트 없음" : `${src.lastKind ?? "?"} ${ago(iso(src.lastEventAt), now)}`;
    return `${src.name}${src.type === "builtin" ? "" : ` (${src.type})`} ${last}${src.failing ? " 실패" : ""}`;
  });
  return parts.length ? [`- 이벤트 소스: ${list(parts, max, 400)}`] : [];
};

/** "- brief: 다음 10-24 09:00 KST (20시간 후)", "- backup: ..., 지난 실행 failed exit 1": one line per scheduled job. */
const scheduleLines = (s: Status, now: number): string[] => (s.schedules ?? []).map((job) => {
  const next = job.waiting ? `${job.waiting} 기다리는 중` : job.nextRunAt === undefined ? "다음 실행 없음" : `다음 ${kst(job.nextRunAt)} KST (${left(job.nextRunAt, now)})`;
  return clip(`- ${job.name}: ${next}${job.lastResult && job.lastResult !== "ok" && job.lastResult !== "emitted" ? `, 지난 실행 ${job.lastResult}` : ""}`, 200);
});

const perWake = (calls: number, measured: number): string => (measured ? (calls / measured).toFixed(1) : "?");

const SOURCE_WORDS: Readonly<Record<WakeSource, string>> = { owner: "소유자", lane: "레인", noise: "노이즈" };

/** "- 리드 깨움 12회 (소유자 5 · 레인 4 · 노이즈 3), 깨울 때마다 모델 호출 8.3회" and "- 많은 순: INBOUND 이벤트 20 · 깨움 5; ..." (깨움 only for kinds that woke the lead). */
const eventLines = (e: EventStats, max: number): string[] => {
  if (!e.kinds.length) return [];
  const split = e.wakes ? ` (${WAKE_SOURCES.map((source) => `${SOURCE_WORDS[source]} ${e.sources[source]}`).join(" · ")})` : "";
  const head = `- 리드 깨움 ${e.wakes}회${split}${e.wakes ? `, 깨울 때마다 모델 호출 ${perWake(e.calls, e.measured)}회` : ""}`;
  const shown = e.kinds.map((k) => `${k.kind} 이벤트 ${k.events}${k.wakes ? ` · 깨움 ${k.wakes}` : ""}`);
  return [head, `- 많은 순: ${list(shown, Math.min(max, 5), 220, "; ")}`];
};
/** Discord's limit is 2000 including the code fence the command adds; stay well inside. */
export const STATUS_MAX_CHARS = 1900;

type Lanes = Status["lanes"];
/** "- ops (27분 · opus-5-5 · dori-mode #55): Full run"; a lane in recovery starts with "[복구 포기]" or "[복구 대기]". */
const laneLine = (lane: Lanes[number], progress: number): string => {
  const where = [lane.repo, lane.pr !== undefined ? `#${lane.pr}` : ""].filter(Boolean).join(" ");
  const facts = [dur(lane.ageMin), lane.model ? shortModel(lane.model) : "", where].filter(Boolean).join(" · ");
  const flag = lane.recovery ? `[복구 ${lane.recovery === "exhausted" ? "포기" : "대기"}] ` : "";
  return `- ${flag}${lane.key} (${facts})${lane.progress ? `: ${clip(lane.progress, progress)}` : ""}`;
};

const leadLine = (l: Status["lead"]): string => {
  const state = l.state === "cold" && l.idleMin === undefined ? "멈춤" : LEAD_WORDS[l.state];
  const parts = [
    `${state}${l.idleMin !== undefined ? ` (마지막 턴 ${l.idleMin < 1 ? "방금" : `${dur(l.idleMin)} 전`}, 프롬프트 캐시 ${l.state === "warm" ? "유지" : "만료"})` : ""}`,
    ...(l.tokens !== undefined ? [`컨텍스트 ${kilo(l.tokens)}/${kilo(l.capTokens)} 토큰`] : []),
  ];
  const note = l.note ? LEAD_NOTES[l.note] ?? l.note : undefined;
  return `- ${l.pane || "(리드 패널 기록 없음)"}: ${parts.join(" · ")}${note ? ` - ${clip(note, 100)}` : ""}`;
};

/** The line under page 1's lanes naming how many more there are (and, paged, where). */
type More = (hidden: number) => string;
const plainMore: More = (hidden) => `외 ${hidden}개`;

/** Short titled sections: a two-line summary, then problems, services, lead, lanes, waits, schedules, machines, connections, activity. */
const build = (s: Status, lim: Limits, more: More = plainMore): string => {
  const now = Date.parse(s.at);
  const probs = problems(s, now);
  const counts = `작업 중 레인 ${s.lanes.length}개 · ${s.waits.length ? `대기 ${s.waits.length}개` : "대기 없음"}`;
  const lines = [
    `도리 상태 · ${kst(now)} KST`,
    probs.length ? `⚠️ 확인 필요: ${probs.slice(0, 3).map((p) => p.label).join(", ")}${probs.length > 3 ? ` 외 ${probs.length - 3}건` : ""} · ${counts}` : `✅ 모두 정상 · ${counts}`,
  ];
  const section = (title: string, items: readonly string[]) => { if (items.length) lines.push("", `■ ${title}`, ...items); };

  section("문제", probs.filter((p) => p.line).map((p) => `- ${p.line}`));
  section("서비스", s.services.filter((u) => u.name !== LEGACY_PRESENCE || u.active === "active").map((u) => `- ${unitName(u)}: ${unitWords(u)}`));

  const l = s.lead;
  section("리드", [
    leadLine(l),
    `- 새 레인 워크스페이스: ${l.laneWorkspace || "아직 없음 (수퍼바이저가 만듦)"}`,
    ...(l.pendingRestart ? [clip(`- 재시작 ${l.pendingRestart.id} 대기 중: ${l.pendingRestart.models.map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> ")}, 다음 유휴 때`, 300)] : []),
  ]);

  section(`레인 (${s.lanes.length})`, s.lanes.length ? [
    ...s.lanes.slice(0, lim.lanes).map((lane) => laneLine(lane, lim.progress)),
    ...(s.lanes.length > lim.lanes ? [`- ${more(s.lanes.length - lim.lanes)}`] : []),
  ] : ["- 없음"]);

  section(`대기 (${s.waits.length})`, s.waits.length ? [
    ...s.waits.slice(0, lim.waits).map((w) => {
      const fire = waitFireMs(w);
      const timeout = waitTimeoutMs(w);
      const when = fire !== null ? `${kst(fire)} KST에 실행 (${left(fire, now)})`
        : timeout !== null ? `신호 대기, ${kst(timeout)} KST 시한 (${left(timeout, now)})`
        : `조건: ${clip(w.until, 50)}`;
      return `- ${w.key}: ${when}${w.note ? ` - ${clip(w.note, lim.progress)}` : ""}`;
    }),
    ...(s.waits.length > lim.waits ? [`- 외 ${s.waits.length - lim.waits}개`] : []),
  ] : ["- 없음"]);

  section("예약 작업", scheduleLines(s, now));
  section(`머신 (${(s.runners ?? []).length})`, (s.runners ?? []).flatMap(machineLines));

  const g = s.github;
  section("연결", [
    `- Discord 게이트웨이: ${s.gateway.state === "live" ? "연결됨" : gatewayWords(s.gateway)}`,
    `- GitHub: 저장소 ${g.repos.length}개 감시, 마지막 폴링 ${ago(g.lastPollAt, now)}${g.failures.length ? `, ${g.failures.length}개 실패` : ""}`,
    g.issueAuthors.length ? `- 이슈: 저장소 ${g.issueRepos.length}개 감시` : "- 이슈: 꺼짐 (신뢰 작성자 없음)",
    ...sourceLine(s, now, lim.kinds),
  ]);

  section(`활동 (최근 ${s.events.hours}시간)`, eventLines(s.events, lim.kinds));
  return lines.join("\n");
};

/** Over the limit even at the tightest LIMITS row: drop whole lines from the end, never part of one. */
const bounded = (text: string): string => {
  if (text.length <= STATUS_MAX_CHARS) return text;
  const note = "(나머지 생략)";
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
  const { lim } = fit(s, (hidden) => `외 ${hidden}개 (2-99999쪽)`);
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
  const first = bounded(build(s, lim, (hidden) => `외 ${hidden}개 (${total > 2 ? `2-${total}` : "2"}쪽)`));
  return [first, ...chunks.map((lines, i) => [
    `도리 레인 · ${i + 2}/${total}쪽 · ${now} KST`,
    "",
    `■ 레인 (${s.lanes.length}) 이어서`,
    ...lines,
    ...(i + 2 < total ? ["", `다음: /status page:${i + 3}`] : []),
  ].join("\n"))];
};

/** One page of `/status` (1-based); a page past the end says how many there are. */
export const statusPage = (s: Status, page: number): string => {
  const pages = statusPages(s);
  return pages[page - 1] ?? `도리 상태는 ${pages.length}쪽까지 있습니다. ${page}쪽은 없습니다.`;
};

/** The /status slash command text: page 1 unless the command named another. */
export const lookupStatus = (d: StatusDeps) => async (_signal?: AbortSignal, page = 1): Promise<string> => statusPage(await collectStatus(d), page);
