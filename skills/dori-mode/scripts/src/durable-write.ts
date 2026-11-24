import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { withStateLockSync } from "./state-lock.ts";

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const textOf = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/**
 * Reads a JSON state file that a sweep reads every pass: undefined when it is missing. One that does not parse or fails
 * `valid` is renamed to `<path>.corrupt-<ms>-<uuid>`, logged as `<tag>_CORRUPT ... continuing with <empty>`, and read
 * as undefined, so the next pass starts from the empty state instead of failing on the same file again.
 * `lock` is the file's store lock when the caller does not hold it: the file is read again under it before the move.
 * Without one the file moves only while it still holds the text that failed, so a writer's replacement is read instead.
 */
export const readJsonState = <T>(path: string, tag: string, valid: (v: unknown) => v is T, empty: string, lock?: string): T | undefined => {
  const text = textOf(path);
  if (text === undefined) return undefined;
  let problem = "unexpected shape";
  try {
    const value: unknown = JSON.parse(text);
    if (valid(value)) return value;
  } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  if (lock !== undefined) return withStateLockSync(lock, () => readJsonState(path, tag, valid, empty));
  if (textOf(path) !== text) return readJsonState(path, tag, valid, empty);
  const aside = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
  renameSync(path, aside);
  console.error(`${tag}_CORRUPT moved ${path} to ${aside}: ${problem}; continuing with ${empty}`);
  return undefined;
};

/** Runs `write` against `tmp` and removes `tmp` when it throws, so a failed replace leaves no partial copy behind. */
const throughTmp = (tmp: string, write: () => void): void => {
  try { write(); } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};

/**
 * Replaces `path` atomically through a unique tmp file and rename; nothing is fsynced, so a crash may lose the update but never tears it.
 * Concurrent writers of one path never share a tmp file: the last rename wins whole.
 */
export const replaceFileAtomic = (path: string, data: string, mode: number): void => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  throughTmp(tmp, () => {
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
  });
};

/** Replaces `path` durably: tmp file (unique unless the caller names one), fsync, rename, then fsync of the directory so the rename survives a crash. */
export const replaceFileDurable = (path: string, data: string, mode: number, tmp = `${path}.${randomUUID()}.tmp`): void => {
  throughTmp(tmp, () => {
    const fd = openSync(tmp, "w", mode);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  });
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

/** Appends `data` to `path` (created with `mode`, even when `data` is empty) and fsyncs it before returning. */
export const appendFileDurable = (path: string, data: string, mode: number): void => {
  const fd = openSync(path, "a", mode);
  try {
    const bytes = Buffer.from(data);
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
};
