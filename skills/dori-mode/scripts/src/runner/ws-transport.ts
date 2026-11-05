import type { ServerWebSocket } from "bun";
import { MAX_FRAME_BYTES } from "./protocol.ts";
import type { Connector, Listener, Transport } from "./transport.ts";

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

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_JITTER = 0.2;

/**
 * Delay in ms before reconnect attempt number `attempt` (0 is the first retry): 1s doubling up to 60s, then scaled by
 * a factor in [0.8, 1.2] taken from `random()` (a value in [0, 1)). Pure: pass a seeded or fixed `random` in tests.
 */
export const backoff = (attempt: number, random: () => number): number => {
  const exponent = Math.max(0, Math.min(Math.floor(attempt), 30));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.round(base * (1 + (random() * 2 - 1) * BACKOFF_JITTER));
};

type Wire = { send(data: string): unknown; close(code?: number, reason?: string): void };

const stripNewline = (line: string): string => (line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line);

/** WebSocket close reasons are limited to 123 bytes. */
const shortReason = (reason: string): string => Buffer.from(reason, "utf8").subarray(0, 120).toString("utf8").replace(/\uFFFD/g, "");

/**
 * One WebSocket as a `Transport`. Lines that arrive before the first `onLine` subscriber are held for it. A message
 * over the protocol size limit, or a binary message, closes the link.
 */
class WsTransport implements Transport {
  private readonly lines = new Set<(line: string) => void>();
  private readonly closers = new Set<(reason: string) => void>();
  private readonly held: string[] = [];
  private closed = false;

  constructor(private readonly wire: Wire) {}

  get open(): boolean {
    return !this.closed;
  }

  send(line: string): void {
    if (this.closed) throw new Error("transport closed");
    const text = stripNewline(line);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new Error(`frame over ${MAX_FRAME_BYTES} bytes`);
    this.wire.send(text);
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
    if (!this.lines.size) {
      this.held.push(message);
      return;
    }
    for (const handler of [...this.lines]) handler(message);
  }

  onLine(handler: (line: string) => void): () => void {
    this.lines.add(handler);
    while (this.held.length && this.lines.size) {
      const next = this.held.shift() as string;
      for (const each of [...this.lines]) each(next);
    }
    return () => { this.lines.delete(handler); };
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closers.add(handler);
    return () => { this.closers.delete(handler); };
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.ended(reason);
    try { this.wire.close(1000, shortReason(reason)); } catch { /* already closed */ }
  }

  /** The peer or the OS closed the socket. */
  ended(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closers]) handler(reason);
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
      open(ws: ServerWebSocket<ServerData>) {
        const transport = new WsTransport(ws);
        ws.data.transport = transport;
        open.add(transport);
        transport.onClose(() => { open.delete(transport); });
        for (const handler of [...subscribers]) handler(transport);
      },
      message(ws, message) { ws.data.transport?.receive(message); },
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

/** Connects to a hub at `url` (`ws://host:port`); the connector rejects when the socket cannot be opened. */
export const connectWs = (url: string): Connector => () =>
  new Promise<Transport>((resolve, reject) => {
    const socket = new WebSocket(url);
    const transport = new WsTransport({
      send: (data) => socket.send(data),
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
