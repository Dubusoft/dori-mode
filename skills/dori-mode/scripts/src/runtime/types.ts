import type { Pane } from "../panes.ts";
import type { Ran } from "../run.ts";
import type { ProcessInfo } from "../runner/protocol.ts";

/**
 * An hc terminal's pane id: `hc:<address>` (`hc:t7`). hc (herdr-core) is the only terminal runtime: every lane, and the
 * lead, lives in an hc terminal, and records and state store this prefixed id.
 */
export const HC_PANE_PREFIX = "hc:";

/** A pane's processes, or why the runtime gave none (its own error text, which `q.process` hands to the supervisor). */
type ProcessRead = { readonly info: ProcessInfo } | { readonly error: string };

export const infoOf = (read: ProcessRead): ProcessInfo | undefined => ("info" in read ? read.info : undefined);

/** A fresh lane session: its pane id and what the launch line needs. */
export type OpenedSession = {
  readonly pane: string;
  readonly terminalId?: string;
  readonly shellPid?: number;
};

export type OpenSpec = {
  /** The lane key: the hc `dori.lane` label and terminal name. */
  readonly key: string;
  /** The `k=v` label the terminal gets instead of `dori.lane=<key>` (the lead's is `dori.lead=1`). */
  readonly label?: string;
  readonly cwd: string;
};

/**
 * What the runner does with a lane's terminal, in the shapes the lane code reads (`Pane`, `ProcessInfo`). Every call
 * goes through the runner's `Runner`, so tests replace the hc binary with a recorder. Pane arguments use the `hc:` prefix.
 */
export interface SessionRuntime {
  /** The running server's identity; a lane record from another instance names a pane that no longer exists. */
  instance(): Promise<string | undefined>;
  /** Every live pane on this host. Throws when the list cannot be read. */
  listPanes(): Promise<Pane[]>;
  /** The last `lines` lines of scrollback and screen, or the visible screen when `lines` is absent. "" when unreadable. */
  read(pane: string, lines?: number): Promise<string>;
  /** Types `text` and presses Enter once (one atomic paste + Enter). False when the runtime refused it. */
  sendText(pane: string, text: string): Promise<boolean>;
  key(pane: string, key: "enter" | "escape"): Promise<boolean>;
  /** The pane's shell and foreground processes. */
  processInfo(pane: string): Promise<ProcessRead>;
  /** A new session running the user's shell and nothing else, in `spec.cwd`. Throws when it cannot be opened. */
  open(spec: OpenSpec): Promise<OpenedSession>;
  /** Types the launch line into the session's shell (`hc send`). */
  run(pane: string, command: string): Promise<Ran>;
  /** Ends the session: kills and removes the terminal. */
  close(pane: string): Promise<void>;
}
