import type {
  AnyRunnerEvent, CommandResults, CommandStatusState, DurableCommandType, QueryBodies, QueryResults, QueryType, RunnerControl, SupervisorCommandBodies,
} from "./protocol.ts";
import type { RunnerAccept } from "./serve.ts";
import { checkLaneFilesBody } from "../lane-files.ts";

/**
 * The supervisor's awaitable runner calls (design D6): durable effects await their `cmd.result` by `cmdId`, read-only
 * queries await their `q.result` by `qid`. Both fail closed with `RunnerUnavailable` when the runner has no admitted
 * connection, speaks a protocol too old for the type, or does not answer in time. This module holds the types,
 * timeouts and id shapes; the `RunnerCalls` implementation over the hub lives next to them.
 */

/**
 * `outdated`: the label's hello proto is below what the command or query needs (`NEEDS_PROTO`). `lost`: the CLI relay
 * closed after the request was sent, so the command may have reached the runner.
 */
export type CallWhy = "disconnected" | "timeout" | "outdated" | "lost";

export class RunnerUnavailable extends Error {
  readonly code = "RUNNER_UNAVAILABLE";
  constructor(readonly label: string, readonly why: CallWhy, detail: string) {
    super(`RUNNER_UNAVAILABLE runner=${label} ${why}: ${detail}`);
    this.name = "RunnerUnavailable";
  }
}

export type CallOptions = { readonly cmdId?: string; readonly timeoutMs?: number };

/** A `failed` or `ambiguous` result is data for the caller (its read-backs decide); only `verified` carries `result`. */
export type CallResult<R> =
  | { readonly cmdId: string; readonly state: "verified"; readonly detail: string; readonly result: R }
  | { readonly cmdId: string; readonly state: "failed" | "ambiguous"; readonly detail: string; readonly result?: undefined };

/** The one way supervisor code talks to a runner. Both methods throw RunnerUnavailable at once when `label` has no admitted connection (fail closed), and on timeout. */
export type RunnerCall = {
  call<T extends DurableCommandType>(
    label: string, type: T, body: Omit<SupervisorCommandBodies[T], "cmdId">, opts?: CallOptions,
  ): Promise<CallResult<CommandResults[T]>>;
  query<T extends QueryType>(label: string, type: T, body: Omit<QueryBodies[T], "qid">, opts?: { readonly timeoutMs?: number }): Promise<QueryResults[T]>;
  connected(label: string): boolean;
};

export const CALL_TIMEOUT_MS = 30_000;
export const QUERY_TIMEOUT_MS = 15_000;
/** Per-type call timeouts; a type not listed waits `CALL_TIMEOUT_MS`. */
export const COMMAND_TIMEOUTS: Partial<Record<DurableCommandType, number>> = {
  "lane.start": 90_000, "lane.recover": 90_000, "lane.close": 60_000, "lane.git": 60_000, "lane.pause": 30_000, "host.herdr": 90_000,
};

/** The lowest proto that carries each type; anything not listed is proto 2 (today's commands). */
export const NEEDS_PROTO: Partial<Record<DurableCommandType | QueryType, number>> = {
  "lane.start": 5, "lane.recover": 5, "q.lane.files": 5,
  "lane.adopt": 3, "lane.pause": 3, "lane.resume": 3, "lane.notify": 3, "lane.git": 3,
  "q.panes": 3, "q.screen": 3, "q.process": 3, "q.stat": 3, "q.lane.inspect": 3, "q.machine.observe": 3,
  "host.herdr": 4,
  "wait.check": 5, "job.run": 5,
};
export const isFileOperation = (type: string): type is "lane.start" | "lane.recover" | "q.lane.files" =>
  type === "lane.start" || type === "lane.recover" || type === "q.lane.files";
export const fileCapabilityDetail = (proto: number | undefined): string => proto === undefined
  ? "lane files require proto 5 (runner proto unknown); run dori runner update, wait for its hello, and retry"
  : `lane files require proto 5 (runner proto ${proto}); run dori runner update`;

/**
 * A new cmdId. `lane-start:<key>:<ms>` and `recover:<key>:<ms>` keep the shapes lanes-hub.ts parses; every other type
 * is `<type>:<key|->:<ms>:<n>`, where `n` tells apart two calls of one type for one key in the same millisecond.
 */
export const newCmdId = (type: DurableCommandType, key: string | undefined, now: number, n: number): string => {
  const k = key ?? "-";
  if (type === "lane.start") return `lane-start:${k}:${now}`;
  if (type === "lane.recover") return `recover:${k}:${now}`;
  return `${type}:${k}:${now}:${n}`;
};

/** A query the runner answered with `ok: false` (the facade maps it to `LaneOpsError("LANE_OP_FAILED")`). */
export class QueryFailed extends Error {
  readonly code = "LANE_OP_FAILED";
  constructor(readonly label: string, detail: string) {
    super(detail);
    this.name = "QueryFailed";
  }
}

export type Timers = { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The durable record of commands sent and not yet answered (hub.ts `runner_attempts`), so a supervisor back from a
 * restart can read them back (durability.ts `settleAttempted`). Only the types in `ATTEMPT_TYPES` are recorded.
 */
export type AttemptLog = {
  readonly record: (label: string, type: DurableCommandType, cmdId: string, key: string | undefined, body: object) => void;
  readonly settle: (label: string, cmdId: string) => void;
};

/** The commands whose loss a restart has to read back: a `lane.start` with no answer leaves a lane with no pane. */
export const ATTEMPT_TYPES: ReadonlySet<DurableCommandType> = new Set(["lane.start"]);

export const STATUS_TIMEOUT_MS = QUERY_TIMEOUT_MS;

export type RunnerCallsDeps = {
  readonly accept: Pick<RunnerAccept, "command" | "control" | "connected"> & Partial<Pick<RunnerAccept, "status">>;
  readonly attempts?: AttemptLog;
  /** The proto the label said hello with (hub row), undefined when unknown. */
  readonly proto: (label: string) => number | undefined;
  readonly now: () => number;
  readonly timers: Timers;
  readonly log: (line: string) => void;
};

type Waiter<V> = { readonly label: string; readonly resolve: (value: V) => void; readonly reject: (error: Error) => void; timer: unknown };
type CmdResultBody = { readonly cmdId: string; readonly state: "verified" | "failed" | "ambiguous"; readonly detail: string; readonly result?: unknown };
type QueryAnswer = RunnerControl<"q.result">["body"];

const LATE_REMEMBERED = 1000;

export class RunnerCalls implements RunnerCall {
  private readonly cmdWaiters = new Map<string, Set<Waiter<CmdResultBody>>>();
  private readonly queryWaiters = new Map<string, Waiter<QueryAnswer>>();
  /** `cmd.status` waiters by `<label> <cmdId>`. */
  private readonly statusWaiters = new Map<string, Set<Waiter<CommandStatusState>>>();
  private readonly late = new Set<string>();
  private n = 0;

  constructor(private readonly deps: RunnerCallsDeps) {}

  connected(label: string): boolean {
    return this.deps.accept.connected(label);
  }

  private gate(label: string, type: DurableCommandType | QueryType): void {
    if (!this.deps.accept.connected(label)) throw new RunnerUnavailable(label, "disconnected", `no admitted connection for ${type}`);
    const need = NEEDS_PROTO[type];
    const proto = this.deps.proto(label);
    if (isFileOperation(type) && (proto === undefined || proto < 5)) throw new RunnerUnavailable(label, "outdated", fileCapabilityDetail(proto));
    if (need !== undefined && proto !== undefined && proto < need) {
      throw new RunnerUnavailable(label, "outdated", `${type} needs runner proto ${need}, the runner speaks ${proto}`);
    }
  }

  async call<T extends DurableCommandType>(
    label: string, type: T, body: Omit<SupervisorCommandBodies[T], "cmdId">, opts: CallOptions = {},
  ): Promise<CallResult<CommandResults[T]>> {
    this.gate(label, type);
    this.n += 1;
    const cmdId = opts.cmdId ?? newCmdId(type, (body as { key?: string }).key, this.deps.now(), this.n);
    if (type === "lane.start" || type === "lane.recover") checkLaneFilesBody((body as { key?: string }).key!, { ...body, cmdId });
    const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUTS[type] ?? CALL_TIMEOUT_MS;
    const answer = new Promise<CmdResultBody>((resolve, reject) => {
      const waiter: Waiter<CmdResultBody> = { label, resolve, reject, timer: undefined };
      const set = this.cmdWaiters.get(cmdId) ?? new Set<Waiter<CmdResultBody>>();
      set.add(waiter);
      this.cmdWaiters.set(cmdId, set);
      waiter.timer = this.deps.timers.set(() => {
        this.dropCmdWaiter(cmdId, waiter);
        reject(new RunnerUnavailable(label, "timeout", `no cmd.result for ${type} ${cmdId} within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    const key = (body as { key?: string }).key;
    const recorded = ATTEMPT_TYPES.has(type) && this.deps.attempts !== undefined;
    if (recorded) this.deps.attempts?.record(label, type, cmdId, key, body);
    let sent;
    try { sent = this.deps.accept.command(label, type, { ...body, cmdId } as SupervisorCommandBodies[T]); }
    catch (e) {
      if (recorded) this.deps.attempts?.settle(label, cmdId);
      this.rejectCmd(cmdId, label, e instanceof Error ? e : new Error(String(e)));
      return answer.then(() => { throw e; });
    }
    if (sent === undefined) {
      if (recorded) this.deps.attempts?.settle(label, cmdId);
      this.rejectCmd(cmdId, label, new RunnerUnavailable(label, "disconnected", `${type} was not sent`));
      return answer.then(() => { throw new RunnerUnavailable(label, "disconnected", `${type} was not sent`); });
    }
    const outcome = await answer;
    if (outcome.state === "verified") return { cmdId, state: "verified", detail: outcome.detail, result: (outcome.result ?? {}) as CommandResults[T] };
    return { cmdId, state: outcome.state, detail: outcome.detail };
  }

  async query<T extends QueryType>(label: string, type: T, body: Omit<QueryBodies[T], "qid">, opts: { readonly timeoutMs?: number } = {}): Promise<QueryResults[T]> {
    this.gate(label, type);
    this.n += 1;
    const qid = `q:${this.deps.now()}:${this.n}`;
    const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
    const answer = new Promise<QueryAnswer>((resolve, reject) => {
      const waiter: Waiter<QueryAnswer> = { label, resolve, reject, timer: undefined };
      this.queryWaiters.set(qid, waiter);
      waiter.timer = this.deps.timers.set(() => {
        if (this.queryWaiters.get(qid) !== waiter) return;
        this.queryWaiters.delete(qid);
        reject(new RunnerUnavailable(label, "timeout", `no q.result for ${type} ${qid} within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    let sent;
    try { sent = this.deps.accept.control(label, type, { ...body, qid } as QueryBodies[T]); }
    catch (e) {
      const waiter = this.queryWaiters.get(qid);
      if (waiter) { this.deps.timers.clear(waiter.timer); this.queryWaiters.delete(qid); }
      throw e;
    }
    if (!sent) {
      const waiter = this.queryWaiters.get(qid);
      if (waiter) { this.deps.timers.clear(waiter.timer); this.queryWaiters.delete(qid); }
      answer.catch(() => undefined);
      throw new RunnerUnavailable(label, "disconnected", `${type} was not sent`);
    }
    const result = await answer;
    if (!result.ok) throw new QueryFailed(label, result.detail);
    return result.result as unknown as QueryResults[T];
  }

  /**
   * Asks `label` what it knows of `cmdId` (`cmd.status`). Throws RunnerUnavailable when it is not connected, its
   * connection drops before the answer, or it does not answer within `timeoutMs`.
   */
  async status(label: string, cmdId: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<CommandStatusState> {
    if (!this.deps.accept.connected(label) || !this.deps.accept.status) throw new RunnerUnavailable(label, "disconnected", `no admitted connection for cmd.status ${cmdId}`);
    const id = `${label} ${cmdId}`;
    const answer = new Promise<CommandStatusState>((resolve, reject) => {
      const waiter: Waiter<CommandStatusState> = { label, resolve, reject, timer: undefined };
      const set = this.statusWaiters.get(id) ?? new Set<Waiter<CommandStatusState>>();
      set.add(waiter);
      this.statusWaiters.set(id, set);
      waiter.timer = this.deps.timers.set(() => {
        this.dropStatusWaiter(id, waiter);
        reject(new RunnerUnavailable(label, "timeout", `no cmd.status.result for ${cmdId} within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    if (!this.deps.accept.status(label, cmdId)) {
      for (const waiter of [...(this.statusWaiters.get(id) ?? [])]) this.dropStatusWaiter(id, waiter);
      answer.catch(() => undefined);
      throw new RunnerUnavailable(label, "disconnected", `cmd.status ${cmdId} was not sent`);
    }
    return answer;
  }

  /** Hub hook: a received `cmd.status.result`. */
  onStatus(label: string, frame: RunnerControl<"cmd.status.result">): void {
    const id = `${label} ${frame.body.cmdId}`;
    const waiters = [...(this.statusWaiters.get(id) ?? [])];
    if (!waiters.length) return this.noteLate(`status=${frame.body.cmdId}`, label);
    for (const waiter of waiters) {
      this.dropStatusWaiter(id, waiter);
      waiter.resolve(frame.body.state);
    }
  }

  /**
   * Hub hook: resolves the waiters of a committed `cmd.result` and settles its attempt record; a result nobody waits
   * for is logged `RUNNER_CALL_LATE cmdId=` once.
   */
  onEvent(label: string, frame: AnyRunnerEvent): void {
    if (frame.type !== "cmd.result") return;
    const body = frame.body as CmdResultBody;
    this.deps.attempts?.settle(label, body.cmdId);
    const waiters = [...(this.cmdWaiters.get(body.cmdId) ?? [])].filter((w) => w.label === label);
    if (!waiters.length) return this.noteLate(`cmdId=${body.cmdId}`, label);
    for (const waiter of waiters) {
      this.dropCmdWaiter(body.cmdId, waiter);
      waiter.resolve(body);
    }
  }

  /** Hub hook: a received `q.result`. */
  onControl(label: string, frame: RunnerControl<"q.result">): void {
    const waiter = this.queryWaiters.get(frame.body.qid);
    if (!waiter || waiter.label !== label) return this.noteLate(`qid=${frame.body.qid}`, label);
    this.queryWaiters.delete(frame.body.qid);
    this.deps.timers.clear(waiter.timer);
    waiter.resolve(frame.body);
  }

  /** Rejects every pending query of `label`; pending calls keep waiting for the replayed result until their timeout. */
  disconnected(label: string): void {
    for (const [qid, waiter] of [...this.queryWaiters]) {
      if (waiter.label !== label) continue;
      this.queryWaiters.delete(qid);
      this.deps.timers.clear(waiter.timer);
      waiter.reject(new RunnerUnavailable(label, "disconnected", "connection lost before q.result"));
    }
    for (const [id, set] of [...this.statusWaiters]) {
      for (const waiter of [...set]) {
        if (waiter.label !== label) continue;
        this.dropStatusWaiter(id, waiter);
        waiter.reject(new RunnerUnavailable(label, "disconnected", "connection lost before cmd.status.result"));
      }
    }
  }

  pending(): number {
    let n = this.queryWaiters.size;
    for (const set of this.cmdWaiters.values()) n += set.size;
    for (const set of this.statusWaiters.values()) n += set.size;
    return n;
  }

  private dropCmdWaiter(cmdId: string, waiter: Waiter<CmdResultBody>): void {
    this.deps.timers.clear(waiter.timer);
    const set = this.cmdWaiters.get(cmdId);
    if (!set) return;
    set.delete(waiter);
    if (!set.size) this.cmdWaiters.delete(cmdId);
  }

  private dropStatusWaiter(id: string, waiter: Waiter<CommandStatusState>): void {
    this.deps.timers.clear(waiter.timer);
    const set = this.statusWaiters.get(id);
    if (!set) return;
    set.delete(waiter);
    if (!set.size) this.statusWaiters.delete(id);
  }

  private rejectCmd(cmdId: string, label: string, error: Error): void {
    for (const waiter of [...(this.cmdWaiters.get(cmdId) ?? [])]) {
      if (waiter.label !== label) continue;
      this.dropCmdWaiter(cmdId, waiter);
      waiter.reject(error);
    }
  }

  private noteLate(what: string, label: string): void {
    if (this.late.has(what)) return;
    if (this.late.size >= LATE_REMEMBERED) this.late.delete(this.late.values().next().value as string);
    this.late.add(what);
    this.deps.log(`RUNNER_CALL_LATE ${what} runner=${label}`);
  }
}
