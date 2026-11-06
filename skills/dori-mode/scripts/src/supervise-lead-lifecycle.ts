import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { FlowDeps } from "./done-flow.ts";
import { leadModels, leadCommand, LEAD_DIET_ARGS, LEAD_DIET_ENV, qualifiedModel } from "./config.ts";
import { eventClass } from "./event-policy.ts";
import { ALIVE_STATUSES, listPanes, type Pane, readScreen, sendGuarded, sendVerified } from "./panes.ts";
import { quoteForPane } from "./launch.ts";
import type { Runner } from "./run.ts";
import { type Carried, completeLines, parseLogLine, readCarried, takeCursor, writeCarried } from "./inbox.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { completeLeadRestart } from "./lead-restart.ts";
import { redactSecrets } from "./redact.ts";
import { launchQueue, launchQueueText } from "./routing.ts";
import type { Durability } from "./store.ts";
import { type AwaitingAck, type Event, type Journal, type JournalCore, type OutboxItem, type Restart, SuperviseError, TransientSuperviseError } from "./supervise-journal.ts";
import { COLD_START_EMOJI, HUNG_EMOJI, latest, OWNER_INBOUND, OWNER_REVISION, type OwnerTracking, type SupervisorHooks } from "./supervise-owner-tracking.ts";

/** Lines read to inspect a paused or stuck lead. */
const LEAD_SCREEN_LINES = 40;

export const LEAD_SKILL = fileURLToPath(new URL("../../SKILL.md", import.meta.url));

const heldLine = (queue: ReturnType<typeof launchQueue>): string =>
  `LAUNCH_QUEUE held launches are still waiting; start each after dori can-launch says CAN_LAUNCH${launchQueueText(queue)}`;

/**
 * A working lead's screen without its animation, which changes on a frozen turn and is not progress: digits (timers,
 * counters), braille, circle, star and dot spinner glyphs, and a lone ASCII spinner frame (| / - \ as its own token).
 */
export const screenStill = (screen: string): string =>
  screen.replace(/[\d\u2800-\u28ff\u25d0-\u25d3\u25f4-\u25f7\u2722-\u273f\u00b7\u2022\u2219\u25cf\u25cb\u25c9\u23fa]/g, "")
    .replace(/(^|\s)[|/\\-](?=\s|$)/gm, "$1");

/** How much of the lead's session file is read from its end to find an open tool call. */
const SESSION_TAIL_BYTES = 256 * 1024;

/** The last SESSION_TAIL_BYTES of the lead's session file; undefined (logged) when it cannot be read. */
const sessionTail = (file: string): string | undefined => {
  try {
    const fd = openSync(file, "r");
    try {
      const size = statSync(file).size;
      const length = Math.min(size, SESSION_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    console.error(`LEAD_SESSION_UNREADABLE ${file}: ${e.message}`);
    return undefined;
  }
};

/** /new keeps argv unchanged; a holder for the same process identifies its newest persisted session. */
const heldSession = (dir: string, pid: number | undefined): { readonly id: string; readonly file: string } | undefined => {
  if (!pid || !existsSync(dir)) return undefined;
  return readdirSync(dir).flatMap((name) => {
    const id = /(?:^|_)([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1];
    if (!id || !existsSync(join(dir, "session-holders", id, `${pid}.json`))) return [];
    const file = join(dir, name);
    try { return [{ id, file, mtime: statSync(file).mtimeMs }]; }
    catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw e;
    }
  }).sort((a, b) => b.mtime - a.mtime)[0];
};

/**
 * When the lead's current tool call started: the newest assistant message in its session ends in a tool call that has
 * no result yet. Undefined when the session is between tool calls (streaming, idle) or unreadable.
 */
export const openToolCallSince = (file: string): number | undefined => {
  const text = sessionTail(file);
  if (text === undefined) return undefined;
  const answered = new Set<string>();
  for (const line of text.trimEnd().split("\n").reverse()) {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (message.role === "toolResult") {
      if (typeof message.toolCallId === "string") answered.add(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const open = message.content.some((part: { type?: unknown; id?: unknown }) => part.type === "toolCall" && typeof part.id === "string" && !answered.has(part.id));
    const at = "timestamp" in entry && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return open && Number.isFinite(at) ? at : undefined;
  }
  return undefined;
};

/**
 * omo's waitingOn.background sources that are the lead's own work a restart would kill: child tasks and detached code
 * cells. Monitors, terminal sessions and queued deliveries are not; the tail monitor alone would hold every restart.
 */
const CHILD_SOURCES: ReadonlySet<string> = new Set(["senpi-task", "senpi-codemode"]);

/** Work the lead's omo session waits on: running children, own background work, and since when it has been waiting. */
export type ChildWork = { readonly children: number; readonly background: number; readonly since: number };

export const childWorkText = (work: ChildWork): string =>
  [work.children ? `${work.children} child task(s)` : "", work.background ? `${work.background} background job(s)` : ""].filter(Boolean).join(" and ");

/**
 * What the lead's session still waits on, from its newest session-lifecycle entry (omo writes one on every state
 * change, e.g. waiting_children with waitingOn.children). `since` is that state's start, else the entry's time.
 * Undefined when it waits on nothing of its own, has no such entry in the tail, or is unreadable.
 */
export const childWork = (file: string): ChildWork | undefined => {
  const text = sessionTail(file);
  if (text === undefined) return undefined;
  for (const line of text.trimEnd().split("\n").reverse()) {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    if (typeof entry !== "object" || entry === null || !("customType" in entry) || entry.customType !== "session-lifecycle" || !("data" in entry)) continue;
    const data = entry.data as { since?: unknown; waitingOn?: { children?: unknown; background?: unknown } };
    const children = typeof data.waitingOn?.children === "number" && data.waitingOn.children > 0 ? data.waitingOn.children : 0;
    const background = (Array.isArray(data.waitingOn?.background) ? data.waitingOn.background as { source?: unknown; activeCount?: unknown }[] : [])
      .filter((item) => typeof item.source === "string" && CHILD_SOURCES.has(item.source))
      .reduce((sum, item) => sum + (typeof item.activeCount === "number" && item.activeCount > 0 ? item.activeCount : 0), 0);
    if (!children && !background) return undefined;
    const stamp = "timestamp" in entry && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const since = typeof data.since === "string" ? Date.parse(data.since) : NaN;
    return { children, background, since: Number.isFinite(since) ? since : Number.isFinite(stamp) ? stamp : 0 };
  }
  return undefined;
};

/** Why an idle lead is cold-started for a delivery instead of taking it in place. */
export type ColdReason = { readonly kind: "hard-cap" | "context-cap" | "stale"; readonly detail: string; readonly tokens: number };

/** omo's footer on a session paused by Esc ("Paused · N updates held · type to continue, /resume to resume"). */
export const PAUSED = /\bPaused\b.*\/resume\b/;

/** The omo input line holds nothing the owner typed: typing /resume cannot submit or mangle their text. */
const emptyInput = (screen: string): boolean => {
  const input = screen.split("\n").reverse().find((line) => line.trimStart().startsWith("\u276f"));
  return input !== undefined && input.trimStart().slice(1).trim() === "";
};

export class LeadLifecycle {
  private resumedAt = 0;

  constructor(
    private readonly core: JournalCore, private readonly owners: OwnerTracking, private readonly hooks: SupervisorHooks,
    private readonly enqueue: (id: string, line: string) => void,
    /** Writes the open lane-outcome and decision lists `dori inbox take` reminds from (they may change in the same pass). */
    private readonly publishObligations: () => void = () => {},
  ) {}

  private get deps(): FlowDeps { return this.core.deps; }
  private set deps(deps: FlowDeps) { this.core.deps = deps; }
  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }
  private get delivered(): Set<string> { return this.core.delivered; }
  private persist(durability?: Durability): void { this.core.persist(durability); }

  private leadConfig(): FlowDeps["config"] {
    return this.journal.models ? { ...this.deps.config, leadModel: this.journal.models[0], leadThinking: undefined } : this.deps.config;
  }

  /** Durable episode clocks (M5): a supervisor restart must not start them over. Saved only on change. */
  private patchJournal(patch: Partial<Pick<Journal, "leadBusySince" | "leadScreen">>): void {
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((key) => JSON.stringify(this.journal[key]) !== JSON.stringify(patch[key]));
    if (!changed) return;
    this.journal = { ...this.journal, ...patch };
    this.persist("normal");
  }

  /** Owner messages handed to the lead with no ack and not handled; `readable` narrows to those whose read window opened. */
  private unacked(readable?: boolean): AwaitingAck[] {
    return (this.journal.awaitingAck ?? []).filter((entry) => !entry.quarantined && entry.ackedAt === undefined && entry.handledAt === undefined &&
      this.delivered.has(latest(entry)) && (readable === undefined || (entry.since !== undefined) === readable));
  }

  /** The lead's session id and file; either is empty/undefined when it cannot be resolved. */
  private async sessionFile(cwd: string): Promise<{ readonly id: string; readonly file?: string }> {
    const hit = await resolveSession(this.deps.config.leadPane, cwd, await procTable(this.deps.run), { run: this.deps.run, sessionsDir: this.deps.config.sessionsDir });
    if (!hit.id) return { id: "" };
    if (existsSync(hit.id)) return { id: hit.id, file: hit.id };
    const dir = sessionDirFor(this.deps.config.sessionsDir, cwd);
    const files = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: dir, absolute: true, onlyFiles: true }));
    return heldSession(dir, hit.pid) ?? { id: hit.id, file: files.find((path) => path.endsWith(`_${hit.id}.jsonl`) || path.endsWith(`/${hit.id}.jsonl`)) };
  }

  /**
   * True when the restart cap refuses an unread-driven restart (stuckRestart, the push ladder). Forced
   * restarts of the last hour count (they still run past the cap). The first refusal of each hour is
   * logged, told to the owner once and journaled for the lead as an urgent LEAD_UNRESPONSIVE event (so its next pointer
   * says why nobody restarts it); the push step keeps re-pushing meanwhile.
   */
  capRefuses(what: string): boolean {
    const { delivery } = this.deps.config;
    const now = this.deps.clock.now();
    const count = this.core.forcedRestartsSince(now);
    if (count < delivery.restartMaxPerHour) return false;
    const hour = Math.floor(now / 3_600_000);
    const inbox = this.journal.inbox;
    if (inbox && inbox.capNotice !== hour) {
      console.log(`LEAD_RESTART_CAPPED ${what}: ${count} forced restarts in the last hour (delivery.restartMaxPerHour ${delivery.restartMaxPerHour}); re-pushing instead`);
      this.journal = { ...this.journal, inbox: { ...inbox, capNotice: hour } };
      this.persist();
      this.enqueue(`lead-unresponsive:${hour}`, `LEAD_UNRESPONSIVE ${what}: you did not take pushed events or handle owner messages, and ${count} forced restarts in the last hour reached delivery.restartMaxPerHour ${delivery.restartMaxPerHour}, so you are not restarted; run dori inbox take now`);
      this.owners.announce(`lead-restart-capped:${hour}`, `The lead is not taking new events, but it was already restarted ${count} times in the last hour, so it is not restarted again for now. The supervisor keeps notifying it.`);
    }
    return true;
  }

  /**
   * An idle lead paused by Esc (omo holds every monitor event, so the delivery log never wakes it) with an owner message
   * unacked past the ack window is resumed: `/resume` is typed once per ack window, only into an empty input line.
   * One that stays silent is restarted by the push ladder after push.escalateMin.
   */
  async resumePaused(readPane = async (): Promise<Pane | undefined> =>
    (await listPanes(this.deps.run)).find((p) => p.pane_id === this.deps.config.leadPane)): Promise<void> {
    const { config, clock, run } = this.deps;
    const now = clock.now();
    const window = config.ackTimeoutSec * 1000;
    if (now - this.resumedAt < window) return;
    if (!this.unacked(true).some((entry) => now - (entry.since ?? now) >= window)) return;
    const pane = await readPane();
    if (!pane?.agent || (pane.agent_status !== "idle" && pane.agent_status !== "done")) return;
    const screen = await readScreen(run, config.leadPane, LEAD_SCREEN_LINES);
    if (!PAUSED.test(screen)) return;
    this.resumedAt = now;
    if (!emptyInput(screen)) {
      console.log(`LEAD_PAUSED_INPUT ${config.leadPane}: paused with text in its input; not typing, restart follows after ${config.delivery.push.escalateMin} min`);
      return;
    }
    console.log(`LEAD_RESUMED ${config.leadPane} ${await sendVerified(run, clock, config.leadPane, "/resume")}`);
  }

  /**
   * A lead that stays blocked (an approval prompt) while owner messages handed to it stay unread (no read window, no
   * ack) for leadStuckRestartMin is cold-restarted with them, and the owner is told. A working lead may be in a long
   * build or review, so it counts only while its screen has also not changed for that long (a hung turn). Measured from
   * the latest of the oldest unread message, the first time the lead was seen busy with it, and the last screen change;
   * those clocks are journaled, so a supervisor restart does not reset them.
   * A faster rule uses push.escalateMin: a working lead held inside one tool call (a foreground wait or watch cannot
   * take a pushed pointer until it returns), counted from the later of the call's start and the oldest unacked message.
   * A working lead whose process is identified but whose session file is not found (no tool-call evidence either way)
   * gets the same clock from the oldest unacked message, not the 30 min rule. One whose process cannot be identified
   * keeps the 30 min rule: stopLead refuses to stop an unidentified lead. An idle lead is left to the push ladder.
   */
  async stuckRestart(pending: readonly Event[], readPane = async (): Promise<Pane | undefined> =>
    (await listPanes(this.deps.run)).find((p) => p.pane_id === this.deps.config.leadPane)): Promise<boolean> {
    const { config, clock, run } = this.deps;
    const limit = config.leadStuckRestartMin * 60_000;
    if (!(limit > 0)) return false;
    // The push ladder owns idle leads, and one tool call is clocked by push.escalateMin (supervise-push.ts).
    const unreadLimit = config.delivery.push.escalateMin * 60_000;
    const waiting = this.unacked();
    if (!waiting.length) { this.patchJournal({ leadBusySince: undefined, leadScreen: undefined }); return false; }
    const now = clock.now();
    const pane = await readPane();
    if (!pane?.agent) { this.patchJournal({ leadBusySince: undefined, leadScreen: undefined }); return false; }
    const restart = async (status: string, minutes: number, count: number): Promise<boolean> => {
      // The cap is checked before anything is announced: a refused restart must not tell the owner it is happening.
      if (this.capRefuses(`stuck ${status}`)) return false;
      this.patchJournal({ leadBusySince: undefined, leadScreen: undefined });
      const session = randomUUID();
      console.log(`LEAD_STUCK_RESTART ${config.leadPane} ${status} ${minutes} min, ${count} owner message(s) unread`);
      await this.noteRestart("stuck", `${status} ${minutes} min with ${count} owner message(s) unread`, pane.cwd ?? config.defaultCwd);
      this.owners.announce(`lead-stuck:${session}`, `The lead has been stuck (${status}) for ${minutes} min without reading your messages, so it is being restarted; your unanswered messages go to the new lead.`);
      this.setRestart({
        session, events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size,
        phase: "stopping", force: true,
        reason: `it was stuck ${status} for ${minutes} min with ${count} owner message(s) unread, so the supervisor restarted it`,
      });
      return true;
    };
    const at = (ids: ReadonlySet<string>): number[] => this.journal.events.filter((event) => ids.has(event.id) && event.at !== undefined).map((event) => event.at ?? 0);
    if (pane.agent_status === "idle" || pane.agent_status === "done") {
      this.patchJournal({ leadBusySince: undefined, leadScreen: undefined });
      return false;
    }
    if (pane.agent_status === "working") {
      // A lead inside one tool call cannot take a monitor event until the call returns: a foreground wait, watch or
      // sleep. Owner messages must not wait for it, however busy its screen looks.
      // A probe that cannot resolve the session must not stop delivery: the other rules still apply.
      let file: string | undefined;
      let id = "";
      try { ({ id, file } = await this.sessionFile(pane.cwd ?? config.defaultCwd)); } catch (e) {
        if (!(e instanceof Error)) throw e;
        console.error(`LEAD_SESSION_UNRESOLVED ${config.leadPane}: ${e.message}`);
      }
      const call = file ? openToolCallSince(file) : undefined;
      const times = at(new Set(waiting.map(latest)));
      if (call !== undefined && times.length) {
        const since = Math.max(Math.min(...times), call);
        if (now - since >= unreadLimit) return await restart("in one tool call", Math.round((now - since) / 60_000), waiting.length);
      } else if (id && !file && times.length) {
        // The lead process is identified (a restart can stop it) but its session file is not: no tool-call evidence.
        const since = Math.min(...times);
        if (now - since >= unreadLimit) return await restart("with its session unresolved", Math.round((now - since) / 60_000), waiting.length);
      }
    }
    const unread = new Set(this.unacked(false).map(latest));
    const times = at(unread);
    if (!times.length) { this.patchJournal({ leadBusySince: undefined, leadScreen: undefined }); return false; }
    const busySince = this.journal.leadBusySince ?? now;
    this.patchJournal({ leadBusySince: busySince });
    let since = Math.max(Math.min(...times), busySince);
    if (pane.agent_status === "working") {
      const hash = Bun.hash(screenStill(await readScreen(run, config.leadPane, LEAD_SCREEN_LINES))).toString(16);
      if (this.journal.leadScreen?.hash !== hash) this.patchJournal({ leadScreen: { hash, since: now } });
      since = Math.max(since, this.journal.leadScreen?.since ?? now);
    } else if (this.journal.leadScreen) this.patchJournal({ leadScreen: undefined });
    if (now - since < limit) return false;
    return await restart(pane.agent_status ?? "unknown", Math.round((now - since) / 60_000), unread.size);
  }

  setRestart(restart: Restart | undefined): void {
    if (restart?.phase === "stopping") {
      this.owners.consumeReceipts();
      // Unfinished owner messages travel in their latest revision; deleted ones never reach the new lead.
      const awaiting = this.journal.awaitingAck ?? [];
      const deleted = new Set(awaiting.filter((entry) => entry.deleted).map((entry) => entry.id));
      const unfinished = new Set(awaiting.filter((entry) => entry.handledAt === undefined && !entry.quarantined).map(latest));
      const events = new Map(restart.events.filter((event) => !deleted.has(event.id)).map((event) => [event.id, event]));
      for (const event of this.journal.events) if (unfinished.has(event.id)) events.set(event.id, event);
      restart = { ...restart, events: [...events.values()] };
    }
    this.journal = { ...this.journal, restart };
    this.persist();
  }

  /**
   * Recreate a vanished lead pane like dori-boot-prep.sh: a tab in the "Dori" workspace at defaultCwd.
   * The runtime leadPane changes and persistLeadPane writes it back to the loaded config. Returns the new
   * pane id, or undefined when the pane exists or cannot be recreated cleanly (retries continue).
   */
  async repairLeadPane(): Promise<string | undefined> {
    const { run, config } = this.deps;
    if ((await listPanes(run)).some((p) => p.pane_id === config.leadPane)) return undefined;
    const pane = await this.createLeadPane();
    if (!pane) return undefined;
    // A launch submitted into the vanished pane can never confirm there; the same events get a fresh session in the new one.
    const pending = this.journal.restart;
    if (pending?.phase === "submitted") this.abandon(pending);
    console.log(`LEAD_PANE_RECREATED ${config.leadPane} -> ${pane}`);
    return pane;
  }

  /** Move a restart to a fresh session id (phase starting) with the same events and offset; drops the old prompt file. */
  private abandon(restart: Restart): Restart {
    const old = join(this.deps.config.stateDir, `lead-${restart.session}.md`);
    if (existsSync(old)) unlinkSync(old);
    const next: Restart = { ...restart, session: randomUUID(), phase: "starting", unconfirmed: 0 };
    this.setRestart(next);
    return next;
  }

  /**
   * A new "dori-lead" tab in the Dori workspace at defaultCwd, persisted as the lead pane. herdr removes a workspace
   * together with its last pane, so closing the lead by hand can take the Dori workspace with it: then the workspace is
   * created again, as dori-boot-prep.sh does, and its root pane becomes the lead. Undefined, with herdr's reason logged,
   * when herdr refuses.
   */
  private async createLeadPane(): Promise<string | undefined> {
    const { run, config } = this.deps;
    const refused = (what: string, result: { readonly out: string; readonly err: string }): undefined => {
      console.error(`LEAD_PANE_CREATE_FAILED ${what}: ${result.err || result.out}`);
      return undefined;
    };
    const listed = await run(["herdr", "workspace", "list"]);
    if (listed.code !== 0) return refused("herdr workspace list", listed);
    const workspace = (JSON.parse(listed.out) as { result: { workspaces: { label?: string; workspace_id: string }[] } }).result.workspaces.find((w) => w.label === "Dori");
    let pane: string | undefined;
    if (workspace) {
      const made = await run(["herdr", "tab", "create", "--workspace", workspace.workspace_id, "--cwd", config.defaultCwd, "--label", "dori-lead"]);
      if (made.code !== 0) return refused(`herdr tab create in ${workspace.workspace_id}`, made);
      pane = (JSON.parse(made.out) as { result: { root_pane: { pane_id?: string } } }).result.root_pane.pane_id;
    } else {
      const made = await run(["herdr", "workspace", "create", "--label", "Dori", "--cwd", config.defaultCwd, "--no-focus"]);
      if (made.code !== 0) return refused("herdr workspace create Dori", made);
      const root = (JSON.parse(made.out) as { result: { root_pane: { pane_id?: string; tab_id?: string; workspace_id?: string } } }).result.root_pane;
      pane = root.pane_id;
      console.log(`LEAD_WORKSPACE_RECREATED ${root.workspace_id ?? "?"}`);
      if (root.tab_id) {
        const renamed = await run(["herdr", "tab", "rename", root.tab_id, "dori-lead"]);
        if (renamed.code !== 0) console.error(`LEAD_TAB_RENAME_FAILED ${root.tab_id}: ${renamed.err || renamed.out}`);
      }
    }
    if (!pane) return refused("herdr returned no pane id", { out: "", err: "" });
    this.deps = { ...this.deps, config: { ...config, leadPane: pane } };
    try { this.hooks.persistLeadPane?.(pane); } catch (e) {
      console.error(`LEAD_PANE_PERSIST_FAILED ${pane}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return pane;
  }

  /** The lead pane's last 80 lines, saved to the state dir: the only evidence of why a start failed once the pane is gone. */
  private async saveLeadScreen(): Promise<void> {
    const { run, config, clock } = this.deps;
    const pane = config.leadPane;
    const screen = await run(["herdr", "pane", "read", pane, "--source", "recent", "--lines", "80"]);
    if (screen.code !== 0) {
      console.error(`LEAD_PANE_SCREEN_UNREADABLE ${pane}: ${screen.err || screen.out}`);
      return;
    }
    const path = join(config.stateDir, `lead-pane-${pane.replace(/[^\w.-]/g, "_")}-${clock.now()}.txt`);
    const fd = openSync(path, "w", 0o600);
    try { writeFileSync(fd, redactSecrets(screen.out)); fsyncSync(fd); } finally { closeSync(fd); }
    console.log(`LEAD_PANE_SCREEN_SAVED ${pane} ${path}`);
  }

  /**
   * Replace an existing lead pane whose launch never confirmed (its screen is saved first by the caller). Only a pane
   * left with a plain shell is closed, after the new tab exists; any other foreground process is not the supervisor's
   * and the pane is kept. Returns the new pane id.
   */
  private async replaceLeadPane(): Promise<string | undefined> {
    const { run, config } = this.deps;
    const old = config.leadPane;
    const info = await processInfo(this.deps);
    if (!info || !plainShell(info)) {
      console.log(`LEAD_PANE_KEPT ${old}: foreground is not a plain shell`);
      return undefined;
    }
    const pane = await this.createLeadPane();
    if (!pane) {
      console.error(`LEAD_PANE_RECREATE_FAILED ${old}`);
      return undefined;
    }
    const closed = await run(["herdr", "pane", "close", old]);
    if (closed.code !== 0) console.error(`LEAD_PANE_CLOSE_FAILED ${old}: ${closed.err || closed.out}`);
    console.log(`LEAD_PANE_RECREATED ${old} -> ${pane}`);
    return pane;
  }

  /** The session file the last coldReason() resolved: a warm wake is recorded against it. */
  warmSession = "";

  /** Why the idle lead must be cold-started for a delivery now, or undefined when it is warm and takes it in place. */
  async coldReason(cwd: string): Promise<ColdReason | undefined> {
    const { config, clock } = this.deps;
    const { id, file } = await this.sessionFile(cwd);
    if (!id) throw new TransientSuperviseError("cannot resolve idle lead session; refusing an unproven cold restart");
    if (!file) throw new TransientSuperviseError(`cannot find lead session file for ${id}`);
    this.warmSession = file;
    const tokens = this.leadTokens(file);
    // Idle at delivery time (checked by the caller): a lead past the hard cap restarts even with a warm cache.
    if (tokens >= config.leadContextHardCapTokens) return { kind: "hard-cap", tokens, detail: `context ${tokens} tokens reached leadContextHardCapTokens ${config.leadContextHardCapTokens}` };
    const idleMs = clock.now() - statSync(file).mtimeMs;
    const idle = `idle ${Math.floor(idleMs / 60_000)} min`;
    // A lead at or above the context cap always restarts at this safe point (idle, its own children done), warm cache or not.
    if (tokens >= config.leadContextCapTokens) return { kind: "context-cap", tokens, detail: `context ${tokens} tokens at or above leadContextCapTokens ${config.leadContextCapTokens} (${idle}, cache ${idleMs < config.cacheTtlMin * 60_000 ? "warm" : "stale"})` };
    if (idleMs < config.cacheTtlMin * 60_000) return undefined;
    const stale = `${idle} (past cacheTtlMin ${config.cacheTtlMin})`;
    // Pending waits and working lanes do not keep a stale lead: their events stay in the log past the take cursor, and
    // the fresh lead is reminded of open decisions and unreported lane outcomes until it settles them.
    return { kind: "stale", tokens, detail: stale };
  }

  /** What the lead's own session still waits on; undefined when nothing, or when its session cannot be resolved (logged). */
  async childWorkOf(cwd: string): Promise<ChildWork | undefined> {
    try {
      const { file } = await this.sessionFile(cwd);
      return file ? childWork(file) : undefined;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      console.error(`LEAD_SESSION_UNRESOLVED ${this.deps.config.leadPane}: ${e.message}`);
      return undefined;
    }
  }

  /** Per trigger kind, the child wait whose deferral was logged: each wait is logged once per kind. */
  private readonly deferrals = new Map<string, number>();

  /**
   * A restart that may wait (a lead-restart request, a cold or context-cap start) waits while the idle lead's session
   * still waits on its own children: stopping the lead would kill them and lose their results. It waits at most
   * leadChildWaitMaxMin from when the lead began waiting, so a hung child cannot hold the lead forever. Each wait is
   * logged once per trigger kind; its expiry every time it lets a restart through.
   */
  async deferForChildren(cwd: string, kind: string, detail: string): Promise<boolean> {
    const work = await this.childWorkOf(cwd);
    if (!work) return false;
    const { clock, config } = this.deps;
    const minutes = Math.floor((clock.now() - work.since) / 60_000);
    if (clock.now() - work.since >= config.leadChildWaitMaxMin * 60_000) {
      console.log(`LEAD_CHILD_WAIT_EXPIRED ${kind}: the lead has waited on ${childWorkText(work)} for ${minutes} min (leadChildWaitMaxMin ${config.leadChildWaitMaxMin}); restarting it anyway`);
      return false;
    }
    if (this.deferrals.get(kind) !== work.since) {
      this.deferrals.set(kind, work.since);
      console.log(`LEAD_RESTART_DEFERRED ${kind} ${detail}: the lead waits on ${childWorkText(work)} for ${minutes} min; deferred up to leadChildWaitMaxMin ${config.leadChildWaitMaxMin}, events delivered in place`);
    }
    return true;
  }

  /** Every restart is logged with its trigger before it starts; given the lead's cwd, it also names the children it stops. */
  async noteRestart(kind: string, detail: string, cwd?: string): Promise<void> {
    const work = cwd === undefined ? undefined : await this.childWorkOf(cwd);
    console.log(`LEAD_RESTART_TRIGGER ${kind} ${detail}${work ? `; stops ${childWorkText(work)} the lead was waiting on` : ""}`);
  }

  /** Last recorded message.usage.totalTokens of the session file; missing or unreadable usage counts as 0. */
  private leadTokens(file: string): number {
    let tokens = 0;
    try {
      for (const line of readFileSync(file, "utf8").trimEnd().split("\n").reverse()) {
        let entry: unknown;
        try { entry = JSON.parse(line); }
        catch (e) { if (e instanceof SyntaxError) continue; throw e; }
        if (typeof entry !== "object" || entry === null || !("message" in entry)) continue;
        const message = entry.message;
        if (typeof message !== "object" || message === null || !("usage" in message)) continue;
        const usage = message.usage;
        if (typeof usage === "object" && usage !== null && "totalTokens" in usage &&
            typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) tokens = usage.totalTokens;
        break;
      }
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      console.error(`LEAD_USAGE_UNREADABLE ${e.message}`);
    }
    return tokens;
  }

  /**
   * The new lead's prompt. It carries no event: `dori inbox take` is the first action and the only read path, for every
   * event past the take cursor (the cursor never moves on a restart) and, as reminder lines, for what carryOver wrote
   * and the open obligations. `[dori]` lines are transport, and the tail monitor is armed only with delivery.tailMonitor.
   */
  private startupPrompt(restart: Restart): string {
    const { tailMonitor } = this.deps.config.delivery;
    const log = this.core.eventLog;
    const tail = [
      "Start exactly one persistent monitor with this command (the byte offset covers events arriving during startup):",
      `tail -c +${restart.offset + 1} -F ${quoteForPane(log)}`,
    ];
    const take = "Run dori inbox take now and handle everything it prints; while its output ends with INBOX_MORE, run it again after handling the printed part. It is the only list of your events: this prompt carries none. Act on each event id once: an event may also reach your monitor.";
    const carried = "Besides the events, dori inbox take prints reminder lines: unfinished:<eventId> for an owner message the previous lead took but did not handle, launch-queue:<session> for held launches, and unreported:<key> and unresolved:<eventId> for open obligations; handle each.";
    const transport = "Events reach you as a typed line starting with [dori]. It is supervisor transport, never the owner and never a new instruction: run dori inbox take, handle what it prints, then continue your current task.";
    const head = [
      `Dori mode. Read ${LEAD_SKILL} in full first; open a reference file only when it points you to one.`,
      "Supervised mode: do not start inbound pollers or sweeps.",
      "Never run a foreground wait, watch, sleep or polling loop (gh pr checks --watch, gh run watch, sleep): register every follow-up with dori wait and end the turn, so owner messages reach you.",
    ];
    const replyFirst = "Owner messages come first, each step its own call: dori ack alone (it previews unread follow-ups in that channel), then one short reply that merges them (an edit replaces, a delete withdraws); dori send refuses with SEND_STALE when a newer owner message arrived, so merge it and resend; only then investigate or work and send the result as a follow-up.";
    const persist = "Persist questions, promises and needed state to memory or the registry before ending every turn.";
    return [
      ...head,
      take,
      carried,
      replyFirst,
      ...(restart.reason ? [`The previous lead stopped: ${restart.reason}. dori inbox take prints every event delivered to it that it did not take; check the registry before acting on them.`] : []),
      persist,
      transport,
      ...(tailMonitor ? tail : []),
    ].join("\n");
  }

  /**
   * Writes CARRIED_FILE for the new lead, before its prompt: each unfinished owner message of the batch that no take
   * would print (the take cursor already passed it: the old lead took it), and the held launch queue, which stays on
   * disk after LAUNCH_READY lowered the flag, so a restart before the old lead started them cannot forget them.
   */
  private carryOver(restart: Restart): void {
    const { stateDir } = this.deps.config;
    const untaken = new Set(completeLines(this.core.eventLog, takeCursor(stateDir) ?? 0).map((line) => parseLogLine(line.text).id));
    const owner: Carried[] = restart.events
      .filter((event) => (OWNER_INBOUND.test(event.id) || OWNER_REVISION.test(event.id)) && !untaken.has(event.id))
      .map((event) => ({ kind: "owner", id: event.id, line: event.line }));
    const queue = launchQueue(stateDir);
    writeCarried(stateDir, [...owner, ...(queue.length ? [{ kind: "held" as const, id: `launch-queue:${restart.session}`, line: heldLine(queue) }] : [])]);
    this.publishObligations();
  }

  /** Prunes CARRIED_FILE: an owner message leaves once handled, deleted or edited again; the queue once it is empty. */
  refreshCarried(): void {
    const { stateDir } = this.deps.config;
    const carried = readCarried(stateDir);
    if (!carried.length) return;
    const open = new Set((this.journal.awaitingAck ?? []).filter((entry) => entry.handledAt === undefined && !entry.quarantined).map(latest));
    let queue: ReturnType<typeof launchQueue> | undefined;
    const next = carried.flatMap((item): Carried[] => {
      if (item.kind === "owner") return open.has(item.id) ? [item] : [];
      queue ??= launchQueue(stateDir);
      return queue.length ? [{ ...item, line: heldLine(queue) }] : [];
    });
    if (JSON.stringify(next) !== JSON.stringify(carried)) writeCarried(stateDir, next);
  }

  async restart(restart: Restart): Promise<void> {
    const { deps } = this;
    const promptSession = restart.phase.startsWith("soft-ready:") ? restart.phase.slice("soft-ready:".length) : restart.session;
    const promptPath = join(deps.config.stateDir, `lead-${promptSession}.md`);
    let soft = restart.phase.startsWith("soft-ready:");
    let sendSoft = false;
    let softStartedAt: number | undefined;
    if (soft && !(await softLive(deps))) {
      console.log("LEAD_SOFT_RESTART_FAILED reused lead is not ready; falling back to a process restart");
      restart = { ...restart, session: promptSession, phase: "soft-failed" };
      this.setRestart(restart);
      soft = false;
    }
    if (restart.phase === "stopping" && !restart.force) {
      const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
      if (pane?.agent && (pane.agent_status === "idle" || pane.agent_status === "done")) {
        const hit = await resolveSession(deps.config.leadPane, pane.cwd ?? deps.config.defaultCwd, await procTable(deps.run), { run: deps.run, sessionsDir: deps.config.sessionsDir });
        const latest = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
        if (hit.pid && latest?.agent && (latest.agent_status === "idle" || latest.agent_status === "done")) {
          const old = (await this.sessionFile(pane.cwd ?? deps.config.defaultCwd)).id || hit.id;
          if (restart.request) this.journal = { ...this.journal, models: restart.request.models };
          softStartedAt = deps.clock.now();
          this.owners.record(restart.events);
          restart = { ...restart, offset: statSync(this.core.eventLog).size, phase: `soft:${old}` };
          this.setRestart(restart);
          this.owners.react(restart.events, [["add", COLD_START_EMOJI]]);
          sendSoft = true;
        }
      }
    }
    if (restart.phase.startsWith("soft:")) {
      const old = restart.phase.slice("soft:".length);
      // The reused lead gets the prompt itself, on one line so a single Enter submits it. A file named in a "Read it"
      // prompt is removed once the restart is confirmed, which can be before the new lead's first tool call reads it.
      const softPrompt = this.startupPrompt(restart).split("\n").join(" ");
      try {
        if (sendSoft) {
          this.carryOver(restart);
          const entry = leadModels(this.leadConfig())[0];
          if (!entry) throw new TransientSuperviseError("soft restart model is missing");
          await softCommand(deps, "/new");
          // The editor is back before omo has switched to the new session; anything typed meanwhile lands in the old
          // session or is lost, so the next command waits until the new session has finished starting.
          const started = await softSessionStarted(deps, old, softStartedAt);
          if (!started) throw new TransientSuperviseError("new session did not start after /new");
          // /new keeps the process's model and thinking. A bare lead model is compared, and typed, as provider/model:
          // omo's /model picker does not submit a bare name on the first Enter.
          const current = sessionModel(started);
          const model = qualifiedModel(entry.model, current.model, [leadModels(deps.config)[0]?.model, deps.config.defaultModel]);
          const commands = [
            ...(current.model === model ? [] : [`/model ${model}`]),
            ...(entry.thinking && current.thinking !== entry.thinking ? [`/thinking ${entry.thinking}`] : []),
          ];
          for (const command of commands) await softCommand(deps, command);
          await softCommand(deps, softPrompt, true);
        }
        // A soft start journaled before the prompt was typed inline is recognised by its file path.
        const session = await softEvidence(deps, old, [JSON.stringify(softPrompt).slice(1, -1), promptPath], softStartedAt);
        if (!session) throw new TransientSuperviseError("no new session containing the startup prompt path");
        const table = await procTable(deps.run);
        const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
        const hit = await resolveSession(deps.config.leadPane, pane?.cwd ?? deps.config.defaultCwd, table, { run: deps.run, sessionsDir: deps.config.sessionsDir });
        if (!hit.pid) throw new TransientSuperviseError("cannot identify reused lead process");
        const targets = await ownedTargets(deps, table, undefined, old);
        const protectedPids = new Set<number>();
        for (let pid: number | undefined = hit.pid; pid && !protectedPids.has(pid); pid = table.find((p) => p.pid === pid)?.ppid) protectedPids.add(pid);
        for (const pid of protectedPids) targets.delete(pid);
        await killTargets(deps, targets);
        restart = { ...restart, session, phase: `soft-ready:${restart.session}` };
        this.setRestart(restart);
        soft = true;
        console.log(`LEAD_SOFT_RESTARTED ${deps.config.leadPane} ${session}`);
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        console.log(`LEAD_SOFT_RESTART_FAILED ${e.message.replace(/\s+/g, " ")}; falling back to a process restart`);
        restart = { ...restart, phase: "soft-failed" };
        this.setRestart(restart);
      }
    }
    if (restart.phase === "stopping" || restart.phase === "soft-failed") {
      const softFailed = restart.phase === "soft-failed";
      if (!(await stopLead(deps, softFailed || restart.force))) {
        // The lead woke while identity/ownership was being resolved. Deliver
        // warm rather than interrupting it or abandoning the queued event.
        if (!softFailed) this.owners.record(restart.events);
        this.setRestart(undefined);
        return;
      }
      // The restart cap counts forced restarts once the lead really stopped; an owner's request and a
      // demand-driven cold start never count.
      if (!restart.request && restart.force) this.core.noteForcedRestart("forced");
      if (restart.request) {
        this.journal = { ...this.journal, models: restart.request.models };
      }
      // Log the cold batch before launch. The old monitor is gone. The new lead
      // takes these lines with dori inbox take and tails strictly after this batch.
      if (!softFailed) {
        this.owners.record(restart.events);
        restart = { ...restart, offset: statSync(this.core.eventLog).size };
      }
      restart = { ...restart, phase: "starting" };
      this.setRestart(restart);
      if (!softFailed) this.owners.react(restart.events, [["add", COLD_START_EMOJI]]);
    }
    if (restart.phase === "starting") {
      this.carryOver(restart);
      const prompt = this.startupPrompt(restart);
      // `pane run` types the command: into anything but a plain shell it lands in that program's input
      // (e.g. an agent started by hand). Checked before "submitted", so a refusal retries cleanly.
      // Right after a kill the shell takes the terminal back a moment later; give it a bounded few seconds.
      let info = await processInfo(deps);
      for (let attempt = 0; attempt < 10 && info && !plainShell(info); attempt++) {
        await deps.clock.sleep(500);
        info = await processInfo(deps);
      }
      if (!info) throw new TransientSuperviseError(`cannot verify a plain shell in lead pane ${deps.config.leadPane}; lead launch not sent`);
      if (!plainShell(info)) {
        const fg = (info.foreground_processes ?? []).filter((p) => p.pid !== info.shell_pid).map((p) => p.argv?.[0] ?? `pid ${p.pid ?? "?"}`).join(", ");
        throw new TransientSuperviseError(`LEAD_PANE_BUSY ${deps.config.leadPane}: foreground is not a plain shell (${fg || `process group ${info.foreground_process_group_id}`}); refusing to type the lead launch into it`);
      }
      // Persist intent before admission. On an uncertain response, recovery only
      // verifies this exact session; it never blindly submits the prompt twice.
      restart = { ...restart, phase: "submitted" };
      this.setRestart(restart);
      // File inclusion avoids the terminal's canonical input line limit for a
      // burst of events or a full-length multibyte Discord message.
      const fd = openSync(promptPath, "w", 0o600);
      try { writeFileSync(fd, prompt); fsyncSync(fd); } finally { closeSync(fd); }
      const agent = leadCommand(this.leadConfig(), `@${promptPath}`);
      const executable = agent[0];
      if (!executable) throw new SuperviseError("agentCommand must name an executable");
      const argv = [
        "env", "DORI_SUPERVISED=1", ...(deps.config.leadDiet ? LEAD_DIET_ENV : []), executable, "--session-id", restart.session,
        "--session-dir", sessionDirFor(deps.config.sessionsDir, deps.config.defaultCwd),
        ...deps.config.leadArgs, ...(deps.config.leadDiet ? LEAD_DIET_ARGS : []), ...agent.slice(1),
      ];
      const launched = await deps.run(["herdr", "pane", "run", deps.config.leadPane, `cd ${quoteForPane(deps.config.defaultCwd)} && ${argv.map(quoteForPane).join(" ")}`]);
      if (launched.code !== 0) throw new TransientSuperviseError(`lead launch admission unconfirmed: ${launched.err || launched.out}; pending session ${restart.session}`);
    }
    let confirmed = soft ? await softLive(deps) : await confirmLead(deps, restart.session);
    if (soft && !confirmed) {
      console.log("LEAD_SOFT_RESTART_FAILED reused lead lost readiness; falling back to a process restart");
      const next: Restart = { ...restart, session: promptSession, phase: "soft-failed" };
      this.setRestart(next);
      return this.restart(next);
    }
    if (!confirmed) {
      const unconfirmed = (restart.unconfirmed ?? 0) + 1;
      restart = { ...restart, unconfirmed };
      this.setRestart(restart);
      // A session with startup evidence did initialise (it may be blocked on a dialog or show a provider error):
      // it is never killed or given a second copy of the events; a human inspects it.
      if (unconfirmed < UNCONFIRMED_LIMIT || hasStartupEvidence(deps, restart.session)) {
        throw new TransientSuperviseError(`STARTUP_UNCONFIRMED ${restart.session}; events retained, inspect the lead before retrying`);
      }
      // This session never initialised and will not confirm. Save the screen while the failure is still on it, stop
      // exactly its tree, replace the pane when only a shell is left, and give the same events and offset a fresh
      // session, as a hung start does. The launch guard protects a kept pane.
      await this.saveLeadScreen();
      await stopHung(deps, restart.session);
      const pane = await this.replaceLeadPane();
      const next = this.abandon(restart);
      console.log(`LEAD_STARTUP_ABANDONED ${restart.session} -> ${next.session}`);
      throw new TransientSuperviseError(`STARTUP_UNCONFIRMED ${restart.session} after ${unconfirmed} checks; ${pane ? `lead pane recreated as ${pane}` : "lead pane kept"}, relaunching as ${next.session}`);
    }
    if (!soft && !(await awaitStartupEvidence(deps, restart.session))) {
      // The process answered herdr but omo never initialised (no holder file, no session jsonl).
      // Stop exactly that process tree; the same events and tail offset go to a fresh session.
      await stopHung(deps, restart.session);
      if (existsSync(promptPath)) unlinkSync(promptPath);
      const strikes = (restart.strikes ?? 0) + 1;
      const next: Restart = { ...restart, session: randomUUID(), strikes, phase: "starting", unconfirmed: 0 };
      this.setRestart(next);
      if (strikes === 1) {
        console.log(`LEAD_STARTUP_HUNG_RETRY ${restart.session}`);
        return this.restart(next);
      }
      console.log(`LEAD_STARTUP_HUNG ${restart.session}`);
      this.owners.react(restart.events, [["remove", COLD_START_EMOJI], ["add", HUNG_EMOJI]]);
      throw new TransientSuperviseError(`LEAD_STARTUP_HUNG ${restart.session}; events retained, relaunch deferred to backoff`);
    }
    // The new lead can read now: every message handed to it (in its log or carried over) and still waiting for its ack gets a
    // fresh window from here, so neither a cold-start batch nor a message the old lead never acked is escalated while
    // this lead boots. A message that arrived during startup and is not delivered yet gets its window when it is.
    // A posted notice stays posted, and so does a reminder: the new lead gets the message in its handoff, so it is never
    // reminded with ACK_MISSING a second time (one reminder per message, however many restarts).
    const ready = deps.clock.now();
    this.journal = {
      ...this.journal,
      awaitingAck: this.journal.awaitingAck?.map((entry) => entry.quarantined || !this.delivered.has(latest(entry)) ? entry : {
        ...entry, since: ready,
        ...(entry.ackedAt !== undefined && entry.handledAt === undefined ? { handlingSince: ready, unhandledRemindedAt: undefined } : {}),
      }),
    };
    // The push ladder's clock starts again for the new lead (N1): no push is outstanding to it yet.
    if (this.journal.inbox) this.journal = { ...this.journal, inbox: { ...this.journal.inbox, sessionSince: ready, push: undefined } };
    this.setRestart(undefined);
    const policy = deps.config.eventPolicy;
    const urgent = restart.events.filter((event) => eventClass(event.line, policy) === "lead-urgent");
    this.core.wakes.record(restart.session, restart.events, urgent.length ? urgent : restart.events);
    if (restart.request) completeLeadRestart(deps.config.stateDir, restart.request.id);
    if (existsSync(promptPath)) unlinkSync(promptPath);
    console.log(`LEAD_RESTARTED ${deps.config.leadPane} ${restart.session}`);
    // The hourglass is left in place on purpose. LEAD_RESTARTED only means the new process initialised; the lead
    // still has to read its skill before it can answer. It hands the status over itself, removing the hourglass
    // and adding its eyes back to back as its first action, so the owner never sits on an unreacted gap and the
    // hourglass never outlives a start that failed to get going.
  }
}

export const UNCONFIRMED_LIMIT = 5;

type ForegroundProcess = { readonly pid?: number; readonly argv?: readonly string[] };
type ProcessInfo = { readonly shell_pid?: number; readonly foreground_process_group_id?: number; readonly foreground_processes?: readonly ForegroundProcess[] };

const STARTUP_ERROR = /Cannot find module|All fallback models failed|No API key|model_not_available|No model matching|usage limit|rate limit|quota|Session crashed|unknown provider/i;

const softLive = async (deps: FlowDeps): Promise<boolean> => {
  const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
  return !!pane?.agent && ALIVE_STATUSES.has(pane.agent_status ?? "");
};

/**
 * Submit, then observe a completed interactive command before submitting the next one. Typing alone changes the screen,
 * and omo's argument autocomplete takes the first Enter to accept its selection, leaving the command in the editor;
 * a command still shown there gets Enter again, so the next command is never typed onto the same line.
 */
const softCommand = async (deps: FlowDeps, command: string, prompt = false): Promise<void> => {
  const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
  if (!pane?.agent || (pane.agent_status !== "idle" && pane.agent_status !== "done")) throw new TransientSuperviseError("lead left idle/done before soft command");
  const before = await readScreen(deps.run, deps.config.leadPane);
  const previous = new Set(before.split("\n"));
  let enterFailed = false;
  const run: FlowDeps["run"] = async (argv, options) => {
    const result = await deps.run(argv, options);
    if (argv[2] === "send-keys" && result.code !== 0) enterFailed = true;
    return result;
  };
  if (await sendGuarded(run, deps.config.leadPane, command) === "failed" || enterFailed) throw new TransientSuperviseError("soft command send failed");
  if (prompt) return;
  const deadline = deps.clock.now() + 5_000;
  let enters = 1;
  for (let attempt = 0; attempt <= 25; attempt++) {
    const after = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
    const screen = await readScreen(deps.run, deps.config.leadPane);
    const addedLines = screen.split("\n").filter((line) => !previous.has(line));
    // omo's herdr integration can release the pane's agent once /new has shut the old session down; that is /new
    // taking effect, and softSessionStarted waits for the agent to come back.
    if (command === "/new" && !after?.agent) return;
    if (!after?.agent || (after.agent_status !== "idle" && after.agent_status !== "done") || STARTUP_ERROR.test(addedLines.join("\n"))) throw new TransientSuperviseError("lead not ready after soft command");
    if (addedLines.some((line) => line.includes(command))) {
      if (enters >= 3) throw new TransientSuperviseError("soft command stayed in the editor");
      if ((await deps.run(["herdr", "pane", "send-keys", deps.config.leadPane, "enter"])).code !== 0) throw new TransientSuperviseError("soft command send failed");
      enters++;
    } else if ((after.revision !== undefined && after.revision !== pane.revision) || screen !== before) return;
    if (deps.clock.now() >= deadline) break;
    await deps.clock.sleep(200);
  }
  throw new TransientSuperviseError("soft command showed no completed screen change");
};

/**
 * After /new omo writes the new session's header at once, its model entry while still starting, and its startup
 * bookkeeping right after; the session takes input once that file has stopped growing for this long.
 */
export const SOFT_SESSION_SETTLE_MS = 1_000;

/** The model (`provider/modelId`) and thinking level a session file last recorded. */
const sessionModel = (file: string): { model?: string; thinking?: string } => {
  let model: string | undefined;
  let thinking: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"model_change"') && !line.includes('"thinking_level_change"')) continue;
    let entry: { type?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") model = `${entry.provider}/${entry.modelId}`;
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinking = entry.thinkingLevel;
  }
  return { model, thinking };
};

/**
 * After /new omo's herdr integration can release the pane's agent while the old session shuts down and report it again
 * once the new one has started (about two seconds). For this long a missing agent whose process still holds the pane's
 * foreground is that switch, not a dead lead.
 */
export const SOFT_RELEASE_GRACE_MS = 10_000;

/**
 * One soft wait's liveness: true when the agent is ready, false during a release gap. Throws at once when only the
 * shell is left in the pane, and once the agent has been missing for longer than the grace.
 */
const softLiveCheck = (deps: FlowDeps): (() => Promise<boolean>) => {
  let missingSince: number | undefined;
  return async () => {
    if (await softLive(deps)) {
      missingSince = undefined;
      return true;
    }
    const now = deps.clock.now();
    missingSince ??= now;
    const info = await processInfo(deps);
    if (!info || plainShell(info)) throw new TransientSuperviseError("reused lead is not live");
    if (now - missingSince >= SOFT_RELEASE_GRACE_MS) throw new TransientSuperviseError(`reused lead is not live after ${SOFT_RELEASE_GRACE_MS / 1000}s`);
    return false;
  };
};

/** The new session's file once it has started and settled with its agent back, or undefined at the deadline. */
const softSessionStarted = async (deps: FlowDeps, old: string, startedAt: number | undefined): Promise<string | undefined> => {
  const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
  const dir = sessionDirFor(deps.config.sessionsDir, pane?.cwd ?? deps.config.defaultCwd);
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  const live = softLiveCheck(deps);
  let seen: { readonly file: string; readonly size: number; readonly since: number } | undefined;
  while (deps.clock.now() < deadline) {
    // The next command is typed only into a settled new session whose agent is back.
    const ready = await live();
    let found: { readonly file: string; readonly size: number } | undefined;
    for (const name of readdirSync(dir)) {
      const id = /(?:^|_)([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1];
      if (!id || id === old) continue;
      const file = join(dir, name);
      try {
        const stat = statSync(file);
        if (startedAt !== undefined && stat.mtimeMs < startedAt) continue;
        if (readFileSync(file, "utf8").includes('"type":"model_change"')) found = { file, size: stat.size };
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
        throw e;
      }
    }
    if (found && seen?.file === found.file && seen.size === found.size) {
      if (ready && deps.clock.now() - seen.since >= SOFT_SESSION_SETTLE_MS) return found.file;
    } else seen = found && { ...found, since: deps.clock.now() };
    await deps.clock.sleep(200);
  }
  return undefined;
};

/** A new session must have persisted the unique startup-file pointer, not merely a holder directory. */
const softEvidence = async (deps: FlowDeps, old: string, markers: readonly string[], startedAt: number | undefined): Promise<string | undefined> => {
  const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
  const dir = sessionDirFor(deps.config.sessionsDir, pane?.cwd ?? deps.config.defaultCwd);
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  const live = softLiveCheck(deps);
  for (let attempt = 0; attempt <= STARTUP_EVIDENCE_MS / 500; attempt++) {
    for (const name of (await live()) ? readdirSync(dir) : []) {
      if (deps.clock.now() >= deadline) return undefined;
      const id = /(?:^|_)([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1];
      if (!id || id === old) continue;
      const file = join(dir, name);
      try {
        if (startedAt !== undefined && statSync(file).mtimeMs < startedAt) continue;
        if (deps.clock.now() >= deadline) return undefined;
        const text = readFileSync(file, "utf8");
        if (markers.some((marker) => text.includes(marker)) && deps.clock.now() < deadline) return id;
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
        throw e;
      }
    }
    if (deps.clock.now() >= deadline) break;
    await deps.clock.sleep(500);
  }
  return undefined;
};

const processInfo = async (deps: FlowDeps): Promise<ProcessInfo | undefined> => {
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
  if (info.code !== 0) return undefined;
  try { return (JSON.parse(info.out) as { result: { process_info: ProcessInfo } }).result.process_info; }
  catch (e) { if (e instanceof SyntaxError) return undefined; throw e; }
};

/** A short-lived or partly read entry can lack argv; it never matches. */
const launchedAs = (p: ForegroundProcess, session: string): boolean =>
  Array.isArray(p.argv) && p.argv.some((arg, i, argv) => arg === "--session-id" && argv[i + 1] === session);

/** Nothing but the pane's shell is in the foreground, so typed text reaches the shell and not a program's input. */
export const plainShell = (info: ProcessInfo): boolean =>
  !!info.shell_pid && (!info.foreground_process_group_id || info.foreground_process_group_id === info.shell_pid) &&
  (info.foreground_processes ?? []).every((p) => p.pid === undefined || p.pid === info.shell_pid);

/** Only a ready status for the exact newly requested process is positive evidence. */
export const confirmLead = async (deps: FlowDeps, session: string): Promise<boolean> => {
  // `pane run` acknowledges admission, not execution. A stale idle/done status
  // from the old occupant cannot confirm the new process. Recheck identity after
  // the status gate until the bounded startup deadline.
  const deadline = deps.clock.now() + 30_000;
  for (let attempt = 0; attempt < 60 && deps.clock.now() <= deadline; attempt++) {
    const ready = await deps.run(["herdr", "agent", "wait", deps.config.leadPane, "--until", "idle", "--until", "working", "--until", "done", "--timeout", String(Math.max(1, deadline - deps.clock.now()))]);
    if (ready.code !== 0) {
      // During replacement herdr can briefly report agent_not_running before
      // the new occupant registers. This is not failed admission.
      await deps.clock.sleep(500);
      continue;
    }
    const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
    const info = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
    if (info.code !== 0) return false;
    const processes: readonly ForegroundProcess[] = JSON.parse(info.out).result.process_info.foreground_processes ?? [];
    const identity = processes.some((p) => launchedAs(p, session));
    if (identity && pane && (pane.agent_status === "idle" || pane.agent_status === "working" || pane.agent_status === "done")) {
      const screen = await readScreen(deps.run, deps.config.leadPane, 40);
      return !STARTUP_ERROR.test(screen);
    }
    await deps.clock.sleep(500);
  }
  return false;
};

export const STARTUP_EVIDENCE_MS = 20_000;

/**
 * A healthy omo writes <sessionDir>/session-holders/<session>/<pid>.json and the session jsonl within
 * seconds of launch; a hung cold start creates the empty holder directory and nothing else. Either file
 * is positive evidence for that exact session and does not depend on the model replying.
 */
export const hasStartupEvidence = (deps: FlowDeps, session: string): boolean => {
  const dir = sessionDirFor(deps.config.sessionsDir, deps.config.defaultCwd);
  const names = (path: string): readonly string[] => { try { return readdirSync(path); } catch { return []; } };
  return names(join(dir, "session-holders", session)).some((name) => name.endsWith(".json")) ||
    names(dir).some((name) => name.endsWith(`_${session}.jsonl`) || name === `${session}.jsonl`);
};

export const awaitStartupEvidence = async (deps: FlowDeps, session: string): Promise<boolean> => {
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  for (let attempt = 0; attempt <= STARTUP_EVIDENCE_MS / 500; attempt++) {
    if (hasStartupEvidence(deps, session)) return true;
    if (deps.clock.now() >= deadline) return false;
    await deps.clock.sleep(500);
  }
  return false;
};

/** Descendants of `root` plus detached processes whose environment carries PI_SESSION_ID=<id>. */
const ownedTargets = async (deps: FlowDeps, table: Awaited<ReturnType<typeof procTable>>, root: number | undefined, id: string): Promise<Set<number>> => {
  const targets = new Set<number>();
  if (root) {
    targets.add(root);
    for (;;) {
      const before = targets.size;
      for (const p of table) if (targets.has(p.ppid)) targets.add(p.pid);
      if (targets.size === before) break;
    }
  }
  if (id) {
    // Detached monitor processes inherit PI_SESSION_ID. Do not match command text
    // (which may quote another session), and never kill the supervisor itself.
    for (const p of table) {
      if (targets.has(p.pid) || p.pid === process.pid) continue;
      const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(p.pid)]);
      if (new RegExp(`(?:^|\\s)PI_SESSION_ID=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(env.out)) targets.add(p.pid);
    }
  }
  targets.delete(process.pid);
  return targets;
};

const killTargets = async (deps: FlowDeps, targets: ReadonlySet<number>): Promise<void> => {
  for (const pid of [...targets].reverse()) {
    const stopped = await deps.run(["kill", "-KILL", String(pid)]);
    if (stopped.code !== 0 && (await deps.run(["kill", "-0", String(pid)])).code === 0) throw new TransientSuperviseError(`cannot stop owned lead process ${pid}`);
  }
  // Waiting for the foreground process group to exit is an observable gate, not
  // a fixed delay. The runner is bounded and never sends keys to a shell.
  if (targets.size) {
    const released = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
    if (released.code !== 0) throw new TransientSuperviseError("cannot verify lead termination");
    const live: readonly ForegroundProcess[] = JSON.parse(released.out).result.process_info.foreground_processes ?? [];
    if (live.some((p) => p.pid !== undefined && targets.has(p.pid))) throw new TransientSuperviseError("old lead has not exited; events retained");
  }
};

/** Kill only the process tree launched with `--session-id <session>`; status gates do not apply to a hung start. */
export const stopHung = async (deps: FlowDeps, session: string): Promise<void> => {
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
  if (info.code !== 0) throw new TransientSuperviseError("cannot identify hung lead process; refusing broad process cleanup");
  const processes: readonly ForegroundProcess[] = JSON.parse(info.out).result.process_info.foreground_processes ?? [];
  const hung = processes.find((p) => p.pid && launchedAs(p, session));
  await killTargets(deps, await ownedTargets(deps, await procTable(deps.run), hung?.pid, session));
};

/** Stop the pane's exact foreground agent tree, then its detached session-owned monitors. */
export const stopLead = async (deps: FlowDeps, force = false): Promise<boolean> => {
  const { leadPane, sessionsDir, defaultCwd } = deps.config;
  const pane = (await listPanes(deps.run)).find((p) => p.pane_id === leadPane);
  if (!pane) throw new TransientSuperviseError(`lead pane ${leadPane} is missing`);
  // `force` (a stuck lead) stops a working/blocked lead too.
  if (!force && pane.agent && pane.agent_status !== "idle" && pane.agent_status !== "done") return false;
  const table = await procTable(deps.run);
  const hit = await resolveSession(leadPane, pane.cwd ?? defaultCwd, table, { run: deps.run, sessionsDir });
  if (pane.agent && !hit.pid) throw new TransientSuperviseError("cannot identify lead process; refusing broad process cleanup");
  if (!pane.agent && !hit.pid) {
    const info = await deps.run(["herdr", "pane", "process-info", "--pane", leadPane]);
    if (info.code !== 0) throw new TransientSuperviseError("cannot verify an available shell in the lead pane");
    const proc: { readonly shell_pid: number; readonly foreground_process_group_id?: number } = JSON.parse(info.out).result.process_info;
    if (proc.foreground_process_group_id && proc.foreground_process_group_id !== proc.shell_pid) throw new TransientSuperviseError("lead pane contains a non-agent foreground process; refusing to type into it");
  }
  const current = heldSession(sessionDirFor(sessionsDir, pane.cwd ?? defaultCwd), hit.pid);
  const targets = await ownedTargets(deps, table, hit.pid, current?.id ?? hit.id);
  const latest = (await listPanes(deps.run)).find((p) => p.pane_id === leadPane);
  if (!latest) throw new TransientSuperviseError("lead pane disappeared during process resolution");
  if (!force && latest.agent && latest.agent_status !== "idle" && latest.agent_status !== "done") return false;
  await killTargets(deps, targets);
  return true;
};
