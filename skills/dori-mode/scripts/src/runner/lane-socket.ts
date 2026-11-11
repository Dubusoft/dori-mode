import { isReportKind } from "./report-kinds.ts";
import type { LaneNotice } from "./lanes.ts";
import type { RunnerEventBodies, RunnerEventType } from "./protocol.ts";
import type { Listener, Transport } from "./transport.ts";
import { LaneFileError } from "./lane-files.ts";
import type { LaneOutputFiles } from "./protocol.ts";
import { SECRET_NAME } from "../secret-name.ts";

/**
 * The lane socket `<runnerDir>/sock/lane` (design 2.5): one JSON request line in, one JSON reply line out, many per
 * connection. Verbs:
 * - `{kind: <report kind>, key, token, text, evidence?}`: the report goes to the outbox as `lane.report`; `{ok}`.
 * - `{kind: "status", key, token}`: the lane's status as the supervisor last pushed it with `lane.notify`
 *   (`{ok, status, objection, claim}`; before any notify `working` with no objection and no claim).
 * - `{kind: "ack", key, token, id}`: publishes `lane.ack {key, id}`; `{ok}`.
 * - `{kind: "whoami", pane}`: the key of the lane whose record holds `pane` (`{ok, key?}`), no token needed. The CLI
 *   uses it only to tell lane mode from lead mode.
 * - `{kind: "secret", key, token, names}`: asks the runner for the named secrets; `{ok, values}` on a grant, `{ok:false,
 *   code, detail}` on a refusal. Nothing is published and neither the values nor the reply are logged.
 * Every verb but `whoami` needs the key's own token (`RUNNER_LANE_AUTH_FAILED`). A failure is `{ok:false, code, detail}`.
 */

export const LANE_SOCKET = "lane";

type Publish = <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;

/** The runner's answer to a `secret` request: the values by name, or a refusal. */
export type SecretGrant =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly code: string; readonly detail: string };

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
};

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
      const known = req.kind === "status" || req.kind === "ack" || req.kind === "secret" || isReportKind(req.kind);
      if (!str(req.key) || !str(req.token) || !known) { bad("needs key, token, and a report kind, status, ack, secret or whoami"); return; }
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
          (result) => { reply(result.ok ? { ok: true, values: result.values } : { ok: false, code: result.code, detail: result.detail }); },
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
