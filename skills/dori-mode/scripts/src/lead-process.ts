import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { paneRow, readScreen } from "./panes.ts";
import { infoOf, sessionRuntime } from "./runtime/index.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { LANE_PERMISSION_FLAGS } from "./runner/lane-launch.ts";
import { TransientSuperviseError } from "./supervise-journal.ts";

/** /new keeps argv unchanged; a holder for the same process identifies its newest persisted session. */
export const heldSession = (dir: string, pid: number | undefined): { readonly id: string; readonly file: string } | undefined => {
  if (!pid || !existsSync(dir)) return undefined;
  return readdirSync(dir).flatMap((name) => {
    const id = /(?:^|_)([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1];
    if (!id || !existsSync(join(dir, "session-holders", id, `${pid}.json`))) return [];
    const file = join(dir, name);
    try { return [{ id, file, mtime: statSync(file).mtimeMs }]; }
    catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw e;
    }
  }).sort((a, b) => b.mtime - a.mtime)[0];
};

export const UNCONFIRMED_LIMIT = 5;

type ForegroundProcess = { readonly pid?: number; readonly argv?: readonly string[] };
type ProcessInfo = { readonly shell_pid?: number; readonly foreground_process_group_id?: number; readonly foreground_processes?: readonly ForegroundProcess[] };

export const STARTUP_ERROR = /Cannot find module|All fallback models failed|No API key|model_not_available|No model matching|usage limit|rate limit|quota|Session crashed|unknown provider/i;

/** The lead pane's shell and foreground processes, from the runtime that holds it; undefined when it gave none. */
export const processInfo = async (deps: FlowDeps): Promise<ProcessInfo | undefined> =>
  infoOf(await sessionRuntime(deps.run).processInfo(deps.config.leadPane));

/** The old lead's tree was killed but is still listed: it is stuck in its pane, not refused. */
export const LEAD_STAYS = /old lead has not exited|cannot stop owned lead process/;

/** A lead process the supervisor launched: its lead command always carries `--session-id`. Entries without argv never match. */
/**
 * The lead's omo permission flags: like every lane, the lead has nobody to answer an omo permission prompt, so it runs
 * under `--permission-preset full-access` on every OS unless its own argv (`leadArgs`, `agentCommand`) names a preset.
 */
export const leadPermissionArgs = (argv: readonly string[]): readonly string[] =>
  argv.some((part) => /^--permission-preset(?:=|$)/.test(part)) ? [] : LANE_PERMISSION_FLAGS;

export const supervisorLaunch = (p: ForegroundProcess): boolean => Array.isArray(p.argv) && p.argv.includes("--session-id");

/**
 * The part of a pane's screen written since the launch of `session`: the lines after the last one naming it. A reused
 * pane still shows what its old occupant printed above (the previous lead's own words, or the escape-sequence replies a
 * broken terminal typed), which says nothing about the new process. The whole screen when the launch line is not on it.
 */
export const screenSinceLaunch = (screen: string, session: string): string => {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((line) => line.includes(session));
  return at < 0 ? screen : lines.slice(at + 1).join("\n");
};

/** A short-lived or partly read entry can lack argv; it never matches. */
const launchedAs = (p: ForegroundProcess, session: string): boolean =>
  Array.isArray(p.argv) && p.argv.some((arg, i, argv) => arg === "--session-id" && argv[i + 1] === session);

/** Nothing but the pane's shell is in the foreground, so typed text reaches the shell and not a program's input. */
export const plainShell = (info: ProcessInfo): boolean =>
  !!info.shell_pid && (!info.foreground_process_group_id || info.foreground_process_group_id === info.shell_pid) &&
  (info.foreground_processes ?? []).every((p) => p.pid === undefined || p.pid === info.shell_pid);

/** Only a ready status for the exact newly requested process is positive evidence. */
export const confirmLead = async (deps: FlowDeps, session: string): Promise<boolean> => {
  // `pane run` acknowledges admission, not execution. A stale idle/done status
  // from the old occupant cannot confirm the new process. Recheck identity after
  // the status gate until the bounded startup deadline.
  const deadline = deps.clock.now() + 30_000;
  for (let attempt = 0; attempt < 60 && deps.clock.now() <= deadline; attempt++) {
    // hc has no wait for an agent status, so the status is read every 500 ms.
    const pane = await paneRow(deps.run, deps.config.leadPane);
    const info = await processInfo(deps);
    if (!info) return false;
    const identity = (info.foreground_processes ?? []).some((p) => launchedAs(p, session));
    if (identity && pane && (pane.agent_status === "idle" || pane.agent_status === "working" || pane.agent_status === "done")) {
      const screen = await readScreen(deps.run, deps.config.leadPane, 40);
      return !STARTUP_ERROR.test(screenSinceLaunch(screen, session));
    }
    await deps.clock.sleep(500);
  }
  return false;
};

export const STARTUP_EVIDENCE_MS = 20_000;

/**
 * A healthy omo writes <sessionDir>/session-holders/<session>/<pid>.json and the session jsonl within
 * seconds of launch; a hung cold start creates the empty holder directory and nothing else. Either file
 * is positive evidence for that exact session and does not depend on the model replying.
 */
export const hasStartupEvidence = (deps: FlowDeps, session: string): boolean => {
  const dir = sessionDirFor(deps.tunables.sessionsDir, deps.config.leadCwd);
  const names = (path: string): readonly string[] => { try { return readdirSync(path); } catch { return []; } };
  return names(join(dir, "session-holders", session)).some((name) => name.endsWith(".json")) ||
    names(dir).some((name) => name.endsWith(`_${session}.jsonl`) || name === `${session}.jsonl`);
};

export const awaitStartupEvidence = async (deps: FlowDeps, session: string): Promise<boolean> => {
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  for (let attempt = 0; attempt <= STARTUP_EVIDENCE_MS / 500; attempt++) {
    if (hasStartupEvidence(deps, session)) return true;
    if (deps.clock.now() >= deadline) return false;
    await deps.clock.sleep(500);
  }
  return false;
};

/** Descendants of `root` plus detached processes whose environment carries PI_SESSION_ID=<id>. */
export const ownedTargets = async (deps: FlowDeps, table: Awaited<ReturnType<typeof procTable>>, root: number | undefined, id: string): Promise<Set<number>> => {
  const targets = new Set<number>();
  if (root) {
    targets.add(root);
    for (;;) {
      const before = targets.size;
      for (const p of table) if (targets.has(p.ppid)) targets.add(p.pid);
      if (targets.size === before) break;
    }
  }
  if (id) {
    // Detached monitor processes inherit PI_SESSION_ID. Do not match command text
    // (which may quote another session), and never kill the supervisor itself.
    for (const p of table) {
      if (targets.has(p.pid) || p.pid === process.pid) continue;
      const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(p.pid)]);
      if (new RegExp(`(?:^|\\s)PI_SESSION_ID=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(env.out)) targets.add(p.pid);
    }
  }
  targets.delete(process.pid);
  return targets;
};

export const killTargets = async (deps: FlowDeps, targets: ReadonlySet<number>): Promise<void> => {
  for (const pid of [...targets].reverse()) {
    const stopped = await deps.run(["kill", "-KILL", String(pid)]);
    if (stopped.code !== 0 && (await deps.run(["kill", "-0", String(pid)])).code === 0) throw new TransientSuperviseError(`cannot stop owned lead process ${pid}`);
  }
  // Waiting for the foreground process group to exit is an observable gate, not
  // a fixed delay. The runner is bounded and never sends keys to a shell.
  if (targets.size) {
    const released = await processInfo(deps);
    if (!released) throw new TransientSuperviseError("cannot verify lead termination");
    if ((released.foreground_processes ?? []).some((p) => p.pid !== undefined && targets.has(p.pid))) throw new TransientSuperviseError("old lead has not exited; events retained");
  }
};

/** Kill only the process tree launched with `--session-id <session>`; status gates do not apply to a hung start. */
export const stopHung = async (deps: FlowDeps, session: string): Promise<void> => {
  const info = await processInfo(deps);
  if (!info) throw new TransientSuperviseError("cannot identify hung lead process; refusing broad process cleanup");
  const hung = (info.foreground_processes ?? []).find((p) => p.pid && launchedAs(p, session));
  await killTargets(deps, await ownedTargets(deps, await procTable(deps.run), hung?.pid, session));
};

/** Stop the pane's exact foreground agent tree, then its detached session-owned monitors. */
export const stopLead = async (deps: FlowDeps, force = false): Promise<boolean> => {
  const { leadPane, leadCwd } = deps.config;
  const { sessionsDir } = deps.tunables;
  const pane = await paneRow(deps.run, leadPane);
  if (!pane) throw new TransientSuperviseError(`lead pane ${leadPane} is missing`);
  // `force` (a stuck lead) stops a working/blocked lead too.
  if (!force && pane.agent && pane.agent_status !== "idle" && pane.agent_status !== "done") return false;
  const table = await procTable(deps.run);
  const hit = await resolveSession(leadPane, pane.cwd ?? leadCwd, table, { run: deps.run, sessionsDir });
  if (pane.agent && !hit.pid) throw new TransientSuperviseError("cannot identify lead process; refusing broad process cleanup");
  if (!pane.agent && !hit.pid) {
    const proc = await processInfo(deps);
    if (!proc) throw new TransientSuperviseError("cannot verify an available shell in the lead pane");
    if (proc.foreground_process_group_id && proc.foreground_process_group_id !== proc.shell_pid) throw new TransientSuperviseError("lead pane contains a non-agent foreground process; refusing to type into it");
  }
  const current = heldSession(sessionDirFor(sessionsDir, pane.cwd ?? leadCwd), hit.pid);
  const targets = await ownedTargets(deps, table, hit.pid, current?.id ?? hit.id);
  const latest = await paneRow(deps.run, leadPane);
  if (!latest) throw new TransientSuperviseError("lead pane disappeared during process resolution");
  if (!force && latest.agent && latest.agent_status !== "idle" && latest.agent_status !== "done") return false;
  await killTargets(deps, targets);
  return true;
};
