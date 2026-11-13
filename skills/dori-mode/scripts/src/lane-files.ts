import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LANE_KEY, type Lane } from "./registry.ts";
import { acquireStateLock, StateLockError } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";
import type { LaneBriefFiles, LaneFile, LaneFileLimits, LaneFileReceipt, LaneFileRun, LaneFileTree, LaneOutputFiles } from "./runner/protocol.ts";
import { currentUserSid, evaluateSddl, readSddl } from "./runner/win-acl.ts";

export const LEAD_ATTACHMENT_ROOTS = (stateDir: string): readonly string[] => [
  join(dirname(stateDir), "research"), join(stateDir, "briefs"),
];
/**
 * The attachment sources a fresh launch shipped, pinned beside the research root rather than under stateDir: local
 * sandboxes mount stateDir (briefs and registry included) read-write, while the rest of the dori home stays read-only to
 * a lane. Recovery ships only references inside this set, so a lane that rewrites its own brief gains no new reads.
 */
const attachmentPinPath = (stateDir: string, key: string): string => join(dirname(resolve(stateDir)), "lane-attachments", `${key}.json`);
export const writeLaneAttachmentPin = (stateDir: string, key: string, sources: readonly string[]): void => {
  validateFileKey(key);
  const path = attachmentPinPath(stateDir, key);
  if (sources.length === 0) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  saveJsonFile(path, { key, sources });
};
/** A lane launched without a pin (no attachments, or before pins existed) ships nothing on recovery. */
export const readLaneAttachmentPin = (stateDir: string, key: string): readonly string[] => {
  validateFileKey(key);
  let text: string;
  try { text = readFileSync(attachmentPinPath(stateDir, key), "utf8"); } catch (e) { if (codeOf(e) === "ENOENT") return []; throw e; }
  let pin: { key?: unknown; sources?: unknown };
  try { pin = JSON.parse(text) as typeof pin; } catch { return []; }
  if (pin.key !== key || !Array.isArray(pin.sources) || !pin.sources.every((s) => typeof s === "string" && isAbsolute(s))) return [];
  return pin.sources as string[];
};
export const FILE_LIMITS = {
  fileBytes: 262144, totalBytes: 393216, files: 64, directories: 128, references: 256, depth: 16,
  relativePathBytes: 240, componentBytes: 120, sourcePathBytes: 4096, briefBytes: 65536,
  reportTextBytes: 65536, evidenceBytes: 16384, wireBodyBytes: 786432,
} as const satisfies LaneFileLimits;
export const FILE_FOOTER_HEADING = "\n## Lane footer (written by dori launch)";
const MARKER = ".dori-lane-files.json";
const bytes = (s: string): number => Buffer.byteLength(s);
const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const inside = (root: string, path: string): boolean => {
  const r = relative(root, path);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
};
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
const absent = (path: string): Stats | undefined => {
  try { return lstatSync(path); } catch (e) { if (codeOf(e) === "ENOENT") return undefined; throw e; }
};

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
const limit = (key: string, name: keyof LaneFileLimits, n: number, output = false): void => {
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
const portablePath = (key: string, path: string, output: boolean): void => {
  const parts = path.split("/");
  if (!parts.every(portableComponent) || parts[0]?.toLowerCase() === MARKER) throw invalidFiles(key, "duplicate-path");
  limit(key, "depth", parts.length, output);
  limit(key, "relativePathBytes", bytes(path), output);
  for (const p of parts) limit(key, "componentBytes", bytes(p), output);
};
const runValid = (run: LaneFileRun): boolean =>
  typeof run?.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.id) && typeof run.requiredReport === "boolean";
export const treeDigest = (tree: LaneFileTree): string =>
  hash(JSON.stringify([tree.directories, tree.files.map((f) => [f.path, f.bytes, f.sha256])]));

/** Structural q.result guard; semantic errors remain permanent event refusals at the consumer. */
export const isLaneOutputFiles = (v: unknown): v is LaneOutputFiles => {
  const obj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const keys = (x: Record<string, unknown>, names: string[]): boolean => Object.keys(x).length === names.length && names.every((n) => n in x);
  if (!obj(v) || !keys(v, ["run", "revision", "sha256", "tree"]) || !obj(v.run) || !keys(v.run, ["id", "requiredReport"])
    || typeof v.run.id !== "string" || typeof v.run.requiredReport !== "boolean" || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || typeof v.sha256 !== "string"
    || !obj(v.tree) || !keys(v.tree, ["directories", "files"]) || !Array.isArray(v.tree.directories) || !v.tree.directories.every((p) => typeof p === "string")
    || !Array.isArray(v.tree.files)) return false;
  return v.tree.files.every((f) => obj(f) && keys(f, ["path", "bytes", "sha256", "base64"]) && typeof f.path === "string"
    && Number.isSafeInteger(f.bytes) && (f.bytes as number) >= 0 && typeof f.sha256 === "string" && typeof f.base64 === "string");
};
export const validateLaneTree = (key: string, tree: LaneFileTree, output = false): void => {
  limit(key, "directories", tree.directories.length, output);
  limit(key, "files", tree.files.length, output);
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
    if (f.bytes > FILE_LIMITS.fileBytes) throw new LaneFileError(output ? "LANE_REPORT_TOO_LARGE" : "LANE_FILE_TOO_LARGE", key,
      `${output ? "output file" : "attachment"} ${JSON.stringify(f.path)} is ${f.bytes} bytes; the limit is 262144 bytes; ${output ? "reduce it in DORI_LANE_OUT and claim done again" : "split or reduce it and launch again"}`);
    total += f.bytes;
    if (f.base64.length > 4 * Math.ceil(FILE_LIMITS.fileBytes / 3)) throw invalidFiles(key, "base64");
    const buf = Buffer.from(f.base64, "base64");
    if (buf.toString("base64") !== f.base64) throw invalidFiles(key, "base64");
    if (buf.length !== f.bytes) throw invalidFiles(key, "byte-count");
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || hash(buf) !== f.sha256) throw invalidFiles(key, "digest");
  }
  if (total > FILE_LIMITS.totalBytes) throw new LaneFileError(output ? "LANE_REPORTS_TOO_LARGE" : "LANE_FILES_TOO_LARGE", key,
    `${output ? "DORI_LANE_OUT totals" : "attachments total"} ${total} bytes; the limit is 393216 bytes; ${output ? "remove or reduce files there and claim done again" : "remove or reduce attachments and launch again"}`);
};
export const validateLaneOutput = (key: string, files: LaneOutputFiles, expected: LaneFileRun): void => {
  if (!isLaneOutputFiles(files) || !runValid(files.run)) throw invalidFiles(key, "run-id");
  if (files.run.id !== expected.id) throw new LaneFileError("LANE_REPORT_STALE", key, "the report belongs to an older lane run; claim done again from the current lane");
  if (files.run.requiredReport !== expected.requiredReport) throw invalidFiles(key, "run-requirement");
  if (!Number.isSafeInteger(files.revision) || files.revision < 1) throw invalidFiles(key, "revision");
  validateLaneTree(key, files.tree, true);
  if (treeDigest(files.tree) !== files.sha256) throw invalidFiles(key, "digest");
  // The lead cannot reproduce the runner's lane CLI path, so an empty required snapshot is an invalid payload here.
  if (expected.requiredReport && files.tree.files.length === 0) throw invalidFiles(key, "run-requirement");
};

export const checkLaneReportText = (key: string, text: string, evidence?: string): void => {
  limit(key, "reportTextBytes", bytes(text), true);
  limit(key, "evidenceBytes", bytes(evidence ?? ""), true);
};

export type BriefPath = { readonly start: number; readonly end: number; readonly path: string };
export const briefBody = (text: string): string => text.split(FILE_FOOTER_HEADING, 1)[0]!;
/** Ranges are UTF-16 indices, deliberately independent of Markdown rendering. */
export const scanBriefPaths = (text: string, platform: NodeJS.Platform = process.platform): BriefPath[] => {
  const body = briefBody(text);
  const native = (s: string): boolean => platform === "win32" ? /^[A-Za-z]:[\\/]/.test(s) : s.startsWith("/") && !s.startsWith("//");
  const out: BriefPath[] = [];
  const suffix = /(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/;
  for (let i = 0; i < body.length;) {
    const c = body[i]!;
    const endQuote = c === "<" ? ">" : c;
    // An apostrophe inside a word (don't, lane's) never opens a delimited token.
    if (["'", '"', "`", "<"].includes(c) && !(c === "'" && /\p{L}/u.test(body[i - 1] ?? ""))) {
      const end = body.indexOf(endQuote, i + 1);
      if (end !== -1) {
        const s = body.slice(i + 1, end);
        const path = s.replace(suffix, "");
        const prefix = /\S*$/.exec(body.slice(0, i))?.[0] ?? "";
        const inUrl = /(?:^|[([{])[A-Za-z][A-Za-z0-9+.-]*:/.test(prefix);
        if (!inUrl && native(path) && !/[\r\n]/.test(path)) {
          out.push({ start: i + 1, end: i + 1 + path.length, path });
          i = end + 1;
          continue;
        }
        // Not a whole-path token: scan its interior as ordinary unquoted text.
        if (!inUrl) { i++; continue; }
        i = end + 1;
        continue;
      }
    }
    const prev = body[i - 1];
    const boundary = i === 0 || /[\s([{=]/.test(prev!) || (prev === ":" && !/[A-Za-z][A-Za-z0-9+.-]*:$/.test(body.slice(0, i)));
    if (boundary && native(body.slice(i))) {
      let end = i;
      while (end < body.length && !/[\s'"`<>()\[\]{};]/.test(body[end]!)) end++;
      const path = body.slice(i, end).replace(/[.,!?]+$/, "").replace(suffix, "");
      if (path) out.push({ start: i, end: i + path.length, path });
      i = end;
    } else i++;
  }
  return out;
};

export type FileReaders = {
  readonly lstat?: typeof lstatSync;
  readonly readdir?: (path: string) => string[];
  readonly read?: (path: string, size: number) => Buffer;
  readonly security?: (path: string) => "reparse-point" | "owner-or-acl" | undefined;
};
const unchanged = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const boundedRead = (path: string, size: number): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd), expected = lstatSync(path);
    if (!unchanged(before, expected)) throw new Error("changed");
    const buf = Buffer.alloc(size + 1);
    let n = 0, read = 0;
    do { read = readSync(fd, buf, n, buf.length - n, null); n += read; } while (read && n < buf.length);
    if (n !== size || !unchanged(before, fstatSync(fd)) || !unchanged(before, lstatSync(path))) throw new Error("changed");
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
};
export const prepareLaneBrief = (input: {
  readonly key: string; readonly stateDir: string; readonly briefText: string; readonly requiredReport: boolean;
  readonly rawBriefText?: string;
  readonly runId?: string; readonly readers?: FileReaders;
  /** Real source paths a recovery may ship (the launch pin); unset on a fresh launch, which may ship any in-root path. */
  readonly allowed?: readonly string[];
}): { readonly files: LaneBriefFiles; readonly notes: readonly string[]; readonly sources: readonly string[] } => {
  const { key, stateDir, briefText, requiredReport } = input;
  validateFileKey(key);
  limit(key, "briefBytes", bytes(input.rawBriefText ?? briefBody(briefText)));
  // A root that does not exist still claims its paths, so a reference under it is reported missing rather than outside.
  const roots = LEAD_ATTACHMENT_ROOTS(stateDir).map((path): { path: string; real?: string } => {
    try { return { path: resolve(path), real: realpathSync(path) }; } catch (e) { if (codeOf(e) === "ENOENT") return { path: resolve(path) }; throw e; }
  });
  const research = resolve(LEAD_ATTACHMENT_ROOTS(stateDir)[0]!);
  const unsafe = (path: string, reason: string): never => { throw new LaneFileError("LANE_FILE_UNSAFE", key,
    `attachment ${JSON.stringify(path)} is unsafe (${reason}); copy a regular file or directory without links into ${JSON.stringify(research)} and update the brief`); };
  const stat = input.readers?.lstat ?? lstatSync;
  const security = input.readers?.security ?? ((path: string) => {
    if (process.platform !== "win32") return undefined;
    const info = readSddl(path);
    return info.reparseTag !== undefined ? "reparse-point" : evaluateSddl(info.sddl, currentUserSid()) ? "owner-or-acl" : undefined;
  });
  const source = new Map<string, string>();
  const notes: string[] = [], noted = new Set<string>();
  const occurrences = scanBriefPaths(briefText);
  for (const occurrence of occurrences) {
    const path = resolve(occurrence.path);
    const root = roots.find((r) => inside(r.path, path) || (r.real !== undefined && inside(r.real, path)));
    if (!root) {
      // Metadata only: do not resolve, open, enumerate, or charge outside-root paths.
      try { stat(path); if (!noted.has(occurrence.path)) { noted.add(occurrence.path); notes.push(`LANE_FILE_NOT_SHIPPED ${key}: ${JSON.stringify(occurrence.path)} is outside the attachment roots and stays literal`); } } catch {}
      continue;
    }
    const pinned = (real: string): boolean => !input.allowed || input.allowed.some((a) => inside(a, real));
    const notPinned = (): void => {
      if (noted.has(occurrence.path)) return;
      noted.add(occurrence.path);
      notes.push(`LANE_FILE_NOT_SHIPPED ${key}: ${JSON.stringify(occurrence.path)} was not attached at launch and stays literal`);
    };
    const missingNote = (why: string): void => {
      if (noted.has(occurrence.path)) return;
      noted.add(occurrence.path);
      notes.push(`LANE_FILE_NOT_SHIPPED ${key}: ${JSON.stringify(occurrence.path)} ${why} and stays literal`);
    };
    const rootReal = root.real;
    if (rootReal === undefined) {
      if (input.allowed && !input.allowed.some((a) => inside(a, path))) notPinned();
      else missingNote(`does not exist (the attachment root ${JSON.stringify(root.path)} is missing)`);
      continue;
    }
    // Checked before any stat, so a reference the launch never attached can neither ship nor refuse the recovery.
    if (!pinned(inside(root.path, path) ? join(rootReal, relative(root.path, path)) : path)) { notPinned(); continue; }
    limit(key, "sourcePathBytes", bytes(occurrence.path));
    const base = inside(root.path, path) ? root.path : rootReal;
    let cursor = base, missing = false;
    for (const component of relative(base, path).split(sep).filter(Boolean)) {
      cursor = join(cursor, component);
      try {
        if (stat(cursor).isSymbolicLink()) unsafe(cursor, "symlink");
        const reason = security(cursor); if (reason) unsafe(cursor, reason);
      }
      catch (e) { if (codeOf(e) === "ENOENT") { missing = true; break; } if (e instanceof LaneFileError) throw e; throw new LaneFileError("LANE_FILE_READ_FAILED", key, `cannot read attachment ${JSON.stringify(path)}; make it readable or remove its reference and launch again`); }
    }
    if (missing) { missingNote(`does not exist (no ${JSON.stringify(cursor)})`); continue; }
    const real = realpathSync(path);
    if (!inside(rootReal, real)) unsafe(path, "outside-root");
    if (!pinned(real)) { notPinned(); continue; }
    source.set(occurrence.path, real);
  }
  const unique = [...new Set(source.values())].sort(compare);
  const top = unique.filter((p) => !unique.some((parent) => p !== parent && inside(parent, p)));
  const directories = new Set<string>(), files: LaneFile[] = [], targets = new Map<string, string>();
  let total = 0, current = top[0];
  const walk = (path: string, target: string, root: string): void => {
    current = path;
    if (!inside(root, realpathSync(path))) unsafe(path, "outside-root");
    const before = stat(path);
    if (before.isSymbolicLink()) unsafe(path, "symlink");
    const reason = security(path); if (reason) unsafe(path, reason);
    if (!portableComponent(basename(path))) unsafe(path, "unsafe-name");
    portablePath(key, target, false);
    if (before.isDirectory()) {
      directories.add(target); limit(key, "directories", directories.size);
      const list = (input.readers?.readdir ?? readdirSync)(path).sort(compare);
      for (const name of list) walk(join(path, name), `${target}/${name}`, root);
      current = path;
      const after = stat(path), again = (input.readers?.readdir ?? readdirSync)(path).sort(compare);
      if (!unchanged(before, after) || JSON.stringify(list) !== JSON.stringify(again)) throw new Error("changed");
    } else if (before.isFile()) {
      if (before.nlink !== 1) unsafe(path, "hard-link");
      if (before.size > FILE_LIMITS.fileBytes) throw new LaneFileError("LANE_FILE_TOO_LARGE", key, `attachment ${JSON.stringify(path)} is ${before.size} bytes; the limit is 262144 bytes; split or reduce it and launch again`);
      total += before.size;
      if (total > FILE_LIMITS.totalBytes) throw new LaneFileError("LANE_FILES_TOO_LARGE", key, `attachments total ${total} bytes; the limit is 393216 bytes; remove or reduce attachments and launch again`);
      limit(key, "files", files.length + 1);
      const data = (input.readers?.read ?? boundedRead)(path, before.size);
      if (data.length !== before.size || !unchanged(before, stat(path))) throw new Error("changed");
      files.push({ path: target, bytes: data.length, sha256: hash(data), base64: data.toString("base64") });
    } else unsafe(path, "special-file");
  };
  try {
    top.forEach((path, i) => {
      const group = `r${String(i).padStart(4, "0")}`, target = `${group}/${basename(path)}`;
      directories.add(group);
      walk(path, target, path);
      for (const child of unique.filter((p) => inside(path, p))) targets.set(child, [target, relative(path, child).split(sep).join("/")].filter(Boolean).join("/"));
    });
  } catch (e) {
    if (e instanceof LaneFileError) throw e;
    if (e instanceof Error && e.message === "changed") throw new LaneFileError("LANE_FILE_CHANGED", key, `attachment ${JSON.stringify(current)} changed while being read; finish writing it and launch again`);
    throw new LaneFileError("LANE_FILE_READ_FAILED", key, `cannot read attachment ${JSON.stringify(current)}; make it readable or remove its reference and launch again`);
  }
  const references = occurrences.flatMap((o) => { const real = source.get(o.path), target = real && targets.get(real); return target ? [{ start: o.start, end: o.end, target }] : []; });
  limit(key, "references", references.length);
  const tree = { directories: [...directories].sort(compare), files: files.sort((a, b) => compare(a.path, b.path)) };
  validateLaneTree(key, tree);
  const run = { id: input.runId ?? randomUUID(), requiredReport };
  if (!runValid(run)) throw invalidFiles(key, "run-id");
  const result = { files: { run, tree, references }, notes, sources: top };
  checkLaneFilesBody(key, { briefText, files: result.files });
  return result;
};

/**
 * The tree `dori attach` adds to a running lane: the named lead paths under the same roots, safety checks and caps as a
 * launch. A path that would stay literal in a brief (missing, outside the roots) refuses the whole attachment.
 */
export const prepareLaneAttachment = (input: {
  readonly key: string; readonly stateDir: string; readonly paths: readonly string[]; readonly readers?: FileReaders;
}): { readonly tree: LaneFileTree; readonly targets: readonly { readonly source: string; readonly target: string }[] } => {
  const { key, paths } = input;
  validateFileKey(key);
  if (paths.length === 0) throw new LaneFileError("LANE_ATTACH_INVALID", key, "name at least one file or directory under the attachment roots");
  for (const p of paths) {
    if (!isAbsolute(p) || /[`\r\n]/.test(p)) throw new LaneFileError("LANE_ATTACH_INVALID", key, `${JSON.stringify(p)} must be an absolute path without backticks or line breaks`);
  }
  // Each path as one delimited brief token, so the launch scanner, roots and caps decide exactly as for a brief.
  const briefText = paths.map((p) => `\`${p}\``).join("\n");
  const prepared = prepareLaneBrief({ key, stateDir: input.stateDir, briefText, requiredReport: false, ...(input.readers ? { readers: input.readers } : {}) });
  const targets = prepared.files.references.map((ref) => ({ source: briefText.slice(ref.start, ref.end), target: ref.target }));
  const skipped = paths.filter((p) => !targets.some((t) => t.source === p));
  if (prepared.notes.length || skipped.length) {
    const roots = LEAD_ATTACHMENT_ROOTS(input.stateDir).map((r) => JSON.stringify(resolve(r))).join(" or ");
    throw new LaneFileError("LANE_ATTACH_REFUSED", key, [...prepared.notes,
      ...skipped.filter((p) => !prepared.notes.some((n) => n.includes(JSON.stringify(p)))).map((p) => `${JSON.stringify(p)} is not a file or directory under ${roots}`),
    ].join("; "));
  }
  return { tree: prepared.files.tree, targets };
};

export type CollectionNote = { readonly id: string; readonly line: string };
export type InstallOptions = {
  readonly now?: () => number;
  readonly emit?: (id: string, line: string) => void;
  readonly checkCurrent: () => Promise<Lane | null | undefined>;
  readonly step?: (name: string) => void;
  /** Injectable per-key lock acquisition (tests); defaults to the state lock. */
  readonly lock?: (path: string) => Promise<() => void>;
};
type Receipt = LaneFileReceipt & { readonly key: string };
type Identity = { readonly dev: number; readonly ino: number };
type Intent = {
  readonly key: string; readonly target: string; readonly oldReceipt: Receipt | null; readonly newReceipt: Receipt;
  readonly migration?: { readonly backup: string; readonly identity: Identity; readonly note: CollectionNote };
};
const sameReceipt = (a: Receipt | undefined | null, b: Receipt | undefined | null): boolean =>
  Boolean(a && b && a.key === b.key && a.run.id === b.run.id && a.run.requiredReport === b.run.requiredReport && a.revision === b.revision && a.sha256 === b.sha256);
const destination = (stateDir: string, key: string): string => join(dirname(resolve(stateDir)), "research", key);
const unsafeDestination = (key: string, path: string): LaneFileError => new LaneFileError("LANE_REPORT_DESTINATION_UNSAFE", key,
  `collection destination ${JSON.stringify(path)} is not a safe dori-managed directory; move the conflicting path aside and retry the claim`);
const ownerSafe = (path: string, st: Stats): boolean => {
  if (process.platform === "win32") {
    const info = readSddl(path);
    return info.reparseTag === undefined && !evaluateSddl(info.sddl, currentUserSid(), { root: false });
  }
  return typeof process.getuid !== "function" || st.uid === process.getuid();
};
export const protectLaneCollectionDirectory = (path: string, options: {
  readonly platform?: NodeJS.Platform; readonly sid?: () => string;
  readonly run?: (exe: string, args: readonly string[]) => unknown;
} = {}): void => {
  if ((options.platform ?? process.platform) !== "win32") return;
  const args = [path, "/inheritance:r", "/grant:r", `*${(options.sid ?? currentUserSid)()}:(OI)(CI)F`];
  (options.run ?? ((exe, argv) => execFileSync(exe, argv, { windowsHide: true })))("icacls.exe", args);
};
const safeDirectory = (path: string, key: string, create = false): void => {
  const parent = dirname(path);
  if (parent !== path) safeDirectory(parent, key, create);
  let st = absent(path);
  if (!st && create) { mkdirSync(path, { mode: 0o700 }); st = lstatSync(path); }
  // System ancestors may belong to root; writable destination parents must belong to this user.
  if (!st || !st.isDirectory() || st.isSymbolicLink() || (process.platform === "win32" && readSddl(path).reparseTag !== undefined)) throw unsafeDestination(key, path);
};
const privateDirectory = (path: string, key: string): void => {
  const existed = absent(path);
  safeDirectory(path, key, true);
  if (!existed) protectLaneCollectionDirectory(path);
  if (!ownerSafe(path, lstatSync(path))) throw unsafeDestination(key, path);
};
const syncDir = (path: string): void => {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
const receiptAt = (path: string, key: string): Receipt | undefined => {
  const st = absent(path);
  if (!st) return undefined;
  if (!st.isDirectory() || st.isSymbolicLink() || !ownerSafe(path, st)) throw unsafeDestination(key, path);
  const marker = join(path, MARKER), m = absent(marker);
  if (!m || !m.isFile() || m.isSymbolicLink() || m.nlink !== 1 || m.size > FILE_LIMITS.wireBodyBytes || !ownerSafe(marker, m)) return undefined;
  let receipt: Receipt;
  try { receipt = JSON.parse(boundedRead(marker, m.size).toString("utf8")); } catch { return undefined; }
  if (receipt.key !== key || !runValid(receipt.run) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return undefined;
  const tree: { directories: string[]; files: LaneFile[] } = { directories: [], files: [] };
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort(compare)) {
      if (!prefix && name === MARKER) continue;
      const file = join(dir, name), rel = prefix ? `${prefix}/${name}` : name, s = lstatSync(file);
      if (s.isSymbolicLink() || !ownerSafe(file, s)) throw unsafeDestination(key, path);
      portablePath(key, rel, true);
      if (s.isDirectory()) {
        tree.directories.push(rel); limit(key, "directories", tree.directories.length, true); walk(file, rel);
      }
      else if (s.isFile() && s.nlink === 1 && s.size <= FILE_LIMITS.fileBytes) {
        limit(key, "files", tree.files.length + 1, true);
        total += s.size;
        if (total > FILE_LIMITS.totalBytes) throw unsafeDestination(key, path);
        const data = boundedRead(file, s.size);
        tree.files.push({ path: rel, bytes: data.length, sha256: hash(data), base64: data.toString("base64") });
      } else throw unsafeDestination(key, path);
    }
  };
  try {
    walk(path, "");
    tree.directories.sort(compare); tree.files.sort((a, b) => compare(a.path, b.path));
    validateLaneTree(key, tree, true);
    return treeDigest(tree) === receipt.sha256 ? receipt : undefined;
  } catch (e) { if (e instanceof LaneFileError) return undefined; throw e; }
};
const removePrivate = (path: string, key: string): void => {
  const st = absent(path);
  if (!st) return;
  if (!st.isDirectory() || st.isSymbolicLink() || !ownerSafe(path, st)) throw unsafeDestination(key, path);
  rmSync(path, { recursive: true });
};
const receiptOf = (key: string, files: LaneOutputFiles): Receipt => ({ key, run: files.run, revision: files.revision, sha256: files.sha256 });
const revalidate = async (key: string, run: LaneFileRun, options: InstallOptions): Promise<void> => {
  const lane = await options.checkCurrent();
  if (!lane || lane.closedAt || lane.fileRun?.id !== run.id || lane.fileRun.requiredReport !== run.requiredReport)
    throw new LaneFileError("LANE_REPORT_STALE", key, "the report belongs to an older lane run; claim done again from the current lane");
};
/** The lock covers transaction replay, active-run checks, and publication. */
const collection = async <T>(stateDir: string, key: string, options: InstallOptions, action: (paths: { target: string; tx: string; next: string; previous: string; intent: string }) => Promise<T>): Promise<T> => {
  validateFileKey(key);
  const target = destination(stateDir, key), research = dirname(target), lockDir = join(stateDir, "lane-files");
  try {
    privateDirectory(dirname(resolve(stateDir)), key);
    privateDirectory(lockDir, key);
    const lockPath = join(lockDir, `${key}.lock.sqlite`), lock = absent(lockPath);
    if (lock && (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 || !ownerSafe(lockPath, lock))) throw unsafeDestination(key, lockPath);
    const unlock = await (options.lock ?? acquireStateLock)(lockPath);
    try {
      privateDirectory(research, key);
      const tx = join(research, ".dori-lane-files", key);
      privateDirectory(dirname(tx), key); privateDirectory(tx, key);
      return await action({ target, tx, next: join(tx, "next"), previous: join(tx, "previous"), intent: join(tx, "intent.json") });
    } finally { unlock(); }
  } catch (e) {
    if (e instanceof LaneFileError) throw e;
    // A busy per-key lock (e.g. a concurrent direct claim) is contention, not an unsafe destination.
    if (e instanceof StateLockError || ["ENOSPC", "EIO", "EBUSY", "EAGAIN"].includes(codeOf(e) ?? "")) {
      // Accepted head-of-line stall: durable journal bytes are retained until this install succeeds.
      throw new LaneFileError("LANE_REPORT_COLLECT_FAILED", key, `cannot install report files in ${JSON.stringify(target)}; fix lead disk space and permissions; the saved report will retry`, true);
    }
    if (["EACCES", "EPERM", "ENOTDIR", "EEXIST"].includes(codeOf(e) ?? "")) throw unsafeDestination(key, target);
    // Anything else is unexpected: propagate unrelabeled so callers retry it as transient.
    throw e;
  }
};

const collectLaneReports = async (stateDir: string, key: string, options: InstallOptions,
  files?: LaneOutputFiles, receipt?: LaneFileReceipt, admit?: () => Promise<void>): Promise<LaneFileReceipt> => {
  if (files) validateLaneOutput(key, files, files.run);
  if (receipt && (!runValid(receipt.run) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !/^[a-f0-9]{64}$/.test(receipt.sha256))) throw invalidFiles(key, "revision");
  return collection(stateDir, key, options, async (p) => {
    await revalidate(key, (files ?? receipt)!.run, options);
    const step = (s: string): void => options.step?.(s);
    const readControl = <T>(path: string, initial: T): T => {
      const st = absent(path);
      if (!st) return initial;
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !ownerSafe(path, st) || st.size > FILE_LIMITS.wireBodyBytes) throw unsafeDestination(key, path);
      return JSON.parse(boundedRead(path, st.size).toString("utf8")) as T;
    };
    const notesPath = join(p.tx, "migration-notes.json");
    const notes = readControl<CollectionNote[]>(notesPath, []);
    const deliveredPath = join(p.tx, "migration-delivered.json");
    const delivered = readControl<string[]>(deliveredPath, []);
    const deliver = (): void => {
      if (!options.emit) return;
      for (const note of notes) {
        if (delivered.includes(note.id)) continue;
        options.emit(note.id, note.line); step("note-emitted");
        delivered.push(note.id); saveJsonFile(deliveredPath, delivered); step("note-delivered");
      }
    };
    const recordNote = (note: CollectionNote): void => {
      if (!notes.some((n) => n.id === note.id)) { notes.push(note); saveJsonFile(notesPath, notes); step("note-persisted"); }
      deliver();
    };
    const stage = (receipt: Receipt): void => {
      if (!files || !sameReceipt(receipt, receiptOf(key, files))) throw new LaneFileError("LANE_REPORT_RECEIPT_MISSING", key, "the collected report is missing or changed; claim done again through the runner");
      removePrivate(p.next, key);
      mkdirSync(p.next, { mode: 0o700 });
      for (const dir of files.tree.directories) mkdirSync(join(p.next, dir), { mode: 0o700 });
      for (const file of files.tree.files) {
        const path = join(p.next, file.path), fd = openSync(path, "wx", 0o600);
        try { writeFileSync(fd, Buffer.from(file.base64, "base64")); fsyncSync(fd); } finally { closeSync(fd); }
      }
      saveJsonFile(join(p.next, MARKER), receipt);
      for (const dir of [...files.tree.directories].reverse()) syncDir(join(p.next, dir));
      syncDir(p.next); step("staged");
    };
    const loadIntent = (): Intent | undefined => {
      if (!absent(p.intent)) return undefined;
      const st = lstatSync(p.intent);
      if (!st.isFile() || st.isSymbolicLink() || !ownerSafe(p.intent, st)) throw unsafeDestination(key, p.target);
      const i: Intent = JSON.parse(readFileSync(p.intent, "utf8"));
      const valid = (r: Receipt | null): boolean => Boolean(r && r.key === key && runValid(r.run) && Number.isSafeInteger(r.revision) && r.revision > 0 && /^[a-f0-9]{64}$/.test(r.sha256));
      if (i.key !== key || i.target !== p.target || !valid(i.newReceipt) || (i.oldReceipt !== null && !valid(i.oldReceipt))
        || (i.migration && (!i.migration.backup.startsWith(`${p.target}.pre-dori-`) || dirname(i.migration.backup) !== dirname(p.target)))) throw unsafeDestination(key, p.target);
      return i;
    };
    const complete = (intent: Intent): void => {
      if (absent(p.previous) && !sameReceipt(receiptAt(p.previous, key), intent.oldReceipt)) throw unsafeDestination(key, p.previous);
      saveJsonFile(join(p.tx, "complete.json"), intent.newReceipt); step("completed");
      removePrivate(p.next, key); removePrivate(p.previous, key);
      unlinkSync(p.intent); syncDir(p.tx);
    };
    const resume = (i: Intent): void => {
      // A marker is never enough: every candidate receipt is checked against its actual bytes.
      const final = receiptAt(p.target, key), next = receiptAt(p.next, key), previous = receiptAt(p.previous, key);
      const migration = i.migration;
      if (migration) {
        const original = absent(p.target), backup = absent(migration.backup);
        const identity = (st: Stats | undefined): boolean => Boolean(st && st.isDirectory() && !st.isSymbolicLink() && st.dev === migration.identity.dev && st.ino === migration.identity.ino);
        if (backup && (!identity(backup) || !ownerSafe(migration.backup, backup))) throw unsafeDestination(key, migration.backup);
        if (sameReceipt(final, i.newReceipt) && identity(backup)) { recordNote(migration.note); complete(i); return; }
        if (!sameReceipt(next, i.newReceipt)) {
          if (!identity(backup) || original) throw unsafeDestination(key, p.target);
          stage(i.newReceipt);
        }
        if (original) {
          if (!identity(original) || backup) throw unsafeDestination(key, p.target);
          step("before-migration-rename");
          if (absent(migration.backup)) throw unsafeDestination(key, migration.backup);
          renameSync(p.target, migration.backup); syncDir(dirname(p.target)); step("migration-renamed");
        } else if (!identity(backup)) throw unsafeDestination(key, p.target);
        recordNote(migration.note);
      } else {
        if (sameReceipt(final, i.newReceipt)) { complete(i); return; }
        if (sameReceipt(final, i.oldReceipt) && sameReceipt(next, i.newReceipt) && !absent(p.previous)) {
          renameSync(p.target, p.previous); syncDir(dirname(p.target)); step("previous-renamed");
        } else if (!absent(p.target) && sameReceipt(previous, i.oldReceipt) && !next) {
          renameSync(p.previous, p.target); removePrivate(p.next, key); unlinkSync(p.intent); return;
        } else if (absent(p.target) || !sameReceipt(next, i.newReceipt)
          || (i.oldReceipt ? !sameReceipt(previous, i.oldReceipt) : Boolean(absent(p.previous)))) throw unsafeDestination(key, p.target);
      }
      step("before-snapshot-rename");
      renameSync(p.next, p.target); syncDir(dirname(p.target)); step("snapshot-renamed");
      complete(i);
    };
    const intent = loadIntent();
    if (intent) resume(intent);
    else if (absent(p.previous)) throw unsafeDestination(key, p.previous);
    if (!files) {
      const installed = receiptAt(p.target, key);
      if (!installed || installed.run.id !== receipt!.run.id || installed.run.requiredReport !== receipt!.run.requiredReport
        || installed.revision < receipt!.revision || (installed.revision === receipt!.revision && installed.sha256 !== receipt!.sha256))
        throw new LaneFileError("LANE_REPORT_RECEIPT_MISSING", key, "the collected report is missing or changed; claim done again through the runner");
      deliver();
      await revalidate(key, receipt!.run, options);
      await admit?.();
      return { run: installed.run, revision: installed.revision, sha256: installed.sha256 };
    }
    await revalidate(key, files.run, options);
    const existing = receiptAt(p.target, key), proposed = receiptOf(key, files);
    if (existing?.run.id === files.run.id) {
      if (existing.revision === files.revision && existing.sha256 !== files.sha256) throw invalidFiles(key, "digest");
      if (existing.revision >= files.revision) { deliver(); return { run: existing.run, revision: existing.revision, sha256: existing.sha256 }; }
    }
    stage(proposed);
    const old = absent(p.target);
    if (old && (!old.isDirectory() || old.isSymbolicLink() || !ownerSafe(p.target, old))) throw unsafeDestination(key, p.target);
    let migration: Intent["migration"];
    if (old && !existing) {
      let time = (options.now ?? Date.now)(), backup: string, timestamp: string;
      do { timestamp = new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); backup = `${p.target}.pre-dori-${timestamp}`; time += 1000; } while (absent(backup));
      migration = { backup, identity: { dev: old.dev, ino: old.ino }, note: {
        id: `lane-report-migrated:${key}:${timestamp}`, line: `LANE_REPORT_MIGRATED ${key}: moved unmanaged collection directory ${JSON.stringify(p.target)} to ${JSON.stringify(backup)}; preserved its contents and installing the report snapshot`,
      } };
    }
    const nextIntent: Intent = { key, target: p.target, oldReceipt: existing ?? null, newReceipt: proposed, ...(migration ? { migration } : {}) };
    saveJsonFile(p.intent, nextIntent); step("intent-written");
    resume(nextIntent);
    deliver();
    return { run: files.run, revision: files.revision, sha256: files.sha256 };
  });
};

export const installLaneReports = (stateDir: string, key: string, files: LaneOutputFiles, options: InstallOptions): Promise<LaneFileReceipt> =>
  collectLaneReports(stateDir, key, options, files);

/** Admission runs under the same per-key lock as receipt verification and transaction recovery. */
export const verifyLaneFileReceipt = async (stateDir: string, key: string, receipt: LaneFileReceipt, options: InstallOptions,
  admit?: () => Promise<void>): Promise<void> => {
  await collectLaneReports(stateDir, key, options, undefined, receipt, admit);
};
