/**
 * The line transport the runner client and the hub share. It moves whole frame lines (protocol.ts `encodeFrame`
 * output) and knows nothing of their content.
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

