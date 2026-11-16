import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";

/**
 * The herdr ids the supervisor owns: the lead pane and the workspace new lane tabs open in. They live in dori state
 * (`<stateDir>/herdr-panes.json`), not in the config: herdr renumbers them after a restart, and the supervisor (or a
 * launch) finds, creates and records them again. A config that still names `leadPane`, `laneWorkspace` or `workspaces`
 * seeds the state once; after that the keys are ignored.
 */
export const MANAGED_PANES_FILE = "herdr-panes.json";
export const LANES_WORKSPACE = "lanes";
export const LEAD_WORKSPACE = "Dori";
export const LEAD_TAB = "dori-lead";
export const LEGACY_PANE_KEYS = ["leadPane", "laneWorkspace", "workspaces"] as const;

export type ManagedPanes = {
  readonly leadPane?: string;
  readonly laneWorkspace?: string;
  /** Set once the state is authoritative: the legacy config keys are no longer read. */
  readonly migrated?: boolean;
};

export class ManagedPanesError extends Error {}

export const managedPanesPath = (stateDir: string): string => join(stateDir, MANAGED_PANES_FILE);

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The recorded ids; a missing or unreadable file records none. */
export const readManagedPanes = (stateDir: string): ManagedPanes => {
  const path = managedPanesPath(stateDir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  return {
    ...(text(o.leadPane) ? { leadPane: text(o.leadPane) } : {}),
    ...(text(o.laneWorkspace) ? { laneWorkspace: text(o.laneWorkspace) } : {}),
    ...(o.migrated === true ? { migrated: true } : {}),
  };
};

/** Merges `patch` into the recorded ids (owner-only file, renamed into place) and returns the result. */
export const saveManagedPanes = (stateDir: string, patch: ManagedPanes): ManagedPanes => {
  const next = { ...readManagedPanes(stateDir), ...patch };
  mkdirSync(stateDir, { recursive: true });
  const path = managedPanesPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
};

/** Which legacy pane keys a raw config object still carries. */
export const legacyPaneKeys = (raw: Readonly<Record<string, unknown>>): string[] => LEGACY_PANE_KEYS.filter((key) => key in raw);

/**
 * The ids in force for a loaded config: the recorded ones. Until the state is marked migrated, ids a config still names
 * fill the ones the state lacks and are written back with `migrated`, so the config is read for them exactly once.
 * `saved` says whether that write happened (a read-only state, as inside a lane sandbox, keeps them for this process only).
 */
export const resolveManagedPanes = (stateDir: string, raw: Readonly<Record<string, unknown>>): { readonly leadPane: string; readonly laneWorkspace: string; readonly migrated?: { readonly saved: boolean } } => {
  const recorded = readManagedPanes(stateDir);
  const current = { leadPane: recorded.leadPane ?? "", laneWorkspace: recorded.laneWorkspace ?? "" };
  if (recorded.migrated) return current;
  const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  const legacy = { leadPane: text(raw.leadPane), laneWorkspace: text(raw.laneWorkspace) || text(workspaces[0]) };
  if (!legacy.leadPane && !legacy.laneWorkspace) return current;
  const seeded = { leadPane: current.leadPane || legacy.leadPane, laneWorkspace: current.laneWorkspace || legacy.laneWorkspace };
  try {
    saveManagedPanes(stateDir, { ...(seeded.leadPane ? { leadPane: seeded.leadPane } : {}), ...(seeded.laneWorkspace ? { laneWorkspace: seeded.laneWorkspace } : {}), migrated: true });
    return { ...seeded, migrated: { saved: true } };
  } catch {
    return { ...seeded, migrated: { saved: false } };
  }
};

type Workspace = { readonly label?: string; readonly workspace_id: string };

const listWorkspaces = async (run: Runner): Promise<Workspace[]> => {
  const r = await run(["herdr", "workspace", "list"]);
  if (r.code !== 0) throw new ManagedPanesError(`herdr workspace list failed: ${(r.err || r.out).trim()}`);
  try {
    return (JSON.parse(r.out) as { result: { workspaces: Workspace[] } }).result.workspaces;
  } catch {
    throw new ManagedPanesError("herdr workspace list returned unreadable output");
  }
};

/**
 * The workspace new local lane tabs open in: the recorded one while herdr still lists it, else the workspace labelled
 * `lanes`, else a new `lanes` workspace at `cwd`. A changed id is recorded in dori state and logged
 * (`LANE_WORKSPACE_REGISTERED`). Throws ManagedPanesError when herdr cannot list or create workspaces.
 */
export const ensureLaneWorkspace = async (run: Runner, stateDir: string, cwd: string, log: (line: string) => void): Promise<string> => {
  const recorded = readManagedPanes(stateDir).laneWorkspace;
  const listed = await listWorkspaces(run);
  if (recorded && listed.some((w) => w.workspace_id === recorded)) return recorded;
  let id = listed.find((w) => w.label === LANES_WORKSPACE)?.workspace_id;
  const how = id ? "found by label" : "created";
  if (!id) {
    const made = await run(["herdr", "workspace", "create", "--label", LANES_WORKSPACE, "--cwd", cwd, "--no-focus"]);
    if (made.code !== 0) throw new ManagedPanesError(`herdr workspace create --label ${LANES_WORKSPACE} failed: ${(made.err || made.out).trim()}`);
    id = (await listWorkspaces(run)).find((w) => w.label === LANES_WORKSPACE)?.workspace_id;
    if (!id) throw new ManagedPanesError(`herdr created no workspace labelled ${LANES_WORKSPACE}`);
  }
  saveManagedPanes(stateDir, { laneWorkspace: id, migrated: true });
  log(`LANE_WORKSPACE_REGISTERED ${id} (${how}${recorded ? `; ${recorded} is gone` : ""})`);
  return id;
};

/** Records a lead pane the supervisor created; the state is authoritative from then on. */
export const saveLeadPane = (stateDir: string, leadPane: string): void => {
  saveManagedPanes(stateDir, { leadPane, migrated: true });
};
