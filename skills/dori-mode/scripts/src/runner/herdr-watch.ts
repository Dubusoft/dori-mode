import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { listPanes } from "../panes.ts";
import type { Runner } from "../run.ts";
import { GUARD_SAMPLE_MS } from "./guard.ts";
import type { HerdrHealth, RunnerEventBodies, RunnerEventType } from "./protocol.ts";

export type WinHerdrOptions = { platform?: string; user?: string };

export const WIN_HERDR_SCRIPT = [
  "Get-CimInstance Win32_Process -Filter \"Name='herdr.exe'\" | ForEach-Object {",
  "$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner;",
  "[pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; CreationDate = $_.CreationDate.ToString('o'); Owner = $o.User; Domain = $o.Domain }",
  "} | ConvertTo-Json -Compress",
].join(" ");

/**
 * The current user's `herdr server` processes on Windows as `<pid>@<CreationDate>`, or undefined when the CIM query
 * failed or its output could not be read.
 */
export const winHerdrServers = async (run: Runner, user: string = userInfo().username): Promise<string[] | undefined> => {
  const r = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WIN_HERDR_SCRIPT]);
  if (r.code !== 0) return undefined;
  const text = r.out.trim();
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const me = user.toLowerCase();
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return undefined;
    const v = row as Record<string, unknown>;
    if (!Number.isSafeInteger(v.ProcessId) || typeof v.CreationDate !== "string") return undefined;
    if (typeof v.CommandLine !== "string" || !/\bserver\b/.test(v.CommandLine)) continue;
    const owner = typeof v.Owner === "string" ? v.Owner.toLowerCase() : "";
    const domain = typeof v.Domain === "string" ? v.Domain.toLowerCase() : "";
    if (owner !== me && `${domain}\\${owner}` !== me) continue;
    ids.push(`${v.ProcessId}@${v.CreationDate}`);
  }
  return ids.sort();
};

/** Process inspection failure is treated as possibly running: it must never authorize a start. */
export const herdrProcess = async (run: Runner, opts: WinHerdrOptions = {}): Promise<{ running: boolean; instance?: string }> => {
  if ((opts.platform ?? process.platform) === "win32") {
    const ids = await winHerdrServers(run, opts.user);
    if (!ids) return { running: true };
    return ids.length ? { running: true, instance: ids.join(";") } : { running: false };
  }
  const pids = await run(["pgrep", "-u", String(process.getuid?.() ?? 0), "-f", "(^|/)herdr server($| )"]);
  if (pids.code === 1) return { running: false };
  if (pids.code !== 0 || !pids.out.trim()) return { running: true };
  const ids = pids.out.trim().split(/\s+/).filter((p) => /^\d+$/.test(p)).sort((a, b) => Number(a) - Number(b));
  if (!ids.length) return { running: true };
  const ps = await run(["ps", "-p", ids.join(","), "-o", "pid=", "-o", "lstart="]);
  const rows = ps.out.trim().split("\n").map((s) => s.trim().replace(/\s+/g, " ")).sort();
  return { running: true, ...(ps.code === 0 && rows.length === ids.length && rows.every((s) => /^\d+ .+/.test(s)) ? { instance: rows.join(";") } : {}) };
};

export type HerdrUnitDeps = { run: Runner; os?: string; home?: string; exists?: (path: string) => boolean; read?: (path: string) => string };

export const HERDR_SYSTEMD_UNIT = ".config/systemd/user/herdr-server.service";
export const HERDR_LAUNCHD_PLIST = "Library/LaunchAgents/com.dori.herdr.plist";

/** Whether a herdr unit (`dori setup` or `dori runner install`) is installed on this host. */
export const herdrUnitInstalled = (deps: Omit<HerdrUnitDeps, "run">): boolean => {
  const os = deps.os ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  if (os === "linux") return exists(join(home, HERDR_SYSTEMD_UNIT));
  if (os === "darwin") return exists(join(home, HERDR_LAUNCHD_PLIST));
  return false;
};

/** The saved launchd domain of the runner (`gui/<uid>` or `user/<uid>`); undefined when absent, "" when invalid. */
export const launchdDomain = (deps: Omit<HerdrUnitDeps, "run" | "os">): string | undefined => {
  const home = deps.home ?? homedir();
  const domainFile = join(home, ".dori/runner/launchd-domain");
  if (!(deps.exists ?? existsSync)(domainFile)) return undefined;
  const domain = (deps.read ?? ((p) => readFileSync(p, "utf8")))(domainFile).trim();
  return /^(gui|user)\/\d+$/.test(domain) ? domain : "";
};

/**
 * Only starts an installed unit. It never stops, restarts or spawns a herdr child. On macOS a unit that is not loaded
 * (`dori runner herdr stop` boots it out) is bootstrapped again before the kickstart is retried.
 */
export const startManagedHerdr = async (deps: HerdrUnitDeps): Promise<{ ok: boolean; detail: string } | undefined> => {
  const os = deps.os ?? process.platform;
  const home = deps.home ?? homedir();
  if (!herdrUnitInstalled(deps)) return undefined;
  let argv: string[];
  let domain: string | undefined;
  if (os === "linux") {
    argv = ["systemctl", "--user", "start", "herdr-server.service"];
  } else if (os === "darwin") {
    domain = launchdDomain(deps);
    if (domain === undefined) return undefined;
    if (!domain) return { ok: false, detail: "invalid launchd domain" };
    argv = ["launchctl", "kickstart", `${domain}/com.dori.herdr`];
  } else return undefined;
  let r = await deps.run(argv);
  if (r.code !== 0 && domain) {
    const loaded = await deps.run(["launchctl", "bootstrap", domain, join(home, HERDR_LAUNCHD_PLIST)]);
    if (loaded.code === 0) r = await deps.run(argv);
  }
  return { ok: r.code === 0, detail: (r.err || r.out).trim() || `exit=${r.code}` };
};

export type HerdrWatchDeps = {
  readonly run: Runner;
  readonly now: () => number;
  readonly monotonic: () => number;
  readonly publish: <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;
  readonly process?: () => Promise<{ running: boolean; instance?: string }>;
  readonly start?: () => ReturnType<typeof startManagedHerdr>;
  /** The watch pause marker (`dori runner herdr stop`): while set, a down herdr is reported but not started. */
  readonly paused?: () => boolean;
};

export class HerdrWatch {
  private health: HerdrHealth | undefined;
  private lastTick: number | undefined;
  private failedAt: number | undefined;
  private misses = 0;
  private nextStart = -Infinity;
  private backoff = 60_000;

  constructor(private readonly deps: HerdrWatchDeps) {}

  snapshot(): HerdrHealth | undefined { return this.health; }

  /** Called by the guard's existing pane count read, so the watch adds no pane-list requests. */
  async sample(): Promise<number> {
    const at = this.deps.monotonic();
    const waking = this.lastTick !== undefined && at - this.lastTick > 3 * GUARD_SAMPLE_MS;
    this.lastTick = at;
    let panes: number;
    try { panes = (await listPanes(this.deps.run)).length; } catch { panes = -1; }
    if (panes >= 0) {
      this.misses = 0;
      this.failedAt = undefined;
      const proc = await (this.deps.process ?? (() => herdrProcess(this.deps.run)))();
      this.transition("up", proc.instance, "pane list readable");
      this.backoff = 60_000;
      this.nextStart = -Infinity;
      return panes;
    }
    if (waking) { this.misses = 0; this.failedAt = undefined; return panes; }
    this.failedAt ??= at;
    if (++this.misses < 2 || at - this.failedAt < 30_000) return panes;
    const proc = await (this.deps.process ?? (() => herdrProcess(this.deps.run)))();
    const state = proc.running ? "hung" : "down";
    const paused = !proc.running && (this.deps.paused?.() ?? false);
    this.transition(state, undefined, proc.running ? "pane list failed; server process may still be running"
      : paused ? "pane list failed; no server process; stopped by dori runner herdr stop, not started again" : "pane list failed; no server process");
    if (state === "down" && !paused && at >= this.nextStart) {
      this.nextStart = at + this.backoff;
      const result = await (this.deps.start ?? (() => startManagedHerdr({ run: this.deps.run })))();
      if (result) {
        this.deps.publish("herdr.start", result);
        this.backoff = Math.min(30 * 60_000, this.backoff * 2);
      }
    }
    return panes;
  }

  private transition(state: HerdrHealth["state"], instance: string | undefined, detail: string): void {
    if (this.health?.state === state && this.health.instance === instance) return;
    this.health = { state, since: Math.round(this.deps.now()), ...(instance ? { instance } : {}) };
    this.deps.publish("herdr.state", { state, ...(instance ? { instance } : {}), detail });
  }
}
