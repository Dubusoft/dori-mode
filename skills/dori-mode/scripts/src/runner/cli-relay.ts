import { join } from "node:path";
import { RUNNER_PATHS } from "./fs-safety.ts";
import { QueryFailed, RunnerUnavailable, realTimers, CALL_TIMEOUT_MS, COMMAND_TIMEOUTS, QUERY_TIMEOUT_MS } from "./call.ts";
import type { CallOptions, CallResult, CallWhy, RunnerCall, Timers } from "./call.ts";
import type { CommandResults, DurableCommandType, QueryBodies, QueryResults, QueryType, SupervisorCommandBodies } from "./protocol.ts";
import type { Connector, Listener, Transport } from "./transport.ts";
import { connectUnix } from "./unix-transport.ts";

/**
 * The CLI relay (design 0.2): the supervisor serves a `RunnerCall` over a unix socket so the separate `dori` CLI
 * process reaches the runners that live in the supervisor. One JSON request per line, one JSON reply per line, many
 * requests per connection. Trust is the 0700 `sock/` directory, as for the control socket.
 */

export const CLI_SOCKET = "cli";

/** `<runnerDir>/sock/cli`. */
export const cliSocketPath = (runnerDir: string): string => join(runnerDir, RUNNER_PATHS.sock, CLI_SOCKET);

export type RelayRequest = {
  readonly id: string;
  readonly op: "call" | "query" | "connected";
  readonly label: string;
  readonly type?: string;
  readonly body?: Record<string, unknown>;
  readonly opts?: { readonly cmdId?: string; readonly timeoutMs?: number };
};
export type RelayReply =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly code: "RUNNER_UNAVAILABLE" | "LANE_OP_FAILED"; readonly label: string; readonly why?: CallWhy; readonly detail: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTimeout = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

const failure = (id: string, label: string, error: unknown): RelayReply => {
  if (error instanceof RunnerUnavailable) return { id, ok: false, code: "RUNNER_UNAVAILABLE", label, why: error.why, detail: error.message };
  return { id, ok: false, code: "LANE_OP_FAILED", label, detail: error instanceof Error ? error.message : String(error) };
};

const handle = async (request: unknown, calls: RunnerCall): Promise<RelayReply> => {
  const raw = isObject(request) ? request : {};
  const id = typeof raw.id === "string" ? raw.id : "";
  const label = typeof raw.label === "string" ? raw.label : "";
  if (!isObject(request) || !id || !label || (raw.op !== "call" && raw.op !== "query" && raw.op !== "connected")) {
    return { id, ok: false, code: "LANE_OP_FAILED", label, detail: "malformed relay request" };
  }
  try {
    if (raw.op === "connected") return { id, ok: true, value: calls.connected(label) };
    if (typeof raw.type !== "string" || !isObject(raw.body)) return { id, ok: false, code: "LANE_OP_FAILED", label, detail: "malformed relay request" };
    const opts = isObject(raw.opts) ? raw.opts : {};
    const timeoutMs = isTimeout(opts.timeoutMs) ? opts.timeoutMs : undefined;
    if (raw.op === "query") {
      const value = await calls.query(label, raw.type as QueryType, raw.body as Omit<QueryBodies[QueryType], "qid">, { timeoutMs });
      return { id, ok: true, value };
    }
    const callOpts: CallOptions = { cmdId: typeof opts.cmdId === "string" ? opts.cmdId : undefined, timeoutMs };
    const value = await calls.call(label, raw.type as DurableCommandType, raw.body as Omit<SupervisorCommandBodies[DurableCommandType], "cmdId">, callOpts);
    return { id, ok: true, value };
  } catch (error) {
    return failure(id, label, error);
  }
};

/**
 * Supervisor side: answers each request line with a reply line. Returns a stop function that unsubscribes from the
 * listener and closes the open connections; the caller owns the listener itself.
 */
export const serveCliRelay = (listener: Listener, calls: RunnerCall, log: (line: string) => void): (() => void) => {
  const open = new Set<Transport>();
  const off = listener.onConnection((transport) => {
    open.add(transport);
    transport.onClose(() => { open.delete(transport); });
    transport.onLine((line) => {
      let request: unknown;
      try { request = JSON.parse(line); } catch { request = undefined; }
      void handle(request, calls).then((reply) => {
        if (!reply.ok) log(`CLI_RELAY_FAILED ${reply.code} runner=${reply.label} ${reply.detail}`);
        if (transport.open) transport.send(`${JSON.stringify(reply)}\n`);
      });
    });
  });
  return () => {
    off();
    for (const transport of [...open]) transport.close("relay stopped");
  };
};

export type CliRunnerCall = RunnerCall & {
  /** Asks the supervisor whether `label` is connected and refreshes what `connected()` answers. */
  refresh(label: string): Promise<boolean>;
};

const SUPERVISOR_DOWN = "the supervisor is not running (systemctl --user start dori-supervisor.service)";
/** Slack added to the call's own timeout so the supervisor's timeout answer normally arrives first. */
const CLIENT_SLACK_MS = 5_000;

/**
 * CLI side: a `RunnerCall` over the relay socket, one connection per request. A socket that cannot be reached throws
 * `RunnerUnavailable(label, "disconnected", ...)`. `connected()` is synchronous in `RunnerCall`, so it answers the last
 * value this client learned (false before any exchange); `refresh()` asks.
 */
export const cliRunnerCall = (socketPath: string, deps: { readonly connect?: Connector; readonly timers?: Timers; readonly now?: () => number } = {}): CliRunnerCall => {
  const connect = deps.connect ?? connectUnix(socketPath);
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;
  const known = new Map<string, boolean>();
  let n = 0;

  const request = async (label: string, req: Omit<RelayRequest, "id" | "label">, timeoutMs: number): Promise<unknown> => {
    n += 1;
    const id = `cli:${now()}:${n}`;
    let transport: Transport;
    try {
      transport = await connect();
    } catch (error) {
      known.set(label, false);
      throw new RunnerUnavailable(label, "disconnected", `${SUPERVISOR_DOWN}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const reply = await new Promise<RelayReply>((resolve, reject) => {
        const timer = timers.set(() => reject(new RunnerUnavailable(label, "timeout", `no relay answer for ${req.op} within ${timeoutMs} ms`)), timeoutMs);
        const settle = (fn: () => void): void => { timers.clear(timer); fn(); };
        transport.onLine((line) => {
          let parsed: RelayReply;
          try { parsed = JSON.parse(line) as RelayReply; } catch { return; }
          if (parsed.id === id) settle(() => resolve(parsed));
        });
        transport.onClose(() => settle(() => reject(new RunnerUnavailable(label, "disconnected", `relay connection closed: ${SUPERVISOR_DOWN}`))));
        try {
          transport.send(`${JSON.stringify({ id, label, ...req })}\n`);
        } catch (error) {
          settle(() => reject(new RunnerUnavailable(label, "disconnected", `${SUPERVISOR_DOWN}: ${error instanceof Error ? error.message : String(error)}`)));
        }
      });
      if (reply.ok) {
        if (req.op !== "connected") known.set(label, true);
        return reply.value;
      }
      if (reply.code === "RUNNER_UNAVAILABLE") {
        if (reply.why === "disconnected") known.set(label, false);
        throw new RunnerUnavailable(label, reply.why ?? "disconnected", reply.detail.replace(/^RUNNER_UNAVAILABLE runner=\S+ \S+: /, ""));
      }
      throw new QueryFailed(label, reply.detail);
    } finally {
      transport.close();
    }
  };

  return {
    call: <T extends DurableCommandType>(label: string, type: T, body: Omit<SupervisorCommandBodies[T], "cmdId">, opts?: CallOptions) =>
      request(label, { op: "call", type, body: body as Record<string, unknown>, opts }, (opts?.timeoutMs ?? COMMAND_TIMEOUTS[type] ?? CALL_TIMEOUT_MS) + CLIENT_SLACK_MS) as Promise<CallResult<CommandResults[T]>>,
    query: <T extends QueryType>(label: string, type: T, body: Omit<QueryBodies[T], "qid">, opts?: { readonly timeoutMs?: number }) =>
      request(label, { op: "query", type, body: body as Record<string, unknown>, opts }, (opts?.timeoutMs ?? QUERY_TIMEOUT_MS) + CLIENT_SLACK_MS) as Promise<QueryResults[T]>,
    connected: (label) => known.get(label) ?? false,
    refresh: async (label) => {
      const value = (await request(label, { op: "connected" }, QUERY_TIMEOUT_MS)) === true;
      known.set(label, value);
      return value;
    },
  };
};
