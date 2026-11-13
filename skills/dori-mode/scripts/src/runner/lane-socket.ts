import { existsSync } from "node:fs";
import { join } from "node:path";

import { RUNNER_PATHS } from "./fs-safety.ts";
import { isReportKind } from "./report-kinds.ts";
import type { LaneNotice } from "./lanes.ts";
import type { RunnerEventBodies, RunnerEventType } from "./protocol.ts";
import type { Connector, Listener, Transport } from "./transport.ts";
import { LaneFileError } from "./lane-files.ts";
import type { LaneOutputFiles } from "./protocol.ts";
import { SECRET_NAME } from "../secret-name.ts";
import type { SecretRunResult } from "./secret-run.ts";

/**
 * The lane socket `<runnerDir>/sock/lane.d/lane` (design 2.5): one JSON request line in, one JSON reply line out, many per
 * connection. Verbs:
 * - `{kind: <report kind>, key, token, text, evidence?}`: the report goes to the outbox as `lane.report`; `{ok}`.
 * - `{kind: "status", key, token}`: the lane's status as the supervisor last pushed it with `lane.notify`
 *   (`{ok, status, objection, claim}`; before any notify `working` with no objection and no claim).
 * - `{kind: "ack", key, token, id}`: publishes `lane.ack {key, id}`; `{ok}`.
 * - `{kind: "whoami", pane}`: the key of the lane whose record holds `pane` (`{ok, key?}`), no token needed. The CLI
 *   uses it only to tell lane mode from lead mode.
 * - `{kind: "secret", key, token, names}`: asks the runner for the named secrets; `{ok, values, kinds?}` on a grant (`kinds` only names that are ssh-key or file), `{ok:false,
 *   code, detail}` on a refusal. Nothing is published and neither the values nor the reply are logged.
 * - `{kind: "secret-run", key, token, op}`: has the host run config `secretCommands.<op>` for the lane (secret-run.ts);
 *   `{ok, exitCode, stdout, stderr, truncated}` or a refusal. The token is checked before `op`; the output is never logged.
 * - `{kind: "secret-put", key, token, name, value}`: stores `value` (1 to `SECRET_PUT_MAX_BYTES` bytes) under `name` when
 *   config allows this lane to (`secrets.<name>.put`); `{ok, created, backend}` or a refusal. Write only: nothing is read
 *   back, and neither the value nor the request is logged or published.
 * Every verb but `whoami` needs the key's own token (`RUNNER_LANE_AUTH_FAILED`). A failure is `{ok:false, code, detail}`.
 */

export const LANE_SOCKET = "lane";

/**
 * The lane socket's own 0700 directory under `sock/`. A Linux lane sandbox binds this directory, not the socket file: a
 * restarted runner unlinks the socket and binds a new one at the same path, and a bind of the old file would keep the
 * lane on the dead inode. The control and cli sockets stay outside it, so a lane still cannot dial them.
 */
export const LANE_SOCKET_DIR = "lane.d";

/** `<runnerDir>/sock/lane.d/lane`, where the runner serves the lane socket. */
export const laneSocketPath = (runnerDir: string): string => join(runnerDir, RUNNER_PATHS.sock, LANE_SOCKET_DIR, LANE_SOCKET);

/**
 * `<runnerDir>/sock/lane`, where runners before `lane.d` served it. The runner serves it too, for lanes whose sandbox
 * was set up for that path (a macOS profile that allows only it, or a lane started before the update).
 */
export const legacyLaneSocketPath = (runnerDir: string): string => join(runnerDir, RUNNER_PATHS.sock, LANE_SOCKET);

/** Whether either lane socket path exists as seen from here (inside a lane: through its sandbox). */
export const laneSocketExists = (runnerDir: string): boolean =>
  existsSync(laneSocketPath(runnerDir)) || existsSync(legacyLaneSocketPath(runnerDir));

/**
 * How a lane's `dori` dials the lane socket: the `lane.d` path, and when that connect fails the legacy path. Existence
 * does not decide it: an older macOS profile lets a lane stat `lane.d` but refuses the connect. Rejects with the
 * `lane.d` error when neither connects.
 */
export const connectLaneSocket = (runnerDir: string, connect: (path: string) => Connector): Connector => {
  const current = connect(laneSocketPath(runnerDir));
  const legacy = connect(legacyLaneSocketPath(runnerDir));
  return async () => {
    try { return await current(); } catch (error) {
      try { return await legacy(); } catch { throw error; }
    }
  };
};

type Publish = <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;

/** How a granted value reaches the lane's command: in env, or as the path of a 0600 file (`ssh-key`, `file`). */
export type SecretKind = "env" | "ssh-key" | "file";

/** The runner's answer to a `secret` request: the values by name, or a refusal. */
export type SecretGrant =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>>; readonly kinds?: Readonly<Record<string, SecretKind>> }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** The runner's answer to a `secret-put` request: whether the name was new and the store backend, or a refusal. */
export type SecretPutResult =
  | { readonly ok: true; readonly created: boolean; readonly backend: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** The largest value `secret-put` takes, in UTF-8 bytes. */
export const SECRET_PUT_MAX_BYTES = 65_536;

export type LaneRequest = { readonly key: string; readonly token: string; readonly kind: string; readonly text: string; readonly evidence?: string };

/**
 * What the socket needs of the runner's lanes. `notice` and `keyForPane` are optional so a token-only fake still serves
 * reports; without them `status` answers the default and `whoami` answers no key.
 */
export type LaneSocketLanes = {
  readonly reportFiles?: (key: string) => LaneOutputFiles | undefined;
  readonly tokenFor: (key: string, token: string) => boolean;
  readonly notice?: (key: string) => LaneNotice | undefined;
  readonly keyForPane?: (pane: string) => string | undefined;
  /** Hands out secret values to a lane; absent on a runner that does not support them. */
  readonly secrets?: (key: string, names: readonly string[]) => Promise<SecretGrant>;
  /** Runs a configured secret command for a lane; absent on a runner that does not support them. */
  readonly secretRun?: (key: string, op: string) => Promise<SecretRunResult>;
  /** Stores a value a lane made; absent on a runner that does not support it. */
  readonly secretPut?: (key: string, name: string, value: string) => Promise<SecretPutResult>;
};

/** A `secretCommands` op name. */
const SECRET_OP = /^[a-z][a-z0-9-]{0,63}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** Serves the lane socket on `listener`; returns the unsubscribe function (the caller closes the listener). */
export const serveLaneSocket = (listener: Listener, lanes: LaneSocketLanes, publish: Publish, log: (line: string) => void): (() => void) =>
  listener.onConnection((link: Transport) => {
    link.onLine((line) => {
      const reply = (body: object): void => {
        try { link.send(`${JSON.stringify(body)}\n`); }
        catch (e) { log(`RUNNER_LANE_REPLY_FAILED ${e instanceof Error ? e.message : String(e)}`); }
      };
      const bad = (detail: string): void => { reply({ ok: false, code: "RUNNER_LANE_BAD_REQUEST", detail }); };
      let req: unknown;
      try { req = JSON.parse(line); } catch { bad("not JSON"); return; }
      if (!isRecord(req)) { bad("not a JSON object"); return; }
      if (req.kind === "whoami") {
        if (!str(req.pane) || !req.pane) { bad("whoami needs a pane"); return; }
        const key = lanes.keyForPane?.(req.pane);
        reply({ ok: true, ...(key ? { key } : {}) });
        return;
      }
      const known = req.kind === "status" || req.kind === "ack" || req.kind === "secret" || req.kind === "secret-run" || req.kind === "secret-put" || isReportKind(req.kind);
      if (!str(req.key) || !str(req.token) || !known) { bad("needs key, token, and a report kind, status, ack, secret, secret-run, secret-put or whoami"); return; }
      if (req.kind === "secret-put") {
        if (!lanes.tokenFor(req.key, req.token)) {
          log(`RUNNER_LANE_AUTH_FAILED key=${req.key} verb=secret-put`);
          reply({ ok: false, code: "RUNNER_LANE_AUTH_FAILED", detail: `not ${req.key}'s lane token` });
          return;
        }
        const { name, value } = req;
        if (!str(name) || !SECRET_NAME.test(name)) { bad("secret-put needs a secret name"); return; }
        if (!str(value) || !value || Buffer.byteLength(value) > SECRET_PUT_MAX_BYTES) { bad(`secret-put needs a value of 1 to ${SECRET_PUT_MAX_BYTES} bytes`); return; }
        if (!lanes.secretPut) { reply({ ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "this runner does not store secrets" }); return; }
        const store = lanes.secretPut;
        const key = req.key;
        // The value stays out of the log and the outbox; the reply carries no value either.
        void Promise.resolve().then(() => store(key, name, value)).then(
          (result) => { reply(result.ok ? { ok: true, created: result.created, backend: result.backend } : { ok: false, code: result.code, detail: result.detail }); },
          (error: unknown) => { reply({ ok: false, code: "RUNNER_SECRET_FAILED", detail: error instanceof Error ? error.message : String(error) }); },
        );
        return;
      }
      if (req.kind === "secret-run") {
        if (!lanes.tokenFor(req.key, req.token)) {
          log(`RUNNER_LANE_AUTH_FAILED key=${req.key} verb=secret-run`);
          reply({ ok: false, code: "RUNNER_LANE_AUTH_FAILED", detail: `not ${req.key}'s lane token` });
          return;
        }
        const op = req.op;
        if (!str(op) || !SECRET_OP.test(op)) { bad("secret-run needs op matching ^[a-z][a-z0-9-]{0,63}$"); return; }
        if (!lanes.secretRun) { reply({ ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "this runner does not run secret commands" }); return; }
        const runOp = lanes.secretRun;
        const key = req.key;
        // The output stays out of the log and the outbox; only the reply line carries it.
        void Promise.resolve().then(() => runOp(key, op)).then(
          (result) => {
            reply(result.ok
              ? { ok: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated }
              : { ok: false, code: result.code, detail: result.detail });
          },
          (error: unknown) => { reply({ ok: false, code: "RUNNER_SECRET_FAILED", detail: error instanceof Error ? error.message : String(error) }); },
        );
        return;
      }
      if (req.kind === "secret") {
        const names = req.names;
        if (!Array.isArray(names) || !names.length || names.length > 32 || !names.every((n) => str(n) && SECRET_NAME.test(n)) || new Set(names).size !== names.length) {
          bad("secret needs names: 1 to 32 unique secret names");
          return;
        }
        if (!lanes.tokenFor(req.key, req.token)) {
          log(`RUNNER_LANE_AUTH_FAILED key=${req.key} verb=secret names=${names.join(",")}`);
          reply({ ok: false, code: "RUNNER_LANE_AUTH_FAILED", detail: `not ${req.key}'s lane token` });
          return;
        }
        if (!lanes.secrets) { reply({ ok: false, code: "RUNNER_SECRET_UNSUPPORTED", detail: "this runner does not hand out secrets" }); return; }
        const grant = lanes.secrets;
        const key = req.key;
        // The values stay out of the log and the outbox; only the reply line carries them.
        void Promise.resolve().then(() => grant(key, names as string[])).then(
          (result) => { reply(result.ok ? { ok: true, values: result.values, ...(result.kinds ? { kinds: result.kinds } : {}) } : { ok: false, code: result.code, detail: result.detail }); },
          (error: unknown) => { reply({ ok: false, code: "RUNNER_SECRET_FAILED", detail: error instanceof Error ? error.message : String(error) }); },
        );
        return;
      }
      if (isReportKind(req.kind) && !str(req.text)) { bad("needs key, token, a report kind and text"); return; }
      if (req.kind === "ack" && (!str(req.id) || !req.id)) { bad("ack needs an id"); return; }
      if (!lanes.tokenFor(req.key, req.token)) {
        log(`RUNNER_LANE_AUTH_FAILED key=${req.key}`);
        reply({ ok: false, code: "RUNNER_LANE_AUTH_FAILED", detail: `not ${req.key}'s lane token` });
        return;
      }
      if (req.kind === "status") {
        const notice = lanes.notice?.(req.key);
        reply({ ok: true, status: notice?.status ?? "working", objection: notice?.objection ?? null, claim: notice?.claim ?? null });
        return;
      }
      if (req.kind === "ack") {
        publish("lane.ack", { key: req.key, id: req.id as string });
        reply({ ok: true });
        return;
      }
      try {
        const files = req.kind === "done" ? lanes.reportFiles?.(req.key) : undefined;
        publish("lane.report", { key: req.key, kind: req.kind as RunnerEventBodies["lane.report"]["kind"], text: req.text as string, ...(str(req.evidence) && req.evidence ? { evidence: req.evidence } : {}), ...(files ? { files } : {}) });
        reply({ ok: true });
      } catch (error) {
        const failure = error instanceof LaneFileError ? error : new LaneFileError("LANE_REPORT_STORE_FAILED", req.key,
          "the complete report was not stored by the runner; fix runner disk space and permissions, then claim done again");
        reply({ ok: false, code: failure.code, detail: failure.message.slice(failure.code.length + 1) });
      }
    });
  });
