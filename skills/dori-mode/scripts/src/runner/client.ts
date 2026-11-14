import { randomBytes } from "node:crypto";
import { SECRET_COMMAND_MAX_TIMEOUT_SEC } from "../config.ts";
import type { Clock } from "../run.ts";
import { isRejectCode, type PendingRunnerHello, type RunnerAuth, type Session } from "./auth.ts";
import { OutboxEventTooLarge, type Outbox } from "./outbox.ts";
import {
  CLOSED_LANES_PROTO, MAX_FRAME_BYTES, PROTO, SECRET_PROTO, SECRET_PUT_PROTO, decodeFrame, secretsSupported, encodeFrame, isQueryType, runnerControl, runnerEvent, ProtocolError,
  type AnyRunnerControl, type AnyRunnerEvent, type ClosedLaneBody, type AnySupervisorCommand, type AnySupervisorControl, type InventoryLane, type RejectCode, type RunnerControlBodies, type WorkspaceEntry,
  type RunnerControlType, type RunnerEventBodies, type RunnerEventType, type SupervisorCommand, type SupervisorControlBodies, type SupervisorFrame,
} from "./protocol.ts";
import type { RunnerState } from "./state.ts";
import type { Connector, Transport } from "./transport.ts";

/**
 * The runner side of the connection. One `connectOnce` is: connect, send `hello {proto, gen, label, hostId, cmdAck}`,
 * wait for `hello.ok`, raise `maxEpoch` to its epoch, then send every outbox row with `seq > eventAck` in seq order.
 * Each `ack {eventAck}` frame marks rows up to it acked in the outbox; an ack never moves the cursor backwards.
 * `run` repeats `connectOnce` with the reconnect backoff until aborted. `gen` is the state's current gen: the
 * process bumps it with `RunnerState.boot()` once before the client starts.
 *
 * With `auth` set (auth.ts), the hello carries a nonce and an ephemeral key; the client checks the supervisor's
 * `hello.challenge` signature against the pinned key and closes with `RUNNER_AUTH_FAILED` when it does not verify,
 * answers `auth.proof`, and from then on seals every frame it sends with the session MAC and drops (logging
 * `RUNNER_AUTH_FAILED`) every received frame whose MAC does not check. Before the handshake only `hello.challenge` and
 * `hello.reject` are read. `runner.rotate` is handled here: the client answers `runner.rotated` with a new key and
 * makes it current on `rotate.ok`, recording the command in the state so `cmdAck` moves past it.
 *
 * A frame over `MAX_FRAME_BYTES` is never sent. When the replay cannot send a row, the attempt ends as
 * `RUNNER_CLOSED` with `RUNNER_REPLAY_FAILED seq=<n> ...` logged and the connection closed, so the reconnect loop
 * backs off instead of holding a connection that never becomes ready.
 */

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const RECONNECT_JITTER = 0.2;
export const HEARTBEAT_MS = 15_000;
/** How long `secretRequest("secret.get")` waits for the supervisor's answer before `RUNNER_SECRET_TIMEOUT`. */
export const SECRET_TIMEOUT_MS = 30_000;
/**
 * How long `secretRequest("secret.run")` waits: the op runs on the supervisor host for up to its `timeoutSec` (at most
 * `SECRET_COMMAND_MAX_TIMEOUT_SEC`, then it is killed and answered), plus a margin for the hops and the reply. The runner
 * does not know the op's own `timeoutSec` (the supervisor's config holds it), so it waits for the longest one allowed.
 */
export const SECRET_RUN_TIMEOUT_MS = SECRET_COMMAND_MAX_TIMEOUT_SEC * 1000 + 60_000;

/** The secret frames a runner sends through `secretRequest`, and the answer type each one waits for. */
export type SecretRequestType = "secret.get" | "secret.run";
const SECRET_ANSWER = { "secret.get": "secret.value", "secret.run": "secret.run.result", "secret.put": "secret.put.result" } as const;

/** The outcome of `secretRequest`: the opened box's plaintext (JSON, never logged), or a refusal with its code. */
export type SecretReply =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

type PendingClosed = { readonly transport: Transport; readonly done: (error: Error | undefined, lanes?: readonly ClosedLaneBody[]) => void };
/** How long `closedLanes` waits for the supervisor's `lanes.closed.result`. */
export const CLOSED_LANES_TIMEOUT_MS = 60_000;

type PendingSecret = { readonly answer: string; readonly transport: Transport; readonly settle: (reply: SecretReply) => void };

/**
 * Waits one turn of the event loop. The reconnect loops await it after every attempt, so a sleep that resolves at
 * once (a fake clock) or a connection that fails without I/O can never keep the loop on microtasks alone, which would
 * starve timers, aborts and everything else on the event loop.
 */
export const yieldTurn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

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
  /** The lanes the runner sees, sent with each hello (its inventory). */
  readonly inventory?: () => readonly InventoryLane[];
  /** The repos the runner declares and detects (workspaces.ts), sent with each hello. */
  readonly workspaces?: () => { readonly workspaces: readonly WorkspaceEntry[]; readonly detected: readonly WorkspaceEntry[] };
  /** Receives commands; when unset, commands are ignored. */
  readonly onCommand?: (command: AnySupervisorCommand) => void;
  /**
   * Receives a frame that carries a `cmdSeq` but fails the schema (unknown type or field, wrong type), as parsed JSON,
   * so the runner can answer it `RUNNER_CMD_REJECTED <rule>`. With `auth` it is passed on only when its MAC checks.
   */
  readonly onInvalidCommand?: (raw: unknown) => void;
  /**
   * Receives the supervisor's read-only `q.*` queries (control frames: never recorded, never in the outbox). The runner
   * answers each with `control("q.result", ...)`; without it a query is ignored and the supervisor times out.
   */
  readonly onQuery?: (frame: AnySupervisorControl) => void;
  /** Enables the signed handshake and frame MACs. */
  readonly auth?: RunnerAuth;
  /** Receives `RUNNER_AUTH_FAILED ...` and `RUNNER_KEY_ROTATED ...` lines. */
  readonly log?: (line: string) => void;
  /** Arms the `secretRequest` timeout: calls `fire` after `ms` unless the returned cancel runs first. Default setTimeout. */
  readonly timer?: (ms: number, fire: () => void) => () => void;
};

const defaultTimer = (ms: number, fire: () => void): (() => void) => {
  const handle = setTimeout(fire, ms);
  return () => { clearTimeout(handle); };
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
  /** Set once the supervisor's challenge verified; every frame after that is sealed and checked with it. */
  private session: Session | undefined;
  private pendingHello: PendingRunnerHello | undefined;
  /** The `proto` of the current connection's `hello.ok`; undefined before it and after a close. */
  private helloProto: number | undefined;
  /** Open `secretRequest`s by rid, each bound to the connection it went out on. */
  private readonly secrets = new Map<string, PendingSecret>();
  /** Open `closedLanes` requests by rid, each bound to the connection it went out on. */
  private readonly closedAsks = new Map<string, PendingClosed>();

  constructor(private readonly config: ClientConfig, private readonly deps: ClientDeps) {}

  private head() {
    return { runner: this.config.label, gen: this.deps.state.gen(), epoch: this.deps.state.maxEpoch() };
  }

  private sendFrame(frame: Parameters<typeof encodeFrame>[0]): void {
    const line = encodeFrame(this.session ? this.session.seal(frame) : frame);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_FRAME_BYTES) throw new Error(`${frame.type} frame is ${bytes} bytes, over ${MAX_FRAME_BYTES}`);
    this.transport?.send(line);
  }

  private log(line: string): void {
    this.deps.log?.(line);
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
    this.session = undefined;
    this.helloProto = undefined;
    this.pendingHello = this.deps.auth?.startHello();
    const outcome = new Promise<ConnectOutcome>((resolve) => { this.settle = resolve; });
    let markClosed: () => void = () => {};
    this.closedWaiter = new Promise<void>((resolve) => { markClosed = resolve; });
    const offLine = transport.onLine((line) => { if (this.transport === transport) this.handleLine(line); });
    transport.onClose((reason) => {
      offLine();
      if (this.transport === transport) {
        this.transport = undefined;
        this.ready = false;
        this.session = undefined;
        this.helloProto = undefined;
        this.pendingHello = undefined;
        this.finish({ ok: false, code: isRejectCode(reason) ? reason : "RUNNER_CLOSED", detail: reason });
      }
      for (const [rid, pending] of [...this.secrets]) {
        if (pending.transport !== transport) continue;
        this.secrets.delete(rid);
        pending.settle({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "connection lost" });
      }
      for (const pending of [...this.closedAsks.values()]) if (pending.transport === transport) pending.done(new Error("connection lost"));
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
      ...(this.deps.workspaces ? this.deps.workspaces() : {}),
      ...(this.pendingHello ? { nonce: this.pendingHello.nonce, dh: this.pendingHello.dh } : {}),
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
      await yieldTurn();
      if (signal.aborted) break;
      await this.deps.clock.sleep(backoffMs(Math.max(0, attempt - 1), this.deps.random));
    }
  }

  /**
   * Appends an event to the outbox and sends the stored row at once when connected; returns its seq. An event the
   * outbox refuses as too large is logged `RUNNER_EVENT_DROPPED` and returns undefined. A failed live send leaves the
   * row for the replay after the next hello.
   */
  publish<T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]): number | undefined {
    let row;
    try {
      row = this.deps.outbox.append(type, body);
    } catch (error) {
      if (type === "lane.report" && (body as RunnerEventBodies["lane.report"]).files !== undefined) throw error;
      if (!(error instanceof OutboxEventTooLarge)) throw error;
      this.log(`RUNNER_EVENT_DROPPED type=${type} ${error.message}`);
      return undefined;
    }
    if (this.ready && this.transport?.open) {
      try {
        this.sendFrame(runnerEvent(this.head(), row.seq, row.type, row.body) as AnyRunnerEvent);
      } catch (error) {
        this.log(`RUNNER_SEND_FAILED seq=${row.seq} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return row.seq;
  }

  /**
   * Sends a runner control frame (a `q.result`) on the live connection, sealed like every frame; never through the
   * outbox. Returns false, sending nothing, when not connected: a query answer has no use on a later connection.
   */
  control<T extends RunnerControlType>(type: T, body: RunnerControlBodies[T]): boolean {
    if (!this.connected) return false;
    this.sendFrame(runnerControl(this.head(), type, body) as AnyRunnerControl);
    return true;
  }

  /**
   * Asks the supervisor over the authenticated link (`secret.get` or `secret.run`, a sealed control frame with a fresh
   * 32-hex rid) and resolves with the opened `s2r` box of the matching answer, or a refusal: `RUNNER_SECRET_FAILED`
   * when not connected, on a lost connection or a box that does not open; `RUNNER_SECRET_UNSUPPORTED` without an auth
   * session; `RUNNER_SECRET_OUTDATED` when the supervisor's `hello.ok` proto is below `SECRET_PROTO`;
   * `RUNNER_SECRET_TIMEOUT` after `SECRET_TIMEOUT_MS` (`SECRET_RUN_TIMEOUT_MS` for `secret.run`); the supervisor's own code otherwise. Never rejects and never
   * logs a body.
   */
  secretRequest<T extends SecretRequestType>(type: T, body: Omit<RunnerControlBodies[T], "rid">): Promise<SecretReply> {
    return this.secretAsk(type, (rid) => ({ ...body, rid }) as RunnerControlBodies[T]);
  }

  /**
   * Has the supervisor store `value` under `name` for lane `key` (`secret.put`, proto 8): the value goes only inside a
   * box sealed `r2s` under aad `{runner, gen, epoch, type: "secret.put", rid}`. Resolves like `secretRequest`, with
   * plaintext JSON `{created, backend}` on success; `RUNNER_SECRET_OUTDATED` when the supervisor is below `SECRET_PUT_PROTO`.
   */
  secretPut(body: { readonly key: string; readonly name: string; readonly value: string; readonly repo?: string }): Promise<SecretReply> {
    const { value, ...rest } = body;
    return this.secretAsk("secret.put", (rid, session, head) => ({
      ...rest, rid, sealed: session.sealSecret("r2s", { ...head, type: "secret.put", rid }, value),
    }), SECRET_PUT_PROTO);
  }

  /**
   * The lanes of this runner the supervisor's registry records as closed (`lanes.closed`, proto 9), for the cleanup
   * sweep. Rejects when not connected, when the supervisor is below CLOSED_LANES_PROTO, on its refusal, a lost
   * connection or no answer within CLOSED_LANES_TIMEOUT_MS.
   */
  closedLanes(): Promise<readonly ClosedLaneBody[]> {
    const transport = this.transport;
    if (!this.connected || !transport) return Promise.reject(new Error("not connected to the supervisor"));
    if ((this.helloProto ?? 0) < CLOSED_LANES_PROTO) return Promise.reject(new Error(`supervisor speaks proto ${this.helloProto}; closed lanes need proto ${CLOSED_LANES_PROTO}`));
    const rid = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      let cancel: () => void = () => {};
      const done: PendingClosed["done"] = (error, lanes) => {
        if (this.closedAsks.get(rid)?.done !== done) return;
        this.closedAsks.delete(rid);
        cancel();
        if (error) reject(error); else resolve(lanes ?? []);
      };
      this.closedAsks.set(rid, { transport, done });
      cancel = (this.deps.timer ?? defaultTimer)(CLOSED_LANES_TIMEOUT_MS, () => { done(new Error(`no answer to lanes.closed within ${CLOSED_LANES_TIMEOUT_MS / 1000}s`)); });
      try { this.sendFrame(runnerControl(this.head(), "lanes.closed", { rid }) as AnyRunnerControl); } catch (e) { done(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  private secretAsk<T extends SecretRequestType | "secret.put">(
    type: T, build: (rid: string, session: Session, head: ReturnType<RunnerClient["head"]>) => RunnerControlBodies[T], needProto = SECRET_PROTO,
  ): Promise<SecretReply> {
    const transport = this.transport;
    if (!this.connected || !transport) return Promise.resolve({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "not connected" });
    const session = this.session;
    if (!session) return Promise.resolve({ ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "unauthenticated link" });
    if (!secretsSupported(this.helloProto) || (this.helloProto as number) < needProto) {
      return Promise.resolve({ ok: false, code: "RUNNER_SECRET_OUTDATED", detail: `supervisor speaks proto ${this.helloProto}; ${type === "secret.put" ? "secret put needs" : "secrets need"} proto ${needProto}` });
    }
    const rid = randomBytes(16).toString("hex");
    const timeoutMs = type === "secret.run" ? SECRET_RUN_TIMEOUT_MS : SECRET_TIMEOUT_MS;
    return new Promise<SecretReply>((resolve) => {
      let cancel: () => void = () => {};
      const settle = (reply: SecretReply): void => { cancel(); resolve(reply); };
      this.secrets.set(rid, { answer: SECRET_ANSWER[type], transport, settle });
      cancel = (this.deps.timer ?? defaultTimer)(timeoutMs, () => {
        if (this.secrets.get(rid)?.settle !== settle) return;
        this.secrets.delete(rid);
        resolve({ ok: false, code: "RUNNER_SECRET_TIMEOUT", detail: `no answer to ${type} within ${timeoutMs / 1000}s` });
      });
      try {
        const head = this.head();
        this.sendFrame(runnerControl(head, type, build(rid, session, head)) as AnyRunnerControl);
      } catch (error) {
        this.secrets.delete(rid);
        settle({ ok: false, code: "RUNNER_SECRET_FAILED", detail: `${type} not sent: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  /** Settles the open request an (already MAC-checked) secret answer answers; others are dropped. */
  private secretAnswer(frame: AnySupervisorControl & { readonly type: "secret.value" | "secret.run.result" | "secret.put.result" }): void {
    const body = frame.body;
    const pending = this.secrets.get(body.rid);
    if (!pending || pending.answer !== frame.type || !this.session) return;
    this.secrets.delete(body.rid);
    if (!body.ok) {
      pending.settle({ ok: false, code: body.code ?? "RUNNER_SECRET_FAILED", detail: body.detail ?? "refused by the supervisor" });
      return;
    }
    if (frame.type === "secret.put.result") {
      const put = frame.body as SupervisorControlBodies["secret.put.result"];
      pending.settle({ ok: true, plaintext: JSON.stringify({ created: put.created === true, backend: put.backend ?? "" }) });
      return;
    }
    const aad = { runner: frame.runner, gen: frame.gen, epoch: frame.epoch, type: frame.type, rid: body.rid };
    const sealed = (body as SupervisorControlBodies["secret.value"]).sealed;
    const plaintext = sealed ? this.session.openSecret("s2r", aad, sealed) : undefined;
    pending.settle(plaintext === undefined
      ? { ok: false, code: "RUNNER_SECRET_FAILED", detail: "sealed reply did not open" }
      : { ok: true, plaintext });
  }

  /**
   * Closes the live connection so `run` reconnects at once with a fresh hello (new workspaces after a config reload).
   * Nothing is lost: unacked events replay from the outbox and commands are acked by `cmdAck`, as after any reconnect.
   */
  rehello(): void {
    this.transport?.close("rehello");
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
      if (!(error instanceof ProtocolError)) throw error;
      this.invalidCommand(line);
      return;
    }
    if (this.deps.auth) {
      if (!this.session) {
        if (frame.type === "hello.challenge" && this.pendingHello) {
          this.answerChallenge(frame.body as SupervisorControlBodies["hello.challenge"]);
          return;
        }
        if (frame.type !== "hello.reject") {
          this.log(`RUNNER_AUTH_FAILED frame dropped: ${frame.type} before the handshake`);
          return;
        }
      } else if (!this.session.check(frame)) {
        this.log(`RUNNER_AUTH_FAILED frame dropped: bad mac type=${frame.type}`);
        return;
      }
    }
    if ("cmdSeq" in frame) {
      if (frame.type === "runner.rotate" && this.deps.auth && this.session) this.rotate(frame as SupervisorCommand<"runner.rotate">);
      else this.deps.onCommand?.(frame);
      return;
    }
    switch (frame.type) {
      case "hello.ok": {
        this.deps.state.observeEpoch(frame.body.epoch);
        this.cursor = frame.body.eventAck;
        this.deps.outbox.ack(this.cursor);
        let seq = this.cursor;
        try {
          for (const row of this.deps.outbox.unacked(this.cursor)) {
            seq = row.seq;
            this.sendFrame(runnerEvent(this.head(), row.seq, row.type, row.body) as AnyRunnerEvent);
            this.replayed += 1;
          }
        } catch (error) {
          const detail = `RUNNER_REPLAY_FAILED seq=${seq} ${error instanceof Error ? error.message : String(error)}`;
          this.log(detail);
          this.finish({ ok: false, code: "RUNNER_CLOSED", detail });
          this.transport?.close("RUNNER_REPLAY_FAILED");
          return;
        }
        this.helloProto = frame.body.proto;
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
      case "rotate.ok": {
        const record = this.deps.state.command(frame.body.cmdId);
        if (!this.deps.auth || record?.type !== "runner.rotate" || record.state !== "intent") return;
        this.deps.auth.confirmRotate();
        this.deps.state.recordResult(frame.body.cmdId, "verified", "runner key rotated");
        this.log(`RUNNER_KEY_ROTATED cmdId=${frame.body.cmdId}`);
        return;
      }
      case "secret.value":
      case "secret.run.result":
      case "secret.put.result":
        this.secretAnswer(frame);
        return;
      case "lanes.closed.result": {
        const body = frame.body as SupervisorControlBodies["lanes.closed.result"];
        const pending = this.closedAsks.get(body.rid);
        if (!pending) return;
        if (body.ok) pending.done(undefined, body.lanes ?? []);
        else pending.done(new Error(body.detail ?? "refused by the supervisor"));
        return;
      }
      default:
        if (isQueryType(frame.type)) {
          // A query is answered only on an admitted connection.
          if (this.ready) this.deps.onQuery?.(frame);
          return;
        }
        // hello.challenge after the handshake and enroll.ok have no meaning on an open connection.
        return;
    }
  }

  private invalidCommand(line: string): void {
    if (!this.deps.onInvalidCommand) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    if (typeof raw !== "object" || raw === null || !("cmdSeq" in raw)) return;
    if (this.deps.auth && !(this.session && this.session.check(raw as SupervisorFrame))) {
      this.log(`RUNNER_AUTH_FAILED frame dropped: bad mac on an invalid command`);
      return;
    }
    this.deps.onInvalidCommand(raw);
  }

  private answerChallenge(challenge: SupervisorControlBodies["hello.challenge"]): void {
    const auth = this.deps.auth as RunnerAuth;
    const pending = this.pendingHello as PendingRunnerHello;
    this.pendingHello = undefined;
    const answer = auth.answerChallenge(pending, { label: this.config.label, hostId: this.config.hostId, gen: this.deps.state.gen() }, challenge);
    if (!answer.ok) {
      this.log(`RUNNER_AUTH_FAILED ${answer.detail}`);
      this.finish({ ok: false, code: "RUNNER_AUTH_FAILED", detail: answer.detail });
      this.transport?.close("RUNNER_AUTH_FAILED");
      return;
    }
    // The proof is the last unsealed frame; the session takes over right after it.
    this.sendFrame(runnerControl(this.head(), "auth.proof", { sig: answer.sig }));
    this.session = answer.session;
  }

  private rotate(command: SupervisorCommand<"runner.rotate">): void {
    const auth = this.deps.auth as RunnerAuth;
    const intent = this.deps.state.recordIntent({ cmdId: command.body.cmdId, cmdSeq: command.cmdSeq, type: "runner.rotate", epoch: command.epoch });
    if (!intent.fresh && intent.existing.state !== "intent") return;
    const answer = auth.rotateAnswer(this.session as Session, this.config.label, command.body.cmdId);
    this.sendFrame(runnerControl(this.head(), "runner.rotated", answer));
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
