import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../setup.ts";
import { tryStateLock } from "../state-lock.ts";
import { currentUserSid, evaluateSddl, IO_REPARSE_TAG_AF_UNIX, readSddl, type AclInfo } from "./win-acl.ts";
import { LANE_KEY } from "../registry.ts";

/**
 * The runner directory and its safety rules. The directory (default `~/.dori/runner`) and every directory under it
 * are 0700, every file is 0600 (0600 or 0700 under `bin/` and `bun/`, where `dori runner install` puts the runner's
 * wrapper and bun), nothing in it is a symlink, and everything is owned by the runner's user. A runner
 * that finds otherwise at start writes `RUNNER_DIR_UNSAFE <path> <reason>` to stderr and exits 1. Files are replaced
 * atomically (temporary file, fsync, rename) through `writeFileAtomic` from setup.ts.
 *
 * On Windows the modes and uids give way to the owner and DACL (see win-acl.ts): every entry is owned by the runner
 * user's SID, allow ACEs name only that user, SYSTEM and Administrators (CREATOR OWNER inherit-only), the root's DACL is
 * protected, nothing is a reparse point except the AF_UNIX socket directly under `sock\`, and the directory is not on
 * a UNC path.
 */

export const RUNNER_DIR_MODE = 0o700;
export const RUNNER_FILE_MODE = 0o600;

/** Entries of the runner directory, relative to it. */
export const RUNNER_PATHS = {
  identity: "runner.json",
  state: "state.sqlite",
  outbox: "outbox.sqlite",
  bodies: "bodies",
  briefs: "briefs",
  keys: "keys",
  sock: "sock",
  health: "health",
  logs: "logs",
  bin: "bin",
  bun: "bun",
} as const;

/** The lock `runner serve` holds for its whole life (0600, inside the runner directory). */
export const SERVE_LOCK = "serve.lock";

/**
 * Takes the runner directory's serve lock, or returns undefined while another live process holds it. Two serves on one
 * directory share its outbox and state: each appends events under seqs the other never sends, so the supervisor sees a
 * gap, and both hello with the same gen. The kernel drops the lock when the holder dies.
 */
export const holdServeLock = (dir: string): (() => void) | undefined => {
  const path = join(dir, SERVE_LOCK);
  writeFileSync(path, "", { flag: "a", mode: RUNNER_FILE_MODE });
  chmodSync(path, RUNNER_FILE_MODE);
  return tryStateLock(path);
};

/** `~/.dori/runner` under `home`; every runner module takes the directory as an argument and defaults to this. */
export const defaultRunnerDir = (home: string = homedir()): string => join(home, ".dori", "runner");

export type UnsafeReason = "symlink" | "mode" | "owner" | "not-directory" | "not-file" | "acl" | "remote";

/** The first unsafe entry found. Message: `RUNNER_DIR_UNSAFE <path> <reason>`. */
export class RunnerDirUnsafe extends Error {
  readonly code = "RUNNER_DIR_UNSAFE";
  constructor(readonly path: string, readonly reason: UnsafeReason, readonly detail = "") {
    super(`RUNNER_DIR_UNSAFE ${path} ${reason}${detail ? ` ${detail}` : ""}`);
    this.name = "RunnerDirUnsafe";
  }
}

/**
 * The owner the check expects; tests pass their own uid. Defaults to `process.getuid()`. `platform` (default
 * `process.platform`) selects the Windows rules, where `acl` reads an entry's owner and SDDL (default `readSddl`) and
 * `userSid` is the expected owner (default `currentUserSid()`).
 */
export type FsSafetyOptions = {
  readonly uid?: number;
  readonly platform?: NodeJS.Platform;
  readonly acl?: (path: string) => AclInfo;
  readonly userSid?: string;
};

const expectedOwner = (options: FsSafetyOptions): number | undefined =>
  options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);

const isWindows = (options: FsSafetyOptions): boolean => (options.platform ?? process.platform) === "win32";

/** What the Windows walk checks against: the root (for `D:P` and `sock\`), the user SID and the ACL reader. */
type WinCheck = { readonly root: string; readonly userSid: string; readonly acl: (path: string) => AclInfo };

/** `\\server\share\...`, `//server/share/...` or `\\?\UNC\...`; a `\\?\C:\` long local path is not one. */
const isUncPath = (path: string): boolean => /^[\\/]{2}(?![?.][\\/][A-Za-z]:)/.test(path);

const DIRECTORY_ENTRIES: ReadonlySet<string> = new Set([
  RUNNER_PATHS.bodies, RUNNER_PATHS.briefs, RUNNER_PATHS.keys, RUNNER_PATHS.sock, RUNNER_PATHS.logs, RUNNER_PATHS.bin, RUNNER_PATHS.bun,
]);
/** Directories holding executables: their files may also be 0700, still owner-only. */
const EXECUTABLE_DIRS: ReadonlySet<string> = new Set([RUNNER_PATHS.bin, RUNNER_PATHS.bun]);
const FILE_ENTRIES: ReadonlySet<string> = new Set([RUNNER_PATHS.identity, RUNNER_PATHS.state, RUNNER_PATHS.outbox]);

const inspect = (path: string, uid: number | undefined, kind: "dir" | "file", executable = false): Stats => {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new RunnerDirUnsafe(path, "symlink");
  if (kind === "dir" && !st.isDirectory()) throw new RunnerDirUnsafe(path, "not-directory");
  if (kind === "file" && !st.isFile() && !st.isSocket()) throw new RunnerDirUnsafe(path, "not-file");
  if (uid !== undefined && st.uid !== uid) throw new RunnerDirUnsafe(path, "owner", `uid=${st.uid}`);
  // Sockets take their mode from the umask of whoever binds them; the 0700 sock/ directory is their boundary.
  if (!st.isSocket()) {
    const mode = st.mode & 0o777;
    const want = kind === "dir" ? RUNNER_DIR_MODE : RUNNER_FILE_MODE;
    if (mode !== want && !(kind === "file" && executable && mode === RUNNER_DIR_MODE)) throw new RunnerDirUnsafe(path, "mode", `mode=${mode.toString(8).padStart(4, "0")}`);
  }
  return st;
};

/**
 * The Windows form of `inspect`: reparse points (symlinks, junctions) are refused except an AF_UNIX socket directly
 * under `sock\`, the type is checked as on POSIX, and the owner and DACL go through `evaluateSddl` instead of uid and mode.
 * The socket is never lstat'd: Bun on Windows fails that with EACCES once its listener is gone (a hard-killed runner).
 */
const inspectWindows = (path: string, win: WinCheck, kind: "dir" | "file"): void => {
  const info = win.acl(path);
  const socket = info.reparseTag === IO_REPARSE_TAG_AF_UNIX && kind === "file" && dirname(path) === join(win.root, RUNNER_PATHS.sock);
  if (!socket) {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || info.reparseTag !== undefined) throw new RunnerDirUnsafe(path, "symlink", info.reparseTag !== undefined ? `tag=0x${info.reparseTag.toString(16)}` : "");
    if (kind === "dir" && !st.isDirectory()) throw new RunnerDirUnsafe(path, "not-directory");
    if (kind === "file" && !st.isFile() && !st.isSocket()) throw new RunnerDirUnsafe(path, "not-file");
  }
  const verdict = evaluateSddl(info.sddl, win.userSid, { root: path === win.root });
  if (verdict) throw new RunnerDirUnsafe(path, verdict.reason, verdict.detail);
};

const lstatDenied = (path: string): boolean => {
  try { lstatSync(path); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "EACCES"; }
};

const outputName = (name: string): boolean => name.endsWith(".out") && LANE_KEY.test(name.slice(0, -4))
  && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name.slice(0, -4)) && !name.slice(0, -4).endsWith(".");
const walk = (dir: string, uid: number | undefined, top: boolean, executable = false, win?: WinCheck, root = dir): void => {
  if (win) inspectWindows(dir, win, "dir");
  else inspect(dir, uid, "dir");
  // Lane output is untrusted data. Audit its exact root, then let bounded capture audit descendants.
  if (dirname(dir) === join(root, RUNNER_PATHS.briefs) && outputName(basename(dir))) return;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    // A socket left under `sock\` by a killed runner can't be lstat'd on Windows (EACCES); inspectWindows reads it.
    if (win && dir === join(win.root, RUNNER_PATHS.sock) && lstatDenied(path)) { inspectWindows(path, win, "file"); continue; }
    const st = lstatSync(path);
    if (dir === join(root, RUNNER_PATHS.briefs) && outputName(name)) {
      walk(path, uid, false, false, win, root);
      continue;
    }
    // Only the entries the runner itself defines have a fixed type; anything else is checked by what it is.
    const isTopDir = top && DIRECTORY_ENTRIES.has(name);
    const isTopFile = top && (FILE_ENTRIES.has(name) || /^(state|outbox)\.sqlite-(wal|shm)$/.test(name));
    if (st.isSymbolicLink() && !win) throw new RunnerDirUnsafe(path, "symlink");
    if (isTopDir || (st.isDirectory() && !st.isSymbolicLink() && !isTopFile)) walk(path, uid, false, top ? EXECUTABLE_DIRS.has(name) : executable, win, root);
    else if (win) inspectWindows(path, win, "file");
    else inspect(path, uid, "file", executable);
  }
};

/**
 * Checks `dir` and everything under it (lstat, never following links). Throws `RunnerDirUnsafe` for the first entry
 * that is a symlink, is not mode 0700 (directories) or 0600 (files; 0700 also under `bin/` and `bun/`), is owned by another user, or is a file where a
 * directory belongs (or the reverse) for a known `RUNNER_PATHS` entry. A missing `dir` is unsafe as `not-directory`.
 * On Windows the uid and mode checks are replaced by the owner/DACL policy (`owner`, `acl`), reparse points fail as
 * `symlink` (the socket under `sock\` excepted), and a UNC path fails as `remote` before anything is read.
 */
export const checkRunnerDir = (dir: string, options: FsSafetyOptions = {}): void => {
  const windows = isWindows(options);
  if (windows && isUncPath(dir)) throw new RunnerDirUnsafe(dir, "remote", "unc");
  const uid = windows ? undefined : expectedOwner(options);
  try {
    lstatSync(dir);
  } catch {
    throw new RunnerDirUnsafe(dir, "not-directory", "missing");
  }
  const win = windows ? { root: dir, userSid: options.userSid ?? currentUserSid(), acl: options.acl ?? readSddl } : undefined;
  walk(dir, uid, true, false, win);
};

/**
 * Creates `dir` (0700, parents included) when absent, then runs `checkRunnerDir`; it never loosens or repairs modes.
 * On Windows there is no chmod: the installer sets the protected DACL, which new entries inherit.
 */
export const ensureRunnerDir = (dir: string, options: FsSafetyOptions = {}): void => {
  if (!(isWindows(options) && isUncPath(dir)) && !existsSync(dir) && !isDanglingLink(dir)) {
    mkdirSync(dir, { recursive: true, mode: RUNNER_DIR_MODE });
    if (!isWindows(options)) chmodSync(dir, RUNNER_DIR_MODE);
  }
  checkRunnerDir(dir, options);
};

const isDanglingLink = (path: string): boolean => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

/** Creates a subdirectory of the runner directory with 0700, refusing an existing symlink in its place. */
export const ensureRunnerSubdir = (dir: string, name: string, options: Pick<FsSafetyOptions, "platform"> = {}): string => {
  const path = join(dir, name);
  let st: Stats | undefined;
  try { st = lstatSync(path); } catch { st = undefined; }
  if (!st) {
    mkdirSync(path, { mode: RUNNER_DIR_MODE });
    if (!isWindows(options)) chmodSync(path, RUNNER_DIR_MODE);
    return path;
  }
  if (st.isSymbolicLink()) throw new RunnerDirUnsafe(path, "symlink");
  if (!st.isDirectory()) throw new RunnerDirUnsafe(path, "not-directory");
  return path;
};

/** Atomically replaces `path` with `content`, mode 0600 (delegates to setup.ts `writeFileAtomic`). */
export const writeRunnerFile = (path: string, content: string): void => {
  writeFileAtomic(path, content, RUNNER_FILE_MODE);
};

/**
 * Sets 0600 on a SQLite database and its `-wal`/`-shm` companions that exist (called after open and after checkpoints).
 * A no-op on Windows, where the files inherit the runner directory's DACL.
 */
export const lockDownDatabase = (path: string, options: Pick<FsSafetyOptions, "platform"> = {}): void => {
  if (isWindows(options)) return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file) && !lstatSync(file).isSymbolicLink()) chmodSync(file, RUNNER_FILE_MODE);
  }
};

export type StartupIo = { readonly stderr: (text: string) => void; readonly exit: (code: number) => void };

/**
 * Startup gate for the serve entry: runs `ensureRunnerDir`; on an unsafe directory writes the
 * `RUNNER_DIR_UNSAFE <path> <reason>` line to stderr and exits 1. Returns whether startup may continue.
 */
export const runStartupCheck = (dir: string, io: StartupIo, options: FsSafetyOptions = {}): boolean => {
  try {
    ensureRunnerDir(dir, options);
    return true;
  } catch (e) {
    if (!(e instanceof RunnerDirUnsafe)) throw e;
    io.stderr(`${e.message}\n`);
    io.exit(1);
    return false;
  }
};
