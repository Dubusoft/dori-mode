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
 * failed or its output could not be read. Also undefined when no server matched but a `herdr.exe` hid its command line:
 * an unelevated runner can't read an elevated process (herdr started from an administrator's ssh session), so that
 * one may be the server.
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
  let hidden = false;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return undefined;
    const v = row as Record<string, unknown>;
    if (!Number.isSafeInteger(v.ProcessId) || typeof v.CreationDate !== "string") return undefined;
    if (typeof v.CommandLine !== "string") { hidden = true; continue; }
    if (!/\bserver\b/.test(v.CommandLine)) continue;
    const owner = typeof v.Owner === "string" ? v.Owner.toLowerCase() : "";
    const domain = typeof v.Domain === "string" ? v.Domain.toLowerCase() : "";
    if (owner !== me && `${domain}\\${owner}` !== me) continue;
    ids.push(`${v.ProcessId}@${v.CreationDate}`);
  }
  return ids.length || !hidden ? ids.sort() : undefined;
};

export const WIN_HERDR_SOCKET_SCRIPT = [
  "$j = herdr status server --json 2>$null | ConvertFrom-Json;",
  "if ($j.running -and $j.socket) { (Get-Item -LiteralPath $j.socket -Force).LastWriteTimeUtc.ToString('o') }",
].join(" ");

/**
 * The running herdr server's instance on Windows as `socket@<last write time>` of the socket it binds at start, read
 * through herdr itself; undefined when herdr does not answer. For a server whose process this runner can't read. Not
 * the creation time: NTFS tunneling hands a socket re-made within seconds of a stop the old file's creation time.
 */
export const winHerdrSocketInstance = async (run: Runner): Promise<string | undefined> => {
  const r = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WIN_HERDR_SOCKET_SCRIPT]);
  const at = r.out.trim();
  return r.code === 0 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(at) ? `socket@${at}` : undefined;
};

/** Process inspection failure is treated as possibly running: it must never authorize a start. */
export const herdrProcess = async (run: Runner, opts: WinHerdrOptions = {}): Promise<{ running: boolean; instance?: string }> => {
  if ((opts.platform ?? process.platform) === "win32") {
    const ids = await winHerdrServers(run, opts.user);
    if (ids) return ids.length ? { running: true, instance: ids.join(";") } : { running: false };
    const socket = await winHerdrSocketInstance(run);
    return { running: true, ...(socket ? { instance: socket } : {}) };
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

/**
 * Whether a failed herdr client call was refused by a server that runs elevated. On Windows a server started from an
 * administrator session (an ssh login of an administrator account gets a full administrator token) refuses unelevated
 * clients such as the runner's logon task with PermissionDenied (os error 5) and a hint to use an administrator
 * terminal. That server answers, so it is not hung, and ending it from the runner fails the same way.
 */
export const herdrElevatedError = (text: string, platform: string = process.platform): boolean =>
  platform === "win32" && /PermissionDenied|permission denied|access is denied|os error 5\b|elevated server|administrator terminal/i.test(text);

/** What fixes an elevated herdr server, for the HERDR_ELEVATED refusals and `dori doctor`. */
export const HERDR_ELEVATED_FIX = "end that server from an administrator terminal on the host (herdr server stop) and the runner starts an unelevated one, "
  + "or add [server] allow_unelevated_clients = true to %APPDATA%\\herdr\\config.toml there and restart the server from an administrator terminal";

/**
 * Starts `herdr server` on Windows through WMI (Win32_Process.Create) with the runner's own, unelevated token and no
 * window. The new server's parent is the WMI provider host, so it is outside the runner's process tree and its
 * scheduled task: a runner restart (`taskkill /T`) or a stopped task leaves herdr and its lane panes running.
 */
export const WIN_HERDR_START_SCRIPT = [
  "$h = (Get-Command herdr.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source;",
  "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 };",
  "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('\"' + $h + '\" server'); CurrentDirectory = $env:USERPROFILE; ProcessStartupInformation = $s };",
  "if ($r.ReturnValue -ne 0) { Write-Output ('Win32_Process.Create returned ' + $r.ReturnValue); exit 1 };",
  "Write-Output ('started herdr server pid ' + $r.ProcessId)",
].join(" ");

export type HerdrUnitDeps = { run: Runner; os?: string; home?: string; exists?: (path: string) => boolean; read?: (path: string) => string };

export const HERDR_SYSTEMD_UNIT = ".config/systemd/user/herdr-server.service";
export const HERDR_LAUNCHD_PLIST = "Library/LaunchAgents/com.dori.herdr.plist";

/**
 * Whether this host's herdr server is the runner's to start: a herdr unit (`dori setup` or `dori runner install`) is
 * installed on Linux and macOS; on Windows the runner itself starts it (WIN_HERDR_START_SCRIPT), so always.
 */
export const herdrUnitInstalled = (deps: Omit<HerdrUnitDeps, "run">): boolean => {
  const os = deps.os ?? process.platform;
  if (os === "win32") return true;
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
 * Only starts an installed unit, or on Windows a `herdr server` outside the runner's tree (WIN_HERDR_START_SCRIPT). It
 * never stops, restarts or spawns a herdr child. On macOS a unit that is not loaded (`dori runner herdr stop` boots it
 * out) is bootstrapped again before the kickstart is retried.
 */
export const startManagedHerdr = async (deps: HerdrUnitDeps): Promise<{ ok: boolean; detail: string } | undefined> => {
  const os = deps.os ?? process.platform;
  const home = deps.home ?? homedir();
  if (!herdrUnitInstalled(deps)) return undefined;
  let argv: string[];
  let domain: string | undefined;
  if (os === "win32") {
    argv = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WIN_HERDR_START_SCRIPT];
  } else if (os === "linux") {
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
  /** The host OS (default process.platform): an elevated-server refusal is read only on win32. */
  readonly platform?: string;
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

  /**
   * Once at runner start on Windows: start the server right away when none runs, unless `dori runner herdr stop` holds
   * it down. The first herdr client to reach a stopped server starts it with its own token, so an unelevated runner
   * that starts it first keeps an administrator ssh session (herdr's remote bridge) from starting an elevated one. The
   * regular watch only starts it after failures spanning 30 s. Elsewhere the herdr unit's manager starts it at boot.
   */
  async boot(): Promise<void> {
    if ((this.deps.platform ?? process.platform) !== "win32" || (this.deps.paused?.() ?? false)) return;
    try { await listPanes(this.deps.run); return; } catch { /* not answering: is there a server at all? */ }
    if ((await (this.deps.process ?? (() => herdrProcess(this.deps.run)))()).running) return;
    const result = await (this.deps.start ?? (() => startManagedHerdr({ run: this.deps.run })))();
    if (!result) return;
    this.nextStart = this.deps.monotonic() + this.backoff;
    this.deps.publish("herdr.start", result);
  }

  /** Called by the guard's existing pane count read, so the watch adds no pane-list requests. */
  async sample(): Promise<number> {
    const at = this.deps.monotonic();
    const waking = this.lastTick !== undefined && at - this.lastTick > 3 * GUARD_SAMPLE_MS;
    this.lastTick = at;
    let panes: number;
    let failure = "";
    try { panes = (await listPanes(this.deps.run)).length; } catch (e) { panes = -1; failure = e instanceof Error ? e.message : String(e); }
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
    if (herdrElevatedError(failure, this.deps.platform)) {
      this.transition("elevated", undefined, `pane list refused: the herdr server runs elevated and refuses this unelevated runner; ${HERDR_ELEVATED_FIX}`);
      return panes;
    }
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
