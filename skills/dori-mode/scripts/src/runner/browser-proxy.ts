import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket, TCPSocketListener, UnixSocketListener } from "bun";
import { RUNNER_DIR_MODE, RunnerDirUnsafe, writeRunnerFile } from "./fs-safety.ts";

/**
 * The per-lane browser fill proxy. The lane's browser client (omowright) finds the BrowserSkill daemon through
 * `$BSK_HOME/daemon.json`; the runner points `BSK_HOME` at `<runnerDir>/browser/<key>`, where this proxy listens on
 * `daemon.sock` and relays NDJSON calls (`{id, method, params}` -> `{id, result}` | `{id, error}`, one upstream
 * connection per call) to the real daemon. A `tool.fill` whose value is a secret handle (`dsh_...`) is a secret fill:
 * the proxy checks with its own `tool.cooperate` sync and `tool.evaluate` that the selector names a top-frame
 * `input[type=password]`, then exchanges the handle for the value with the granting side (`exchange`) and forwards the
 * fill with the value. Afterwards `tool.evaluate` is refused until `session.stop` (the page now holds the value), and
 * every reply line has every value this proxy ever received redacted. The lane never sees a value.
 */

/** A secret handle. Mirrors `SECRET_HANDLE_PATTERN` in secret-handles.ts; kept local so the proxy stands alone. */
const HANDLE = /^dsh_[A-Za-z0-9_-]{43}$/;
const HANDLE_ANYWHERE = /dsh_[A-Za-z0-9_-]{43}/;

/** The proxy's socket and descriptor names inside its directory, and the version it advertises. */
export const BROWSER_PROXY_SOCKET = "daemon.sock";
export const BROWSER_PROXY_DESCRIPTOR = "daemon.json";
export const BROWSER_PROXY_VERSION = "dori-browser-proxy";

/** The granting side's answer to a handle exchange. */
export type BrowserExchangeResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * What the proxy needs: the lane `key`, its directory `dir` (`<runnerDir>/browser/<key>`), `upstream` (the real
 * daemon socket, read per call; production passes `() => bskDaemonSocket(realBskHome)`), `exchange` (the runner's
 * in-process call or the sealed supervisor frame, with this proxy's lane key bound by the caller), `log` (one line per
 * request) and `pid` (written into daemon.json).
 */
export type BrowserProxyDeps = {
  readonly key: string;
  readonly dir: string;
  readonly upstream: () => string | undefined;
  readonly exchange: (handle: string, origin: string) => Promise<BrowserExchangeResult>;
  readonly log: (line: string) => void;
  readonly pid: number;
};

/** A running proxy: its socket, the directory to launch the lane with as `BSK_HOME`, and `stop`. */
export type BrowserProxy = { readonly sockPath: string; readonly home: string; readonly stop: () => Promise<void> };

/** The `sock_path` of `<bskHome>/daemon.json` when it is a non-empty string, else undefined (missing or unreadable too). */
export const bskDaemonSocket = (bskHome: string): string | undefined => {
  try {
    const sock = (JSON.parse(readFileSync(join(bskHome, BROWSER_PROXY_DESCRIPTOR), "utf8")) as { sock_path?: unknown } | null)?.sock_path;
    return typeof sock === "string" && sock !== "" ? sock : undefined;
  } catch {
    return undefined;
  }
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const encoder = new TextEncoder();

/** Pending writes of one socket: Bun's `write` may take only part of a chunk, the rest goes out on `drain`. */
type Outbox = { chunks: Uint8Array[]; ending: boolean };
const pump = <T>(socket: Socket<T>, box: Outbox): void => {
  while (box.chunks.length > 0) {
    const chunk = box.chunks[0]!;
    const n = socket.write(chunk);
    if (n < chunk.length) { if (n > 0) box.chunks[0] = chunk.subarray(n); return; }
    box.chunks.shift();
  }
  if (box.ending) socket.end();
};

/** Splits a byte stream into lines across chunk (and UTF-8 sequence) boundaries; returns the lines each chunk completes. */
const lineReader = (): ((chunk: Uint8Array) => string[]) => {
  const decoder = new TextDecoder();
  let parts: string[] = [];
  return (chunk) => {
    const text = decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    let start = 0;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) {
      parts.push(text.slice(start, i));
      out.push(parts.join(""));
      parts = [];
      start = i + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
    return out;
  };
};

/** The encodings of a value a page or reply may carry it in; each is replaced by `[REDACTED]`. */
const encodings = (value: string): string[] => {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  return [value, JSON.stringify(value).slice(1, -1), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), hex, hex.toUpperCase(), encodeURIComponent(value)];
};

/** Something a log line may carry from a client or page: printable, no spaces, bounded. */
const loggable = (text: string): string => /^[\x21-\x7e]{1,200}$/.test(text) ? text : "unknown";

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  bad_request: "request is not a JSON object",
  secret_handle_misuse: "a secret handle may only be the whole value of a fill",
  secret_target_unsupported: "a secret fill needs a CSS selector, without tab_id or ref",
  secret_target_not_password: "a secret fill needs a top-frame password input",
  secret_origin_not_allowed: "the secret is not allowed on this origin",
  secret_unavailable: "the secret is unavailable",
  secret_tainted_session: "evaluate is refused after a secret fill until session.stop",
};

/** A target check that failed in the daemon rather than on the page. */
class Unavailable extends Error {}

/**
 * Starts the proxy for lane `deps.key`: makes `dir` and its parent 0700 (refusing a symlink, non-directory or foreign
 * owner with `RunnerDirUnsafe`), removes a stale socket, listens on `<dir>/daemon.sock` (chmod 0600) and writes
 * `<dir>/daemon.json` (0600) `{pid, sock_path, ws_port: 0, version: "dori-browser-proxy"}`. Each request logs one
 * `RUNNER_BROWSER lane=<key> method=<method> decision=<forward|allow|refuse:<reason>>[ origin=<origin>]` line and never
 * a selector, value, handle, param or reply. `stop` closes the listener and every connection and removes `dir`.
 */
export const startBrowserProxy = (deps: BrowserProxyDeps): BrowserProxy => {
  const { key, dir, upstream, exchange, log } = deps;
  ownedDir(dirname(dir));
  ownedDir(dir);
  const sockPath = join(dir, BROWSER_PROXY_SOCKET);
  rmSync(sockPath, { force: true });

  const secrets = new Set<string>();
  let redactions: string[] = [];
  let tainted = false;
  let seq = 0;
  const upstreams = new Set<Socket<undefined>>();
  const clients = new Set<Socket<Client>>();

  const remember = (value: string): void => {
    secrets.add(value);
    redactions = [...new Set([...secrets].flatMap(encodings))].filter((f) => f !== "").sort((a, b) => b.length - a.length);
  };
  const redact = (line: string): string => redactions.reduce((text, form) => text.includes(form) ? text.split(form).join("[REDACTED]") : text, line);

  /** One upstream call: sends `line`, resolves with the first reply line. */
  const rpc = (path: string, line: string): Promise<string> => new Promise((resolve, reject) => {
    let settled = false;
    const settle = (f: () => void): void => { if (!settled) { settled = true; f(); } };
    const box: Outbox = { chunks: [encoder.encode(`${line}\n`)], ending: false };
    const lines = lineReader();
    Bun.connect({
      unix: path,
      socket: {
        open: (s) => { upstreams.add(s); pump(s, box); },
        drain: (s) => pump(s, box),
        data: (s, chunk) => {
          const [first] = lines(chunk);
          if (first === undefined) return;
          settle(() => resolve(first));
          s.end();
        },
        close: (s) => { upstreams.delete(s); settle(() => reject(new Error("upstream closed"))); },
        error: (_s, e) => settle(() => reject(e)),
        connectError: (_s, e) => settle(() => reject(e)),
      },
    }).catch((e: unknown) => settle(() => reject(e)));
  });

  /** An internal call's `result`, or `Unavailable` for a daemon error or unparseable reply. */
  const call = async (path: string, method: string, params: Json): Promise<unknown> => {
    let reply: unknown;
    try { reply = JSON.parse(await rpc(path, JSON.stringify({ id: `dori-proxy-${++seq}`, method, params }))); } catch { throw new Unavailable(); }
    if (!isObject(reply) || reply.error !== undefined) throw new Unavailable();
    return reply.result;
  };
  const sync = async (path: string, base: Json): Promise<Json> => {
    const result = await call(path, "tool.cooperate", { ...base, action: "sync" });
    return isObject(result) && typeof result.context_id === "string" ? { ...base, context_id: result.context_id } : base;
  };
  /** Reads the page origin, whether it is the top frame, and whether `selector` is a real password input. */
  const probe = async (path: string, selector: string, context: Json): Promise<{ origin: string; top: boolean; masked: boolean } | undefined> => {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); `
      + `return { origin: location.origin, top: window.top === window, masked: !!el && el.tagName === "INPUT" `
      + `&& el.getAttribute("type") === "password" && el.type === "password" }; })()`;
    let result: unknown;
    try { result = await call(path, "tool.evaluate", { ...context, expression }); } catch { return undefined; }
    const v = isObject(result) && isObject(result.value) ? result.value : result;
    if (!isObject(v) || typeof v.origin !== "string" || typeof v.top !== "boolean" || typeof v.masked !== "boolean") return undefined;
    return { origin: v.origin, top: v.top, masked: v.masked };
  };

  const record = (method: string, decision: string, origin?: string): void =>
    log(`RUNNER_BROWSER lane=${key} method=${loggable(method)} decision=${decision}${origin !== undefined ? ` origin=${loggable(origin)}` : ""}`);
  const refuse = (id: unknown, method: string, reason: string, origin?: string): string => {
    record(method, `refuse:${reason}`, origin);
    return JSON.stringify({ id, error: { code: "permission_denied", message: REASON_MESSAGES[reason] ?? reason, data: { reason, effect_state: "none" } } });
  };
  const unavailable = (id: unknown, method: string, effect: "none" | "unknown", origin?: string): string => {
    record(method, "refuse:daemon_unavailable", origin);
    return JSON.stringify({ id, error: { code: "daemon_unavailable", message: "browser daemon unavailable", data: { effect_state: effect } } });
  };

  const secretFill = async (id: unknown, req: Json, params: Json, handle: string): Promise<string> => {
    const method = "tool.fill";
    const selector = params.selector;
    if (typeof selector !== "string" || selector === "" || params.tab_id !== undefined || params.ref !== undefined) return refuse(id, method, "secret_target_unsupported");
    const path = upstream();
    if (path === undefined) return unavailable(id, method, "none");
    const base: Json = typeof params.session_id === "string" ? { session_id: params.session_id } : {};
    let target: Awaited<ReturnType<typeof probe>>;
    try { target = await probe(path, selector, await sync(path, base)); } catch { return unavailable(id, method, "none"); }
    if (!target) return refuse(id, method, "secret_target_not_password");
    const { origin } = target;
    if (!target.top || !target.masked) return refuse(id, method, "secret_target_not_password", origin);
    let got: BrowserExchangeResult;
    try { got = await exchange(handle, origin); } catch { got = { ok: false, code: "RUNNER_SECRET_UNAVAILABLE", detail: "" }; }
    if (!got.ok) return refuse(id, method, got.code === "RUNNER_SECRET_DENIED" ? "secret_origin_not_allowed" : "secret_unavailable", origin);
    remember(got.value);
    tainted = true;
    let reply: string;
    try {
      const context = await sync(path, base);
      reply = await rpc(path, JSON.stringify({ ...req, params: { ...params, ...context, value: got.value } }));
    } catch { return unavailable(id, method, "unknown", origin); }
    record(method, "allow", origin);
    return redact(reply);
  };

  /** One client request line to the reply line for the client. */
  const handle = async (raw: string): Promise<string> => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let req: unknown;
    try { req = JSON.parse(line); } catch { req = undefined; }
    if (!isObject(req)) return refuse(null, "unknown", HANDLE_ANYWHERE.test(line) ? "secret_handle_misuse" : "bad_request");
    const id = req.id ?? null;
    const method = typeof req.method === "string" ? req.method : "unknown";
    const params = isObject(req.params) ? req.params : {};
    const handleValue = method === "tool.fill" && typeof params.value === "string" && HANDLE.test(params.value) ? params.value : undefined;
    // The decoded request, so a handle hidden behind JSON escapes is found too.
    const rest = handleValue !== undefined ? { ...req, params: { ...params, value: "" } } : req;
    if (HANDLE_ANYWHERE.test(JSON.stringify(rest))) return refuse(id, method, "secret_handle_misuse");
    if (handleValue !== undefined) return secretFill(id, req, params, handleValue);
    if (method === "tool.evaluate" && tainted) return refuse(id, method, "secret_tainted_session");
    const path = upstream();
    if (path === undefined) return unavailable(id, method, "none");
    let reply: string;
    try { reply = await rpc(path, line); } catch { return unavailable(id, method, "unknown"); }
    if (method === "session.stop") {
      try { const parsed: unknown = JSON.parse(reply); if (isObject(parsed) && parsed.error === undefined) tainted = false; } catch { /* the taint stays */ }
    }
    record(method, "forward");
    return redact(reply);
  };

  const server: UnixSocketListener<Client> | TCPSocketListener<Client> = Bun.listen<Client>({
    unix: sockPath,
    socket: {
      open: (s) => { s.data = { box: { chunks: [], ending: false }, lines: lineReader(), chain: Promise.resolve() }; clients.add(s); },
      data: (s, chunk) => {
        for (const line of s.data.lines(chunk)) {
          if (line.trim() === "") continue;
          s.data.chain = s.data.chain
            .then(() => handle(line))
            .catch(() => JSON.stringify({ id: null, error: { code: "proxy_error", message: "browser proxy error", data: { effect_state: "unknown" } } }))
            .then((out) => { s.data.box.chunks.push(encoder.encode(`${out}\n`)); pump(s, s.data.box); });
        }
      },
      drain: (s) => pump(s, s.data.box),
      close: (s) => { clients.delete(s); },
    },
  });
  chmodSync(sockPath, 0o600);
  writeRunnerFile(join(dir, BROWSER_PROXY_DESCRIPTOR), `${JSON.stringify({ pid: deps.pid, sock_path: sockPath, ws_port: 0, version: BROWSER_PROXY_VERSION })}\n`);

  const stop = async (): Promise<void> => {
    server.stop(true);
    for (const s of clients) s.end();
    for (const s of upstreams) s.end();
    clients.clear();
    upstreams.clear();
    rmSync(dir, { recursive: true, force: true });
  };
  return { sockPath, home: dir, stop };
};

type Client = { box: Outbox; lines: (chunk: Uint8Array) => string[]; chain: Promise<void> };

/** Creates `path` 0700 when absent; an existing one must be a real directory owned by this user, then is set to 0700. */
const ownedDir = (path: string): void => {
  let st: Stats | undefined;
  try { st = lstatSync(path); } catch { st = undefined; }
  if (!st) mkdirSync(path, { mode: RUNNER_DIR_MODE });
  else {
    if (st.isSymbolicLink()) throw new RunnerDirUnsafe(path, "symlink");
    if (!st.isDirectory()) throw new RunnerDirUnsafe(path, "not-directory");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid) throw new RunnerDirUnsafe(path, "owner", `uid=${st.uid}`);
  }
  chmodSync(path, RUNNER_DIR_MODE);
};
