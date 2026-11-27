import type { Runner } from "../run.ts";
import { hcRuntime } from "./hc.ts";
import type { SessionRuntime } from "./types.ts";

export { infoOf, type SessionRuntime } from "./types.ts";

const built = new WeakMap<Runner, SessionRuntime>();

/** The terminal runtime (hc) that runs its CLI through `run`, built once per runner function. */
export const sessionRuntime = (run: Runner): SessionRuntime => {
  let runtime = built.get(run);
  if (!runtime) built.set(run, runtime = hcRuntime(run));
  return runtime;
};
