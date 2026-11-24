import type { ServerWebSocket } from "bun";
import { realTimers, type Timers } from "./call.ts";
import { MAX_FRAME_BYTES } from "./protocol.ts";
import { backoffMs, type Connector, LineTransport, type Listener, type Transport } from "./transport.ts";

/**
 * The network runner link: one frame per WebSocket text message over TCP. Lines cross the `Transport` boundary the
 * same way as on the unix link: a trailing newline on a sent line is dropped (the message boundary is the frame
 * boundary) and received lines carry none. Authentication and the frame MAC belong to the layer above; this module
 * only moves messages and refuses to listen anywhere but a private address.
 */

const parseIPv4 = (text: string): number[] | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
};

/** Splits `host:port` or `[v6]:port` into host and numeric port. */
const splitHostPort = (hostPort: string): { host: string; port: number } | undefined => {
  const match = /^\[([^\]]*)\]:(\d{1,5})$/.exec(hostPort) ?? /^([^:[\]]*):(\d{1,5})$/.exec(hostPort);
  if (!match) return undefined;
  const port = Number(match[2]);
  return port <= 65535 ? { host: match[1] as string, port } : undefined;
};

const isPrivateHost = (host: string): boolean => {
  const v4 = parseIPv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!host.includes(":")) return false;
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // fd00::/8: the first group is fd00 through fdff.
  return /^fd[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}::/.test(lower);
};

/**
 * True when `hostPort` (`host:port`, IPv6 as `[host]:port`) names a single private interface address: 127.0.0.0/8,
 * 10/8, 172.16/12, 192.168/16, 100.64/10, fd00::/8 or ::1. The wildcard addresses, empty hosts, hostnames and public
 * addresses are all false.
 */
export const isPrivateListen = (hostPort: string): boolean => {
  const parsed = splitHostPort(hostPort);
  return parsed !== undefined && parsed.host !== "" && isPrivateHost(parsed.host);
};

/**
 * `send` returns Bun's `ServerWebSocketSendStatus` on the accepting side: the byte count when written, -1 when queued
 * under backpressure (a `drain` follows), 0 when dropped. The dialing side's WebSocket queues every message without a
 * status and returns undefined.
 */
type Wire = { send(data: string): number | undefined; close(code?: number, reason?: string): void };

/** Bun's send status for a message the socket dropped. */
const SEND_DROPPED = 0;
/** Bun's send status for a message queued under backpressure. */
const SEND_BACKPRESSURE = -1;

const stripNewline = (line: string): string => (line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line);

/** WebSocket close reasons are limited to 123 bytes. */
const shortReason = (reason: string): string => Buffer.from(reason, "utf8").subarray(0, 120).toString("utf8").replace(/\uFFFD/g, "");

/**
 * One WebSocket as a `Transport`. Lines that arrive before the first `onLine` subscriber are held for it. A message
 * over the protocol size limit, or a binary message, closes the link.
 *
 * Every send status is checked. A message queued under backpressure makes `drained` wait for the socket's `drain`. A
 * dropped message closes the link with `RUNNER_SEND_DROPPED`: the peer then sees the close at once instead of waiting
 * out a timeout for a lost control frame, and a lost event is replayed from the outbox after the reconnect.
 */
class WsTransport extends LineTransport {
  private pressured = false;

  constructor(private readonly wire: Wire) {
    super();
  }

  send(line: string): void {
    if (this.closed) throw new Error("transport closed");
    const text = stripNewline(line);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_FRAME_BYTES) throw new Error(`frame over ${MAX_FRAME_BYTES} bytes`);
    const status = this.wire.send(text);
    if (status === SEND_DROPPED) this.close(`RUNNER_SEND_DROPPED ${bytes}-byte message dropped by the socket`);
    else if (status === SEND_BACKPRESSURE) this.pressured = true;
  }

  /** The socket took its queued output (the server's `drain` handler). */
  drain(): void {
    this.pressured = false;
    this.wake();
  }

  protected backlogged(): boolean {
    return this.pressured;
  }

  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.closed) return;
    if (typeof message !== "string") {
      this.close("binary message");
      return;
    }
    if (Buffer.byteLength(message, "utf8") > MAX_FRAME_BYTES) {
      this.close("frame too large");
      return;
    }
    this.deliver(message);
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.ended(reason);
    try { this.wire.close(1000, shortReason(reason)); } catch { /* already closed */ }
  }
}

export type WsListener = Listener & {
  /** The bound port (useful after listening on port 0). */
  readonly port: number;
  /** The bound host exactly as requested. */
  readonly host: string;
};

type ServerData = { transport?: WsTransport };

/**
 * Listens for WebSocket connections on exactly `hostPort` and throws unless `isPrivateListen(hostPort)`; it never binds
 * a wildcard address. Port 0 picks a free port (read it from `.port`). Messages over `MAX_FRAME_BYTES` are refused by
 * the socket layer, which closes the link. `close` stops listening and ends every open connection.
 */
export const listenWs = (hostPort: string): WsListener => {
  const parsed = splitHostPort(hostPort);
  if (!parsed || !isPrivateListen(hostPort)) throw new Error(`RUNNER_LISTEN_REFUSED ${hostPort} is not a private host:port`);
  const subscribers = new Set<(transport: Transport) => void>();
  const open = new Set<WsTransport>();
  const server = Bun.serve<ServerData>({
    hostname: parsed.host,
    port: parsed.port,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: {} })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      // A link idle this long is pinged and closed when the ping goes unanswered: a worker's only way to drop a
      // supervisor link that died without a FIN, which would otherwise refuse the redial as `runner already connected`.
      idleTimeout: 120,
      sendPings: true,
      open(ws: ServerWebSocket<ServerData>) {
        const transport = new WsTransport(ws);
        ws.data.transport = transport;
        open.add(transport);
        transport.onClose(() => { open.delete(transport); });
        for (const handler of [...subscribers]) handler(transport);
      },
      message(ws, message) { ws.data.transport?.receive(message); },
      drain(ws) { ws.data.transport?.drain(); },
      close(ws, code, reason) { ws.data.transport?.ended(reason || `peer closed (${code})`); },
    },
  });
  return {
    port: server.port as number,
    host: parsed.host,
    onConnection(handler) {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    close() {
      subscribers.clear();
      for (const transport of [...open]) transport.close("listener closed");
      void server.stop(true);
    },
  };
};

/** Opens a WebSocket transport; rejects when the socket cannot be opened. */
export const connectWs = (url: string): Connector => () =>
  new Promise<Transport>((resolve, reject) => {
    const socket = new WebSocket(url);
    const transport = new WsTransport({
      send: (data) => { socket.send(data); return undefined; },
      close: (code, reason) => socket.close(code, reason),
    });
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      resolve(transport);
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      transport.receive(event.data as string | ArrayBuffer);
    });
    socket.addEventListener("error", () => {
      if (!opened) reject(new Error(`RUNNER_CONNECT_FAILED ${url}`));
      else transport.ended("socket error");
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (!opened) reject(new Error(`RUNNER_CONNECT_FAILED ${url}`));
      transport.ended(event.reason || `peer closed (${event.code})`);
    });
  });

export type AcceptingConnector = {
  readonly connect: Connector;
  readonly host: string;
  readonly port: number;
  close(): void;
};

/** A worker owns the listening socket. Keep one early inbound connection for its next connectOnce(). */
export const acceptWs = (hostPort: string): AcceptingConnector => {
  const listener = listenWs(hostPort);
  let closed = false;
  let held: Transport | undefined;
  let active: Transport | undefined;
  let waiting: { resolve: (transport: Transport) => void; reject: (error: Error) => void } | undefined;
  listener.onConnection((transport) => {
    if (active?.open || held?.open) {
      transport.close("runner already connected");
      return;
    }
    if (waiting) {
      const { resolve } = waiting;
      waiting = undefined;
      active = transport;
      resolve(transport);
    } else held = transport;
  });
  return {
    host: listener.host, port: listener.port,
    connect: () => {
      if (closed) return Promise.reject(new Error("runner listener closed"));
      if (waiting || active?.open) return Promise.reject(new Error("runner already connecting"));
      if (held?.open) {
        active = held;
        held = undefined;
        return Promise.resolve(active);
      }
      held = undefined;
      return new Promise<Transport>((resolve, reject) => { waiting = { resolve, reject }; });
    },
    close() {
      closed = true;
      waiting?.reject(new Error("runner listener closed"));
      waiting = undefined;
      listener.close();
    },
  };
};

export type DialingOptions = {
  readonly endpoints: () => Readonly<Record<string, string>>;
  readonly timers?: Timers;
  readonly random?: () => number;
  readonly dial?: (url: string) => Promise<Transport>;
  readonly refreshMs?: number;
  readonly log?: (line: string) => void;
};
export type DialingListener = Listener & { refresh(): void };

/** Dial each recorded worker, redial broken links, and periodically discover endpoint file changes. */
export const dialWs = (options: DialingOptions): DialingListener => {
  const timers = options.timers ?? realTimers;
  const random = options.random ?? Math.random;
  const dial = options.dial ?? ((url: string) => connectWs(url)());
  const handlers = new Set<(transport: Transport) => void>();
  type Peer = { endpoint: string; attempt: number; transport?: Transport; timer?: unknown };
  const peers = new Map<string, Peer>();
  let closed = false;
  let started = false;
  let refreshTimer: unknown;
  const current = (label: string, peer: Peer): boolean => !closed && peers.get(label) === peer;
  const connect = (label: string, peer: Peer): void => {
    const retry = (): void => {
      if (!current(label, peer)) return;
      peer.timer = timers.set(() => { peer.timer = undefined; connect(label, peer); }, backoffMs(peer.attempt++, random));
    };
    void dial(`ws://${peer.endpoint}`).then((transport) => {
      if (!current(label, peer)) { transport.close("endpoint removed"); return; }
      peer.transport = transport;
      if (!transport.open) { retry(); return; }
      peer.attempt = 0;
      transport.onClose(retry);
      for (const handler of [...handlers]) handler(transport);
    }, (error: unknown) => {
      if (!current(label, peer)) return;
      options.log?.(`RUNNER_CONNECT_FAILED runner=${label} endpoint=${peer.endpoint} ${error instanceof Error ? error.message : String(error)}`);
      retry();
    });
  };
  const remove = (label: string, peer: Peer): void => {
    peers.delete(label);
    if (peer.timer !== undefined) timers.clear(peer.timer);
    peer.transport?.close("endpoint removed");
  };
  const refresh = (): void => {
    if (closed || !started) return;
    const endpoints = options.endpoints();
    for (const [label, peer] of peers) if (endpoints[label] !== peer.endpoint) remove(label, peer);
    for (const [label, endpoint] of Object.entries(endpoints)) {
      if (peers.has(label)) continue;
      if (!isPrivateListen(endpoint)) {
        options.log?.(`RUNNER_LISTEN_REFUSED runner=${label} endpoint=${endpoint} is not a private host:port`);
        continue;
      }
      const peer: Peer = { endpoint, attempt: 0 };
      peers.set(label, peer);
      connect(label, peer);
    }
  };
  const tick = (): void => {
    try { refresh(); }
    catch (error) { options.log?.(`RUNNER_ENDPOINTS_FAILED ${error instanceof Error ? error.message : String(error)}`); }
    if (!closed) refreshTimer = timers.set(tick, options.refreshMs ?? 1000);
  };
  return {
    refresh,
    onConnection(handler) {
      handlers.add(handler);
      if (!started && !closed) { started = true; tick(); }
      return () => { handlers.delete(handler); };
    },
    close() {
      closed = true;
      timers.clear(refreshTimer);
      for (const [label, peer] of peers) remove(label, peer);
      handlers.clear();
    },
  };
};
