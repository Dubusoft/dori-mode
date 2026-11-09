import type { Runner } from "../run.ts";
import { fetchHttp } from "../messenger/http.ts";
import { checkSignal } from "../signals.ts";
import type { AnySupervisorCommand, CommandResults, RunnerEventBodies, RunnerEventType } from "./protocol.ts";

/**
 * The runner's effects for `wait.check` and `job.run`: one wait check, or one argv job, on this host. The supervisor
 * keeps the scheduling, the dedupe and the journal; the runner only runs the work and publishes what it saw.
 */

/** One wait check is bounded the same way a local check is (src/waits.ts WAIT_CHECK_MS); not imported, to keep supervisor state out of the runner bundle. */
export const RUNNER_WAIT_CHECK_MS = 10_000;
export const JOB_OUTPUT_CAP_BYTES = 65_536;
export const JOB_ERR_CAP_BYTES = 4_096;
const DETAIL_CAP = 500;

type Publish = <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;
type Cmd<T extends "wait.check" | "job.run"> = Extract<AnySupervisorCommand, { readonly type: T }>;
type Out<T extends keyof CommandResults> = { readonly detail: string; readonly result: CommandResults[T] };

/** The first `maxBytes` UTF-8 bytes of `text`, cut on a character boundary. */
export const capBytes = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};

export const waitCheckEffect = (deps: { readonly run: Runner; readonly publish: Publish }) =>
  async (command: Cmd<"wait.check">): Promise<Out<"wait.check">> => {
    const { signal, cwd, waitId } = command.body;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RUNNER_WAIT_CHECK_MS);
    try {
      const check = await checkSignal(signal, (argv, opts) => deps.run(argv, { ...opts, cwd, timeoutMs: RUNNER_WAIT_CHECK_MS }), {
        cwd, http: (req) => fetchHttp({ ...req, signal: abort.signal }),
      });
      const met = check.ok && check.error === undefined;
      if (met) deps.publish("wait.result", { waitId, outcome: "WAIT_DONE", detail: check.detail.slice(0, DETAIL_CAP) });
      return {
        detail: met ? "met" : check.error !== undefined ? `error: ${check.error}` : "unmet",
        result: { met, ...(check.error !== undefined ? { error: check.error } : {}) },
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { detail: `error: ${error}`, result: { met: false, error } };
    } finally {
      clearTimeout(timer);
    }
  };

export const jobRunEffect = (deps: { readonly run: Runner; readonly publish: Publish }) =>
  async (command: Cmd<"job.run">): Promise<Out<"job.run">> => {
    const { body } = command;
    if (body.heavy === true) throw new Error("heavy jobs are not supported on a runner yet");
    const ran = await deps.run(body.command, { cwd: body.cwd, timeoutMs: body.timeoutSec * 1000 });
    const timedOut = ran.timedOut === true;
    const output = capBytes(ran.out, JOB_OUTPUT_CAP_BYTES);
    deps.publish("job.result", { opKey: body.opKey, state: ran.code === 0 ? "verified" : "failed", exitCode: ran.code, output });
    return {
      detail: `exit ${ran.code}${timedOut ? " (timed out)" : ""}`,
      result: { exitCode: ran.code, timedOut, output, err: capBytes(ran.err, JOB_ERR_CAP_BYTES) },
    };
  };
