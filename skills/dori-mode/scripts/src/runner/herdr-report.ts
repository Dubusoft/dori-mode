import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureRunnerSubdir, RUNNER_PATHS } from "./fs-safety.ts";
import type { Listener, Transport } from "./transport.ts";
import { listenUnix } from "./unix-transport.ts";

/**
 * The lane's restricted herdr socket: agent reports, reads in its own tab, and panes created through this socket.
 * A new pane starts outside the sandbox, so its first command must enter the same sandbox as the lane's agent.
 */

export const HERDR_REPORT_DIR = "herdr.d";
export const HERDR_REPORT_SOCKET = "herdr";

/** `<runnerDir>/sock/herdr.d/<key>/herdr`, the socket lane `key` reports its agent state through. */
export const herdrReportSocketPath = (runnerDir: string, key: string): string =>
  join(runnerDir, RUNNER_PATHS.sock, HERDR_REPORT_DIR, key, HERDR_REPORT_SOCKET);

/** herdr's own control socket as its CLI finds it: `HERDR_SOCKET_PATH`, else `<XDG_CONFIG_HOME or ~/.config>/herdr/herdr.sock`. */
export const herdrControlSocket = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  env.HERDR_SOCKET_PATH || join(env.XDG_CONFIG_HOME || join(home, ".config"), "herdr", "herdr.sock");

/** The agent states herdr takes in a report. */
const STATES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "unknown"]);
const REPORT_PARAMS: ReadonlySet<string> = new Set(["pane_id", "source", "agent", "state", "message", "seq", "agent_session_id", "agent_session_path"]);
const RELEASE_PARAMS: ReadonlySet<string> = new Set(["pane_id", "source", "agent", "seq"]);
const SESSION_PARAMS: ReadonlySet<string> = new Set(["pane_id", "source", "agent", "agent_session_id", "agent_session_path", "seq"]);
const METADATA_PARAMS: ReadonlySet<string> = new Set(["pane_id", "source", "agent", "applies_to_source", "title", "display_agent", "state_labels", "tokens", "ttl_ms", "seq"]);
const PANE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  ping: [],
  "pane.get": ["pane_id"],
  "pane.read": ["pane_id", "lines", "format"],
  "pane.list": [],
  "pane.layout": ["pane_id"],
  "pane.split": ["target_pane_id", "direction", "ratio", "cwd", "focus", "right_click"],
  "pane.rename": ["pane_id", "label"],
  "pane.close": ["pane_id"],
  "pane.resize": ["pane_id", "direction", "amount"],
  "pane.zoom": ["pane_id"],
  "pane.send_input": ["pane_id", "text", "keys"],
  "pane.send_text": ["pane_id", "text"],
  "pane.send_keys": ["pane_id", "keys"],
};
const REQUEST_FIELDS: ReadonlySet<string> = new Set(["id", "method", "params"]);

export type HerdrReportVerdict =
  | { readonly ok: true; readonly id: string; readonly request: string }
  | { readonly ok: false; readonly id: string; readonly code: string; readonly message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A short single-line identifier (request id, source, agent, session id). */
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const absent = (v: unknown): v is undefined | null => v === undefined || v === null;

/**
 * The request line to forward to herdr for one line from the socket of the lane whose pane is `pane` (undefined while
 * the runner holds no record for the lane), or the refusal. Pure: the caller does the forwarding.
 */
export const checkHerdrReport = (line: string, pane: string | undefined, lanePanes: ReadonlyMap<string, boolean> = new Map()): HerdrReportVerdict => {
  let req: unknown;
  try { req = JSON.parse(line); } catch { return { ok: false, id: "", code: "invalid_request", message: "not JSON" }; }
  const id = isRecord(req) && isLabel(req.id) ? req.id : "";
  const refuse = (code: string, message: string): HerdrReportVerdict => ({ ok: false, id, code, message });
  if (!isRecord(req)) return refuse("invalid_request", "not a JSON object");
  if (!id) return refuse("invalid_request", "needs a string id");
  const extra = Object.keys(req).find((k) => !REQUEST_FIELDS.has(k));
  if (extra !== undefined) return refuse("invalid_request", `unknown field ${extra}`);
  const method = req.method;
  if (typeof method !== "string" || !(Object.hasOwn(PANE_PARAMS, method) || ["pane.report_agent", "pane.release_agent", "pane.report_agent_session", "pane.report_metadata"].includes(method))) {
    return refuse("forbidden", `this socket allows ${[...Object.keys(PANE_PARAMS), "pane.report_agent", "pane.release_agent", "pane.report_agent_session", "pane.report_metadata"].join(", ")} within the lane's pane and tab permissions`);
  }
  const params = req.params === undefined && (method === "ping" || method === "pane.list" || method === "pane.layout") ? {} : req.params;
  if (!isRecord(params)) return refuse("invalid_request", "needs params");
  const allowed = method === "pane.report_agent" ? REPORT_PARAMS : method === "pane.release_agent" ? RELEASE_PARAMS
    : method === "pane.report_agent_session" ? SESSION_PARAMS : method === "pane.report_metadata" ? METADATA_PARAMS : new Set(PANE_PARAMS[method]);
  const unknown = Object.keys(params).find((k) => !allowed.has(k));
  if (unknown !== undefined) return refuse(unknown === "resume_argv" ? "forbidden" : "invalid_request", `${method} param ${unknown} is not accepted here`);
  if (method === "ping") return { ok: true, id, request: line };
  if (pane === undefined) return refuse("forbidden", "the runner holds no pane for this lane");
  if (Object.hasOwn(PANE_PARAMS, method)) {
    const target = method === "pane.split" ? params.target_pane_id : params.pane_id;
    if (method !== "pane.list" && !(method === "pane.layout" && target === undefined) && !isLabel(target)) return refuse("invalid_request", "needs pane_id");
    if (method === "pane.split") {
      if (target !== pane && !lanePanes.has(target as string)) return refuse("forbidden", "only the lane's own pane or a lane pane may be split");
      if (params.direction !== undefined && !["left", "right", "up", "down"].includes(String(params.direction))) return refuse("invalid_request", "invalid direction");
      if (params.ratio !== undefined && !(typeof params.ratio === "number" && params.ratio > 0 && params.ratio < 1)) return refuse("invalid_request", "invalid ratio");
      if (params.cwd !== undefined && !(typeof params.cwd === "string" && !params.cwd.includes("\0"))) return refuse("invalid_request", "invalid cwd");
      if (params.focus !== undefined && typeof params.focus !== "boolean") return refuse("invalid_request", "invalid focus");
      if (params.right_click !== undefined && !isLabel(params.right_click)) return refuse("invalid_request", "invalid right_click");
    } else if (!["pane.get", "pane.read", "pane.list", "pane.layout"].includes(method)) {
      if (target === pane || !lanePanes.has(target as string)) return refuse("forbidden", "only a lane pane may be changed");
    }
    if (["pane.send_input", "pane.send_text"].includes(method) && typeof params.text !== "string") return refuse("invalid_request", "needs text");
    if (["pane.send_input", "pane.send_keys"].includes(method) && params.keys !== undefined && !(Array.isArray(params.keys) && params.keys.every(isLabel))) return refuse("invalid_request", "invalid keys");
    if (method === "pane.send_keys" && params.keys === undefined) return refuse("invalid_request", "needs keys");
    if (method === "pane.send_input") {
      if (params.keys !== undefined && !(Array.isArray(params.keys) && params.keys.length === 1 && params.keys[0] === "Enter")) return refuse("forbidden", 'keys must be exactly ["Enter"]');
      if (lanePanes.get(target as string)) return refuse("forbidden", "a lane pane runs one command");
    }
    if (["pane.send_text", "pane.send_keys"].includes(method) && !lanePanes.get(target as string)) return refuse("forbidden", "a lane pane must run its command before input");
    if (method === "pane.rename" && typeof params.label !== "string") return refuse("invalid_request", "needs label");
    if (method === "pane.read" && ((params.lines !== undefined && !(Number.isSafeInteger(params.lines) && (params.lines as number) > 0)) || (params.format !== undefined && !isLabel(params.format)))) return refuse("invalid_request", "invalid read parameters");
    if (method === "pane.resize" && ((params.direction !== undefined && !["left", "right", "up", "down"].includes(String(params.direction))) || (params.amount !== undefined && !(Number.isSafeInteger(params.amount) && (params.amount as number) > 0)))) return refuse("invalid_request", "invalid resize parameters");
    return { ok: true, id, request: JSON.stringify({ id, method, params }) };
  }
  if (params.pane_id !== pane && !(method === "pane.report_metadata" && lanePanes.has(params.pane_id as string))) return refuse("forbidden", "only the lane's own pane may be reported");
  const { source, agent, seq } = params;
  if (!isLabel(source) || !isLabel(agent)) return refuse("invalid_request", "needs source and agent");
  if (!absent(seq) && !(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0)) return refuse("invalid_request", "seq must be a non-negative integer");
  const common = { pane_id: params.pane_id, source, agent, ...(absent(seq) ? {} : { seq }) };
  if (method === "pane.release_agent") return { ok: true, id, request: JSON.stringify({ id, method, params: common }) };
  if (method === "pane.report_metadata") {
    for (const field of ["applies_to_source", "title", "display_agent"]) if (!absent(params[field]) && typeof params[field] !== "string") return refuse("invalid_request", `${field} must be a string`);
    if (!absent(params.state_labels) && !(Array.isArray(params.state_labels) && params.state_labels.every(isLabel))) return refuse("invalid_request", "state_labels must be strings");
    if (!absent(params.tokens) && !isRecord(params.tokens)) return refuse("invalid_request", "tokens must be an object");
    if (!absent(params.ttl_ms) && !(Number.isSafeInteger(params.ttl_ms) && (params.ttl_ms as number) >= 0)) return refuse("invalid_request", "ttl_ms must be a non-negative integer");
    return { ok: true, id, request: JSON.stringify({ id, method, params }) };
  }
  const { state, message, agent_session_id: sessionId, agent_session_path: sessionPath } = params;
  if (method === "pane.report_agent" && (typeof state !== "string" || !STATES.has(state))) return refuse("invalid_request", `state must be one of ${[...STATES].join(", ")}`);
  if (!absent(message) && !(typeof message === "string" && message.length <= 2048)) return refuse("invalid_request", "message must be a string of at most 2048 characters");
  if (!absent(sessionId) && !isLabel(sessionId)) return refuse("invalid_request", "agent_session_id must be a short string");
  if (!absent(sessionPath) && !(typeof sessionPath === "string" && sessionPath.length <= 4096 && sessionPath.startsWith("/") && !/[\u0000-\u001f]/.test(sessionPath))) {
    return refuse("invalid_request", "agent_session_path must be an absolute path");
  }
  const report = {
    ...common, ...(method === "pane.report_agent" ? { state } : {}),
    ...(absent(message) ? {} : { message }),
    ...(absent(sessionId) ? {} : { agent_session_id: sessionId }),
    ...(absent(sessionPath) ? {} : { agent_session_path: sessionPath }),
  };
  return { ok: true, id, request: JSON.stringify({ id, method, params: report }) };
};

/** How long a forwarded request waits for herdr's reply line. */
const HERDR_REPLY_MS = 3000;

/** Sends one request line to herdr's socket at `path` and resolves with its reply line; rejects on no reply. */
const askHerdr = async (path: string, request: string): Promise<string> => {
  let got = "";
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => { reject(new Error("herdr did not reply")); }, HERDR_REPLY_MS);
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_s, chunk) {
          got += Buffer.from(chunk).toString("utf8");
          const end = got.indexOf("\n");
          if (end >= 0) resolve(got.slice(0, end));
        },
        close() { reject(new Error("herdr closed the connection without a reply")); },
        error(_s, error) { reject(error); },
      },
    });
    socket.write(`${request}\n`);
    try { return await promise; } finally { socket.end(); }
  } finally {
    clearTimeout(timer);
  }
};

export type HerdrReportDeps = {
  readonly runnerDir: string;
  /** The pane the runner records for lane `key`, read at each request (a relaunch moves the lane to a new pane). */
  readonly paneOf?: (key: string) => string | undefined;
  readonly laneOf?: (key: string) => { readonly pane: string; readonly sandboxPrefix?: string; readonly sandbox?: boolean; readonly profile?: string } | undefined;
  readonly log: (line: string) => void;
  /** herdr's control socket (default `herdrControlSocket()`). */
  readonly herdrSocket?: string;
  /** Listens on a unix socket path (default unix-transport.ts `listenUnix`). */
  readonly listen?: (path: string) => Listener;
};

type LanePanes = { readonly panes: Map<string, boolean>; chain: Promise<void>; pane?: string; closed: boolean };
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Serializes requests across connections: herdr's CLI reconnects for each pane command. */
const serveLink = (link: Transport, key: string, deps: HerdrReportDeps, state: LanePanes): void => {
  link.onLine((line) => {
    state.chain = state.chain.then(async () => {
      if (state.closed || !link.open) return;
      const lane = deps.laneOf?.(key);
      const pane = lane?.pane ?? deps.paneOf?.(key);
      if (state.pane !== pane) {
        state.panes.clear();
        state.pane = pane;
      }
      const verdict = checkHerdrReport(line, pane, state.panes);
      let reply: string;
      if (!verdict.ok) {
        deps.log(`HERDR_REPORT_REFUSED lane=${key} ${verdict.code}: ${verdict.message}`);
        reply = JSON.stringify({ id: verdict.id, error: { code: verdict.code, message: verdict.message } });
      } else {
        try {
          const path = deps.herdrSocket ?? herdrControlSocket();
          const req = JSON.parse(verdict.request) as { id: string; method: string; params?: Record<string, unknown> };
          const params = req.params ?? {};
          const refuse = (message: string): string => JSON.stringify({ id: verdict.id, error: { code: "forbidden", message } });
          let tab: string | undefined;
          if (["pane.get", "pane.read", "pane.list", "pane.layout"].includes(req.method)) {
            const own = JSON.parse(await askHerdr(path, JSON.stringify({ id: verdict.id, method: "pane.get", params: { pane_id: pane } })));
            tab = own.result?.pane?.tab_id;
            if (typeof tab !== "string") {
              if (link.open) link.send(`${refuse("only panes in the lane's own tab")}\n`);
              return;
            }
            if (params.pane_id !== undefined && params.pane_id !== pane) {
              const target = JSON.parse(await askHerdr(path, JSON.stringify({ id: verdict.id, method: "pane.get", params: { pane_id: params.pane_id } })));
              if (target.result?.pane?.tab_id !== tab) {
                if (link.open) link.send(`${refuse("only panes in the lane's own tab")}\n`);
                return;
              }
            }
          }
          if (req.method === "pane.send_input") {
            if (lane?.sandboxPrefix === undefined && !(lane && lane.sandbox !== true && lane.profile !== undefined && lane.profile !== "sandboxed")) {
              if (link.open) link.send(`${refuse("relaunch the lane to allow pane run")}\n`);
              return;
            }
            if (lane?.sandboxPrefix) params.text = `exec ${lane.sandboxPrefix} /bin/sh -c ${quote(params.text as string)}`;
            // Claim before forwarding: a lost reply must not allow a second command into a running sandbox.
            state.panes.set(params.pane_id as string, true);
          }
          reply = await askHerdr(path, req.method === "pane.send_input" ? JSON.stringify({ ...req, params }) : verdict.request);
          const response = JSON.parse(reply);
          if (!response.error) {
            if (req.method === "pane.split" && !state.closed && isLabel(response.result?.pane?.pane_id)) state.panes.set(response.result.pane.pane_id, false);
            if (req.method === "pane.close") state.panes.delete(params.pane_id as string);
            if (req.method === "pane.list" && Array.isArray(response.result?.panes)) {
              response.result.panes = response.result.panes.filter((p: unknown) => isRecord(p) && p.tab_id === tab);
              reply = JSON.stringify(response);
            }
            if (req.method === "pane.layout" && response.result?.tab_id !== tab) reply = refuse("only panes in the lane's own tab");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.log(`HERDR_REPORT_FAILED lane=${key} ${message}`);
          reply = JSON.stringify({ id: verdict.id, error: { code: "herdr_unreachable", message } });
        }
      }
      if (link.open) link.send(`${reply}\n`);
    });
  });
};

/** The per-lane herdr report sockets the runner serves; `open` and `close` follow the lane's record. */
export class HerdrReportSockets {
  private readonly served = new Map<string, { listener: Listener; state: LanePanes }>();

  constructor(private readonly deps: HerdrReportDeps) {}

  /** Serves lane `key`'s socket (0700 directory) unless it already is; a failure is logged, never thrown. */
  open(key: string): void {
    if (this.served.has(key)) return;
    try {
      const sock = ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.sock);
      ensureRunnerSubdir(ensureRunnerSubdir(sock, HERDR_REPORT_DIR), key);
      const listener = (this.deps.listen ?? listenUnix)(herdrReportSocketPath(this.deps.runnerDir, key));
      const state: LanePanes = { panes: new Map(), chain: Promise.resolve(), closed: false };
      listener.onConnection((link) => { serveLink(link, key, this.deps, state); });
      this.served.set(key, { listener, state });
    } catch (error) {
      this.deps.log(`HERDR_REPORT_SOCKET_FAILED lane=${key} ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops serving lane `key` and removes its directory. */
  close(key: string): void {
    const served = this.served.get(key);
    if (served) {
      served.state.closed = true;
      served.state.panes.clear();
      served.listener.close();
    }
    this.served.delete(key);
    rmSync(join(this.deps.runnerDir, RUNNER_PATHS.sock, HERDR_REPORT_DIR, key), { recursive: true, force: true });
  }

  /** Stops every listener (the runner is shutting down); the directories stay for the lanes the next runner serves. */
  stop(): void {
    for (const { listener, state } of this.served.values()) {
      state.closed = true;
      state.panes.clear();
      listener.close();
    }
    this.served.clear();
  }
}
