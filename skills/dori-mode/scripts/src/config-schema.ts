// The version of config.json's layout and the table of key changes between versions. `dori setup` (pruneObsolete in
// setup.ts) applies the steps a file has not had yet and stamps it with the current version. Pure: no file IO.

type Json = Record<string, unknown>;

/** The top-level key that holds a file's schema version; absent means version 0 (written before versions existed). */
export const CONFIG_SCHEMA_KEY = "schemaVersion";
/** The version this dori writes. Raise it together with a new CONFIG_MIGRATIONS entry. */
export const CONFIG_SCHEMA_VERSION = 1;

export type ConfigMigration = {
  /** The version a file has after this step. */
  readonly to: number;
  /** Old key -> new key: the value moves to the new key unless that key already has one. */
  readonly renames?: Readonly<Record<string, string>>;
  /** Key -> why config.json no longer reads it. Removal itself is warned about once first (pruneObsolete). */
  readonly removes?: Readonly<Record<string, string>>;
};

/** Every change to config.json's keys, oldest first; never edit a published step, add a new one. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  {
    to: 1,
    removes: {
      sessionsDir: "omo's session directory is fixed",
      laneThinking: "lanes use the built-in thinking level; put --thinking in agentCommand to change it",
      memoryCheck: "derived from defaultCwd",
      store: "detected from the files in stateDir",
      diskGuardPath: "the disk guard checks stateDir",
      toodoEvents: "the toodo event stream runs when its token file exists",
    },
  },
];

export class ConfigSchemaError extends Error {}

/** The schema version `raw` was written with; throws ConfigSchemaError when it is not a whole number >= 0. */
export const configSchemaVersion = (raw: Json): number => {
  const v = raw[CONFIG_SCHEMA_KEY];
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ConfigSchemaError(`${CONFIG_SCHEMA_KEY} must be a whole number, not ${JSON.stringify(v)}`);
  return v;
};

/** Why `key` (a top-level key or `<key>.<sub>`) is no longer read, from the table; a generic reason otherwise. */
export const removalReason = (key: string): string => {
  for (const m of CONFIG_MIGRATIONS) {
    const why = m.removes?.[key];
    if (why) return why;
  }
  return "no longer read from config.json";
};

export type SchemaMigrated = {
  /** `raw` with the pending steps' renames applied, without CONFIG_SCHEMA_KEY. */
  readonly next: Json;
  readonly from: number;
  readonly renamed: readonly (readonly [string, string])[];
};

/**
 * Applies every CONFIG_MIGRATIONS step newer than `raw`'s version. Removals are left to the caller (they are not in
 * CONFIG_FILE_KEYS, so pruning finds them). Throws ConfigSchemaError when `raw` was written by a newer dori: its keys may
 * be ones this version does not know, and pruning them would lose them.
 */
export const migrateConfigSchema = (raw: Json): SchemaMigrated => {
  const from = configSchemaVersion(raw);
  if (from > CONFIG_SCHEMA_VERSION) {
    throw new ConfigSchemaError(`config.json has ${CONFIG_SCHEMA_KEY} ${from}, newer than this dori's ${CONFIG_SCHEMA_VERSION}; update dori first (dori update), nothing was changed`);
  }
  const next: Json = { ...raw };
  delete next[CONFIG_SCHEMA_KEY];
  const renamed: [string, string][] = [];
  for (const m of CONFIG_MIGRATIONS) {
    if (m.to <= from) continue;
    for (const [old, now] of Object.entries(m.renames ?? {})) {
      if (!(old in next)) continue;
      if (!(now in next)) next[now] = next[old];
      delete next[old];
      renamed.push([old, now]);
    }
  }
  return { next, from, renamed };
};
