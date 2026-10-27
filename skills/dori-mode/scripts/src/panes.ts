import type { Clock, Runner } from "./run.ts";
import type { Lane } from "./registry.ts";

/** Herdr IDs belong to a server, not to the host running Dori. */
export const herdrArgv = (lane: Pick<Lane, "machine">, args: readonly string[]): string[] =>
  ["herdr", ...(lane.machine ? ["--machine", lane.machine] : []), ...args];

/** Scope existing pane helpers to a lane; nested lifecycle calls must not add the selector twice. */
export const laneRunner = (run: Runner, lane: Pick<Lane, "machine">): Runner =>
  lane.machine ? (argv, opts) => run(argv[0] === "herdr" && argv[1] !== "--machine" ? herdrArgv(lane, argv.slice(1)) : argv, opts) : run;

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
  /** Bumped by herdr whenever the pane's content changes. */
  readonly revision?: number;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

/** States herdr reports for a pane whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> =>
  (await listPanes(run)).find((p) => p.pane_id === pane)?.agent_status;

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (run: Runner, pane: string): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    return { status: await agentStatus(run, pane) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

/** Why `pane` cannot take typed text as an agent prompt: missing from the list, or no agent runs in it (only a shell). */
export const agentRefusal = (panes: readonly Pane[], pane: string): string | undefined => {
  const found = panes.find((p) => p.pane_id === pane);
  if (!found) return `pane ${pane} missing`;
  if (!found.agent) return `pane ${pane} runs no agent`;
  return undefined;
};

/** Sleeps between successive status lookups after Enter; the first lookup is immediate. */
export const CONFIRM_BACKOFF_MS: readonly number[] = [150, 300, 600, 900, 1000, 1000, 1000];

/** Raw send: types the text and presses Enter once. Not exported, so no caller outside this file can skip the guard below. */
const typeAndEnter = async (run: Runner, pane: string, text: string): Promise<"sent" | "failed"> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return "failed";
  await run(["herdr", "pane", "send-keys", pane, "enter"]);
  return "sent";
};

/** Every send to a pane goes through here: only a pane whose agent is running gets text, since a bare shell would run it as a command. */
const guardedSend = async (run: Runner, pane: string, text: string): Promise<{ readonly sent: "sent" | "failed"; readonly status?: string }> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  let refusal: string | undefined;
  let status: string | undefined;
  try {
    const panes = await listPanes(run);
    status = panes.find((p) => p.pane_id === pane)?.agent_status;
    refusal = agentRefusal(panes, pane) ?? (status !== undefined && ALIVE_STATUSES.has(status) ? undefined : `pane ${pane} agent is not live (${status ?? "unknown"})`);
  } catch (e) {
    refusal = `pane list unreadable: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
  }
  if (refusal) {
    console.error(`sendVerified ${pane}: not typed: ${refusal}`);
    return { sent: "failed", status };
  }
  return { sent: await typeAndEnter(run, pane, text), status };
};

/** Guarded send without waiting for a status change; the caller confirms delivery some other way (e.g. from the screen). */
export const sendGuarded = async (run: Runner, pane: string, text: string): Promise<"sent" | "failed"> => (await guardedSend(run, pane, text)).sent;

/**
 * Types the text and presses Enter exactly once, and only into a pane whose agent is running: a pane left with a bare
 * shell (or unreadable) gets nothing, since typed text plus Enter would run there as a command. Delivery is confirmed
 * only by a state change: the pane's agent_status moving to "working" from something else. A pane that was already
 * working cannot show that change, so its send comes back "unconfirmed" and the caller decides. The screen is never
 * read here, and Enter is never pressed again.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<Delivery> => {
  const { sent, status } = await guardedSend(run, pane, text);
  if (sent === "failed") return "failed";
  if (status === "working") return "unconfirmed";
  for (let attempt = 0; attempt <= CONFIRM_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await clock.sleep(CONFIRM_BACKOFF_MS[attempt - 1] ?? 1000);
    const after = await statusLookup(run, pane);
    if (after.error) console.error(`sendVerified ${pane}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};
