import { convertJsonStore } from "./store-import.ts";
import { jsonStorePending, SQLITE_FILE } from "./store.ts";

const warned = new Set<string>();
const warnOnce = (id: string, line: string): void => {
  if (warned.has(id)) return;
  warned.add(id);
  console.error(line);
};

/**
 * Converts a state dir still on the retired json store to supervisor.sqlite, once, before anything opens its store.
 * It runs at the CLI entry points that read the store, not in loadConfig, so config readers such as the runner bundle
 * never pull in the store conversion. A refusal, or an older supervisor still holding the lock, leaves the json files as
 * they are with one STORE_CONVERT_FAILED line; the next command tries again, and the supervisor refuses to start on them
 * (STORE_IMPORT_PENDING).
 */
export const convertJsonState = async (stateDir: string): Promise<void> => {
  if (!jsonStorePending(stateDir)) return;
  try {
    if (convertJsonStore(stateDir, Date.now())) warnOnce("storeConverted", `STORE_CONVERTED ${stateDir}: the json store moved into ${SQLITE_FILE}`);
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    warnOnce("storeConvertFailed", `STORE_CONVERT_FAILED ${stateDir}: ${e.message}`);
  }
};
