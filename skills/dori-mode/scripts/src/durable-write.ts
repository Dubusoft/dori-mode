import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Replaces `path` atomically through a unique tmp file and rename; nothing is fsynced, so a crash may lose the update but never tears it. */
export const replaceFileAtomic = (path: string, data: string, mode: number): void => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
};

/** Replaces `path` durably: tmp file (unique unless the caller names one), fsync, rename, then fsync of the directory so the rename survives a crash. */
export const replaceFileDurable = (path: string, data: string, mode: number, tmp = `${path}.${randomUUID()}.tmp`): void => {
  const fd = openSync(tmp, "w", mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
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
