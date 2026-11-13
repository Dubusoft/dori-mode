import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listPanes } from "../panes.ts";
import type { Runner } from "../run.ts";
import { writeRunnerFile } from "./fs-safety.ts";
import {
  HERDR_ELEVATED_FIX, herdrElevatedError, herdrProcess, herdrUnitInstalled, launchdDomain, startManagedHerdr, winHerdrServers,
} from "./herdr-watch.ts";
import type { CommandResults, HerdrAction, HerdrHealth } from "./protocol.ts";

/**
 * The runner side of `host.herdr` (since proto 4): what `dori runner herdr <start|restart|stop|status> --machine X`
 * asks of the runner on X. The runner only ever starts herdr through the unit `dori setup` / `dori runner install`
 * installed, or on Windows as its own unelevated `herdr server` (startManagedHerdr); ending the server (restart, stop)
 * is done only on this explicit command, never by the watch.
 */

/** In the runner directory: present while `dori runner herdr stop` holds herdr down (HerdrWatch does not start it). */
export const HERDR_PAUSED_FILE = "herdr-paused";

export const herdrPaused = (runnerDir: string, exists: (path: string) => boolean = existsSync): boolean => exists(join(runnerDir, HERDR_PAUSED_FILE));

/** How long a signalled server gets to exit before the next signal, and how long a started one gets to answer. */
export const HERDR_EXIT_WAIT_MS = 10_000;
export const HERDR_UP_WAIT_MS = 15_000;
const POLL_MS = 500;

export type HerdrControlDeps = {
  readonly run: Runner;
  readonly runnerDir: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
  readonly os?: string;
  readonly home?: string;
  readonly exists?: (path: string) => boolean;
  readonly read?: (path: string) => string;
  /** The marker writers; default: a 0600 file in the runner directory. */
  readonly setPaused?: (on: boolean) => void;
  /** The Windows account whose herdr server processes count (default: the runner's). */
  readonly user?: string;
};

type Output = { readonly detail: string; readonly result: CommandResults["host.herdr"] };

const SERVER_PATTERN = "(^|/)herdr server($| )";

/** The current user's `herdr server` pids; throws when they cannot be read (nothing may be signalled blind). */
const serverPids = async (run: Runner, os: string, user?: string): Promise<number[]> => {
  if (os === "win32") {
    const ids = await winHerdrServers(run, user);
    if (!ids) throw new Error("HERDR_PIDS_UNREADABLE the herdr.exe processes could not be read (an elevated server hides its command line)");
    return ids.map((id) => Number(id.split("@")[0]));
  }
  const r = await run(["pgrep", "-u", String(process.getuid?.() ?? 0), "-f", SERVER_PATTERN]);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new Error(`HERDR_PIDS_UNREADABLE pgrep exit ${r.code}: ${(r.err || r.out).trim()}`);
  return r.out.trim().split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number);
};

export const hostHerdr = (deps: HerdrControlDeps): ((action: HerdrAction) => Promise<Output>) => {
  const unit = { os: deps.os, home: deps.home ?? homedir(), exists: deps.exists, read: deps.read };
  const os = deps.os ?? process.platform;
  const markerPath = join(deps.runnerDir, HERDR_PAUSED_FILE);
  const setPaused = deps.setPaused ?? ((on: boolean) => {
    if (on) writeRunnerFile(markerPath, `${deps.now()}\n`);
    else rmSync(markerPath, { force: true });
  });

  const state = async (): Promise<{ state: HerdrHealth["state"]; instance?: string }> => {
    let up = true;
    let failure = "";
    try { await listPanes(deps.run); } catch (e) { up = false; failure = e instanceof Error ? e.message : String(e); }
    if (!up && herdrElevatedError(failure, os)) return { state: "elevated" };
    const proc = await herdrProcess(deps.run, { platform: os, ...(deps.user ? { user: deps.user } : {}) });
    if (up) return { state: "up", ...(proc.instance ? { instance: proc.instance } : {}) };
    return { state: proc.running ? "hung" : "down" };
  };

  const result = async (action: HerdrAction, detail: string): Promise<Output> => {
    const now = await state();
    return {
      detail: `${detail}; herdr ${now.state}`,
      result: { action, ...now, managed: herdrUnitInstalled(unit), paused: herdrPaused(deps.runnerDir, deps.exists) },
    };
  };

  /** Ends the server: the unit first (so its supervisor does not start it again), then any server process left, TERM before KILL. */
  const end = async (): Promise<string> => {
    const steps: string[] = [];
    if (os === "win32") {
      // herdr's own stop first: taskkill without /F only asks a console process to close, which a headless server ignores.
      const r = await deps.run(["herdr", "server", "stop"], { timeoutMs: 30_000 });
      steps.push(`herdr server stop exit ${r.code}`);
    } else if (herdrUnitInstalled(unit)) {
      if (os === "linux") {
        const r = await deps.run(["systemctl", "--user", "stop", "herdr-server.service"], { timeoutMs: 30_000 });
        steps.push(`unit stop exit ${r.code}`);
      } else if (os === "darwin") {
        const domain = launchdDomain(unit);
        if (domain) {
          const r = await deps.run(["launchctl", "bootout", `${domain}/com.dori.herdr`], { timeoutMs: 30_000 });
          steps.push(`bootout exit ${r.code}`);
        }
      }
    }
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      let pids = await serverPids(deps.run, os, deps.user);
      if (!pids.length) return steps.join(", ") || "no server process";
      for (const pid of pids) {
        try { deps.signal(pid, sig); } catch (e) {
          if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e;
        }
      }
      steps.push(`${sig} ${pids.join(",")}`);
      for (const until = deps.now() + HERDR_EXIT_WAIT_MS; deps.now() < until;) {
        await deps.sleep(POLL_MS);
        pids = await serverPids(deps.run, os, deps.user);
        if (!pids.length) return steps.join(", ");
      }
    }
    const left = await serverPids(deps.run, os, deps.user);
    if (left.length) throw new Error(`HERDR_STOP_FAILED herdr server ${left.join(",")} still runs after SIGKILL`);
    return steps.join(", ");
  };

  /** Starts the unit and waits until herdr's pane list reads. */
  const start = async (): Promise<string> => {
    const started = await startManagedHerdr({ run: deps.run, ...unit });
    if (!started) throw new Error("HERDR_UNMANAGED no herdr unit is installed on this host; dori runner install --machine <label> installs one");
    if (!started.ok) throw new Error(`HERDR_START_FAILED ${started.detail}`);
    for (const until = deps.now() + HERDR_UP_WAIT_MS; ;) {
      try { await listPanes(deps.run); return os === "win32" ? "server started" : "unit started"; } catch { /* not answering yet */ }
      if (deps.now() >= until) throw new Error(`HERDR_START_UNCONFIRMED the unit started but herdr did not answer within ${HERDR_UP_WAIT_MS / 1000} s`);
      await deps.sleep(POLL_MS);
    }
  };

  const elevated = (what: string): Error => new Error(`HERDR_ELEVATED the herdr server runs elevated and refuses this unelevated runner, so it cannot ${what}; ${HERDR_ELEVATED_FIX}`);

  return async (action) => {
    if (action === "status") return result(action, "read");
    // An elevated server (Windows only) can be neither read nor ended from here: refuse before the pause marker or any signal.
    if (action !== "start" && os === "win32" && (await state()).state === "elevated") throw elevated(action === "stop" ? "stop it" : "restart it");
    if (action === "stop") {
      // The marker goes first: the watch must not start the unit between the stop and the marker.
      setPaused(true);
      return result(action, `stopped (${await end()}); the watch leaves herdr down until dori runner herdr start`);
    }
    if (action === "start") {
      setPaused(false);
      const now = await state();
      if (now.state === "up") return result(action, "already running");
      if (now.state === "elevated") throw elevated("use it");
      if (now.state === "hung") throw new Error("HERDR_HUNG the server process runs but does not answer; dori runner herdr restart ends it and starts the unit");
      return result(action, await start());
    }
    // restart: refuse before anything is ended when nothing could bring herdr back.
    if (!herdrUnitInstalled(unit)) throw new Error("HERDR_UNMANAGED no herdr unit is installed on this host, so a restart could not start herdr again; dori runner install --machine <label> installs one");
    setPaused(false);
    const ended = await end();
    return result(action, `restarted (${ended}; ${await start()})`);
  };
};
