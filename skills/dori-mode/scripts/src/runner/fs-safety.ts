import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../setup.ts";

/**
 * The runner directory and its safety rules. The directory (default `~/.dori/runner`) and every directory under it
 * are 0700, every file is 0600, nothing in it is a symlink, and everything is owned by the runner's user. A runner
 * that finds otherwise at start writes `RUNNER_DIR_UNSAFE <path> <reason>` to stderr and exits 1. Files are replaced
 * atomically (temporary file, fsync, rename) through `writeFileAtomic` from setup.ts.
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
} as const;

/** `~/.dori/runner` under `home`; every runner module takes the directory as an argument and defaults to this. */
export const defaultRunnerDir = (home: string = homedir()): string => join(home, ".dori", "runner");

export type UnsafeReason = "symlink" | "mode" | "owner" | "not-directory" | "not-file";

/** The first unsafe entry found. Message: `RUNNER_DIR_UNSAFE <path> <reason>`. */
export class RunnerDirUnsafe extends Error {
  readonly code = "RUNNER_DIR_UNSAFE";
  constructor(readonly path: string, readonly reason: UnsafeReason, readonly detail = "") {
    super(`RUNNER_DIR_UNSAFE ${path} ${reason}${detail ? ` ${detail}` : ""}`);
    this.name = "RunnerDirUnsafe";
  }
}

/** The owner the check expects; tests pass their own uid. Defaults to `process.getuid()`. */
export type FsSafetyOptions = { readonly uid?: number };

const expectedOwner = (options: FsSafetyOptions): number | undefined =>
  options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);

const DIRECTORY_ENTRIES: ReadonlySet<string> = new Set([
  RUNNER_PATHS.bodies, RUNNER_PATHS.briefs, RUNNER_PATHS.keys, RUNNER_PATHS.sock, RUNNER_PATHS.logs,
]);
const FILE_ENTRIES: ReadonlySet<string> = new Set([RUNNER_PATHS.identity, RUNNER_PATHS.state, RUNNER_PATHS.outbox]);

const inspect = (path: string, uid: number | undefined, kind: "dir" | "file"): Stats => {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new RunnerDirUnsafe(path, "symlink");
  if (kind === "dir" && !st.isDirectory()) throw new RunnerDirUnsafe(path, "not-directory");
  if (kind === "file" && !st.isFile() && !st.isSocket()) throw new RunnerDirUnsafe(path, "not-file");
  if (uid !== undefined && st.uid !== uid) throw new RunnerDirUnsafe(path, "owner", `uid=${st.uid}`);
  // Sockets take their mode from the umask of whoever binds them; the 0700 sock/ directory is their boundary.
  if (!st.isSocket()) {
    const mode = st.mode & 0o777;
    const want = kind === "dir" ? RUNNER_DIR_MODE : RUNNER_FILE_MODE;
    if (mode !== want) throw new RunnerDirUnsafe(path, "mode", `mode=${mode.toString(8).padStart(4, "0")}`);
  }
  return st;
};

const walk = (dir: string, uid: number | undefined, top: boolean): void => {
  inspect(dir, uid, "dir");
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = lstatSync(path);
    // Only the entries the runner itself defines have a fixed type; anything else is checked by what it is.
    const isTopDir = top && DIRECTORY_ENTRIES.has(name);
    const isTopFile = top && (FILE_ENTRIES.has(name) || /^(state|outbox)\.sqlite-(wal|shm)$/.test(name));
    if (st.isSymbolicLink()) throw new RunnerDirUnsafe(path, "symlink");
    if (isTopDir || (st.isDirectory() && !isTopFile)) walk(path, uid, false);
    else inspect(path, uid, "file");
  }
};

/**
 * Checks `dir` and everything under it (lstat, never following links). Throws `RunnerDirUnsafe` for the first entry
 * that is a symlink, is not mode 0700 (directories) or 0600 (files), is owned by another user, or is a file where a
 * directory belongs (or the reverse) for a known `RUNNER_PATHS` entry. A missing `dir` is unsafe as `not-directory`.
 */
export const checkRunnerDir = (dir: string, options: FsSafetyOptions = {}): void => {
  const uid = expectedOwner(options);
  try {
    lstatSync(dir);
  } catch {
    throw new RunnerDirUnsafe(dir, "not-directory", "missing");
  }
  walk(dir, uid, true);
};

/** Creates `dir` (0700, parents included) when absent, then runs `checkRunnerDir`; it never loosens or repairs modes. */
export const ensureRunnerDir = (dir: string, options: FsSafetyOptions = {}): void => {
  if (!existsSync(dir) && !isDanglingLink(dir)) {
    mkdirSync(dir, { recursive: true, mode: RUNNER_DIR_MODE });
    chmodSync(dir, RUNNER_DIR_MODE);
  }
  checkRunnerDir(dir, options);
};

const isDanglingLink = (path: string): boolean => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

/** Creates a subdirectory of the runner directory with 0700, refusing an existing symlink in its place. */
export const ensureRunnerSubdir = (dir: string, name: string): string => {
  const path = join(dir, name);
  let st: Stats | undefined;
  try { st = lstatSync(path); } catch { st = undefined; }
  if (!st) {
    mkdirSync(path, { mode: RUNNER_DIR_MODE });
    chmodSync(path, RUNNER_DIR_MODE);
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

/** Sets 0600 on a SQLite database and its `-wal`/`-shm` companions that exist (called after open and after checkpoints). */
export const lockDownDatabase = (path: string): void => {
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
