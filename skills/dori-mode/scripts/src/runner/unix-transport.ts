import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import type { Socket } from "bun";
import { RUNNER_PATHS } from "./fs-safety.ts";
import { LineSplitter } from "./protocol.ts";
import type { Connector, Listener, Transport } from "./transport.ts";

/**
 * The local runner link: frame lines over a unix socket at `<runnerDir>/sock/control`. The supervisor's hub listens
 * there and the local runner connects to it, the same direction as a remote runner over the network.
 *
 * In P1 this socket was unauthenticated: mutual authentication arrived with P2. Bun's socket API does
 * not expose the peer's uid (no SO_PEERCRED), so the only boundary is the 0700 `sock/` directory (and the 0700 runner
 * directory above it) owned by the user both processes run as. Nothing that arrives here may change lane state.
 */

export const CONTROL_SOCKET = "control";

/** `<runnerDir>/sock/control`. */
export const controlSocketPath = (runnerDir: string): string => join(runnerDir, RUNNER_PATHS.sock, CONTROL_SOCKET);

type Wire = { write(data: Uint8Array): number; end(data?: Uint8Array): void };

/**
 * One end of a socket as a `Transport`. Received bytes are decoded as a UTF-8 stream and split into lines; lines that
 * arrive before the first `onLine` subscriber are held for it. Writes the kernel did not take are kept and written on
 * `drain`, so a burst (an outbox replay) is never cut. A frame over the protocol size limit closes the link.
 */
class SocketTransport implements Transport {
  private readonly lines = new Set<(line: string) => void>();
  private readonly closers = new Set<(reason: string) => void>();
  private readonly held: string[] = [];
  private readonly splitter = new LineSplitter();
  private readonly decoder = new TextDecoder();
  private pending: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly wire: Wire) {}

  get open(): boolean {
    return !this.closed;
  }

  send(line: string): void {
    if (this.closed) throw new Error("transport closed");
    this.pending = Buffer.concat([this.pending, Buffer.from(line, "utf8")]);
    this.flush();
  }

  /** Writes as many pending bytes as the socket takes now. */
  flush(): void {
    if (!this.pending.length || this.closed) return;
    const written = this.wire.write(this.pending);
    if (written > 0) this.pending = this.pending.subarray(written);
  }

  receive(chunk: Uint8Array): void {
    if (this.closed) return;
    let lines: string[];
    try {
      lines = this.splitter.push(this.decoder.decode(chunk, { stream: true }));
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const line of lines) this.deliver(line);
  }

  private deliver(line: string): void {
    if (!this.lines.size) {
      this.held.push(line);
      return;
    }
    for (const handler of [...this.lines]) handler(line);
  }

  onLine(handler: (line: string) => void): () => void {
    this.lines.add(handler);
    while (this.held.length && this.lines.size) this.deliver(this.held.shift() as string);
    return () => { this.lines.delete(handler); };
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closers.add(handler);
    return () => { this.closers.delete(handler); };
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    this.ended(reason);
    // Whatever is still pending (a hello.reject before the close) goes out with the end.
    this.wire.end(rest.length ? rest : undefined);
  }

  /** The peer or the OS closed the socket. */
  ended(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closers]) handler(reason);
  }
}

type Data = { transport?: SocketTransport };

const handlers = {
  data(socket: Socket<Data>, chunk: Uint8Array) { socket.data.transport?.receive(chunk); },
  drain(socket: Socket<Data>) { socket.data.transport?.flush(); },
  close(socket: Socket<Data>) { socket.data.transport?.ended("peer closed"); },
  end(socket: Socket<Data>) { socket.data.transport?.ended("peer ended"); },
  error(socket: Socket<Data>, error: Error) { socket.data.transport?.ended(`socket error: ${error.message}`); },
};

/**
 * Listens on `path`. The caller has created its parent directory 0700 (`ensureRunnerSubdir(runnerDir, "sock")`). A
 * leftover socket file from an earlier process is replaced; any other kind of file at `path` is refused. The socket
 * file is chmod 0600. `close` stops listening, ends every open connection and removes the socket file.
 */
const assertSocketPathLength = (path: string, platform: NodeJS.Platform): void => {
  if (platform === "win32" && Buffer.byteLength(path, "utf8") > 107) {
    const error = new Error(`RUNNER_SOCKET_PATH_TOO_LONG ${path}`);
    error.name = "RUNNER_SOCKET_PATH_TOO_LONG";
    Object.assign(error, { code: "RUNNER_SOCKET_PATH_TOO_LONG" });
    throw error;
  }
};

export const listenUnix = (path: string, platform: NodeJS.Platform = process.platform): Listener => {
  assertSocketPathLength(path, platform);
  // A socket directly under `sock/` or the lane socket's `sock/lane.d/` (fs-safety.ts allows only those).
  const winSockEntry = platform === "win32" && (basename(dirname(path)) === RUNNER_PATHS.sock
    || (basename(dirname(path)) === "lane.d" && basename(dirname(dirname(path))) === RUNNER_PATHS.sock));
  let stale: ReturnType<typeof lstatSync> | undefined;
  // Bun on Windows can't lstat a socket whose listener died (EACCES), and binding over it fails with EADDRINUSE.
  let denied = false;
  try { stale = lstatSync(path); } catch (e) { denied = winSockEntry && (e as NodeJS.ErrnoException).code === "EACCES"; }
  if (stale || denied) {
    if (stale && !stale.isSocket() && !winSockEntry) throw new Error(`RUNNER_SOCKET_INVALID ${path} exists and is not a socket`);
    unlinkSync(path);
  }
  const subscribers = new Set<(transport: Transport) => void>();
  const open = new Set<SocketTransport>();
  const server = Bun.listen<Data>({
    unix: path,
    socket: {
      ...handlers,
      open(socket) {
        const transport = new SocketTransport(socket);
        socket.data = { transport };
        open.add(transport);
        transport.onClose(() => { open.delete(transport); });
        for (const handler of [...subscribers]) handler(transport);
      },
    },
  });
  if (platform !== "win32") chmodSync(path, 0o600);
  return {
    onConnection(handler) {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    close() {
      subscribers.clear();
      for (const transport of [...open]) transport.close("listener closed");
      server.stop(true);
      try { unlinkSync(path); } catch { /* already gone */ }
    },
  };
};

/** Connects to the hub's socket at `path`; rejects when nothing listens there. */
export const connectUnix = (path: string, platform: NodeJS.Platform = process.platform): Connector => {
  assertSocketPathLength(path, platform);
  return async () => {
    const socket = await Bun.connect<Data>({ unix: path, data: {}, socket: handlers });
    const transport = new SocketTransport(socket);
    socket.data.transport = transport;
    return transport;
  };
};
