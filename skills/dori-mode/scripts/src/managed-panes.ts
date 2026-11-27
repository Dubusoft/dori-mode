import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileAtomic } from "./durable-write.ts";

/**
 * The pane the supervisor owns: the lead's hc terminal (`hc:<address>`). It lives in dori state
 * (`<stateDir>/herdr-panes.json`, a name kept so existing state still loads), not in the config: the supervisor (or
 * setup) creates and records it. A config that still names `leadPane` seeds the state once; after that the legacy keys
 * are ignored.
 */
const MANAGED_PANES_FILE = "herdr-panes.json";
/** Config keys an older dori read pane ids from; config.json no longer reads them (setup drops them). */
export const LEGACY_PANE_KEYS = ["leadPane", "laneWorkspace", "workspaces"] as const;

export type ManagedPanes = {
  readonly leadPane?: string;
  /** Set once the state is authoritative: the legacy config keys are no longer read. */
  readonly migrated?: boolean;
};

export const managedPanesPath = (stateDir: string): string => join(stateDir, MANAGED_PANES_FILE);

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The recorded lead pane; a missing or unreadable file records none. */
export const readManagedPanes = (stateDir: string): ManagedPanes => {
  const path = managedPanesPath(stateDir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  return {
    ...(text(o.leadPane) ? { leadPane: text(o.leadPane) } : {}),
    ...(o.migrated === true ? { migrated: true } : {}),
  };
};

/** Which legacy pane keys a raw config object still carries. */
export const legacyPaneKeys = (raw: Readonly<Record<string, unknown>>): string[] => LEGACY_PANE_KEYS.filter((key) => key in raw);

/**
 * The lead pane in force for a loaded config: the recorded one. Until the state is marked migrated, a `leadPane` the
 * config still names fills a missing one and is written back with `migrated`, so the config is read for it exactly
 * once. `saved` says whether that write happened (a read-only state, as inside a lane sandbox, keeps it for this
 * process only).
 */
export const resolveManagedPanes = (stateDir: string, raw: Readonly<Record<string, unknown>>): { readonly leadPane: string; readonly migrated?: { readonly saved: boolean } } => {
  const recorded = readManagedPanes(stateDir);
  const current = recorded.leadPane ?? "";
  if (recorded.migrated) return { leadPane: current };
  const legacy = text(raw.leadPane);
  if (!legacy) return { leadPane: current };
  const leadPane = current || legacy;
  try {
    saveLeadPane(stateDir, leadPane);
    return { leadPane, migrated: { saved: true } };
  } catch {
    return { leadPane, migrated: { saved: false } };
  }
};

/** Records a lead pane the supervisor created; the state is authoritative from then on. */
export const saveLeadPane = (stateDir: string, leadPane: string): void => {
  mkdirSync(stateDir, { recursive: true });
  replaceFileAtomic(managedPanesPath(stateDir), `${JSON.stringify({ leadPane, migrated: true }, null, 2)}\n`, 0o600);
};
