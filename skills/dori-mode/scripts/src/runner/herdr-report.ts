import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureRunnerSubdir, RUNNER_PATHS } from "./fs-safety.ts";
import type { Listener, Transport } from "./transport.ts";
import { listenUnix } from "./unix-transport.ts";

/**
 * A sandboxed lane's way to report its agent state to herdr (the omo herdr extension's `pane.report_agent`). The lane
 * sandbox keeps herdr's control socket out of reach, so the runner serves each lane a socket of its own at
 * `<runnerDir>/sock/herdr.d/<key>/herdr`; the lane sandbox binds only that lane's directory and points
 * `HERDR_SOCKET_PATH` at it. A request line is herdr's own socket request. The runner forwards it to herdr's socket,
 * rebuilt from the checked fields, only when it is `pane.report_agent` or `pane.release_agent` for the lane's own pane
 * with known parameters of the right type, and relays herdr's reply. Everything else (another method, another pane,
 * `resume_argv`, which herdr would run outside the sandbox after a restart, unknown fields, malformed JSON) is refused
 * with herdr's error reply shape and nothing reaches herdr.
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
export const checkHerdrReport = (line: string, pane: string | undefined): HerdrReportVerdict => {
  let req: unknown;
  try { req = JSON.parse(line); } catch { return { ok: false, id: "", code: "invalid_request", message: "not JSON" }; }
  const id = isRecord(req) && isLabel(req.id) ? req.id : "";
  const refuse = (code: string, message: string): HerdrReportVerdict => ({ ok: false, id, code, message });
  if (!isRecord(req)) return refuse("invalid_request", "not a JSON object");
  if (!id) return refuse("invalid_request", "needs a string id");
  const extra = Object.keys(req).find((k) => !REQUEST_FIELDS.has(k));
  if (extra !== undefined) return refuse("invalid_request", `unknown field ${extra}`);
  const method = req.method;
  if (method !== "pane.report_agent" && method !== "pane.release_agent") {
    return refuse("forbidden", "this socket forwards only pane.report_agent and pane.release_agent for the lane's own pane");
  }
  const params = req.params;
  if (!isRecord(params)) return refuse("invalid_request", "needs params");
  const allowed = method === "pane.report_agent" ? REPORT_PARAMS : RELEASE_PARAMS;
  const unknown = Object.keys(params).find((k) => !allowed.has(k));
  if (unknown !== undefined) return refuse(unknown === "resume_argv" ? "forbidden" : "invalid_request", `${method} param ${unknown} is not accepted here`);
  if (pane === undefined) return refuse("forbidden", "the runner holds no pane for this lane");
  if (params.pane_id !== pane) return refuse("forbidden", "only the lane's own pane may be reported");
  const { source, agent, seq } = params;
  if (!isLabel(source) || !isLabel(agent)) return refuse("invalid_request", "needs source and agent");
  if (!absent(seq) && !(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0)) return refuse("invalid_request", "seq must be a non-negative integer");
  const common = { pane_id: pane, source, agent, ...(absent(seq) ? {} : { seq }) };
  if (method === "pane.release_agent") return { ok: true, id, request: JSON.stringify({ id, method, params: common }) };
  const { state, message, agent_session_id: sessionId, agent_session_path: sessionPath } = params;
  if (typeof state !== "string" || !STATES.has(state)) return refuse("invalid_request", `state must be one of ${[...STATES].join(", ")}`);
  if (!absent(message) && !(typeof message === "string" && message.length <= 2048)) return refuse("invalid_request", "message must be a string of at most 2048 characters");
  if (!absent(sessionId) && !isLabel(sessionId)) return refuse("invalid_request", "agent_session_id must be a short string");
  if (!absent(sessionPath) && !(typeof sessionPath === "string" && sessionPath.length <= 4096 && sessionPath.startsWith("/") && !/[\u0000-\u001f]/.test(sessionPath))) {
    return refuse("invalid_request", "agent_session_path must be an absolute path");
  }
  const report = {
    ...common, state,
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
  readonly paneOf: (key: string) => string | undefined;
  readonly log: (line: string) => void;
  /** herdr's control socket (default `herdrControlSocket()`). */
  readonly herdrSocket?: string;
  /** Listens on a unix socket path (default unix-transport.ts `listenUnix`). */
  readonly listen?: (path: string) => Listener;
};

/** Answers each request line of one connection in order, forwarding the accepted ones to herdr. */
const serveLink = (link: Transport, key: string, deps: HerdrReportDeps): void => {
  let chain = Promise.resolve();
  link.onLine((line) => {
    chain = chain.then(async () => {
      const verdict = checkHerdrReport(line, deps.paneOf(key));
      let reply: string;
      if (!verdict.ok) {
        deps.log(`HERDR_REPORT_REFUSED lane=${key} ${verdict.code}: ${verdict.message}`);
        reply = JSON.stringify({ id: verdict.id, error: { code: verdict.code, message: verdict.message } });
      } else {
        try {
          reply = await askHerdr(deps.herdrSocket ?? herdrControlSocket(), verdict.request);
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
  private readonly served = new Map<string, Listener>();

  constructor(private readonly deps: HerdrReportDeps) {}

  /** Serves lane `key`'s socket (0700 directory) unless it already is; a failure is logged, never thrown. */
  open(key: string): void {
    if (this.served.has(key)) return;
    try {
      const sock = ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.sock);
      ensureRunnerSubdir(ensureRunnerSubdir(sock, HERDR_REPORT_DIR), key);
      const listener = (this.deps.listen ?? listenUnix)(herdrReportSocketPath(this.deps.runnerDir, key));
      listener.onConnection((link) => { serveLink(link, key, this.deps); });
      this.served.set(key, listener);
    } catch (error) {
      this.deps.log(`HERDR_REPORT_SOCKET_FAILED lane=${key} ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops serving lane `key` and removes its directory. */
  close(key: string): void {
    this.served.get(key)?.close();
    this.served.delete(key);
    rmSync(join(this.deps.runnerDir, RUNNER_PATHS.sock, HERDR_REPORT_DIR, key), { recursive: true, force: true });
  }

  /** Stops every listener (the runner is shutting down); the directories stay for the lanes the next runner serves. */
  stop(): void {
    for (const listener of this.served.values()) listener.close();
    this.served.clear();
  }
}
