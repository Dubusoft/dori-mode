import { existsSync } from "node:fs";
import { join } from "node:path";
import { bskDaemonSocket, startBrowserProxy, type BrowserExchangeResult, type BrowserProxy, type BrowserProxyDeps } from "./browser-proxy.ts";
import { RUNNER_PATHS } from "./fs-safety.ts";

/**
 * The runner's per-lane browser fill proxies (browser-proxy.ts): one per owned lane at `<runnerDir>/browser/<key>`,
 * started before the lane's pane command runs and stopped when the lane closes or the runner stops. Each proxy's
 * exchange is bound to its own lane key here, so the granting side (the runner's `SecretHandles`, or the supervisor
 * over a sealed frame) learns which lane's proxy asks; nothing the lane sends can name another key.
 */

/** What `RunnerLanes` needs of the proxies: the launch env of a lane, and start/stop by key. */
export type LaneBrowser = {
  readonly env: (key: string) => (readonly [string, string])[];
  readonly start: (key: string) => Promise<void>;
  readonly stop: (key: string) => Promise<void>;
};

/** The host's real BrowserSkill home: the runner's own `BSK_HOME`, else `~/.bsk`. */
export const realBskHome = (env: Readonly<Record<string, string | undefined>>, home: string): string => env.BSK_HOME || join(home, ".bsk");

/** Browser proxies run on darwin and linux when the real bsk home exists; never on win32. No config is needed. */
export const browserProxiesEnabled = (platform: NodeJS.Platform, bskHome: string, exists: (path: string) => boolean = existsSync): boolean =>
  (platform === "darwin" || platform === "linux") && exists(bskHome);

export type BrowserProxiesDeps = {
  readonly runnerDir: string;
  /** The real bsk home: the proxies' upstream is its `daemon.json` `sock_path`, and the lane sandbox gets it as `LANE_SANDBOX_BSK_HOME`. */
  readonly bskHome: string;
  /** The granting side's exchange, called with the asking proxy's own lane key. */
  readonly exchange: (key: string, handle: string, origin: string) => Promise<BrowserExchangeResult>;
  readonly log: (line: string) => void;
  readonly pid: number;
  /** Default `startBrowserProxy`. */
  readonly startProxy?: (deps: BrowserProxyDeps) => BrowserProxy;
};

/** The running proxies by lane key. */
export class BrowserProxies implements LaneBrowser {
  readonly #deps: BrowserProxiesDeps;
  readonly #running = new Map<string, BrowserProxy>();

  constructor(deps: BrowserProxiesDeps) { this.#deps = deps; }

  /** The lane's proxy directory, its `BSK_HOME`. */
  home(key: string): string { return join(this.#deps.runnerDir, RUNNER_PATHS.browser, key); }

  env(key: string): (readonly [string, string])[] {
    return [["BSK_HOME", this.home(key)], ["LANE_SANDBOX_BSK_HOME", this.#deps.bskHome]];
  }

  /** Starts lane `key`'s proxy; one already running (a relaunch) is replaced, so its taint and redactions start fresh. */
  async start(key: string): Promise<void> {
    await this.stop(key);
    const { bskHome, exchange } = this.#deps;
    this.#running.set(key, (this.#deps.startProxy ?? startBrowserProxy)({
      key, dir: this.home(key), upstream: () => bskDaemonSocket(bskHome), exchange: (handle, origin) => exchange(key, handle, origin),
      log: this.#deps.log, pid: this.#deps.pid,
    }));
  }

  async stop(key: string): Promise<void> {
    const proxy = this.#running.get(key);
    if (!proxy) return;
    this.#running.delete(key);
    await proxy.stop();
  }

  /** Whether lane `key` has a running proxy. */
  running(key: string): boolean { return this.#running.has(key); }

  /** Starts a proxy for each key, logging `RUNNER_BROWSER_PROXY_FAILED lane=<key>` for one that fails; never throws. */
  async startAll(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await this.start(key).catch((e: unknown) => { this.#deps.log(`RUNNER_BROWSER_PROXY_FAILED lane=${key} ${e instanceof Error ? e.message : String(e)}`); });
    }
  }

  /** Stops every running proxy. */
  async stopAll(): Promise<void> {
    for (const key of [...this.#running.keys()]) {
      await this.stop(key).catch((e: unknown) => { this.#deps.log(`RUNNER_BROWSER_PROXY_STOP_FAILED lane=${key} ${e instanceof Error ? e.message : String(e)}`); });
    }
  }
}
