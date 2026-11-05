import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { laneGeneration } from "../lane-reports.ts";
import type { Pane } from "../panes.ts";
import type { Lane } from "../registry.ts";
import type { Clock } from "../run.ts";
import { backoffMs, type RunnerClient } from "./client.ts";
import { RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import { HUB_FILE, type CommitFn, type RunnerHub } from "./hub.ts";
import {
  decodeFrame, encodeFrame, LABEL_PATTERN, ProtocolError,
  type AnyRunnerEvent, type InventoryLane, type LaneStatus, type RunnerControl,
} from "./protocol.ts";
import { diffUnits, settleCycle, shadowDiffLine, shadowUnit, type ShadowDiff, type ShadowUnit } from "./shadow.ts";
import type { Connector, Listener, Transport } from "./transport.ts";

/**
 * The P1 wiring between the runner modules and the product: the runner's identity file, the supervisor epoch, the hub's
 * connection handling over any `Listener`, the shadow comparison, and the runner's serve loop. Every function takes its
 * clock and IO as arguments; `dori runner serve` and `supervise` pass the real ones.
 */

/** The local runner's default label. */
export const LOCAL_RUNNER = "local";
/** How often a shadow runner reads its lanes. */
export const SHADOW_OBSERVE_MS = 30_000;
/** Committed runner events are kept this long in the hub's journal table. */
export const RUNNER_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Runner identity
// ---------------------------------------------------------------------------------------------------------------

export type RunnerIdentity = { readonly id: string; readonly label: string; readonly hostId: string };

/**
 * Reads `<runnerDir>/runner.json`, or creates it (0600, atomic) with a new id, `label` and `hostId` on first start. A
 * stored label wins over `label`, so a runner keeps its name; a stored file that does not read is an error.
 */
export const loadIdentity = (runnerDir: string, label: string, hostId: string): RunnerIdentity => {
  const path = join(runnerDir, RUNNER_PATHS.identity);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RunnerIdentity>;
    if (typeof raw.id !== "string" || typeof raw.label !== "string" || typeof raw.hostId !== "string" || !LABEL_PATTERN.test(raw.label)) {
      throw new Error(`RUNNER_IDENTITY_INVALID ${path}`);
    }
    return { id: raw.id, label: raw.label, hostId: raw.hostId };
  }
  if (!LABEL_PATTERN.test(label)) throw new Error(`RUNNER_LABEL_INVALID ${label}`);
  const identity = { id: randomUUID(), label, hostId };
  writeRunnerFile(path, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
};

// ---------------------------------------------------------------------------------------------------------------
// Supervisor side: epoch, journal, connections
// ---------------------------------------------------------------------------------------------------------------

const openHubDb = (stateDir: string): Database => {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, HUB_FILE);
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS hub_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS runner_events (id TEXT PRIMARY KEY, line TEXT NOT NULL, at INTEGER NOT NULL)");
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
  return db;
};

/** Commits the next supervisor epoch (one per supervisor start) in `<stateDir>/runners.sqlite` and returns it. */
export const nextEpoch = (stateDir: string): number => {
  const db = openHubDb(stateDir);
  try {
    return db.transaction(() => {
      const row = db.query("SELECT v FROM hub_meta WHERE k = 'epoch'").get() as { v: number } | null;
      const epoch = (row?.v ?? 0) + 1;
      db.query("INSERT INTO hub_meta (k, v) VALUES ('epoch', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(epoch);
      return epoch;
    }).immediate();
  } finally {
    db.close();
  }
};

export type RunnerJournal = { readonly commit: CommitFn; prune(now: number): number; close(): void };

/**
 * The shadow journal: the hub commits runner events into `runner_events` of `runners.sqlite` instead of the lead's
 * event journal, so a shadow runner's events are durable and acked but never wake the lead. `commit` returns false for
 * an id already there, as the contract asks.
 */
export const openRunnerJournal = (stateDir: string, now: () => number): RunnerJournal => {
  const db = openHubDb(stateDir);
  const insert = db.query("INSERT OR IGNORE INTO runner_events (id, line, at) VALUES (?, ?, ?)");
  return {
    commit: (id, line) => insert.run(id, line, now()).changes > 0,
    prune: (at) => db.query("DELETE FROM runner_events WHERE at < ?").run(at - RUNNER_JOURNAL_RETENTION_MS).changes,
    close: () => { db.close(); },
  };
};

export type HubHooks = {
  /** An admitted hello (the runner's label and its hello body). */
  readonly onHello?: (label: string, body: RunnerControl<"hello">["body"]) => void;
  /** An event the hub committed just now. */
  readonly onEvent?: (label: string, frame: AnyRunnerEvent) => void;
  readonly onHeartbeat?: (label: string) => void;
  readonly log: (line: string) => void;
};

/**
 * Serves runner connections from `listener` through `hub`. The first frame must be a hello; a rejected hello is
 * answered and the connection closed. After it, every frame must name the admitted label. A newer connection of the
 * same label replaces the older one. An invalid frame, or an event whose commit throws (no ack), closes the
 * connection; the runner reconnects and replays from its hello. Returns a function that stops accepting.
 */
export const acceptRunners = (hub: RunnerHub, listener: Listener, hooks: HubHooks): (() => void) => {
  const current = new Map<string, Transport>();
  return listener.onConnection((transport) => {
    let label: string | undefined;
    const reply = (frame: Parameters<typeof encodeFrame>[0] | undefined): void => {
      if (frame && transport.open) transport.send(encodeFrame(frame));
    };
    transport.onClose(() => {
      if (label !== undefined && current.get(label) === transport) {
        current.delete(label);
        hub.disconnected(label);
        hooks.log(`RUNNER_DISCONNECTED runner=${label}`);
      }
    });
    transport.onLine((line) => {
      try {
        const frame = decodeFrame(line, "runner");
        if (label === undefined) {
          if (frame.type !== "hello" || "seq" in frame) throw new ProtocolError("sequence", `${frame.type} before hello`);
          const hello = frame as RunnerControl<"hello">;
          const outcome = hub.hello(hello);
          reply(outcome.reply);
          if (!outcome.ok) {
            hooks.log(`${outcome.reply.body.code} runner=${hello.body.label} ${outcome.reply.body.detail}`);
            transport.close(outcome.reply.body.code);
            return;
          }
          label = hello.body.label;
          const previous = current.get(label);
          current.set(label, transport);
          previous?.close("replaced by a newer connection");
          hooks.log(`RUNNER_CONNECTED runner=${label} gen=${hello.body.gen} eventAck=${outcome.row.eventAck}`);
          hooks.onHello?.(label, hello.body);
          return;
        }
        if (frame.runner !== label) throw new ProtocolError("envelope-field", `frame for ${frame.runner} on the connection of ${label}`);
        if ("seq" in frame) {
          const outcome = hub.receive(frame);
          reply(outcome.reply);
          if (outcome.result === "committed") hooks.onEvent?.(label, frame);
          return;
        }
        reply(hub.handle(frame));
        if (frame.type === "heartbeat") hooks.onHeartbeat?.(label);
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
        hooks.log(error instanceof ProtocolError ? `${detail} runner=${label ?? "-"}` : `RUNNER_HUB_ERROR runner=${label ?? "-"} ${detail}`);
        transport.close(error instanceof ProtocolError ? error.code : "hub error");
      }
    });
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Shadow comparison (supervisor side)
// ---------------------------------------------------------------------------------------------------------------

/** The open lanes a runner label covers: the local runner has every open lane without a machine. */
export const lanesFor = (label: string, lanes: readonly Lane[]): Lane[] =>
  lanes.filter((l) => !l.closedAt && l.pane && (label === LOCAL_RUNNER ? !l.machine : l.machine === label));

/** Lane statuses that mean the lane's agent is there. */
const ALIVE: ReadonlySet<LaneStatus> = new Set(["working", "idle"]);

/**
 * Compares what each shadow runner reported with what the supervisor's own paths hold, with no effect on lane state.
 * Two cheap units per lane: `inventory.pane` (the registry's pane id against the runner's hello inventory) and
 * `lane.state` field `alive` (an open registry lane against the runner's latest `lane.state`: working or idle is
 * alive). A difference waits one cycle (`settleCycle`) before it is reported as a `RUNNER_SHADOW_DIFF` line.
 */
export class ShadowObserver {
  private readonly runners = new Map<string, { inventory?: readonly InventoryLane[]; states: Map<string, LaneStatus>; pending: readonly ShadowDiff[] }>();

  private entry(label: string) {
    let entry = this.runners.get(label);
    if (!entry) this.runners.set(label, entry = { states: new Map(), pending: [] });
    return entry;
  }

  hello(label: string, inventory: readonly InventoryLane[] | undefined): void {
    const entry = this.entry(label);
    if (inventory) entry.inventory = inventory;
  }

  event(label: string, frame: AnyRunnerEvent): void {
    if (frame.type === "lane.state") this.entry(label).states.set(frame.body.key, frame.body.status);
  }

  /** Labels that have said hello since this supervisor started. */
  labels(): string[] {
    return [...this.runners.keys()].sort();
  }

  /** One cycle for `label` against the registry's open lanes; returns the lines to log. */
  cycle(label: string, open: readonly Lane[]): string[] {
    const entry = this.entry(label);
    const lanes = lanesFor(label, open);
    const generation = new Map(lanes.map((l) => [l.key, laneGeneration(l)]));
    const gen = (key: string): number => generation.get(key) ?? 0;
    const legacy: ShadowUnit[] = lanes.flatMap((l) => [
      shadowUnit("inventory.pane", l.key, gen(l.key), "pane", l.pane ?? ""),
      shadowUnit("lane.state", l.key, gen(l.key), "alive", "yes"),
    ]);
    const runner: ShadowUnit[] = [
      ...(entry.inventory ?? []).map((lane) => shadowUnit("inventory.pane", lane.key, gen(lane.key), "pane", lane.pane)),
      ...[...entry.states].map(([key, status]) => shadowUnit("lane.state", key, gen(key), "alive", ALIVE.has(status) ? "yes" : "no")),
    ];
    const settled = settleCycle(entry.pending, diffUnits(legacy, runner));
    entry.pending = settled.pending;
    return settled.report.map((diff) => shadowDiffLine(label, diff));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner side
// ---------------------------------------------------------------------------------------------------------------

/** One lane as a shadow runner sees it on its host. */
export type ObservedLane = InventoryLane & { readonly status: LaneStatus };

/**
 * What a runner sees of the lanes it covers: the registry's open lanes for the label, each matched against herdr's
 * pane list. No pane: `missing`; a pane with no agent: `dead`; an agent reported working: `working`; else `idle`.
 */
export const observeLanes = (label: string, open: readonly Lane[], panes: readonly Pane[]): ObservedLane[] => {
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  return lanesFor(label, open).flatMap((lane): ObservedLane[] => {
    const pane = byId.get(lane.pane ?? "");
    const status: LaneStatus = !pane ? "missing" : !pane.agent ? "dead" : pane.agent_status === "working" ? "working" : "idle";
    return [{ key: lane.key, pane: lane.pane ?? "", tab: pane?.tab_id ?? lane.tab ?? "", ...(lane.session ? { session: lane.session } : {}), status }];
  });
};

export type Every = (ms: number, tick: () => void) => () => void;

/** `setInterval` as an `Every`. */
export const realEvery: Every = (ms, tick) => {
  const timer = setInterval(tick, ms);
  return () => { clearInterval(timer); };
};

export type ServeDeps = {
  readonly client: RunnerClient;
  /** The client's newest connection (`trackedConnector(...).latest`), so the loop can wait for its close. */
  readonly latest: () => Transport | undefined;
  readonly clock: Clock;
  /** Runs `tick` every `ms` until the returned stop is called; heartbeats and observations each get their own. */
  readonly every: Every;
  readonly heartbeatMs: number;
  /** Shadow mode: reads the runner's lanes; absent when the runner only says hello and heartbeats. */
  readonly observe?: () => Promise<readonly ObservedLane[]>;
  readonly observeMs?: number;
  readonly random?: () => number;
  readonly log: (line: string) => void;
};

/**
 * The runner's serve loop, as `RunnerClient.run` but with a heartbeat right after each hello and on a timer separate
 * from any work (heartbeats never go through the outbox). In shadow mode a second timer reads the lanes, keeps the
 * latest list as the hello inventory, and publishes `lane.state` for each lane whose status changed (published through
 * the outbox, so nothing is lost while disconnected). It changes nothing on the host.
 */
export const serveRunner = async (deps: ServeDeps, signal: AbortSignal): Promise<void> => {
  const published = new Map<string, LaneStatus>();
  const observeOnce = async (): Promise<void> => {
    if (!deps.observe) return;
    try {
      for (const lane of await deps.observe()) {
        if (published.get(lane.key) === lane.status) continue;
        published.set(lane.key, lane.status);
        deps.client.publish("lane.state", { key: lane.key, status: lane.status });
      }
    } catch (error) {
      deps.log(`RUNNER_OBSERVE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stopHeartbeat = deps.every(deps.heartbeatMs, () => { deps.client.heartbeat(); });
  let observing = false;
  const stopObserve = deps.observe
    ? deps.every(deps.observeMs ?? SHADOW_OBSERVE_MS, () => {
        if (observing) return;
        observing = true;
        void observeOnce().finally(() => { observing = false; });
      })
    : () => {};
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let attempt = 0;
  try {
    await observeOnce();
    while (!signal.aborted) {
      const outcome = await deps.client.connectOnce();
      if (outcome.ok) {
        attempt = 0;
        deps.log(`RUNNER_CONNECTED eventAck=${outcome.eventAck} replayed=${outcome.replayed}`);
        deps.client.heartbeat();
        const open = deps.latest();
        await Promise.race([
          aborted,
          new Promise<void>((resolve) => { if (!open?.open) resolve(); else open.onClose(() => resolve()); }),
        ]);
        if (signal.aborted) open?.close("aborted");
        else deps.log("RUNNER_DISCONNECTED");
      } else {
        deps.latest()?.close(outcome.code);
        deps.log(`${outcome.code} ${outcome.detail}`);
        attempt += 1;
      }
      if (signal.aborted) break;
      await Promise.race([aborted, deps.clock.sleep(backoffMs(Math.max(0, attempt - 1), deps.random))]);
    }
  } finally {
    stopHeartbeat();
    stopObserve();
  }
};

/** Wraps `connect` so `serveRunner` sees each connection; pass the result to both the client and `serveRunner`. */
export const trackedConnector = (connect: Connector): { readonly connect: Connector; readonly latest: () => Transport | undefined } => {
  let latest: Transport | undefined;
  return {
    connect: async () => (latest = await connect()),
    latest: () => latest,
  };
};
