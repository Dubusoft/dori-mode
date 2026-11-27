import type { Pane } from "../panes.ts";
import type { Ran } from "../run.ts";
import type { ProcessInfo } from "../runner/protocol.ts";

/**
 * The terminal runtimes a lane can live on. `herdr` is the default everywhere; `hc` (herdr-core, the headless runtime
 * from the same project) is chosen per host with runner-config `laneRuntime`. The lead's pane follows config.json
 * `leadRuntime` (herdr unless set); the supervisor itself is a service, not a pane.
 */
export type RuntimeKind = "herdr" | "hc";

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["herdr", "hc"];

/** An hc terminal's pane id: `hc:<address>` (`hc:t7`), so every id names its runtime; a herdr pane id stays bare. */
export const HC_PANE_PREFIX = "hc:";

/** The runtime that owns pane `pane`, read off its id. */
export const runtimeOfPane = (pane: string): RuntimeKind => (pane.startsWith(HC_PANE_PREFIX) ? "hc" : "herdr");

/** A pane's processes, or why the runtime gave none (its own error text, which `q.process` hands to the supervisor). */
export type ProcessRead = { readonly info: ProcessInfo } | { readonly error: string };

export const infoOf = (read: ProcessRead): ProcessInfo | undefined => ("info" in read ? read.info : undefined);

/** A fresh lane session: its pane id, its herdr tab ("" on hc, which has no tabs), and what the launch line needs. */
export type OpenedSession = {
  readonly pane: string;
  readonly tab: string;
  readonly terminalId?: string;
  readonly shell: "posix" | "pwsh" | "powershell" | "cmd";
  readonly shellPid?: number;
  readonly cwd?: string;
};

export type OpenSpec = {
  /** The lane key: the herdr tab label, the hc `dori.lane` label and terminal name. */
  readonly key: string;
  /** hc only: the `k=v` label the terminal gets instead of `dori.lane=<key>` (the lead's is `dori.lead=1`). */
  readonly label?: string;
  readonly cwd: string;
  /** herdr only: the workspace the tab opens in (absent: herdr's focused one). */
  readonly workspace?: string;
};

/**
 * What the runner does with a lane's terminal, in herdr's own shapes (`Pane`, `ProcessInfo`) so the lane code reads
 * one shape whatever runtime holds the lane. Every call goes through the runner's `Runner`, so tests replace the
 * runtime binary with a recorder.
 */
export interface SessionRuntime {
  readonly kind: RuntimeKind;
  /** The running server's identity; a lane record from another instance names a pane that no longer exists. */
  instance(): Promise<string | undefined>;
  /** Every live pane of this runtime on this host. Throws when the list cannot be read. */
  listPanes(): Promise<Pane[]>;
  /** The last `lines` lines of scrollback and screen, or the visible screen when `lines` is absent. "" when unreadable. */
  read(pane: string, lines?: number): Promise<string>;
  /** Types `text` and presses Enter once (hc: one atomic paste + Enter). False when the runtime refused it. */
  sendText(pane: string, text: string): Promise<boolean>;
  key(pane: string, key: "enter" | "escape"): Promise<boolean>;
  /** The pane's shell and foreground processes. */
  processInfo(pane: string): Promise<ProcessRead>;
  /** A new session running the user's shell and nothing else, in `spec.cwd`. Throws when it cannot be opened. */
  open(spec: OpenSpec): Promise<OpenedSession>;
  /** Types the launch line into the session's shell (herdr `pane run`, hc `send`). */
  run(pane: string, command: string): Promise<Ran>;
  /** Ends the session: its herdr tab when it has one (else the pane); hc kills and removes the terminal. */
  close(pane: string, tab?: string): Promise<void>;
}
