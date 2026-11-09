import type { LaneOps, PaneRef } from "./lane-ops.ts";
import type { Pane } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Ran } from "./run.ts";

/** A pane on a machine (a lane, or any pane of a snapshot). */
export type { PaneRef } from "./lane-ops.ts";

/**
 * How the sweeps observe panes. Outside a supervisor round (CLI, tests) every call goes to the runner as before
 * (`passthroughView`); inside one (`sweepRound`) they share one pane list per machine and cached reads.
 */
export type SweepView = {
  readonly panes: (machine?: string) => Promise<Pane[]>;
  /** The pane's row, or undefined when it does not exist; throws when the machine's runner cannot list its panes. */
  readonly find: (ref: PaneRef) => Promise<Pane | undefined>;
  /** herdr's agent_status for the pane; a failed lookup comes back as its error text. */
  readonly status: (ref: PaneRef) => Promise<{ readonly status?: string; readonly error?: string }>;
  readonly screen: (ref: PaneRef, lines: number) => Promise<string>;
  readonly processInfo: (ref: PaneRef) => Promise<Ran>;
};

/** Concurrent herdr calls per machine in a round. */
export const SWEEP_CONCURRENCY = 4;
/** One screen read per pane serves every sweep: the largest any of them asks for (remote reports, freshness posts). */
export const SWEEP_SCREEN_LINES = 200;
/** A cached screen older than this is read again even when the pane's revision and scroll extent are unchanged. */
export const SWEEP_SCREEN_MAX_AGE_MS = 5 * 60_000;

/** Every call goes straight to the machine's runner, exactly as the sweeps did before the round view. */
export const passthroughView = (ops: LaneOps): SweepView => ({
  panes: (machine) => ops.panes(machine),
  find: async (ref) => (await ops.panes(ref.machine)).find((p) => p.pane_id === ref.pane),
  status: (ref) => ops.status(ref),
  screen: (ref, lines) => ops.screen(ref, lines),
  processInfo: (ref) => ops.processInfo(ref),
});

/** A gate for the calls of one machine: at most `limit` at once; once `deadlineAt` has passed a call is not started and rejects. */
export type CallGate = <T>(call: () => Promise<T>) => Promise<T>;

/**
 * At most `limit` calls at once; once `deadlineAt` has passed a call is not started and rejects. A freed slot is
 * handed to the next waiter directly, so the limit holds.
 */
export const boundedCalls = (limit: number, deadlineAt: number, now: () => number): CallGate => {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < limit) { active++; return; }
    await new Promise<void>((resolve) => { waiting.push(resolve); });
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (call) => {
    await acquire();
    try {
      if (deadlineAt - now() <= 0) throw new Error("sweep machine deadline passed before a runner call");
      return await call();
    } finally { release(); }
  };
};

type Seen = { readonly token: string; readonly screenToken?: string; readonly readAt?: number; readonly screen?: string; readonly lines?: number; readonly infoToken?: string; readonly info?: Ran };

/** Reads kept across rounds, keyed by machine and pane; a screen is valid while the pane's revision and scroll extent are unchanged and it is younger than SWEEP_SCREEN_MAX_AGE_MS. */
export type SweepCache = Map<string, Seen>;
export const newSweepCache = (): SweepCache => new Map();

export type RoundOptions = {
  readonly now: () => number;
  /** Per machine: no runner call of this round starts later than this many ms after the round began. */
  readonly deadlineMs: number;
  readonly concurrency?: number;
};

type Snapshot = { readonly panes: Pane[]; readonly byId: ReadonlyMap<string, Pane> } | { readonly error: unknown };

let rounds = 0;

const cacheKey = (machine: string | undefined, pane: string): string => `${machine ?? ""}\u0000${pane}`;

/**
 * One sweep round: one `ops.panes` per machine, taken now and shared by every sweep. A screen or process-info
 * read is cached by the pane's `revision` (herdr bumps it on prompt and command events, not when a program prints), so
 * a screen is also keyed by the pane's scrollback extent and re-read once it is older than SWEEP_SCREEN_MAX_AGE_MS;
 * a pane that did not change costs no call at all; a row without a revision is cached for this round only. Reads of open lanes whose pane
 * changed are prefetched with at most `concurrency` calls per machine, each machine within its own deadline.
 * A pane missing from the snapshot (a lane launched meanwhile) is confirmed with one fresh list before it counts as gone.
 */
export const sweepRound = async (ops: LaneOps, cache: SweepCache, lanes: readonly Lane[], opts: RoundOptions): Promise<SweepView> => {
  const round = ++rounds;
  const started = opts.now();
  const gates = new Map<string, CallGate>();
  const gateFor = (machine?: string): CallGate => {
    const key = machine ?? "";
    let g = gates.get(key);
    if (!g) { g = boundedCalls(opts.concurrency ?? SWEEP_CONCURRENCY, started + opts.deadlineMs, opts.now); gates.set(key, g); }
    return g;
  };
  const snapshots = new Map<string, Promise<Snapshot>>();
  const snapshot = (machine?: string): Promise<Snapshot> => {
    const key = machine ?? "";
    let s = snapshots.get(key);
    if (!s) {
      s = gateFor(machine)(() => ops.panes(machine)).then(
        (panes): Snapshot => ({ panes, byId: new Map(panes.map((p) => [p.pane_id, p])) }),
        (error: unknown): Snapshot => ({ error }),
      );
      snapshots.set(key, s);
    }
    return s;
  };
  const confirmed = new Map<string, Promise<Pane | undefined>>();
  const find = async (ref: PaneRef): Promise<Pane | undefined> => {
    const pane = ref.pane ?? "";
    const snap = await snapshot(ref.machine);
    const row = "byId" in snap ? snap.byId.get(pane) : undefined;
    if (row) return row;
    const key = cacheKey(ref.machine, pane);
    let fresh = confirmed.get(key);
    if (!fresh) { fresh = gateFor(ref.machine)(() => ops.panes(ref.machine)).then((panes) => panes.find((p) => p.pane_id === pane)); confirmed.set(key, fresh); }
    return fresh;
  };
  const token = (row: Pane): string => row.revision === undefined ? `round:${round}` : `revision:${row.revision}`;
  const screenToken = (row: Pane): string => `${token(row)}|${row.scroll?.max_offset_from_bottom ?? ""}`;
  const screen = async (ref: PaneRef, lines: number): Promise<string> => {
    const pane = ref.pane ?? "";
    let row: Pane | undefined;
    try { row = await find(ref); }
    catch { return gateFor(ref.machine)(() => ops.screen(ref, lines)); }
    if (!row) return "";
    const key = cacheKey(ref.machine, pane);
    const seen = cache.get(key);
    const want = Math.max(lines, SWEEP_SCREEN_LINES);
    if (seen?.screenToken === screenToken(row) && seen.screen !== undefined && (seen.lines ?? 0) >= lines && opts.now() - (seen.readAt ?? 0) < SWEEP_SCREEN_MAX_AGE_MS) return seen.screen.split("\n").slice(-lines).join("\n");
    const text = await gateFor(ref.machine)(() => ops.screen(ref, want));
    const current = cache.get(key);
    cache.set(key, { ...(current?.token === token(row) ? current : {}), token: token(row), screenToken: screenToken(row), readAt: opts.now(), screen: text, lines: want });
    return text.split("\n").slice(-lines).join("\n");
  };
  const processInfo = async (ref: PaneRef): Promise<Ran> => {
    const pane = ref.pane ?? "";
    const row = await find(ref).catch(() => undefined);
    if (!row) return gateFor(ref.machine)(() => ops.processInfo(ref));
    const key = cacheKey(ref.machine, pane);
    const infoToken = `${token(row)}|${row.agent ?? ""}|${row.agent_status ?? ""}`;
    const seen = cache.get(key);
    if (seen?.infoToken === infoToken && seen.info) return seen.info;
    const r = await gateFor(ref.machine)(() => ops.processInfo(ref));
    if (r.code === 0) {
      const current = cache.get(key);
      cache.set(key, { ...(current?.token === token(row) ? current : { token: token(row) }), infoToken, info: r });
    }
    return r;
  };
  const view: SweepView = {
    panes: async (machine) => {
      const snap = await snapshot(machine);
      if ("error" in snap) throw snap.error;
      return snap.panes;
    },
    find,
    status: async (ref) => {
      try { return { status: (await find(ref))?.agent_status }; }
      catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    },
    screen,
    processInfo,
  };
  const machines = [...new Set<string | undefined>([undefined, ...lanes.map((l) => l.machine)])];
  const taken = await Promise.all(machines.map(async (machine) => [machine, await snapshot(machine)] as const));
  // Forget panes that are gone, so the cache never outgrows the machines' pane lists.
  for (const [machine, snap] of taken) {
    if (!("byId" in snap)) continue;
    for (const key of cache.keys()) {
      const [m, pane] = key.split("\u0000");
      if (m === (machine ?? "") && pane !== undefined && !snap.byId.has(pane)) cache.delete(key);
    }
  }
  // The reads the sweeps will make anyway (freshness reads working local lanes, watch reads remote ones,
  // recovery checks the process of every working lane), started together within each machine's limit.
  await Promise.all(lanes.flatMap((lane) => {
    const status = statusOf(lane);
    if (!lane.pane || !(status === "working" || (status === "not-done" && lane.machine))) return [];
    const snap = taken.find(([m]) => m === lane.machine)?.[1];
    if (!snap || !("byId" in snap) || !snap.byId.has(lane.pane)) return [];
    const reads: Promise<unknown>[] = [screen(lane, SWEEP_SCREEN_LINES)];
    if (status === "working") reads.push(processInfo(lane));
    return reads.map((p) => p.catch(() => undefined));
  }));
  return view;
};
