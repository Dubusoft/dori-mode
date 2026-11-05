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

/** Opens one connection to the supervisor (runner side). Rejects when the peer cannot be reached. */
export type Connector = () => Promise<Transport>;

/** Accepts connections (hub side). */
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
