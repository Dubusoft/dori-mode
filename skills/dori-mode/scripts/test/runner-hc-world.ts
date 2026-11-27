import type { Ran } from "../src/run.ts";
import { HC_MIN_VERSION } from "../src/runtime/hc.ts";

/**
 * A scripted hc (herdr-core) for runner tests: `hcAnswer` answers the `hc` argv the runtime adapter (runtime/hc.ts)
 * sends, from a world the test edits. `panes` is what `hc ls` lists, each row by its `hc:<address>` pane id, with the
 * fields the adapter turns back into a pane row (`agent`/`agent_status` from the terminal's reported status, `created`
 * into its terminal id `hc:<address>@<created>`). Terminals `hc run` opened answer `hc get` even when not listed, as a
 * fresh terminal does before the test lists it. `proc[address]` is a terminal's one foreground process.
 */
export type HcPane = {
  readonly pane_id: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly cwd?: string;
  readonly created?: number;
  readonly shellPid?: number;
};

export type HcProc = { readonly pid?: number; readonly name?: string; readonly argv?: readonly string[] };

export type HcWorld = {
  panes: HcPane[];
  proc: Record<string, HcProc>;
  /** What `hc read` answers for every terminal. */
  screen: string;
  /** The core id `hc server status` reports (the runner's instance is `hc:<id>`); undefined answers no core. */
  instance: string | undefined;
  /** How many of the next `hc run` calls fail. */
  runFails: number;
  /** Exit code of the next `hc send` (the launch line or typed text); 0 succeeds. */
  sendCode: number;
  next: number;
  readonly opened: Map<string, { readonly cwd: string; readonly label: string }>;
};

export const newHcWorld = (): HcWorld => ({ panes: [], proc: {}, screen: "", instance: "core-1", runFails: 0, sendCode: 0, next: 1, opened: new Map() });

const ok = (json: unknown): Ran => ({ code: 0, out: JSON.stringify(json), err: "" });
const fail = (err: string, code = 3): Ran => ({ code, out: "", err });
const addressOf = (pane: string): string => pane.replace(/^hc:/, "");

const terminal = (w: HcWorld, address: string): Record<string, unknown> | undefined => {
  const row = w.panes.find((p) => addressOf(p.pane_id) === address);
  const opened = w.opened.get(address);
  if (!row && !opened) return undefined;
  const status = row?.agent || row?.agent_status ? { ...(row.agent ? { app: row.agent } : {}), ...(row.agent_status ? { state: row.agent_status } : {}) } : null;
  return {
    address, state: "live", cwd: row?.cwd ?? opened?.cwd, created_ms: row?.created ?? 0, pid: row?.shellPid ?? 100, status,
    ...(w.proc[address] ? { foreground: w.proc[address] } : {}),
  };
};

/** hc's answer to `argv`, or undefined when `argv` is not an hc call (the test answers it itself). */
export const hcAnswer = (w: HcWorld, argv: readonly string[]): Ran | undefined => {
  if (argv[0] !== "hc") return undefined;
  if (argv[1] === "--version") return { code: 0, out: `hc ${HC_MIN_VERSION}\n`, err: "" };
  if (argv[1] !== "--json") return ok({});
  const [verb, target] = [argv[2], argv[3] ?? ""];
  if (verb === "server") return w.instance === undefined ? fail("no core") : ok({ core: { id: w.instance }, pid: 7 });
  if (verb === "ls") return ok({ terminals: w.panes.map((p) => ({ address: addressOf(p.pane_id), state: "live" })) });
  if (verb === "get") { const t = terminal(w, target); return t ? ok(t) : fail("not found"); }
  if (verb === "run") {
    if (w.runFails > 0) { w.runFails--; return fail("core unreachable"); }
    const address = `t${w.next++}`;
    w.opened.set(address, { cwd: argv[argv.indexOf("--cwd") + 1] ?? "", label: argv[argv.indexOf("--label") + 1] ?? "" });
    return ok({ address });
  }
  if (verb === "send") {
    if (w.sendCode) { const code = w.sendCode; w.sendCode = 0; return fail("refused", code); }
    return terminal(w, target) ? ok({ turn: 0 }) : fail("not found");
  }
  if (verb === "keys") return terminal(w, target) ? ok({}) : fail("not found");
  if (verb === "read") return ok({ text: w.screen });
  if (verb === "kill") return terminal(w, target) ? ok({}) : fail("not found");
  // Removing a terminal never changes what `hc ls` lists here: the test decides whether a closed pane is gone.
  if (verb === "rm") { w.opened.delete(target); return ok({ removed: target }); }
  return ok({});
};

/** The text of every `hc send` to `pane` (launch lines and typed text), oldest first. */
export const sentTo = (calls: readonly (readonly string[])[], pane?: string): string[] =>
  calls.filter((a) => a[0] === "hc" && a[2] === "send" && (pane === undefined || a[3] === addressOf(pane))).map((a) => a[5] ?? "");

/** The launch lines the runner typed (each starts with the lane's `export`), oldest first. */
export const launchLines = (calls: readonly (readonly string[])[]): string[] => sentTo(calls).filter((text) => /^export |^pwsh |^powershell /.test(text));

/** Whether any call opened (`hc run`) or closed (`hc kill`/`hc rm`) a terminal. */
export const opens = (calls: readonly (readonly string[])[]): number => calls.filter((a) => a[0] === "hc" && a[2] === "run").length;
export const closes = (calls: readonly (readonly string[])[]): string[] => calls.filter((a) => a[0] === "hc" && a[2] === "kill").map((a) => `hc:${a[3]}`);
