import { RESULT_GUARDS } from "./lane-ops.ts";
import type { CallResult, RunnerCall } from "./runner/call.ts";
import { LABEL_PATTERN } from "./runner/protocol.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import type { Ran, Runner } from "./run.ts";
import type { Check } from "./signals.ts";

/*
 * Waits and poll/schedule sources that name a machine run there: the supervisor keeps scheduling, dedupe and
 * journaling, and sends the check or the command to that machine's runner over RunnerCall (`wait.check`, `job.run`).
 * The adapters below give the callers the same shapes a local run has (a Runner, a wait check), so the event ids and
 * lines they journal do not depend on where the work ran.
 */

/** A remote call waits this much longer than the work itself: the round trip to the runner and back. */
export const REMOTE_MARGIN_MS = 20_000;
/** How much longer than the command's own timeout a `job.run` call waits for its `cmd.result`. */
export const REMOTE_JOB_MARGIN_MS = 30_000;

/**
 * The runner label a wait or source names, undefined for the supervisor host (absent or `local`); throws `invalid`
 * with the reason when the value is not a runner label.
 */
export const machineLabel = (value: unknown, invalid: (why: string) => Error): string | undefined => {
  if (value === undefined || value === LOCAL_RUNNER) return undefined;
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) throw invalid(`machine ${JSON.stringify(value)} is not a runner label`);
  return value;
};

const refusal = (r: CallResult<unknown>, malformed: boolean): string => malformed ? `malformed cmd.result (${r.detail})` : `${r.state}: ${r.detail}`;

/**
 * A Runner that runs each command on runner `label` with `job.run`. The command needs `cwd` (a directory on that
 * machine); a refused or failed `cmd.result` throws `RUNNER_JOB_REFUSED runner=<label>: <detail>`, and a runner that
 * is not connected (or does not answer in time) throws RunnerUnavailable.
 */
export const remoteRunner = (call: RunnerCall, label: string, job: { readonly opKey: string; readonly name: string }): Runner =>
  async (argv, opts = {}): Promise<Ran> => {
    if (!opts.cwd) throw new Error(`RUNNER_JOB_REFUSED runner=${label}: a job on a machine needs cwd`);
    const timeoutSec = Math.max(1, Math.ceil((opts.timeoutMs ?? 0) / 1000));
    const r = await call.call(label, "job.run", {
      opKey: job.opKey, name: job.name, command: [...argv], cwd: opts.cwd, timeoutSec, heavy: false,
    }, { timeoutMs: timeoutSec * 1000 + REMOTE_JOB_MARGIN_MS });
    const ok = r.state === "verified" && RESULT_GUARDS["job.run"](r.result);
    if (r.state !== "verified" || !ok) throw new Error(`RUNNER_JOB_REFUSED runner=${label}: ${refusal(r, r.state === "verified")}`);
    const done = r.result;
    return { code: done.exitCode, out: done.output, err: done.err, ...(done.timedOut ? { timedOut: true } : {}) };
  };

type RemoteWait = { readonly id: string; readonly until: string; readonly cwd: string };

/**
 * A wait check run by runner `label` with `wait.check`. A refused cmd.result is a failed check
 * (`RUNNER_WAIT_REFUSED runner=<label>: <detail>`); RunnerUnavailable propagates, and the caller counts it as one.
 */
export const remoteWaitCheck = (call: RunnerCall, label: string, timeoutMs = 10_000 + REMOTE_MARGIN_MS) =>
  async (wait: RemoteWait, _signal?: AbortSignal): Promise<Check> => {
    const r = await call.call(label, "wait.check", { waitId: wait.id, signal: wait.until, cwd: wait.cwd }, { timeoutMs });
    if (r.state !== "verified" || !RESULT_GUARDS["wait.check"](r.result)) {
      const error = `RUNNER_WAIT_REFUSED runner=${label}: ${refusal(r, r.state === "verified")}`;
      return { signal: wait.until, ok: false, detail: r.detail, error };
    }
    return { signal: wait.until, ok: r.result.met, detail: r.detail, ...(r.result.error !== undefined ? { error: r.result.error } : {}) };
  };
