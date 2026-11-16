import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";
import { Database } from "bun:sqlite";

import { GITHUB_FILE, loadGithub } from "../src/github-events.ts";
import { LaneOpsError, type Delivery, type LaneOps, type LaneRef, runnerOf, machineRunner } from "../src/lane-ops.ts";
import type { Pane } from "../src/panes.ts";
import type { CommandResults, LaneInspection, TurnEvidence, LaneOutputFiles } from "../src/runner/protocol.ts";
import { laneStatus } from "../src/runner/serve.ts";
import { checkDone } from "../src/signals.ts";
import { JOURNAL_FILE, SQLITE_FILE, SqliteStore, type StoreKind } from "../src/store.ts";
import type { Journal } from "../src/supervise.ts";
import { BUILT_IN, builtInTunables, type Tunables } from "../src/tunables.ts";

/** The journal store the suite runs against: DORI_TEST_STORE=sqlite runs every supervisor test on supervisor.sqlite. */
export const TEST_STORE: StoreKind = process.env.DORI_TEST_STORE === "sqlite" ? "sqlite" : "json";

/** The supervisor journal as stored, whichever store the suite runs on. */
export const readJournal = (stateDir: string): any => {
  if (TEST_STORE === "json") return JSON.parse(readFileSync(join(stateDir, JOURNAL_FILE), "utf8"));
  const store = new SqliteStore(join(stateDir, SQLITE_FILE));
  try { return store.read(false); } finally { store.close(); }
};

/** The GitHub poll state as stored, whichever store the suite runs on. */
export const readGithub = (stateDir: string): any => {
  if (TEST_STORE === "json") return JSON.parse(readFileSync(join(stateDir, GITHUB_FILE), "utf8"));
  const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
  try { return loadGithub(db); } finally { db.close(); }
};

/** Seeds the journal a supervisor will start from, replacing any stored one. */
export const writeJournal = (stateDir: string, journal: unknown): void => {
  if (TEST_STORE === "json") { writeFileSync(join(stateDir, JOURNAL_FILE), JSON.stringify(journal)); return; }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(stateDir, `${SQLITE_FILE}${suffix}`), { force: true });
  const store = new SqliteStore(join(stateDir, SQLITE_FILE), { create: true });
  try { store.save(journal as Journal, "normal"); } finally { store.close(); }
};

/** Every byte the journal store holds on disk (for the sqlite store: the database and its WAL). */
export const journalBytes = (stateDir: string): string => (TEST_STORE === "json" ? [JOURNAL_FILE] : [SQLITE_FILE, `${SQLITE_FILE}-wal`])
  .filter((name) => existsSync(join(stateDir, name))).map((name) => readFileSync(join(stateDir, name), "latin1")).join("");

export type World = {
  files?: LaneOutputFiles;
  prState: string;
  /** What `gh pr list` answers (a `pr <repo> <branch>` signal read); unset, it answers like `gh pr view`. */
  prList?: unknown[];
  issueState: string;
  aheadCount: string;
  dirty: string;
  screen: string;
  panes: { pane_id: string; workspace_id: string; tab_id?: string; agent?: string; agent_status?: string; title?: string; terminal_title?: string; cwd?: string }[];
  /** agent_status the target pane moves to when Enter is pressed (models a lane picking up the message). */
  onEnterStatus?: string;
  /** agent_status the target pane moves to when Escape is pressed (models a running turn stopping). */
  onEscapeStatus?: string;
  /** Screens returned by successive reads; falls back to `screen` when empty. */
  screens?: string[];
  /** Worktrees a successful `git worktree remove` took away: no longer listed, and `exists` reads them gone. */
  removed: string[];
  calls: string[][];
  /** Every LaneOps call fakeLaneOps(w) took, in order. */
  ops: OpsEntry[];
  /** What a send answers (default "delivered"). */
  sendDelivery?: Delivery;
  pauseResult?: CommandResults["lane.pause"];
  /** What a resume answers (default: goal confirmed, turn running). */
  resumeResult?: CommandResults["lane.resume"];
  /** What `ops.turn` answers (the runner's last stopped turn of an idle lane). */
  turn?: TurnEvidence;
  /** Merged over the inspection fakeLaneOps derives from the World. */
  inspection?: Partial<LaneInspection>;
  startResult?: CommandResults["lane.start"];
  /** What `lane-sandbox --check` answers (default exit 0: the local sandbox works). */
  sandboxCheck?: Ran;
  /** Every runner is down: reads and effects throw RUNNER_UNAVAILABLE, send answers "failed", status an error. */
  runnerDown?: boolean;
  /** The herdr workspaces `herdr workspace list` answers; `workspace create` adds one (`w<n>`). */
  workspaces: { label?: string; workspace_id: string }[];
};

export type OpsEntry = { readonly op: keyof LaneOps; readonly key?: string; readonly args: unknown };

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", screen: "❯ ", panes: [], removed: [], calls: [], ops: [], workspaces: [{ label: "lanes", workspace_id: "wL" }] });

export const fakeRunner = (w: World): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if (cmd === "herdr" && a1 === "pane" && a2 === "read") {
    return ok(w.screens?.length ? (w.screens.shift() ?? w.screen) : w.screen);
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "send-keys" && argv[4] === "escape" && w.onEscapeStatus) {
    const p = w.panes.find((x) => x.pane_id === argv[3]);
    if (p) p.agent_status = w.onEscapeStatus;
    return ok();
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "send-keys" && w.onEnterStatus) {
    const p = w.panes.find((x) => x.pane_id === argv[3]);
    if (p) p.agent_status = w.onEnterStatus;
    return ok();
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: w.panes } }));
  if (cmd === "herdr" && a1 === "workspace" && a2 === "list") return ok(JSON.stringify({ result: { workspaces: w.workspaces } }));
  if (cmd === "herdr" && a1 === "workspace" && a2 === "create") {
    const label = argv[argv.indexOf("--label") + 1];
    w.workspaces.push({ ...(label ? { label } : {}), workspace_id: `w${w.workspaces.length + 1}` });
    return ok();
  }
  // A closed pane leaves the pane list, so a close's read-back sees it gone.
  if (cmd === "herdr" && a1 === "pane" && a2 === "close") w.panes = w.panes.filter((p) => p.pane_id !== argv[3]);
  if (cmd === "herdr") return ok();
  if (cmd === "git" && argv.includes("worktree") && argv.includes("remove")) {
    const wt = argv.at(-1) ?? "";
    if (!w.removed.includes(wt)) w.removed.push(wt);
    return ok();
  }
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) {
    return ok(`worktree /repo\nbranch refs/heads/main${w.removed.includes(WT) ? "" : `\n\nworktree ${WT}\nbranch refs/heads/demo-lane`}`);
  }
  if (cmd === "git" && argv.includes("status")) return ok(w.dirty);
  if (cmd === "git" && argv.includes("rev-list")) return ok(w.aheadCount);
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr" && a2 === "list" && w.prList) return ok(JSON.stringify(w.prList));
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  if (cmd === "lane-sandbox" && a1 === "--check") return w.sandboxCheck ?? ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

/**
 * An injected supervise() pause that waits for the test instead of real time: each loop parks until `tick()` (or its
 * abort), so a test moves the fake clock first and then lets every parked loop take its next pass.
 */
export const manualPause = (): { pause: (ms: number, signal: AbortSignal) => Promise<void>; tick: () => void; parked: () => number } => {
  const waiting = new Set<() => void>();
  return {
    pause: (_ms, signal) => new Promise<void>((resolve) => {
      const done = () => { waiting.delete(done); signal.removeEventListener("abort", done); resolve(); };
      waiting.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    }),
    tick: () => { for (const done of [...waiting]) done(); },
    parked: () => waiting.size,
  };
};

/**
 * On the sqlite test store, creates the state dir's database as `dori store import` does on a real host: closes, the
 * watcher and recovery keep their operation rows there and refuse a sqlite store without it (STORE_MISSING).
 */
export const withSqliteStore = (stateDir: string): void => {
  if (TEST_STORE === "sqlite" && !existsSync(join(stateDir, SQLITE_FILE))) new SqliteStore(join(stateDir, SQLITE_FILE), { create: true }).close();
};

export const withState = (root = tmpdir()): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(root, "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * A LaneOps over the World: panes from w.panes, screens from w.screens/w.screen, send applies w.onEnterStatus and logs,
 * close drops the pane, git worktree-remove pushes w.removed, inspect derives git facts from w.dirty/w.aheadCount/w.removed
 * and runs Done checks through fakeRunner(w); w.runnerDown makes every call throw LaneOpsError RUNNER_UNAVAILABLE (send
 * answers "failed", notify and status never throw, as the real facade). Every call is recorded in w.ops.
 */
export const fakeLaneOps = (w: World): LaneOps => {
  const record = (op: keyof LaneOps, key: string | undefined, args: unknown): void => { w.ops.push({ op, ...(key !== undefined ? { key } : {}), args }); };
  const down = (label: string): void => { if (w.runnerDown) throw new LaneOpsError("RUNNER_UNAVAILABLE", label, "disconnected: the fake World's runner is down"); };
  const paneOf = (id: string | undefined): World["panes"][number] | undefined => w.panes.find((p) => p.pane_id === id);
  const setStatus = (id: string | undefined, status: string | undefined): void => {
    const p = paneOf(id);
    if (p && status) p.agent_status = status;
  };
  const statusOf = (lane: LaneRef) => laneStatus(paneOf(lane.pane) as Pane | undefined);
  return {
    files: async (lane) => { record("files", lane.key, {}); down(runnerOf(lane)); return w.files; },
    panes: async (machine) => { record("panes", undefined, { machine }); down(machineRunner(machine)); return w.panes.map((p) => ({ ...p })); },
    screen: async (ref, lines) => {
      record("screen", undefined, { ...ref, lines }); down(machineRunner(ref.machine));
      return w.screens?.length ? (w.screens.shift() ?? w.screen) : w.screen;
    },
    processInfo: async (ref) => {
      record("processInfo", undefined, { ...ref }); down(machineRunner(ref.machine));
      const info = w.inspection?.process;
      return info ? { code: 0, out: JSON.stringify({ result: { process_info: info } }), err: "" } : { code: 1, out: "", err: "no process info in the fake World" };
    },
    status: async (ref) => {
      record("status", undefined, { ...ref });
      if (w.runnerDown) return { error: `RUNNER_UNAVAILABLE runner=${machineRunner(ref.machine)} disconnected` };
      return { status: paneOf(ref.pane)?.agent_status };
    },
    exists: async (machine, paths) => { record("exists", undefined, { machine, paths }); down(machineRunner(machine)); return paths.map((p) => !w.removed.includes(p)); },
    inspect: async (lane, want) => {
      record("inspect", lane.key, { lane, want }); down(runnerOf(lane));
      const cwd = want.cwd ?? (lane.machine ? lane.remoteCwd : lane.cwd) ?? "/repo";
      const dirty = w.dirty !== "";
      const ahead = Number(w.aheadCount) || 0;
      const worktrees = [
        { path: "/repo", branch: "main", dirty, ahead, exists: true },
        ...(w.removed.includes(WT) ? [] : [{ path: WT, branch: "demo-lane", dirty, ahead, exists: true }]),
      ];
      const pane = paneOf(lane.pane) as Pane | undefined;
      const done = want.done !== undefined
        ? { cwd: lane.machine ? (want.doneCwd ?? "/repo") : cwd, fallback: false, checks: await checkDone(want.done, fakeRunner(w), { cwd }) }
        : undefined;
      const derived: LaneInspection = {
        status: statusOf(lane), ...(pane ? { pane } : {}), cwd, cwdExists: !w.removed.includes(cwd),
        ...(want.git ? {
          git: {
            toplevel: "/repo", branch: "main", worktrees,
            ...(want.branches ? { branches: Object.fromEntries(want.branches.map((b) => [b, { local: true, remote: false }])) } : {}),
          },
        } : {}),
        ...(done ? { done } : {}),
      };
      return { ...derived, ...w.inspection };
    },
    observeMachine: async (machine) => {
      record("observeMachine", undefined, { machine }); down(machineRunner(machine));
      const panes = w.panes.map((p) => ({ ...p }));
      return { os: "linux", sampledAt: 0, sample: { load1: 0, memFreePct: 100, diskFreeGb: 100, swapFreeGb: 0, swapTotalGb: 0, panes: panes.length }, panes };
    },
    send: async (lane, text, opts) => {
      record("send", lane.key, { text, ...(opts ? { opts } : {}) });
      if (w.runnerDown) return "failed";
      setStatus(lane.pane, w.onEnterStatus);
      return w.sendDelivery ?? "delivered";
    },
    pause: async (lane, step) => {
      record("pause", lane.key, { step }); down(runnerOf(lane));
      if (step !== "goal") setStatus(lane.pane, w.onEscapeStatus);
      return w.pauseResult ?? { goal: "confirmed", working: false, stopped: true };
    },
    resume: async (lane) => { record("resume", lane.key, {}); down(runnerOf(lane)); return w.resumeResult ?? { goal: "confirmed", execution: "running" }; },
    start: async (input) => {
      record("start", input.key, input); down(machineRunner(input.machine));
      if (w.startResult) return w.startResult;
      const pane = `w-${input.key}:p1`;
      w.panes.push({ pane_id: pane, workspace_id: `w-${input.key}`, tab_id: `w-${input.key}:t1`, agent: "omo", agent_status: "working", cwd: input.cwd });
      return { pane, tab: `w-${input.key}:t1`, startup: { verdict: "ok", detail: "" } };
    },
    adopt: async (input) => {
      record("adopt", input.key, input); down(machineRunner(input.machine));
      return { pane: input.pane, tab: paneOf(input.pane)?.tab_id ?? "", tokenFile: `/home/test/.dori/runner/briefs/${input.key}.token` };
    },
    recover: async (lane, opts) => {
      record("recover", lane.key, { ...(opts ? { opts } : {}) }); down(runnerOf(lane));
      return { pane: lane.pane ?? "", tab: lane.tab ?? "", relaunched: true, resumed: opts?.session !== undefined };
    },
    close: async (lane, opts) => {
      record("close", lane.key, { ...(opts ? { opts } : {}) }); down(runnerOf(lane));
      const had = paneOf(lane.pane) !== undefined;
      w.panes = w.panes.filter((p) => p.pane_id !== lane.pane);
      return { closed: lane.tab ? "tab" : had ? "pane" : "none", gone: true };
    },
    git: async (lane, op, opts) => {
      record("git", lane.key, { ...op, ...(opts ? { opts } : {}) }); down(runnerOf(lane));
      if (op.op === "worktree-remove" && !w.removed.includes(op.path)) w.removed.push(op.path);
      return { code: 0, out: "", err: "" };
    },
    notify: async (lane, notice) => { record("notify", lane.key, notice); },
    attach: async (lane, tree) => { record("attach", lane.key, tree); down(runnerOf(lane)); return { dir: `/runner/briefs/${lane.key}.files/a0001` }; },
    kill: async (machine, keys) => { record("kill", undefined, { machine, keys }); down(machineRunner(machine)); return []; },
    observe: async (lane) => { record("observe", lane.key, {}); down(runnerOf(lane)); return statusOf(lane); },
    turn: async (lane) => { record("turn", lane.key, {}); down(runnerOf(lane)); return w.turn; },
    connected: () => !w.runnerDown,
  };
};

/** FlowDeps over the World, plus `ops` (a fakeLaneOps over the same World) for modules that reach lanes through the facade. */
const fileRunCounters = new WeakMap<World, number>();
/** BUILT_IN for a /home/test home, with the toodo event stream off. */
export const testTunables = (patch: Partial<Tunables> = {}): Tunables => {
  const base = builtInTunables("/home/test");
  return { ...base, toodoEvents: { ...base.toodoEvents, enabled: false }, ...patch };
};

/** A fixture patch split into its config part and its tunables part (keys of BUILT_IN). */
export const splitTunables = (patch: Partial<DoriConfig & Tunables>): { readonly config: Partial<DoriConfig>; readonly tunables: Partial<Tunables> } => {
  const keys = Object.keys(BUILT_IN);
  const entries = Object.entries(patch);
  return {
    config: Object.fromEntries(entries.filter(([key]) => !keys.includes(key))) as Partial<DoriConfig>,
    tunables: Object.fromEntries(entries.filter(([key]) => keys.includes(key))) as Partial<Tunables>,
  };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig & Tunables> = {}): FlowDeps & { readonly ops: LaneOps } => {
  const split = splitTunables(patch);
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, leadCwd: "/repo", worktreeRoot: "/data/repos/worktrees", leadPane: "lead:p1", store: TEST_STORE, ...split.config };
  const tunables = testTunables(split.tunables);
  // The local sandbox wrapper is installed unless a test says otherwise (override `which`).
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, tunables, exists: (path) => !w.removed.includes(path), ops: fakeLaneOps(w),
    newFileRunId: () => {
      const n = (fileRunCounters.get(w) ?? 0) + 1; fileRunCounters.set(w, n);
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    which: (cmd) => (cmd === "lane-sandbox" ? "/usr/local/bin/lane-sandbox" : null) };
};

/** The texts sent to lanes: through the facade (`w.ops` sends), and through herdr `send-text` by modules not yet moved onto it. */
export const sent = (w: World): string[] => [
  ...w.calls.filter((c) => c[0] === "herdr" && c[2] === "send-text").map((c) => c[4] ?? ""),
  ...w.ops.filter((e) => e.op === "send").map((e) => (e.args as { text: string }).text),
];
