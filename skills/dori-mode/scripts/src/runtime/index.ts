import type { Runner } from "../run.ts";
import { hcRuntime } from "./hc.ts";
import { herdrRuntime } from "./herdr.ts";
import { runtimeOfPane, type RuntimeKind, type SessionRuntime } from "./types.ts";

export {
  HC_PANE_PREFIX, infoOf, RUNTIME_KINDS, runtimeOfPane, type OpenedSession, type OpenSpec, type ProcessRead, type RuntimeKind, type SessionRuntime,
} from "./types.ts";

const built = new WeakMap<Runner, Map<RuntimeKind, SessionRuntime>>();

/** The `kind` runtime that runs its CLI through `run`, built once per runner function. */
export const sessionRuntime = (run: Runner, kind: RuntimeKind): SessionRuntime => {
  let byKind = built.get(run);
  if (!byKind) built.set(run, byKind = new Map());
  let runtime = byKind.get(kind);
  if (!runtime) byKind.set(kind, runtime = kind === "hc" ? hcRuntime(run) : herdrRuntime(run));
  return runtime;
};

/** The runtime that holds pane `pane` (`hc:` ids are hc terminals, every other id a herdr pane). */
export const paneRuntime = (run: Runner, pane: string): SessionRuntime => sessionRuntime(run, runtimeOfPane(pane));

let listed: ReadonlySet<RuntimeKind> = new Set<RuntimeKind>(["herdr"]);

/**
 * Adds `kind` to the runtimes whose panes `listPanes` gathers in this process. herdr is always listed; the runner lists
 * hc once its runner-config selects it or one of its lanes lives on it, so a host that never uses hc never runs it.
 */
export const listRuntime = (kind: RuntimeKind): void => { listed = new Set([...listed, kind]); };

export const unlistRuntime = (kind: Exclude<RuntimeKind, "herdr">): void => { listed = new Set([...listed].filter((k) => k !== kind)); };

export const listedRuntimes = (): readonly RuntimeKind[] => [...listed];
