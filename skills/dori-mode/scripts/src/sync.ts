import { readdirSync } from "node:fs";

import type { FlowDeps } from "./done-flow.ts";
import { laneRunner, listPanes, type Pane } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { procTable, resolveSession, type SessionDeps, type SessionHit } from "./session-id.ts";

export type SyncRow = { readonly key: string; readonly thread: string; readonly pane: string; readonly session: string; readonly status: string };
export type SyncResult = { readonly rows: SyncRow[]; readonly drift: string[]; readonly unregistered: SyncRow[] };

// Each resolution spawns herdr/ps (or ssh for remote lanes); cap the fan-out.
const RESOLVE_CONCURRENCY = 4;

const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

const readDir = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

type LanePlan = { readonly lane: Lane; readonly pane?: Pane; readonly lookupFailed?: string };

export const syncRegistry = async (deps: FlowDeps, write: boolean, readSessionDir: (dir: string) => readonly string[] = readDir): Promise<SyncResult> => {
  const panes = await listPanes(deps.run);
  const live = new Map(panes.map((p) => [p.pane_id, p]));
  const machines = new Map<string, Map<string, Pane>>();
  const table = await procTable(deps.run);
  const directoryEntries = new Map<string, readonly string[]>();
  const sessionDeps: SessionDeps = {
    run: deps.run,
    sessionsDir: deps.config.sessionsDir,
    listDir: (dir) => {
      const cached = directoryEntries.get(dir);
      if (cached) return cached;
      const entries = readSessionDir(dir);
      directoryEntries.set(dir, entries);
      return entries;
    },
  };
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const lanes = await deps.registry.open();
  const plans: LanePlan[] = [];
  for (const lane of lanes) {
    let inventory = live;
    if (lane.machine) {
      let remote = machines.get(lane.machine);
      if (!remote) {
        try {
          remote = new Map((await listPanes(laneRunner(deps.run, lane))).map((p) => [p.pane_id, p]));
          machines.set(lane.machine, remote);
        } catch (e) {
          plans.push({ lane, lookupFailed: `${lane.key}: machine ${lane.machine} lookup failed: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
      }
      inventory = remote;
    }
    const pane = lane.pane ? inventory.get(lane.pane) : undefined;
    plans.push(pane ? { lane, pane } : { lane });
  }
  const none: SessionHit = { id: "", via: "none" };
  const hits = await mapLimit(plans, RESOLVE_CONCURRENCY, ({ lane, pane }) =>
    pane ? resolveSession(pane.pane_id, pane.cwd ?? "", table, sessionDeps, lane) : Promise.resolve(none));
  for (const [i, { lane, pane, lookupFailed }] of plans.entries()) {
    if (lookupFailed) {
      drift.push(lookupFailed);
      rows.push({ key: lane.key, thread: lane.thread, pane: lane.pane ?? "-", session: lane.session ?? "-", status: statusOf(lane) });
      continue;
    }
    if (!pane) drift.push(`${lane.key}: pane ${lane.pane ?? "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const hit = hits[i] ?? none;
    if (lane.session && hit.id && hit.id !== lane.session) drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && hit.id && hit.id !== lane.session) {
      await deps.registry.update(lane.key, (current) =>
        current && current.session !== hit.id ? { ...current, session: hit.id, sessionVia: hit.via } : undefined);
    }
    rows.push({ key: lane.key, thread: lane.thread, pane: lane.pane ?? "-", session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"), status: statusOf(lane) });
  }
  const owned = new Set(lanes.filter((l) => !l.machine).map((l) => l.pane));
  const watch = new Set(deps.config.workspaces);
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  const candidates = panes.filter((p) =>
    !owned.has(p.pane_id) && !skip.has(p.pane_id) && !(watch.size > 0 && !watch.has(p.workspace_id)) && p.agent !== undefined);
  const unregistered = await mapLimit(candidates, RESOLVE_CONCURRENCY, async (p): Promise<SyncRow> => {
    const hit = await resolveSession(p.pane_id, p.cwd ?? "", table, sessionDeps);
    return { key: p.title ?? p.pane_id, thread: "-", pane: p.pane_id, session: hit.id ? `${hit.id} (${hit.via})` : "-", status: "unregistered" };
  });
  return { rows, drift, unregistered };
};
