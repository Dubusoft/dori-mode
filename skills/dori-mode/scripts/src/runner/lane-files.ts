import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { LANE_KEY } from "../registry.ts";
import { ensureRunnerSubdir, writeRunnerFile } from "./fs-safety.ts";
import { currentUserSid, evaluateSddl, readSddl } from "./win-acl.ts";
import type { LaneBriefFiles, LaneFile, LaneFileLimits, LaneFileRun, LaneFileTree, LaneOutputFiles, RunnerEventBodies } from "./protocol.ts";

export const FILE_LIMITS = {
  fileBytes: 262144, totalBytes: 393216, files: 64, directories: 128, references: 256, depth: 16,
  relativePathBytes: 240, componentBytes: 120, sourcePathBytes: 4096, briefBytes: 65536,
  reportTextBytes: 65536, evidenceBytes: 16384, wireBodyBytes: 786432,
} as const satisfies LaneFileLimits;
const bytes = (s: string): number => Buffer.byteLength(s);
const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export class LaneFileError extends Error {
  constructor(readonly code: string, key: string, detail: string) {
    super(`${code} ${key}: ${detail}`);
    this.name = "LaneFileError";
  }
}
export const invalidFiles = (key: string, reason: string): LaneFileError =>
  new LaneFileError("LANE_FILES_INVALID", key, `invalid file payload (${reason}); regenerate the brief or report and retry`);
export const portableComponent = (name: string): boolean =>
  !!name && name !== "." && name !== ".." && name.normalize("NFC") === name
  && !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(name) && !/[. ]$/.test(name)
  && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name);
export const validateFileKey = (key: string): void => {
  if (!LANE_KEY.test(key) || !portableComponent(key)) throw invalidFiles(key, "run-id");
};
const limit = (key: string, name: keyof LaneFileLimits, n: number, output = false): void => {
  if (n > FILE_LIMITS[name]) throw new LaneFileError(output ? "LANE_REPORT_LIMIT" : "LANE_FILES_LIMIT", key,
    `${name} is ${n}, above ${FILE_LIMITS[name]}; ${output ? "reduce DORI_LANE_OUT or the done text/evidence and claim done again" : "reduce the attachment tree or brief and launch again"}`);
};
export const checkFileBody = (key: string, body: unknown): void => {
  const n = bytes(JSON.stringify(body));
  if (n > FILE_LIMITS.wireBodyBytes) throw new LaneFileError("LANE_FILES_FRAME_TOO_LARGE", key,
    `encoded lane files body is ${n} bytes; the limit is 786432 bytes; reduce the brief, attachments, or report and retry`);
};
const validRun = (run: LaneFileRun): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.id) && typeof run.requiredReport === "boolean";
const checkPath = (key: string, path: string, output: boolean): void => {
  const parts = path.split("/");
  if (!parts.every(portableComponent) || parts[0]!.toLowerCase() === ".dori-lane-files.json") throw invalidFiles(key, "duplicate-path");
  limit(key, "depth", parts.length, output);
  limit(key, "relativePathBytes", bytes(path), output);
  for (const part of parts) limit(key, "componentBytes", bytes(part), output);
};
export const treeDigest = (tree: LaneFileTree): string =>
  hash(JSON.stringify([tree.directories, tree.files.map((f) => [f.path, f.bytes, f.sha256])]));
const fileSize = (key: string, path: string, n: number, output: boolean): void => {
  if (n > FILE_LIMITS.fileBytes) throw new LaneFileError(output ? "LANE_REPORT_TOO_LARGE" : "LANE_FILE_TOO_LARGE", key,
    `${output ? "output file" : "attachment"} ${JSON.stringify(path)} is ${n} bytes; the limit is 262144 bytes; ${output ? "reduce it in DORI_LANE_OUT and claim done again" : "split or reduce it and launch again"}`);
};
const totalSize = (key: string, n: number, output: boolean): void => {
  if (n > FILE_LIMITS.totalBytes) throw new LaneFileError(output ? "LANE_REPORTS_TOO_LARGE" : "LANE_FILES_TOO_LARGE", key,
    `${output ? "DORI_LANE_OUT totals" : "attachments total"} ${n} bytes; the limit is 393216 bytes; ${output ? "remove or reduce files there and claim done again" : "remove or reduce attachments and launch again"}`);
};
export const validateTree = (key: string, tree: LaneFileTree, output = false): void => {
  limit(key, "files", tree.files.length, output);
  limit(key, "directories", tree.directories.length, output);
  const dirs = new Set(tree.directories);
  const names = new Set<string>();
  for (const paths of [tree.directories, tree.files.map((f) => f.path)]) {
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]!;
      checkPath(key, p, output);
      if (i && compare(paths[i - 1]!, p) >= 0) throw invalidFiles(key, "tree-order");
      const folded = p.toUpperCase().toLowerCase();
      if (names.has(folded)) throw invalidFiles(key, dirs.has(p) && tree.files.some((f) => f.path === p) ? "file-directory-collision" : "duplicate-path");
      names.add(folded);
      if (p.includes("/") && !dirs.has(p.slice(0, p.lastIndexOf("/")))) throw invalidFiles(key, "missing-parent");
    }
  }
  let total = 0;
  for (const f of tree.files) {
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) throw invalidFiles(key, "byte-count");
    fileSize(key, f.path, f.bytes, output);
    total += f.bytes;
    totalSize(key, total, output);
    if (f.base64.length > 4 * Math.ceil(FILE_LIMITS.fileBytes / 3)) throw invalidFiles(key, "base64");
    const data = Buffer.from(f.base64, "base64");
    if (data.toString("base64") !== f.base64) throw invalidFiles(key, "base64");
    if (data.length !== f.bytes) throw invalidFiles(key, "byte-count");
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || hash(data) !== f.sha256) throw invalidFiles(key, "digest");
  }
};
export const validateBriefFiles = (key: string, brief: string, files: LaneBriefFiles): void => {
  validateFileKey(key);
  if (!validRun(files.run)) throw invalidFiles(key, "run-id");
  // The generated footer is not part of the raw user-brief budget.
  limit(key, "briefBytes", bytes(brief.split("\n## Lane footer (written by dori launch)")[0]!));
  validateTree(key, files.tree);
  limit(key, "references", files.references.length);
  let end = 0;
  const footer = brief.indexOf("\n## Lane footer (written by dori launch)");
  const bodyEnd = footer < 0 ? brief.length : footer;
  const targets = new Set([...files.tree.directories, ...files.tree.files.map((f) => f.path)]);
  for (const ref of files.references) {
    if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < end || ref.end <= ref.start || ref.end > bodyEnd
      || /[\uDC00-\uDFFF]/.test(brief[ref.start] ?? "") || /[\uD800-\uDBFF]/.test(brief[ref.end - 1] ?? "")) throw invalidFiles(key, "reference-range");
    limit(key, "sourcePathBytes", bytes(brief.slice(ref.start, ref.end)));
    if (!targets.has(ref.target)) throw invalidFiles(key, "reference-target");
    end = ref.end;
  }
};
export const checkManagedReport = (body: RunnerEventBodies["lane.report"]): void => {
  if (!body.files) return;
  const { key, files } = body;
  if (body.kind !== "done") throw invalidFiles(key, "report-kind");
  validateFileKey(key);
  if (!validRun(files.run)) throw invalidFiles(key, "run-id");
  if (!Number.isSafeInteger(files.revision) || files.revision < 1) throw invalidFiles(key, "revision");
  validateTree(key, files.tree, true);
  if (treeDigest(files.tree) !== files.sha256) throw invalidFiles(key, "digest");
  limit(key, "reportTextBytes", bytes(body.text), true);
  limit(key, "evidenceBytes", bytes(body.evidence ?? ""), true);
  checkFileBody(key, body);
};
export const laneFilePaths = (runnerDir: string, key: string) => {
  validateFileKey(key);
  return { input: join(runnerDir, "briefs", `${key}.files`), output: join(runnerDir, "briefs", `${key}.out`), stage: join(runnerDir, "briefs", `${key}.files.next`) };
};
const inside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
/** Remove only a derived child of the real briefs directory; rm unlinks child links rather than following them. */
export const removeLaneTree = (runnerDir: string, path: string): void => {
  const briefs = join(runnerDir, "briefs");
  let st: Stats;
  try { st = lstatSync(briefs); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (!inside(briefs, path) || resolve(path) === resolve(briefs) || st.isSymbolicLink()
    || realpathSync(briefs) !== resolve(briefs)) throw new Error("unsafe lane cleanup ancestry");
  rmSync(path, { recursive: true, force: true });
};
export const rewriteBrief = (brief: string, files: LaneBriefFiles, input: string, windows = false): string => {
  for (const ref of [...files.references].reverse()) {
    const path = windows ? win32.join(input, ...ref.target.split("/")) : join(input, ...ref.target.split("/"));
    brief = brief.slice(0, ref.start) + path + brief.slice(ref.end);
  }
  return brief;
};
/** Validate completely, stage privately, install all inputs, and publish the rewritten brief last. */
export const prepareInput = (runnerDir: string, key: string, brief: string, files: LaneBriefFiles, retainOutput: boolean): void => {
  validateBriefFiles(key, brief, files);
  const paths = laneFilePaths(runnerDir, key);
  ensureRunnerSubdir(runnerDir, "briefs");
  try {
    removeLaneTree(runnerDir, paths.stage);
    mkdirSync(paths.stage, { mode: 0o700 });
    for (const dir of files.tree.directories) mkdirSync(join(paths.stage, dir), { mode: 0o700 });
    for (const f of files.tree.files) writeFileSync(join(paths.stage, f.path), Buffer.from(f.base64, "base64"), { flag: "wx", mode: 0o600 });
    removeLaneTree(runnerDir, paths.input);
    renameSync(paths.stage, paths.input);
    if (!retainOutput) removeLaneTree(runnerDir, paths.output);
    ensureRunnerSubdir(runnerDir, join("briefs", `${key}.out`));
    writeRunnerFile(join(runnerDir, "briefs", `${key}.md`), rewriteBrief(brief, files, paths.input));
  } catch (error) {
    removeLaneTree(runnerDir, paths.stage);
    throw new LaneFileError("LANE_FILES_WRITE_FAILED", key, "cannot prepare the runner brief and attachment directories; fix runner disk space and permissions, then retry");
  }
};

export type FileReaders = {
  lstat: typeof lstatSync; readdir: (path: string) => string[]; realpath: (path: string) => string;
  open: (path: string, flags: number) => number; stat: (fd: number) => Stats;
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  close: (fd: number) => void; acl: typeof readSddl; userSid: () => string;
};
const readers: FileReaders = { lstat: lstatSync, readdir: (p) => readdirSync(p), realpath: realpathSync, open: openSync, stat: fstatSync, read: readSync, close: closeSync, acl: readSddl, userSid: currentUserSid };
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
/** A bounded synchronous snapshot; capture/revision persistence and enqueue share the socket's critical section. */
export const captureOutput = (runnerDir: string, key: string, run: LaneFileRun, remote = false, injected: Partial<FileReaders> = {}, platform: NodeJS.Platform = process.platform): LaneFileTree => {
  const io = { ...readers, ...injected };
  const root = laneFilePaths(runnerDir, key).output;
  const changed = (): never => { throw new LaneFileError("LANE_REPORT_CHANGED", key, "DORI_LANE_OUT changed while being read; finish writing report files and claim done again"); };
  const unsafe = (path: string, reason: string): never => { throw new LaneFileError("LANE_REPORT_UNSAFE", key, `output ${JSON.stringify(path)} is unsafe (${reason}); replace it with a regular file or directory without links and claim done again`); };
  const inspect = (path: string): Stats => {
    const st = io.lstat(path);
    if (st.isSymbolicLink()) unsafe(path, "symlink");
    if (platform === "win32") {
      const acl = io.acl(path);
      if (acl.reparseTag !== undefined) unsafe(path, "reparse-point");
      if (evaluateSddl(acl.sddl, io.userSid())) unsafe(path, "owner-or-acl");
    } else if (typeof process.getuid === "function" && st.uid !== process.getuid()) unsafe(path, "owner-or-acl");
    if (!st.isDirectory() && !st.isFile()) unsafe(path, "special-file");
    if (st.isFile() && st.nlink > 1) unsafe(path, "hard-link");
    if (!inside(root, io.realpath(path))) unsafe(path, "outside-root");
    return st;
  };
  const directories: string[] = [];
  const files: LaneFile[] = [];
  const folded = new Set<string>();
  let total = 0;
  const walk = (dir: string, rel: string): void => {
    const before = inspect(dir);
    if (!before.isDirectory()) unsafe(dir, "special-file");
    const names = io.readdir(dir).sort(compare);
    for (const name of names) {
      const path = join(dir, name), target = rel ? `${rel}/${name}` : name;
      if (!portableComponent(name) || (!rel && name.toLowerCase() === ".dori-lane-files.json")) unsafe(path, "unsafe-name");
      checkPath(key, target, true);
      const nameKey = target.toUpperCase().toLowerCase();
      if (folded.has(nameKey)) unsafe(path, "case-collision");
      folded.add(nameKey);
      const st = inspect(path);
      if (st.isDirectory()) {
        directories.push(target); limit(key, "directories", directories.length, true);
        walk(path, target);
      } else {
        limit(key, "files", files.length + 1, true);
        fileSize(key, path, st.size, true);
        totalSize(key, total + st.size, true);
        const fd = io.open(path, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW));
        let data: Buffer;
        try {
          if (!same(st, io.stat(fd))) changed();
          const buf = Buffer.alloc(st.size + 1);
          let n = 0, count: number;
          while (n < buf.length && (count = io.read(fd, buf, n, buf.length - n, n)) > 0) n += count;
          if (n !== st.size || !same(st, io.stat(fd)) || !same(st, inspect(path))) changed();
          data = buf.subarray(0, n);
        } finally { io.close(fd); }
        total += data.length;
        files.push({ path: target, bytes: data.length, sha256: hash(data), base64: data.toString("base64") });
      }
    }
    if (!same(before, inspect(dir)) || JSON.stringify(names) !== JSON.stringify(io.readdir(dir).sort(compare))) changed();
  };
  try {
    // Check the private control ancestry without auditing untrusted output children.
    for (const path of [runnerDir, join(runnerDir, "briefs")]) {
      const st = io.lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || platform === "win32" && io.acl(path).reparseTag !== undefined) unsafe(path, "symlink");
    }
    const rootStat = inspect(root);
    if (!rootStat.isDirectory()) unsafe(root, "special-file");
    if (platform !== "win32" && (rootStat.mode & 0o777) !== 0o700) unsafe(root, "owner-or-acl");
    walk(root, "");
    directories.sort(compare); files.sort((a, b) => compare(a.path, b.path));
    const tree = { directories, files };
    validateTree(key, tree, true);
    if (run.requiredReport && files.length === 0) throw new LaneFileError("LANE_REPORT_REQUIRED", key,
      `DORI_LANE_OUT is empty; write your report to ${JSON.stringify(join(root, "report.md"))}, then run ${remote ? "~/.dori/runner/bin/dori" : "dori"} report ${key} done --text "<one line>" --evidence "<summary>"`);
    return tree;
  } catch (error) {
    if (error instanceof LaneFileError) throw error;
    throw new LaneFileError("LANE_REPORT_READ_FAILED", key, `cannot read output ${JSON.stringify(root)}; make it readable in DORI_LANE_OUT and claim done again`);
  }
};
