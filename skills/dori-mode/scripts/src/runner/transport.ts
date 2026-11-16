/**
 * The line transport the runner client and the hub share. It moves whole frame lines (protocol.ts `encodeFrame`
 * output) and knows nothing of their content. The unix socket implementation comes with the serve wiring; tests use
 * `memoryPair`, which delivers nothing until `pump()` so a test decides exactly when lines arrive.
 */

export interface Transport {
  /** Queues one line for the peer; throws when the transport is closed. */
  send(line: string): void;
  /** Subscribes to received lines; returns the unsubscribe function. */
  onLine(handler: (line: string) => void): () => void;
  /** Subscribes to the close of either end; returns the unsubscribe function. */
  onClose(handler: (reason: string) => void): () => void;
  close(reason?: string): void;
  readonly open: boolean;
}

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const RECONNECT_JITTER = 0.2;

/**
 * Reconnect delay before attempt `attempt` (0-based): 1s doubled per attempt, capped at 60s, then +-20% jitter from
 * `random()` (a value in [0, 1)). Pure: pass a seeded or fixed `random` in tests.
 */
export const backoffMs = (attempt: number, random: () => number = Math.random): number => {
  const exponent = Math.max(0, Math.min(Math.floor(attempt), 30));
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent);
  return Math.round(base * (1 + (random() * 2 - 1) * RECONNECT_JITTER));
};

/**
 * The subscriber and held-line lifecycle of a network `Transport`. Lines delivered before the first `onLine`
 * subscriber are held for it; `ended` marks the link closed and runs every close handler once. Subclasses add the
 * wire: `send`, `close` and whatever feeds `deliver`.
 */
export abstract class LineTransport implements Transport {
  private readonly lines = new Set<(line: string) => void>();
  private readonly closers = new Set<(reason: string) => void>();
  private readonly held: string[] = [];
  protected closed = false;

  get open(): boolean {
    return !this.closed;
  }

  abstract send(line: string): void;
  abstract close(reason?: string): void;

  protected deliver(line: string): void {
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

  /** The peer or the OS closed the link. */
  ended(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closers]) handler(reason);
  }
}

/** Supplies one connection to the supervisor (runner side), whether dialed locally or accepted from the network. */
export type Connector = () => Promise<Transport>;

/** Supplies connections to the hub, whether accepted locally or dialed to worker endpoints. */
export interface Listener {
  onConnection(handler: (transport: Transport) => void): () => void;
  close(): void;
}

export type Direction = "to-supervisor" | "to-runner";

export type MemoryPairOptions = {
  /** Drops a line instead of delivering it (a lossy link); called once per line at `pump()`. */
  readonly drop?: (line: string, direction: Direction) => boolean;
};

export type MemoryPair = {
  readonly runner: Transport;
  readonly supervisor: Transport;
  /** Delivers every queued line in both directions, in send order, including lines sent by handlers during the pump; returns how many were delivered. */
  pump(): number;
  /** Closes both ends as a broken link would: queued lines are lost and both onClose handlers run. */
  sever(reason?: string): void;
  /** Lines queued and not yet delivered. */
  queued(): number;
};

type Queued = { readonly line: string; readonly direction: Direction };

/** An in-memory connected pair. */
export const memoryPair = (options: MemoryPairOptions = {}): MemoryPair => {
  const queue: Queued[] = [];
  let open = true;
  const lineHandlers: Record<"runner" | "supervisor", Set<(line: string) => void>> = { runner: new Set(), supervisor: new Set() };
  const closeHandlers: Record<"runner" | "supervisor", Set<(reason: string) => void>> = { runner: new Set(), supervisor: new Set() };

  const shutdown = (reason: string): void => {
    if (!open) return;
    open = false;
    queue.length = 0;
    for (const side of ["runner", "supervisor"] as const) for (const handler of [...closeHandlers[side]]) handler(reason);
  };

  const end = (side: "runner" | "supervisor"): Transport => ({
    send(line) {
      if (!open) throw new Error("transport closed");
      queue.push({ line, direction: side === "runner" ? "to-supervisor" : "to-runner" });
    },
    onLine(handler) {
      lineHandlers[side].add(handler);
      return () => { lineHandlers[side].delete(handler); };
    },
    onClose(handler) {
      closeHandlers[side].add(handler);
      return () => { closeHandlers[side].delete(handler); };
    },
    close(reason = "closed") { shutdown(reason); },
    get open() { return open; },
  });

  return {
    runner: end("runner"),
    supervisor: end("supervisor"),
    pump() {
      let delivered = 0;
      while (open && queue.length > 0) {
        const next = queue.shift() as Queued;
        if (options.drop?.(next.line, next.direction)) continue;
        const target = next.direction === "to-supervisor" ? "supervisor" : "runner";
        delivered += 1;
        for (const handler of [...lineHandlers[target]]) handler(next.line);
      }
      return delivered;
    },
    sever(reason = "severed") { shutdown(reason); },
    queued: () => queue.length,
  };
};

/**
 * An in-memory listener and a connector for it: each `connect()` creates a new `memoryPair`, hands its supervisor end
 * to the listener and resolves with the runner end. `pairs` lists every pair created, newest last, so a test can pump
 * or sever it.
 */
export const memoryNetwork = (options: MemoryPairOptions = {}): { readonly listener: Listener; readonly connect: Connector; readonly pairs: readonly MemoryPair[] } => {
  const pairs: MemoryPair[] = [];
  const handlers = new Set<(transport: Transport) => void>();
  let closed = false;
  const listener: Listener = {
    onConnection(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    close() {
      closed = true;
      handlers.clear();
    },
  };
  const connect: Connector = async () => {
    if (closed) throw new Error("listener closed");
    const pair = memoryPair(options);
    pairs.push(pair);
    for (const handler of [...handlers]) handler(pair.supervisor);
    return pair.runner;
  };
  return { listener, connect, pairs };
};
