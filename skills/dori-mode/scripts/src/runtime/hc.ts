import { join } from "node:path";
import type { Pane } from "../panes.ts";
import type { Ran, Runner } from "../run.ts";
import type { ProcessInfo } from "../runner/protocol.ts";
import { HC_PANE_PREFIX, type OpenSpec, type OpenedSession, type SessionRuntime } from "./types.ts";

/** The oldest hc the adapter is tested against; an older one is updated before a lane opens on it. */
export const HC_MIN_VERSION = "0.1.22";
export const HC_INSTALL_URL = "https://releases.herdr.dev/core/install.sh";
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * hc's core autostart on every dori host (hc is the only terminal runtime). On Linux the hc client starts its core in transient
 * `systemd-run --user` units that do not come back after a reboot until some hc command runs, so the systemd user unit
 * HC_CORE_UNIT (templates/hc-core.service: oneshot `hc server start`, idempotent while a core runs) starts it at boot.
 * macOS has no user systemd and a core ends with whatever started it, so the launchd agent HC_LAUNCHD_LABEL
 * (templates/dori-hc-launchd.plist) owns the foreground core `hc serve` (KeepAlive, ThrottleInterval 30 so a second core
 * on a taken socket retries spaced out). Both templates carry `@HC_BIN@`, `@PATH@` and (plist) `@HOME@` markers filled on
 * the host; `dori runner install` and the lead host's setup write them.
 */
export const HC_CORE_UNIT = "hc-core.service";
export const HC_LAUNCHD_LABEL = "com.dori.hc";
export const HC_CORE_UNIT_TEMPLATE = join(import.meta.dir, "..", "..", "templates", HC_CORE_UNIT);
export const HC_LAUNCHD_PLIST_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-hc-launchd.plist");
const RM_TRIES = 5;

type Json = Record<string, unknown>;
type Terminal = {
  readonly address: string; readonly state?: string; readonly cwd?: string; readonly title?: string; readonly name?: string | null;
  readonly pid?: number; readonly created_ms?: number;
  readonly status?: { readonly app?: string; readonly state?: string } | null;
  readonly foreground?: { readonly pid?: number; readonly name?: string; readonly argv?: readonly string[] } | null;
};

const address = (pane: string): string => pane.slice(HC_PANE_PREFIX.length);
const paneOf = (addr: string): string => `${HC_PANE_PREFIX}${addr}`;
/** `hc:t7@<created_ms>`: an address hc hands out again after a terminal is removed never matches an old lane record. */
const terminalIdOf = (t: Terminal): string => `${paneOf(t.address)}@${t.created_ms ?? 0}`;

export const versionAtLeast = (have: string, want: string): boolean => {
  const a = have.split(/[.-]/).map(Number);
  const b = want.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

export const hcVersion = async (run: Runner): Promise<string | undefined> => {
  const r = await run(["hc", "--version"]).catch(() => undefined);
  return r?.code === 0 ? /^hc (\d+\.\d+\.\d+)/.exec(r.out.trim())?.[1] : undefined;
};

/**
 * Makes sure hc is on this host at HC_MIN_VERSION or later: a missing hc is installed with the release installer
 * (into ~/.local/bin), an older one is updated in place (`hc update --version`, which
 * keeps running terminals). Throws `RUNNER_HC_UNAVAILABLE` with the fix when it still is not.
 */
export const ensureHc = async (run: Runner): Promise<string> => {
  let version = await hcVersion(run);
  if (version === undefined) {
    await run(["sh", "-c", `curl -fsSL ${HC_INSTALL_URL} | sh`], { timeoutMs: INSTALL_TIMEOUT_MS });
  } else if (!versionAtLeast(version, HC_MIN_VERSION)) {
    await run(["hc", "update", "--version", HC_MIN_VERSION], { timeoutMs: INSTALL_TIMEOUT_MS });
  } else return version;
  version = await hcVersion(run);
  if (version !== undefined && versionAtLeast(version, HC_MIN_VERSION)) return version;
  throw new Error(`RUNNER_HC_UNAVAILABLE hc ${version ?? "is not on the runner's PATH"}${version ? ` is older than ${HC_MIN_VERSION}` : ""}: `
    + `install it with curl -fsSL ${HC_INSTALL_URL} | sh (or hc update) and make sure ~/.local/bin is on the runner's PATH`);
};

const hc = async (run: Runner, argv: readonly string[]): Promise<{ readonly ran: Ran; readonly json: Json }> => {
  const ran = await run(["hc", "--json", ...argv]);
  let json: Json = {};
  try { json = JSON.parse(ran.out.trim() || "{}") as Json; } catch { /* a non-JSON answer leaves {} and the exit code decides */ }
  return { ran, json };
};

const failure = (what: string, ran: Ran): Error => new Error(`hc ${what} failed: ${(ran.err || ran.out).trim() || `exit ${ran.code}`}`);

const getTerminal = async (run: Runner, pane: string): Promise<Terminal | undefined> => {
  const { ran, json } = await hc(run, ["get", address(pane)]);
  return ran.code === 0 && typeof json.address === "string" ? (json as unknown as Terminal) : undefined;
};

/**
 * One hc terminal as a pane row. The agent and its status are what the program reported over OSC 7501 (omo does); a
 * terminal that never reported has no agent.
 */
const paneFromTerminal = (t: Terminal): Pane => ({
  pane_id: paneOf(t.address),
  workspace_id: "",
  tab_id: "",
  terminal_id: terminalIdOf(t),
  ...(t.status?.app ? { agent: t.status.app } : {}),
  ...(t.status?.state ? { agent_status: t.status.state } : {}),
  ...(t.title ? { title: t.title, terminal_title: t.title } : {}),
  ...(t.name ? { label: t.name } : {}),
  ...(t.cwd ? { cwd: t.cwd } : {}),
});

/** hc's one foreground process as a process-info: the terminal's root process is the shell the lane was typed into. */
const processInfoOf = (t: Terminal): ProcessInfo => ({
  ...(t.pid !== undefined ? { shell_pid: t.pid } : {}),
  ...(t.foreground?.pid !== undefined ? { foreground_process_group_id: t.foreground.pid } : {}),
  foreground_processes: t.foreground ? [{
    ...(t.foreground.pid !== undefined ? { pid: t.foreground.pid } : {}),
    ...(t.foreground.name ? { name: t.foreground.name } : {}),
    ...(t.foreground.argv ? { argv: t.foreground.argv } : {}),
  }] : [],
});

/** hc's name rule: 1-32 of a-z 0-9 - _ ., never shaped like an address (`t7`); undefined leaves the terminal unnamed. */
const terminalName = (key: string): string | undefined =>
  /^[a-z0-9][a-z0-9._-]{0,31}$/.test(key) && !/^t[0-9a-z]+$/.test(key) ? key : undefined;

/**
 * herdr-core (`hc`) behind the session runtime interface. A lane terminal runs the user's shell with no parent and no
 * notes (`--no-parent --no-notify`: the supervisor is the only thing that types into a lane), and the launch line is
 * typed into that shell. Nothing but the shell is on the terminal's command line, so `hc get`, `hc ls` and `ps` show no
 * lane variable; the lane's secrets reach it only inside the shell, through `dori secret env` over the lane socket.
 */
export const hcRuntime = (run: Runner, shell: string = process.env.SHELL || "/bin/sh"): SessionRuntime => {
  let ensured: Promise<string> | undefined;
  const ready = (): Promise<string> => ensured ??= ensureHc(run).catch((e: unknown) => { ensured = undefined; throw e; });
  return {
    // `server status` starts a stopped core; its id outlives core restarts, as hc terminals do.
    instance: async () => {
      await ready();
      const { ran, json } = await hc(run, ["server", "status"]);
      const core = json.core as { id?: unknown } | undefined;
      return ran.code === 0 && typeof core?.id === "string" ? `hc:${core.id}` : undefined;
    },
    listPanes: async () => {
      const { ran, json } = await hc(run, ["ls"]);
      if (ran.code !== 0) throw failure("ls", ran);
      const rows = (Array.isArray(json.terminals) ? json.terminals : []) as Terminal[];
      const live = rows.filter((t) => typeof t.address === "string" && !t.address.includes("/") && t.state === "live");
      const got = await Promise.all(live.map((t) => getTerminal(run, paneOf(t.address))));
      return got.filter((t): t is Terminal => t?.state === "live").map(paneFromTerminal);
    },
    read: async (pane, lines) => {
      const { ran, json } = await hc(run, ["read", address(pane), ...(lines ? ["--lines", String(lines)] : [])]);
      if (ran.code !== 0 || typeof json.text !== "string") return "";
      if (!lines) return json.text;
      const rows = json.text.split("\n");
      while (rows.length > 0 && rows.at(-1)?.trim() === "") rows.pop();
      return rows.slice(-lines).join("\n");
    },
    sendText: async (pane, text) => (await hc(run, ["send", address(pane), "--", text])).ran.code === 0,
    key: async (pane, key) => (await hc(run, ["keys", address(pane), key === "escape" ? "esc" : "enter"])).ran.code === 0,
    processInfo: async (pane) => {
      const { ran, json } = await hc(run, ["get", address(pane)]);
      if (ran.code !== 0 || typeof json.address !== "string") return { error: (ran.err || ran.out).trim() || `hc exited ${ran.code}` };
      return { info: processInfoOf(json as unknown as Terminal) };
    },
    open: async (spec: OpenSpec): Promise<OpenedSession> => {
      await ready();
      const name = terminalName(spec.key);
      const argv = (named: boolean) => ["run", "--bg", "--no-parent", "--no-notify", "--cwd", spec.cwd, "--label", spec.label ?? `dori.lane=${spec.key}`,
        ...(named && name ? ["--name", name] : []), "--", shell];
      let made = await hc(run, argv(true));
      if (made.ran.code !== 0 && name) made = await hc(run, argv(false));
      if (made.ran.code !== 0 || typeof made.json.address !== "string") throw failure("run", made.ran);
      const pane = paneOf(made.json.address);
      const t = await getTerminal(run, pane);
      return {
        pane,
        ...(t ? { terminalId: terminalIdOf(t) } : {}), ...(t?.pid !== undefined ? { shellPid: t.pid } : {}),
      };
    },
    run: async (pane, command) => (await hc(run, ["send", address(pane), "--", command])).ran,
    close: async (pane) => {
      const addr = address(pane);
      const killed = await hc(run, ["kill", addr]);
      if (killed.ran.code !== 0 && !(await getTerminal(run, pane))) return;
      for (let attempt = 0; attempt < RM_TRIES; attempt++) {
        const removed = await hc(run, ["rm", addr]);
        if (removed.ran.code === 0 || !(await getTerminal(run, pane))) return;
        await Bun.sleep(200);
      }
    },
  };
};
