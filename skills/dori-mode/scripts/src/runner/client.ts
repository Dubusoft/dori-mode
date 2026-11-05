import type { Clock } from "../run.ts";
import type { Outbox } from "./outbox.ts";
import {
  PROTO, decodeFrame, encodeFrame, runnerControl, runnerEvent, ProtocolError,
  type AnyRunnerEvent, type AnySupervisorCommand, type InventoryLane, type RejectCode, type RunnerControlBodies, type RunnerEventBodies, type RunnerEventType,
  type SupervisorFrame,
} from "./protocol.ts";
import type { RunnerState } from "./state.ts";
import type { Connector, Transport } from "./transport.ts";

/**
 * The runner side of the connection. One `connectOnce` is: connect, send `hello {proto, gen, label, hostId, cmdAck}`,
 * wait for `hello.ok`, raise `maxEpoch` to its epoch, then send every outbox row with `seq > eventAck` in seq order.
 * Each `ack {eventAck}` frame marks rows up to it acked in the outbox; an ack never moves the cursor backwards.
 * `run` repeats `connectOnce` with the reconnect backoff until aborted. `gen` is the state's current gen: the
 * process bumps it with `RunnerState.boot()` once before the client starts.
 */

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const RECONNECT_JITTER = 0.2;
export const HEARTBEAT_MS = 15_000;

export type ClientConfig = {
  readonly label: string;
  readonly hostId: string;
  readonly version?: string;
  /** Default `PROTO`. */
  readonly proto?: number;
};

export type ClientDeps = {
  readonly connect: Connector;
  readonly outbox: Outbox;
  readonly state: RunnerState;
  /** `sleep` paces reconnects; the fake clock makes it resolve at once. */
  readonly clock: Clock;
  /** Jitter source in [0, 1); default Math.random. */
  readonly random?: () => number;
  /** The lanes the runner sees, sent with each hello (shadow inventory). */
  readonly inventory?: () => readonly InventoryLane[];
  /** Receives commands; a shadow runner leaves it unset and commands are ignored. */
  readonly onCommand?: (command: AnySupervisorCommand) => void;
};

export type ConnectOutcome =
  | { readonly ok: true; readonly eventAck: number; readonly replayed: number }
  | { readonly ok: false; readonly code: RejectCode | "RUNNER_UNREACHABLE" | "RUNNER_CLOSED"; readonly detail: string };

export class RunnerClient {
  private transport: Transport | undefined;
  private cursor = 0;
  /** True once the replay after `hello.ok` has been sent; live sends wait for it so the wire stays in seq order. */
  private ready = false;
  private settle: ((outcome: ConnectOutcome) => void) | undefined;
  private replayed = 0;
  private closedWaiter: Promise<void> = Promise.resolve();

  constructor(private readonly config: ClientConfig, private readonly deps: ClientDeps) {}

  private head() {
    return { runner: this.config.label, gen: this.deps.state.gen(), epoch: this.deps.state.maxEpoch() };
  }

  private sendFrame(frame: Parameters<typeof encodeFrame>[0]): void {
    this.transport?.send(encodeFrame(frame));
  }

  /** One connection attempt through to the end of the replay; the connection stays open afterwards. */
  async connectOnce(): Promise<ConnectOutcome> {
    let transport: Transport;
    try {
      transport = await this.deps.connect();
    } catch (error) {
      return { ok: false, code: "RUNNER_UNREACHABLE", detail: error instanceof Error ? error.message : String(error) };
    }
    this.transport = transport;
    this.ready = false;
    this.replayed = 0;
    const outcome = new Promise<ConnectOutcome>((resolve) => { this.settle = resolve; });
    let markClosed: () => void = () => {};
    this.closedWaiter = new Promise<void>((resolve) => { markClosed = resolve; });
    const offLine = transport.onLine((line) => { if (this.transport === transport) this.handleLine(line); });
    transport.onClose((reason) => {
      offLine();
      if (this.transport === transport) {
        this.transport = undefined;
        this.ready = false;
        this.finish({ ok: false, code: "RUNNER_CLOSED", detail: reason });
      }
      markClosed();
    });
    const hello: RunnerControlBodies["hello"] = {
      proto: this.config.proto ?? PROTO,
      gen: this.deps.state.gen(),
      label: this.config.label,
      hostId: this.config.hostId,
      cmdAck: this.deps.state.cmdAck(),
      ...(this.config.version !== undefined ? { version: this.config.version } : {}),
      ...(this.deps.inventory ? { inventory: this.deps.inventory() } : {}),
    };
    transport.send(encodeFrame(runnerControl(this.head(), "hello", hello)));
    return outcome;
  }

  private finish(outcome: ConnectOutcome): void {
    const settle = this.settle;
    this.settle = undefined;
    settle?.(outcome);
  }

  /** Connects, and reconnects with `backoffMs` after every failure or close, until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let attempt = 0;
    while (!signal.aborted) {
      const outcome = await this.connectOnce();
      if (outcome.ok) {
        attempt = 0;
        await Promise.race([this.closedWaiter, aborted]);
        if (signal.aborted) this.transport?.close("aborted");
      } else {
        this.transport?.close(outcome.code);
        attempt += 1;
      }
      if (signal.aborted) break;
      await this.deps.clock.sleep(backoffMs(Math.max(0, attempt - 1), this.deps.random));
    }
  }

  /** Appends an event to the outbox and sends it at once when connected; returns its seq. */
  publish<T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]): number {
    const row = this.deps.outbox.append(type, body);
    if (this.ready && this.transport?.open) this.sendFrame(runnerEvent(this.head(), row.seq, type, body) as AnyRunnerEvent);
    return row.seq;
  }

  /** Sends a heartbeat with the outbox figures when connected (the serve loop calls it every `HEARTBEAT_MS`). */
  heartbeat(): void {
    if (!this.connected) return;
    const stats = this.deps.outbox.stats();
    const outbox = { unacked: stats.unacked, oldestAgeMs: stats.oldestUnackedAt === undefined ? 0 : Math.max(0, this.deps.clock.now() - stats.oldestUnackedAt) };
    this.sendFrame(runnerControl(this.head(), "heartbeat", { outbox }));
  }

  /** Handles one received line: `hello.ok`, `hello.reject`, `ack`, `cmd.status` or a command. */
  handleLine(line: string): void {
    let frame: SupervisorFrame;
    try {
      frame = decodeFrame(line, "supervisor");
    } catch (error) {
      if (error instanceof ProtocolError) return;
      throw error;
    }
    if ("cmdSeq" in frame) {
      this.deps.onCommand?.(frame);
      return;
    }
    switch (frame.type) {
      case "hello.ok": {
        this.deps.state.observeEpoch(frame.body.epoch);
        this.cursor = frame.body.eventAck;
        this.deps.outbox.ack(this.cursor);
        for (const row of this.deps.outbox.unacked(this.cursor)) {
          this.sendFrame(runnerEvent(this.head(), row.seq, row.type, row.body) as AnyRunnerEvent);
          this.replayed += 1;
        }
        this.ready = true;
        this.finish({ ok: true, eventAck: this.cursor, replayed: this.replayed });
        return;
      }
      case "hello.reject":
        this.finish({ ok: false, code: frame.body.code, detail: frame.body.detail });
        this.transport?.close(frame.body.code);
        return;
      case "ack":
        if (frame.body.eventAck > this.cursor) {
          this.cursor = frame.body.eventAck;
          this.deps.outbox.ack(this.cursor);
        }
        return;
      case "cmd.status": {
        const record = this.deps.state.command(frame.body.cmdId);
        this.sendFrame(runnerControl(this.head(), "cmd.status.result", {
          cmdId: frame.body.cmdId,
          state: record ? record.state : "unknown",
        }));
        return;
      }
    }
  }

  /** The last eventAck the supervisor sent (0 before the first hello). */
  get eventAck(): number {
    return this.cursor;
  }

  get connected(): boolean {
    return this.ready && this.transport?.open === true;
  }
}

/** Reconnect delay before attempt `attempt` (0-based): 1s doubled per attempt, capped at 60s, then +-20% jitter. */
export const backoffMs = (attempt: number, random: () => number = Math.random): number => {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 30));
  return Math.round(base * (1 + (random() * 2 - 1) * RECONNECT_JITTER));
};
