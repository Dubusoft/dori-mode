/**
 * The runner wire protocol: one JSON object per line in either direction, the same over a unix socket and over the
 * network. A frame is an envelope `{v, runner, gen, epoch, seq | cmdSeq, type, body, mac?}`:
 *
 * - runner -> supervisor events carry `seq` (per runner, durable, never reset by a new `gen`) and go through the outbox;
 * - supervisor -> runner commands carry `cmdSeq` (per runner, issued by the supervisor) and a `cmdId` in the body;
 * - control frames (hello, heartbeat, acks, command status, the `q.*` queries and their `q.result`) carry neither and
 *   are never queued or journaled.
 *
 * Every frame is validated against a fixed per-type schema: an unknown type, a missing field, a field of the wrong
 * shape or a field the schema does not name is rejected with a `ProtocolError` naming the rule. `mac` is accepted as
 * an optional string here; auth.ts computes and checks it, and the hub and client require it on every frame after the
 * handshake (`enroll`, `hello`, `hello.challenge`, `auth.proof`, `enroll.ok` and a reject sent before the handshake
 * are the only frames without one).
 */

import type { HostSample } from "../host-guard.ts";
import type { Pane } from "../panes.ts";
import type { Check } from "../signals.ts";
import type { ReportKind } from "./report-kinds.ts";

/** The protocol version this code speaks. A runner speaks exactly this; a supervisor also accepts `PROTO - 1`. */
export const PROTO = 3;
/** The envelope layout version (`v`). */
export const ENVELOPE_VERSION = 1;
/** The longest line `decodeFrame` accepts; the outbox caps a single body at 256KB, so a frame stays well under this. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** A runner label: it is part of journal ids (`runner:<label>:<seq>`), so it never contains `:` or whitespace. */
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// Body types
// ---------------------------------------------------------------------------------------------------------------

export type LaneStatus = "working" | "idle" | "dead" | "missing";
export type WaitOutcome = "WAIT_DONE" | "WAIT_TIMEOUT" | "WAIT_FAILED";
export type GuardLevel = "ok" | "alert" | "critical";
export type CommandOutcome = "verified" | "failed" | "ambiguous";
/** What a runner knows of a command when asked (`cmd.status`): `unknown` means it holds no record of it. */
export type CommandStatusState = "intent" | "running" | "verified" | "failed" | "ambiguous" | "unknown";

/** A report text the outbox moved out of its row: the wire carries the text itself plus its digest and size. */
export type BodyRef = { readonly sha256: string; readonly bytes: number; readonly truncated: boolean };

/** One lane the runner sees on its host (hello inventory). */
export type InventoryLane = { readonly key: string; readonly pane: string; readonly tab: string; readonly session?: string };

/** Any JSON value; the `json` schema spec accepts one without walking its content. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [k: string]: JsonValue };

/** Why a runner reports a lane `dead` (since proto 3). */
export type LaneDeadReason = "pane-missing" | "agent-gone";
/** One lane's resident memory on the runner's host, with its heaviest commands (`guard.sample.lanes`). */
export type LaneMemoryBody = {
  readonly key: string; readonly rssKb: number;
  readonly top: readonly { readonly comm: string; readonly rssKb: number; readonly count: number }[];
};

export type RunnerEventBodies = {
  readonly "lane.started": { readonly key: string; readonly pane: string; readonly tab: string; readonly session: string };
  /**
   * `pane` (since proto 2) is the lane's pane id as the runner sees it; a proto 1 runner never sends it. `reason`
   * (since proto 3) says why a lane is `dead`.
   */
  readonly "lane.state": { readonly key: string; readonly status: LaneStatus; readonly pane?: string; readonly reason?: LaneDeadReason };
  readonly "lane.report": {
    readonly key: string; readonly kind: ReportKind; readonly text: string; readonly evidence?: string; readonly bodyRef?: BodyRef;
  };
  readonly "lane.asking": { readonly key: string; readonly text: string };
  /** A screen read: `reportHash` is the hash of the latest `[REPORT]` line seen, when there is one. */
  readonly "lane.progress": { readonly key: string; readonly reportHash?: string; readonly text?: string };
  /** The lane confirmed the supervisor's lane message `id` (`dori report ack <id>`, since proto 3). */
  readonly "lane.ack": { readonly key: string; readonly id: string };
  readonly "wait.result": { readonly waitId: string; readonly outcome: WaitOutcome; readonly detail: string };
  readonly "job.result": { readonly opKey: string; readonly state: "verified" | "failed"; readonly exitCode: number; readonly output: string };
  /** The level with its reasons, plus the readings the supervisor's HOST_GUARD lines quote (-1 when unreadable). */
  readonly "guard.sample": {
    readonly level: GuardLevel; readonly reasons: readonly string[]; readonly sampledAt: number;
    readonly load1?: number; readonly memFreePct?: number; readonly diskFreeGb?: number; readonly swapFreeGb?: number; readonly swapTotalGb?: number;
    readonly os?: string;
    /** Since proto 3: herdr's pane count on the host, and per-lane memory. */
    readonly panes?: number; readonly lanes?: readonly LaneMemoryBody[];
  };
  readonly "guard.alert": { readonly reasons: readonly string[] };
  /** `rssKb[i]` and `cmds[i]` describe `killed[i]`, so the supervisor reports a runner's kills as it reports its own. */
  readonly "guard.critical": {
    readonly killed: readonly number[]; readonly paused: readonly string[]; readonly reasons?: readonly string[];
    readonly rssKb?: readonly number[]; readonly cmds?: readonly string[];
  };
  readonly "heavy.state": { readonly slots: number; readonly used: number; readonly holders: readonly string[] };
  /** `result` (since proto 3) is the effect's structured result (`CommandResults[type]`), absent on a refusal or failure. */
  readonly "cmd.result": {
    readonly cmdId: string; readonly cmdSeq: number; readonly state: CommandOutcome; readonly detail: string; readonly result?: JsonValue;
  };
};

/** Every command body carries the supervisor's operation key `cmdId`. */
type Cmd<T> = { readonly cmdId: string } & T;
type LaneKey = { readonly key: string };

export type LaneGitOp = "worktree-remove" | "branch-delete" | "remote-branch-delete" | "fetch-branch" | "worktree-add";
export type PauseStep = "goal" | "stop" | "both";
export type SendMode = "verified" | "guarded";

export type SupervisorCommandBodies = {
  /**
   * Since proto 3, all optional: `keywords` (the opening keywords; absent: the runner's default), `session` (resume
   * that agent session), `target` (run in this idle shell pane, or the one shell pane of this workspace, instead of a
   * new tab), `heavySlots`/`heavyMaxLoad` (exported to the lane as DORI_HEAVY_SLOTS / DORI_HEAVY_MAX_LOAD).
   */
  readonly "lane.start": Cmd<{
    readonly key: string; readonly briefText: string; readonly done: string; readonly thread: string; readonly cwd: string;
    readonly agentProfile: string; readonly mode: string; readonly model: string; readonly sandbox: boolean; readonly expectedLaneGen: number;
    readonly keywords?: string; readonly session?: string; readonly target?: { readonly pane?: string; readonly workspace?: string };
    readonly heavySlots?: number; readonly heavyMaxLoad?: number;
  }>;
  /** Since proto 3: take the existing pane `pane` as lane `key`; issues a token file. */
  readonly "lane.adopt": Cmd<{ readonly key: string; readonly pane: string; readonly cwd?: string; readonly mode: string; readonly model: string }>;
  readonly "lane.stop": Cmd<LaneKey>;
  /** `step` (since proto 3) defaults to `both`. */
  readonly "lane.pause": Cmd<{ readonly key: string; readonly step?: PauseStep }>;
  readonly "lane.resume": Cmd<LaneKey>;
  /** `session` (since proto 3): resume that agent session when relaunching. */
  readonly "lane.recover": Cmd<{ readonly key: string; readonly session?: string }>;
  /** `mode` and `refuseWhileAsking` since proto 3. */
  readonly "lane.send": Cmd<{ readonly key: string; readonly text: string; readonly verify: boolean; readonly mode?: SendMode; readonly refuseWhileAsking?: boolean }>;
  /** Since proto 3: the lane's status as the supervisor holds it, answered to the lane's `dori lane status`. */
  readonly "lane.notify": Cmd<{
    readonly key: string; readonly status: string;
    readonly objection?: { readonly at: string; readonly reasons: readonly string[] };
    readonly claim?: { readonly at: string; readonly evidence: string };
  }>;
  /**
   * Since proto 3: one git cleanup step for a lane, run in `root` on the runner's host. `sha` (branch deletes only):
   * delete only while the branch is at that commit (`update-ref -d <ref> <sha>` / `push --force-with-lease=<ref>:<sha>`).
   */
  readonly "lane.git": Cmd<{
    readonly key: string; readonly op: LaneGitOp; readonly root: string; readonly path?: string; readonly branch?: string; readonly remote?: string;
    readonly sha?: string; readonly ref?: string;
  }>;
  readonly "lane.close": Cmd<{ readonly key: string; readonly worktreeChecks: boolean }>;
  readonly "lane.observe": Cmd<LaneKey>;
  readonly "wait.check": Cmd<{ readonly waitId: string; readonly signal: string; readonly cwd: string }>;
  readonly "job.run": Cmd<{
    readonly opKey: string; readonly name: string; readonly command: readonly string[]; readonly cwd: string; readonly timeoutSec: number;
    readonly heavy: boolean;
  }>;
  readonly "guard.kill": Cmd<{ readonly keys: readonly string[] }>;
  readonly "runner.rotate": Cmd<Record<never, never>>;
};

export type RunnerControlBodies = {
  /** `nonce` (32 random bytes) and `dh` (an ephemeral X25519 public key) open the signed handshake (base64 each). */
  readonly hello: {
    readonly proto: number; readonly gen: number; readonly label: string; readonly hostId: string; readonly cmdAck: number;
    readonly version?: string; readonly inventory?: readonly InventoryLane[]; readonly nonce?: string; readonly dh?: string;
  };
  /**
   * First frame of an enrollment connection. `proof` is HMAC-SHA256 keyed with the enrollment code over the label,
   * hostId and public key, so the code itself never crosses the network.
   */
  readonly enroll: { readonly label: string; readonly hostId: string; readonly runnerPubKey: string; readonly proof: string };
  /** The runner's Ed25519 signature over the handshake transcript. */
  readonly "auth.proof": { readonly sig: string };
  /** Answer to `runner.rotate`: the new public key, and a signature with the new key binding it to this session. */
  readonly "runner.rotated": { readonly cmdId: string; readonly runnerPubKey: string; readonly sig: string };
  /** `outbox` lets `dori status` show the runner's backlog without reading its files. */
  readonly heartbeat: { readonly outbox?: { readonly unacked: number; readonly oldestAgeMs: number } };
  readonly "cmd.status.result": { readonly cmdId: string; readonly state: CommandStatusState; readonly detail?: string };
  /** The answer to the `q.*` query `qid` (since proto 3): `result` is `QueryResults[type]` when `ok`. */
  readonly "q.result": { readonly qid: string; readonly ok: boolean; readonly detail: string; readonly result?: JsonValue };
};

export type RejectCode = "RUNNER_PROTO_MISMATCH" | "RUNNER_CONFLICT" | "RUNNER_REVOKED" | "RUNNER_AUTH_FAILED" | "RUNNER_ENROLL_REFUSED";

export type SupervisorControlBodies = {
  /** `eventAck` tells the runner where to resume its outbox replay. */
  readonly "hello.ok": { readonly proto: number; readonly epoch: number; readonly eventAck: number };
  readonly "hello.reject": { readonly code: RejectCode; readonly detail: string };
  readonly ack: { readonly eventAck: number };
  readonly "cmd.status": { readonly cmdId: string };
  /** The supervisor's nonce, ephemeral X25519 key, transcript signature and the fingerprint of the runner key it holds. */
  readonly "hello.challenge": { readonly nonce: string; readonly dh: string; readonly sig: string; readonly keyFp: string };
  /** Enrollment accepted: the supervisor's public key, and an HMAC keyed with the code that proves the reply's origin. */
  readonly "enroll.ok": { readonly supervisorPubKey: string; readonly proof: string };
  /** The new runner key from `runner.rotated` is stored; the runner may drop its old key. */
  readonly "rotate.ok": { readonly cmdId: string };
} & QueryBodies;

/**
 * Read-only queries (since proto 3), supervisor to runner as control frames: no `seq`/`cmdSeq`, never queued, never
 * journaled or recorded, dropped when the link is down. Each is answered by one `q.result` with the same `qid`.
 */
export type QueryBodies = {
  /** herdr's pane list of the runner's host. */
  readonly "q.panes": { readonly qid: string };
  /** A pane's screen: the visible screen, or its last `lines` lines of scrollback and screen (`recent`). */
  readonly "q.screen": { readonly qid: string; readonly pane: string; readonly lines: number; readonly source: "visible" | "recent" };
  /** herdr's process-info of a pane. */
  readonly "q.process": { readonly qid: string; readonly pane: string };
  /** Whether each path exists on the runner's host. */
  readonly "q.stat": { readonly qid: string; readonly paths: readonly string[] };
  /** A lane's status, pane, cwd and on request its process-info, git facts, Done checks and agent session. */
  readonly "q.lane.inspect": {
    readonly qid: string; readonly key: string; readonly cwd?: string; readonly process?: boolean; readonly git?: boolean; readonly roots?: readonly string[];
    readonly branches?: readonly string[]; readonly done?: string; readonly doneCwd?: string; readonly session?: boolean; readonly sessionsDir?: string;
  };
  /** The host's guard sample and pane list. */
  readonly "q.machine.observe": { readonly qid: string };
};
export type QueryType = keyof QueryBodies;

// ---------------------------------------------------------------------------------------------------------------
// Structured results (decoded supervisor-side; the wire carries them as `JsonValue`)
// ---------------------------------------------------------------------------------------------------------------

export type GoalOutcome = "confirmed" | "unconfirmed" | "failed";
/** `detail`: the failure word, or e.g. "no ready agent status (idle)"; the last lines are inside it when unconfirmed. */
export type StartupVerdict = { readonly verdict: "ok" | "error" | "unconfirmed"; readonly detail: string };

/** The `result` of a verified `cmd.result`, per command type. */
export type CommandResults = {
  readonly "lane.start": { readonly pane: string; readonly tab: string; readonly startup: StartupVerdict };
  readonly "lane.adopt": { readonly pane: string; readonly tab: string; readonly tokenFile: string };
  readonly "lane.stop": { readonly closed: "tab" | "pane" | "none"; readonly gone: boolean };
  readonly "lane.close": { readonly closed: "tab" | "pane" | "none"; readonly gone: boolean };
  readonly "lane.pause": { readonly goal?: GoalOutcome; readonly working?: boolean; readonly stopped?: boolean };
  readonly "lane.resume": { readonly goal: GoalOutcome };
  readonly "lane.recover": { readonly pane: string; readonly tab: string; readonly relaunched: boolean; readonly resumed: boolean; readonly startup?: StartupVerdict };
  readonly "lane.send": { readonly delivery: "delivered" | "unconfirmed" | "failed" | "sent"; readonly refusal?: string };
  readonly "lane.notify": Record<never, never>;
  /** `out` and `err` are capped at 4 KiB each. */
  readonly "lane.git": { readonly code: number; readonly out: string; readonly err: string };
  readonly "lane.observe": { readonly status: LaneStatus };
  readonly "guard.kill": { readonly killed: readonly { readonly pid: number; readonly lane?: string; readonly comm: string; readonly rssKb: number }[] };
};
/** The commands a supervisor awaits a structured result for. */
export type DurableCommandType = keyof CommandResults;

/** herdr's `pane process-info` result. */
export type ProcessInfo = {
  readonly shell_pid?: number;
  readonly foreground_process_group_id?: number;
  readonly foreground_processes?: readonly { readonly pid?: number; readonly name?: string; readonly argv?: readonly string[] }[];
};

export type LaneInspection = {
  /** `laneStatus(pane)` as serve.ts computes it. */
  readonly status: LaneStatus;
  /** The record's (or the cwd's) pane row when herdr lists it. */
  readonly pane?: Pane;
  readonly process?: ProcessInfo;
  readonly cwd: string;
  readonly cwdExists: boolean;
  readonly git?: {
    readonly toplevel?: string; readonly origin?: string; readonly branch?: string;
    readonly worktrees: readonly {
      readonly path: string; readonly branch?: string; readonly head?: string; readonly dirty?: boolean; readonly ahead?: number;
      readonly exists: boolean; readonly error?: string;
    }[];
    /** For the `branches` asked. */
    readonly branches?: Readonly<Record<string, { readonly local: boolean; readonly remote: boolean }>>;
  };
  /** `fallback`: the checks ran in `doneCwd` because the lane's cwd is gone. */
  readonly done?: { readonly cwd: string; readonly fallback: boolean; readonly checks: readonly Check[] };
  /** session-id.ts `resolveSession` on the runner's host. */
  readonly session?: { readonly id: string; readonly via: string };
};

/** `sample.panes` is filled with the pane count. */
export type MachineObservation = { readonly os: string; readonly sampledAt: number; readonly sample: HostSample; readonly panes: readonly Pane[] };

/** The `result` of an `ok` `q.result`, per query type. */
export type QueryResults = {
  readonly "q.panes": { readonly panes: readonly Pane[] };
  readonly "q.screen": { readonly text: string };
  readonly "q.process": { readonly info?: ProcessInfo; readonly error?: string };
  readonly "q.stat": { readonly exists: readonly boolean[] };
  readonly "q.lane.inspect": LaneInspection;
  readonly "q.machine.observe": MachineObservation;
};

export type RunnerEventType = keyof RunnerEventBodies;
export type SupervisorCommandType = keyof SupervisorCommandBodies;
export type RunnerControlType = keyof RunnerControlBodies;
export type SupervisorControlType = keyof SupervisorControlBodies;

// ---------------------------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------------------------

type Base = {
  readonly v: typeof ENVELOPE_VERSION;
  /** The runner's label: the sender on runner frames, the addressee on supervisor frames. */
  readonly runner: string;
  /** The runner generation (bumped and committed once per runner process start). */
  readonly gen: number;
  /** The supervisor epoch: the highest one the runner has seen, or the sender's own on supervisor frames. */
  readonly epoch: number;
  /** HMAC of the frame without `mac`; optional until authentication is in place. */
  readonly mac?: string;
};

export type RunnerEvent<T extends RunnerEventType = RunnerEventType> = Base & { readonly seq: number; readonly type: T; readonly body: RunnerEventBodies[T] };
export type SupervisorCommand<T extends SupervisorCommandType = SupervisorCommandType> =
  Base & { readonly cmdSeq: number; readonly type: T; readonly body: SupervisorCommandBodies[T] };
export type RunnerControl<T extends RunnerControlType = RunnerControlType> = Base & { readonly type: T; readonly body: RunnerControlBodies[T] };
export type SupervisorControl<T extends SupervisorControlType = SupervisorControlType> =
  Base & { readonly type: T; readonly body: SupervisorControlBodies[T] };

export type AnyRunnerEvent = { [T in RunnerEventType]: RunnerEvent<T> }[RunnerEventType];
export type AnySupervisorCommand = { [T in SupervisorCommandType]: SupervisorCommand<T> }[SupervisorCommandType];
export type AnyRunnerControl = { [T in RunnerControlType]: RunnerControl<T> }[RunnerControlType];
export type AnySupervisorControl = { [T in SupervisorControlType]: SupervisorControl<T> }[SupervisorControlType];
/** Anything a runner sends. */
export type RunnerFrame = AnyRunnerEvent | AnyRunnerControl;
/** Anything a supervisor sends. */
export type SupervisorFrame = AnySupervisorCommand | AnySupervisorControl;
export type Frame = RunnerFrame | SupervisorFrame;
/** Who sent a frame: decoding checks the type belongs to that side. */
export type Sender = "runner" | "supervisor";

export const isRunnerEvent = (frame: Frame): frame is AnyRunnerEvent => "seq" in frame;
export const isSupervisorCommand = (frame: Frame): frame is AnySupervisorCommand => "cmdSeq" in frame;

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

/** The rule a rejected frame broke; it is the second word of the error message. */
export type ProtocolRule =
  | "frame-too-large" | "frame-newline" | "frame-json" | "frame-object" | "envelope-version" | "envelope-field"
  | "unknown-field" | "unknown-type" | "wrong-direction" | "sequence" | "missing-field" | "field-type" | "label";

/** A frame that breaks the protocol. Message: `RUNNER_FRAME_INVALID <rule> <detail>`. */
export class ProtocolError extends Error {
  readonly code = "RUNNER_FRAME_INVALID";
  constructor(readonly rule: ProtocolRule, readonly detail: string) {
    super(`RUNNER_FRAME_INVALID ${rule} ${detail}`);
    this.name = "ProtocolError";
  }
}

type Spec =
  | "string" | "int" | "number" | "bool" | "string[]" | "int[]"
  /** Any JSON value (null, boolean, number, string, array, object); nested content is not walked. */
  | "json"
  | { readonly enum: readonly string[] }
  | { readonly object: Shape }
  | { readonly list: Shape };
type Field = { readonly spec: Spec; readonly optional?: true };
type Shape = Readonly<Record<string, Field>>;

const req = (spec: Spec): Field => ({ spec });
const opt = (spec: Spec): Field => ({ spec, optional: true });
const cmd = (shape: Shape): Shape => ({ cmdId: req("string"), ...shape });
const laneKey: Shape = { key: req("string") };

const BODY_REF: Shape = { sha256: req("string"), bytes: req("int"), truncated: req("bool") };
const INVENTORY: Shape = { key: req("string"), pane: req("string"), tab: req("string"), session: opt("string") };

const EVENT_SCHEMAS: { readonly [T in RunnerEventType]: Shape } = {
  "lane.started": { key: req("string"), pane: req("string"), tab: req("string"), session: req("string") },
  "lane.state": {
    key: req("string"), status: req({ enum: ["working", "idle", "dead", "missing"] }), pane: opt("string"),
    reason: opt({ enum: ["pane-missing", "agent-gone"] }),
  },
  "lane.report": {
    key: req("string"), kind: req({ enum: ["progress", "question", "blocked", "milestone", "done"] }), text: req("string"),
    evidence: opt("string"), bodyRef: opt({ object: BODY_REF }),
  },
  "lane.asking": { key: req("string"), text: req("string") },
  "lane.progress": { key: req("string"), reportHash: opt("string"), text: opt("string") },
  "lane.ack": { key: req("string"), id: req("string") },
  "wait.result": { waitId: req("string"), outcome: req({ enum: ["WAIT_DONE", "WAIT_TIMEOUT", "WAIT_FAILED"] }), detail: req("string") },
  "job.result": { opKey: req("string"), state: req({ enum: ["verified", "failed"] }), exitCode: req("int"), output: req("string") },
  "guard.sample": {
    level: req({ enum: ["ok", "alert", "critical"] }), reasons: req("string[]"), sampledAt: req("int"),
    load1: opt("number"), memFreePct: opt("number"), diskFreeGb: opt("number"), swapFreeGb: opt("number"), swapTotalGb: opt("number"), os: opt("string"),
    panes: opt("int"),
    lanes: opt({ list: { key: req("string"), rssKb: req("int"), top: req({ list: { comm: req("string"), rssKb: req("int"), count: req("int") } }) } }),
  },
  "guard.alert": { reasons: req("string[]") },
  "guard.critical": { killed: req("int[]"), paused: req("string[]"), reasons: opt("string[]"), rssKb: opt("int[]"), cmds: opt("string[]") },
  "heavy.state": { slots: req("int"), used: req("int"), holders: req("string[]") },
  "cmd.result": {
    cmdId: req("string"), cmdSeq: req("int"), state: req({ enum: ["verified", "failed", "ambiguous"] }), detail: req("string"), result: opt("json"),
  },
};

const COMMAND_SCHEMAS: { readonly [T in SupervisorCommandType]: Shape } = {
  "lane.start": cmd({
    key: req("string"), briefText: req("string"), done: req("string"), thread: req("string"), cwd: req("string"),
    agentProfile: req("string"), mode: req("string"), model: req("string"), sandbox: req("bool"), expectedLaneGen: req("int"),
    keywords: opt("string"), session: opt("string"), target: opt({ object: { pane: opt("string"), workspace: opt("string") } }),
    heavySlots: opt("int"), heavyMaxLoad: opt("number"),
  }),
  "lane.adopt": cmd({ key: req("string"), pane: req("string"), cwd: opt("string"), mode: req("string"), model: req("string") }),
  "lane.stop": cmd(laneKey),
  "lane.pause": cmd({ key: req("string"), step: opt({ enum: ["goal", "stop", "both"] }) }),
  "lane.resume": cmd(laneKey),
  "lane.recover": cmd({ key: req("string"), session: opt("string") }),
  "lane.send": cmd({
    key: req("string"), text: req("string"), verify: req("bool"), mode: opt({ enum: ["verified", "guarded"] }), refuseWhileAsking: opt("bool"),
  }),
  "lane.notify": cmd({
    key: req("string"), status: req("string"),
    objection: opt({ object: { at: req("string"), reasons: req("string[]") } }), claim: opt({ object: { at: req("string"), evidence: req("string") } }),
  }),
  "lane.git": cmd({
    key: req("string"), op: req({ enum: ["worktree-remove", "branch-delete", "remote-branch-delete", "fetch-branch", "worktree-add"] }), root: req("string"),
    path: opt("string"), branch: opt("string"), remote: opt("string"), sha: opt("string"), ref: opt("string"),
  }),
  "lane.close": cmd({ key: req("string"), worktreeChecks: req("bool") }),
  "lane.observe": cmd(laneKey),
  "wait.check": cmd({ waitId: req("string"), signal: req("string"), cwd: req("string") }),
  "job.run": cmd({
    opKey: req("string"), name: req("string"), command: req("string[]"), cwd: req("string"), timeoutSec: req("int"), heavy: req("bool"),
  }),
  "guard.kill": cmd({ keys: req("string[]") }),
  "runner.rotate": cmd({}),
};

const RUNNER_CONTROL_SCHEMAS: { readonly [T in RunnerControlType]: Shape } = {
  hello: {
    proto: req("int"), gen: req("int"), label: req("string"), hostId: req("string"), cmdAck: req("int"),
    version: opt("string"), inventory: opt({ list: INVENTORY }), nonce: opt("string"), dh: opt("string"),
  },
  enroll: { label: req("string"), hostId: req("string"), runnerPubKey: req("string"), proof: req("string") },
  "auth.proof": { sig: req("string") },
  "runner.rotated": { cmdId: req("string"), runnerPubKey: req("string"), sig: req("string") },
  heartbeat: { outbox: opt({ object: { unacked: req("int"), oldestAgeMs: req("int") } }) },
  "cmd.status.result": {
    cmdId: req("string"), state: req({ enum: ["intent", "running", "verified", "failed", "ambiguous", "unknown"] }), detail: opt("string"),
  },
  "q.result": { qid: req("string"), ok: req("bool"), detail: req("string"), result: opt("json") },
};

const query = (shape: Shape): Shape => ({ qid: req("string"), ...shape });

const QUERY_SCHEMAS: { readonly [T in QueryType]: Shape } = {
  "q.panes": query({}),
  "q.screen": query({ pane: req("string"), lines: req("int"), source: req({ enum: ["visible", "recent"] }) }),
  "q.process": query({ pane: req("string") }),
  "q.stat": query({ paths: req("string[]") }),
  "q.lane.inspect": query({
    key: req("string"), cwd: opt("string"), process: opt("bool"), git: opt("bool"), roots: opt("string[]"), branches: opt("string[]"),
    done: opt("string"), doneCwd: opt("string"), session: opt("bool"), sessionsDir: opt("string"),
  }),
  "q.machine.observe": query({}),
};

const SUPERVISOR_CONTROL_SCHEMAS: { readonly [T in SupervisorControlType]: Shape } = {
  "hello.ok": { proto: req("int"), epoch: req("int"), eventAck: req("int") },
  "hello.reject": {
    code: req({ enum: ["RUNNER_PROTO_MISMATCH", "RUNNER_CONFLICT", "RUNNER_REVOKED", "RUNNER_AUTH_FAILED", "RUNNER_ENROLL_REFUSED"] }),
    detail: req("string"),
  },
  ack: { eventAck: req("int") },
  "cmd.status": { cmdId: req("string") },
  "hello.challenge": { nonce: req("string"), dh: req("string"), sig: req("string"), keyFp: req("string") },
  "enroll.ok": { supervisorPubKey: req("string"), proof: req("string") },
  "rotate.ok": { cmdId: req("string") },
  ...QUERY_SCHEMAS,
};

const has = <T extends object>(table: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(table, key);

/** The type names each side may send, in a stable order (documentation and tests). */
export const RUNNER_EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as RunnerEventType[];
export const SUPERVISOR_COMMAND_TYPES = Object.keys(COMMAND_SCHEMAS) as SupervisorCommandType[];
export const RUNNER_CONTROL_TYPES = Object.keys(RUNNER_CONTROL_SCHEMAS) as RunnerControlType[];
export const SUPERVISOR_CONTROL_TYPES = Object.keys(SUPERVISOR_CONTROL_SCHEMAS) as SupervisorControlType[];
/** The read-only queries, a subset of `SUPERVISOR_CONTROL_TYPES`. */
export const QUERY_TYPES = Object.keys(QUERY_SCHEMAS) as QueryType[];
export const isQueryType = (type: string): type is QueryType => has(QUERY_SCHEMAS, type);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const checkValue = (path: string, spec: Spec, value: unknown): void => {
  const bad = (want: string): never => { throw new ProtocolError("field-type", `${path} must be ${want}`); };
  if (spec === "string") { if (typeof value !== "string") bad("a string"); return; }
  if (spec === "int") { if (!isInt(value)) bad("a non-negative integer"); return; }
  if (spec === "number") { if (typeof value !== "number" || !Number.isFinite(value)) bad("a finite number"); return; }
  if (spec === "bool") { if (typeof value !== "boolean") bad("a boolean"); return; }
  if (spec === "string[]") { if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) bad("an array of strings"); return; }
  if (spec === "int[]") { if (!Array.isArray(value) || !value.every(isInt)) bad("an array of non-negative integers"); return; }
  // Any value a JSON line can hold (the caller already ruled out undefined); its content is the reader's to check.
  if (spec === "json") return;
  if ("enum" in spec) { if (typeof value !== "string" || !spec.enum.includes(value)) bad(`one of ${spec.enum.join("|")}`); return; }
  if ("object" in spec) { checkShape(path, spec.object, value); return; }
  if (!Array.isArray(value)) bad("an array");
  (value as unknown[]).forEach((item, i) => checkShape(`${path}[${i}]`, spec.list, item));
};

const checkShape = (path: string, shape: Shape, value: unknown): void => {
  if (!isRecord(value)) throw new ProtocolError("field-type", `${path} must be an object`);
  for (const key of Object.keys(value)) if (!has(shape, key)) throw new ProtocolError("unknown-field", `${path}.${key}`);
  for (const [key, field] of Object.entries(shape)) {
    const v = value[key];
    if (v === undefined) {
      if (!field.optional) throw new ProtocolError("missing-field", `${path}.${key}`);
      continue;
    }
    checkValue(`${path}.${key}`, field.spec, v);
  }
};

const ENVELOPE_FIELDS = new Set(["v", "runner", "gen", "epoch", "seq", "cmdSeq", "type", "body", "mac"]);

/** Which schema table a type belongs to, and whether it carries `seq`, `cmdSeq` or neither. */
const schemaFor = (type: string): { readonly sender: Sender; readonly sequence: "seq" | "cmdSeq" | undefined; readonly shape: Shape } | undefined => {
  if (has(EVENT_SCHEMAS, type)) return { sender: "runner", sequence: "seq", shape: EVENT_SCHEMAS[type] };
  if (has(RUNNER_CONTROL_SCHEMAS, type)) return { sender: "runner", sequence: undefined, shape: RUNNER_CONTROL_SCHEMAS[type] };
  if (has(COMMAND_SCHEMAS, type)) return { sender: "supervisor", sequence: "cmdSeq", shape: COMMAND_SCHEMAS[type] };
  if (has(SUPERVISOR_CONTROL_SCHEMAS, type)) return { sender: "supervisor", sequence: undefined, shape: SUPERVISOR_CONTROL_SCHEMAS[type] };
  return undefined;
};

/** Validates an already parsed frame from `from` and returns it typed; throws `ProtocolError` naming the broken rule. */
export function validateFrame(value: unknown, from: "runner"): RunnerFrame;
export function validateFrame(value: unknown, from: "supervisor"): SupervisorFrame;
export function validateFrame(value: unknown, from: Sender): Frame;
export function validateFrame(value: unknown, from: Sender): Frame {
  if (!isRecord(value)) throw new ProtocolError("frame-object", "a frame must be a JSON object");
  for (const key of Object.keys(value)) if (!ENVELOPE_FIELDS.has(key)) throw new ProtocolError("unknown-field", key);
  if (value.v !== ENVELOPE_VERSION) throw new ProtocolError("envelope-version", `v must be ${ENVELOPE_VERSION}, got ${JSON.stringify(value.v)}`);
  if (typeof value.runner !== "string") throw new ProtocolError("envelope-field", "runner must be a string");
  if (!LABEL_PATTERN.test(value.runner)) throw new ProtocolError("label", `runner ${JSON.stringify(value.runner)} is not a valid label`);
  if (!isInt(value.gen)) throw new ProtocolError("envelope-field", "gen must be a non-negative integer");
  if (!isInt(value.epoch)) throw new ProtocolError("envelope-field", "epoch must be a non-negative integer");
  if (value.mac !== undefined && typeof value.mac !== "string") throw new ProtocolError("envelope-field", "mac must be a string");
  if (typeof value.type !== "string") throw new ProtocolError("envelope-field", "type must be a string");
  const schema = schemaFor(value.type);
  if (!schema) throw new ProtocolError("unknown-type", value.type);
  if (schema.sender !== from) throw new ProtocolError("wrong-direction", `${value.type} is sent by the ${schema.sender}, not the ${from}`);
  for (const name of ["seq", "cmdSeq"] as const) {
    if (schema.sequence === name) {
      if (value[name] === undefined) throw new ProtocolError("sequence", `${value.type} requires ${name}`);
      if (!isInt(value[name]) || value[name] === 0) throw new ProtocolError("sequence", `${name} must be a positive integer`);
    } else if (value[name] !== undefined) {
      throw new ProtocolError("sequence", `${value.type} must not carry ${name}`);
    }
  }
  if (value.body === undefined) throw new ProtocolError("missing-field", "body");
  checkShape("body", schema.shape, value.body);
  if ((value.type === "hello" || value.type === "enroll") && isRecord(value.body) && !LABEL_PATTERN.test(String(value.body.label))) {
    throw new ProtocolError("label", `${value.type} label ${JSON.stringify(value.body.label)} is not a valid label`);
  }
  return value as unknown as Frame;
}

// ---------------------------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------------------------

/** One frame as one line, newline included. JSON escapes newlines inside strings, so the line never breaks early. */
export const encodeFrame = (frame: Frame): string => `${JSON.stringify(frame)}\n`;

/** One received line (its trailing newline optional) as a validated frame from `from`. */
export function decodeFrame(line: string, from: "runner"): RunnerFrame;
export function decodeFrame(line: string, from: "supervisor"): SupervisorFrame;
export function decodeFrame(line: string, from: Sender): Frame;
export function decodeFrame(line: string, from: Sender): Frame {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new ProtocolError("frame-too-large", `over ${MAX_FRAME_BYTES} bytes`);
  const text = line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
  if (/[\r\n]/.test(text)) throw new ProtocolError("frame-newline", "a frame is exactly one line");
  let value: unknown;
  try { value = JSON.parse(text); } catch (e) {
    if (e instanceof SyntaxError) throw new ProtocolError("frame-json", e.message);
    throw e;
  }
  return validateFrame(value, from);
}

/**
 * Splits a received byte stream into lines. `push` returns the complete lines the chunk finished; a partial last line
 * waits for the next chunk. A line growing past `MAX_FRAME_BYTES` without a newline is a protocol error.
 */
export class LineSplitter {
  private rest = "";
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    if (Buffer.byteLength(this.rest, "utf8") > MAX_FRAME_BYTES) {
      this.rest = "";
      throw new ProtocolError("frame-too-large", `over ${MAX_FRAME_BYTES} bytes without a newline`);
    }
    return parts.filter((part) => part.length > 0);
  }
  /** The buffered partial line (empty when the stream ended on a newline). */
  get pending(): string { return this.rest; }
}

// ---------------------------------------------------------------------------------------------------------------
// Builders, journal ids, proto compatibility
// ---------------------------------------------------------------------------------------------------------------

/** The envelope fields every frame shares, minus `v`. */
export type FrameHead = { readonly runner: string; readonly gen: number; readonly epoch: number };

export const runnerEvent = <T extends RunnerEventType>(head: FrameHead, seq: number, type: T, body: RunnerEventBodies[T]): RunnerEvent<T> =>
  ({ v: ENVELOPE_VERSION, ...head, seq, type, body });
export const supervisorCommand = <T extends SupervisorCommandType>(
  head: FrameHead, cmdSeq: number, type: T, body: SupervisorCommandBodies[T],
): SupervisorCommand<T> => ({ v: ENVELOPE_VERSION, ...head, cmdSeq, type, body });
export const runnerControl = <T extends RunnerControlType>(head: FrameHead, type: T, body: RunnerControlBodies[T]): RunnerControl<T> =>
  ({ v: ENVELOPE_VERSION, ...head, type, body });
export const supervisorControl = <T extends SupervisorControlType>(head: FrameHead, type: T, body: SupervisorControlBodies[T]): SupervisorControl<T> =>
  ({ v: ENVELOPE_VERSION, ...head, type, body });

/** The supervisor journal id of a runner event: `runner:<label>:<seq>`. */
export const journalId = (label: string, seq: number): string => `runner:${label}:${seq}`;

/** The label and seq of a runner journal id, or undefined for any other id. */
export const parseJournalId = (id: string): { readonly label: string; readonly seq: number } | undefined => {
  const m = /^runner:([^:\s]+):(\d+)$/.exec(id);
  if (!m || !LABEL_PATTERN.test(m[1] ?? "")) return undefined;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) && seq > 0 ? { label: m[1] as string, seq } : undefined;
};

export type ProtoCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "RUNNER_PROTO_MISMATCH"; readonly detail: string };

/**
 * Whether a supervisor speaking `supervisorProto` accepts a runner speaking `runnerProto`: it accepts its own version
 * and the one before. A newer runner, or one two or more versions behind, is refused; that runner needs an upgrade,
 * not a restart.
 */
export const checkProto = (runnerProto: number, supervisorProto: number = PROTO): ProtoCheck => {
  if (runnerProto === supervisorProto || runnerProto === supervisorProto - 1) return { ok: true };
  const why = runnerProto > supervisorProto ? "newer than the supervisor" : "too old for the supervisor";
  return { ok: false, code: "RUNNER_PROTO_MISMATCH", detail: `runner proto ${runnerProto} is ${why} (accepts ${supervisorProto - 1}..${supervisorProto})` };
};
