import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listPanes } from "../panes.ts";
import type { Runner } from "../run.ts";
import { GUARD_SAMPLE_MS } from "./guard.ts";
import type { HerdrHealth, RunnerEventBodies, RunnerEventType } from "./protocol.ts";

/** Process inspection failure is treated as possibly running: it must never authorize a start. */
export const herdrProcess = async (run: Runner): Promise<{ running: boolean; instance?: string }> => {
  const pids = await run(["pgrep", "-u", String(process.getuid?.() ?? 0), "-f", "(^|/)herdr server($| )"]);
  if (pids.code === 1) return { running: false };
  if (pids.code !== 0 || !pids.out.trim()) return { running: true };
  const ids = pids.out.trim().split(/\s+/).filter((p) => /^\d+$/.test(p)).sort((a, b) => Number(a) - Number(b));
  if (!ids.length) return { running: true };
  const ps = await run(["ps", "-p", ids.join(","), "-o", "pid=", "-o", "lstart="]);
  const rows = ps.out.trim().split("\n").map((s) => s.trim().replace(/\s+/g, " ")).sort();
  return { running: true, ...(ps.code === 0 && rows.length === ids.length && rows.every((s) => /^\d+ .+/.test(s)) ? { instance: rows.join(";") } : {}) };
};

/** Only starts an installed unit. It never stops, restarts or spawns a herdr child. */
export const startManagedHerdr = async (deps: {
  run: Runner; os?: string; home?: string; exists?: (path: string) => boolean; read?: (path: string) => string;
}): Promise<{ ok: boolean; detail: string } | undefined> => {
  const os = deps.os ?? process.platform;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  let argv: string[];
  if (os === "linux") {
    if (!exists(join(home, ".config/systemd/user/herdr-server.service"))) return undefined;
    argv = ["systemctl", "--user", "start", "herdr-server.service"];
  } else if (os === "darwin") {
    if (!exists(join(home, "Library/LaunchAgents/com.dori.herdr.plist"))) return undefined;
    const domainFile = join(home, ".dori/runner/launchd-domain");
    if (!exists(domainFile)) return undefined;
    const domain = (deps.read ?? ((p) => readFileSync(p, "utf8")))(domainFile).trim();
    if (!/^(gui|user)\/\d+$/.test(domain)) return { ok: false, detail: "invalid launchd domain" };
    argv = ["launchctl", "kickstart", `${domain}/com.dori.herdr`];
  } else return undefined;
  const r = await deps.run(argv);
  return { ok: r.code === 0, detail: (r.err || r.out).trim() || `exit=${r.code}` };
};

export type HerdrWatchDeps = {
  readonly run: Runner;
  readonly now: () => number;
  readonly monotonic: () => number;
  readonly publish: <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;
  readonly process?: () => Promise<{ running: boolean; instance?: string }>;
  readonly start?: () => ReturnType<typeof startManagedHerdr>;
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
    this.transition(state, undefined, proc.running ? "pane list failed; server process may still be running" : "pane list failed; no server process");
    if (state === "down" && at >= this.nextStart) {
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
