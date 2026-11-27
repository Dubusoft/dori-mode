import type { Runner } from "../run.ts";
import { hcRuntime } from "./hc.ts";
import { herdrRuntime } from "./herdr.ts";
import { RUNTIME_KINDS, runtimeOfPane, type RuntimeKind, type SessionRuntime } from "./types.ts";

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

/** Which runtimes `listPanes` gathers in this process: a runtime left out is never run by it (a host without its binary). */
export type ListedRuntimes = { readonly herdr: boolean; readonly hc: boolean };

const HERDR_ONLY: ListedRuntimes = { herdr: true, hc: false };
let source: () => ListedRuntimes = () => HERDR_ONLY;
let added: ReadonlySet<RuntimeKind> = new Set();

/**
 * Sets the runtimes whose panes `listPanes` gathers in this process, and drops what `listRuntime` added. A function is
 * asked again at each listing, so an owner whose answer changes (the runner: policy reload, lane open and close) keeps the
 * listed set in step without a sync call at every listing site. The default is herdr alone: a process that never sets it
 * (a herdr host, every test) lists as before. The runner sets it from its lanes (lanes.ts), the supervisor, dori status
 * and dori doctor from host-runtimes.ts `listHostRuntimes`.
 */
export const setListedRuntimes = (which: ListedRuntimes | (() => ListedRuntimes)): void => {
  source = typeof which === "function" ? which : () => which;
  added = new Set();
};

/** Also lists `kind` until the next setListedRuntimes: the runtime a lane is opening on, before its record names that pane. */
export const listRuntime = (kind: RuntimeKind): void => { added = new Set([...added, kind]); };

export const listedRuntimes = (): readonly RuntimeKind[] => {
  const which = source();
  return RUNTIME_KINDS.filter((kind) => which[kind] || added.has(kind));
};
