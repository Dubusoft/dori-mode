/**
 * Step lines for `dori runner install` and `remove`: `RUNNER_STEP runner=<label> <step> start|done|failed[: detail]`.
 * The installer and remover print through an optional `progress` callback, so tests and other callers stay quiet.
 */

export type Progress = (line: string) => void;

export type StepState = "start" | "done" | "failed" | "skipped";

export const stepLine = (label: string, step: string, state: StepState, detail?: string): string =>
  `RUNNER_STEP runner=${label} ${step} ${state}${detail ? `: ${detail}` : ""}`;

/** A printer bound to one runner label; a no-op without `progress`. */
export const stepper = (progress: Progress | undefined, label: string) =>
  (step: string, state: StepState, detail?: string): void => { progress?.(stepLine(label, step, state, detail)); };
