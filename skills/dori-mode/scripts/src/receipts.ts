import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { replaceFileDurable } from "./durable-write.ts";

/** Receipt files written by `publishReceipt`: `<prefix>-<uuid>.json`, the prefix a time or an id. */
const RECEIPT_FILE = /^\d+-[\w-]+\.json$/;

/** tmp, fsync, rename, then the directory fsync: a crash leaves either the old file or the complete new one. */
export const writeDurable = (path: string, text: string): void => {
  replaceFileDurable(path, text, 0o600, `${path}.${process.pid}.tmp`);
};

/**
 * Publishes an immutable receipt `<stateDir>/<subdir>/<prefix>-<uuid>.json` (a fresh path each time, so a concurrent
 * consumer never unlinks a newer receipt with an older one): durably written, then both its directory (by the write) and
 * `stateDir` (which may have just gained the directory) are fsynced. Returns the path.
 */
export const publishReceipt = (stateDir: string, subdir: string, prefix: string | number, payload: unknown): string => {
  const dir = join(stateDir, subdir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${prefix}-${randomUUID()}.json`);
  writeDurable(path, JSON.stringify(payload));
  const parent = openSync(stateDir, "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return path;
};

/** The receipt files of `dir` (nothing for a missing directory); the caller parses them and skips what is malformed. */
export const receiptPaths = (dir: string): string[] => {
  try { return readdirSync(dir).filter((name) => RECEIPT_FILE.test(name)).map((name) => join(dir, name)); } catch { return []; }
};

/** Removes a consumed file; one already gone is fine. */
export const dropFile = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};
