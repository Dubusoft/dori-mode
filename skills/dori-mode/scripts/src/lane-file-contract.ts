import { createHash } from "node:crypto";
import { LANE_KEY } from "./registry.ts";
import type { LaneFileLimits, LaneFileTree } from "./runner/protocol.ts";

export const FILE_LIMITS = {
  fileBytes: 262144, totalBytes: 393216, files: 64, directories: 128, references: 256, depth: 16,
  relativePathBytes: 240, componentBytes: 120, sourcePathBytes: 4096, briefBytes: 65536,
  reportTextBytes: 65536, evidenceBytes: 16384, wireBodyBytes: 786432,
} as const satisfies LaneFileLimits;
export const MARKER = ".dori-lane-files.json";
export const bytes = (s: string): number => Buffer.byteLength(s);
export const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export class LaneFileError extends Error {
  constructor(readonly code: string, key: string, detail: string, readonly transient = false) {
    super(`${code} ${key}: ${detail}`);
    this.name = "LaneFileError";
  }
}
export const invalidFiles = (key: string, reason: string): LaneFileError =>
  new LaneFileError("LANE_FILES_INVALID", key, `invalid file payload (${reason}); regenerate the brief or report and retry`);
export const validateFileKey = (key: string): void => {
  if (!LANE_KEY.test(key) || !portableComponent(key)) throw invalidFiles(key, "run-id");
};
export const limit = (key: string, name: keyof LaneFileLimits, n: number, output = false): void => {
  if (n > FILE_LIMITS[name]) throw new LaneFileError(output ? "LANE_REPORT_LIMIT" : "LANE_FILES_LIMIT", key,
    `${name} is ${n}, above ${FILE_LIMITS[name]}; ${output ? "reduce DORI_LANE_OUT or the done text/evidence and claim done again" : "reduce the attachment tree or brief and launch again"}`);
};
export const checkLaneFilesBody = (key: string, body: unknown): void => {
  const size = bytes(JSON.stringify(body));
  if (size > FILE_LIMITS.wireBodyBytes) throw new LaneFileError("LANE_FILES_FRAME_TOO_LARGE", key,
    `encoded lane files body is ${size} bytes; the limit is 786432 bytes; reduce the brief, attachments, or report and retry`);
};
export const portableComponent = (name: string): boolean =>
  name.length > 0 && name !== "." && name !== ".." && name.normalize("NFC") === name
  && !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(name) && !/[. ]$/.test(name)
  && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name);
export const portablePath = (key: string, path: string, output: boolean): void => {
  const parts = path.split("/");
  if (!parts.every(portableComponent) || parts[0]?.toLowerCase() === MARKER) throw invalidFiles(key, "duplicate-path");
  limit(key, "depth", parts.length, output);
  limit(key, "relativePathBytes", bytes(path), output);
  for (const p of parts) limit(key, "componentBytes", bytes(p), output);
};
export const treeDigest = (tree: LaneFileTree): string =>
  hash(JSON.stringify([tree.directories, tree.files.map((f) => [f.path, f.bytes, f.sha256])]));
export const fileSize = (key: string, path: string, n: number, output: boolean): void => {
  if (n > FILE_LIMITS.fileBytes) throw new LaneFileError(output ? "LANE_REPORT_TOO_LARGE" : "LANE_FILE_TOO_LARGE", key,
    `${output ? "output file" : "attachment"} ${JSON.stringify(path)} is ${n} bytes; the limit is 262144 bytes; ${output ? "reduce it in DORI_LANE_OUT and claim done again" : "split or reduce it and launch again"}`);
};
export const totalSize = (key: string, n: number, output: boolean): void => {
  if (n > FILE_LIMITS.totalBytes) throw new LaneFileError(output ? "LANE_REPORTS_TOO_LARGE" : "LANE_FILES_TOO_LARGE", key,
    `${output ? "DORI_LANE_OUT totals" : "attachments total"} ${n} bytes; the limit is 393216 bytes; ${output ? "remove or reduce files there and claim done again" : "remove or reduce attachments and launch again"}`);
};
/**
 * The semantic tree check both boundaries share. `runner` keeps the runner's check order: the file cap before the
 * directory cap, and the running total after each file, before its payload is decoded; the lead checks the total once
 * after every payload is decoded.
 */
export const validateLaneTree = (key: string, tree: LaneFileTree, output = false, runner = false): void => {
  for (const name of runner ? ["files", "directories"] as const : ["directories", "files"] as const) limit(key, name, tree[name].length, output);
  const names = new Map<string, string>();
  const dirs = new Set(tree.directories);
  for (const group of [tree.directories, tree.files.map((f) => f.path)]) {
    for (let i = 0; i < group.length; i++) {
      const path = group[i]!;
      portablePath(key, path, output);
      if (i && compare(group[i - 1]!, path) >= 0) throw invalidFiles(key, "tree-order");
      const folded = path.normalize("NFC").toUpperCase().toLowerCase();
      if (names.has(folded)) throw invalidFiles(key, dirs.has(path) && tree.files.some((f) => f.path === path) ? "file-directory-collision" : "duplicate-path");
      names.set(folded, path);
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (path.includes("/") && !dirs.has(parent)) throw invalidFiles(key, "missing-parent");
    }
  }
  let total = 0;
  for (const f of tree.files) {
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) throw invalidFiles(key, "byte-count");
    fileSize(key, f.path, f.bytes, output);
    total += f.bytes;
    if (runner) totalSize(key, total, output);
    if (f.base64.length > 4 * Math.ceil(FILE_LIMITS.fileBytes / 3)) throw invalidFiles(key, "base64");
    const buf = Buffer.from(f.base64, "base64");
    if (buf.toString("base64") !== f.base64) throw invalidFiles(key, "base64");
    if (buf.length !== f.bytes) throw invalidFiles(key, "byte-count");
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || hash(buf) !== f.sha256) throw invalidFiles(key, "digest");
  }
  totalSize(key, total, output);
};
