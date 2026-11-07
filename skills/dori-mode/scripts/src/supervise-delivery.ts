import { statSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type { FlowDeps } from "./done-flow.ts";
import { DEFAULT_EVENT_POLICY, eventClass, type EventPolicy, forLead } from "./event-policy.ts";
import { scrubForThread } from "./freshness.ts";
import type { OutcomeTracking } from "./lane-outcomes.ts";
import { listPanes, type Pane } from "./panes.ts";
import { pendingLeadRestart } from "./lead-restart.ts";
import { type Event, type Journal, type JournalCore, TransientSuperviseError } from "./supervise-journal.ts";
import type { LeadLifecycle } from "./supervise-lead-lifecycle.ts";
import { latest, type OwnerTracking } from "./supervise-owner-tracking.ts";
import { PushDelivery } from "./supervise-push.ts";

/**
 * Delivery to the lead: which events wake it (urgent) and which wait as digest, the delivery pass that hands pending
 * events to the lead warm or through a cold restart, and the retrying wrapper that keeps transient lead states from
 * ending the supervisor.
 */

/** Only `lead-urgent` events wake the lead; `lead-digest` waits for the next urgent one, or digestMaxDelayMin (event-policy.ts). */
export const eventPriority = (line: string, policy: EventPolicy = DEFAULT_EVENT_POLICY): "urgent" | "digest" =>
  eventClass(line, policy) === "lead-urgent" ? "urgent" : "digest";

export class Delivery {
  private flushing?: Promise<void>;
  private readonly push: PushDelivery;

  constructor(private readonly core: JournalCore, private readonly owners: OwnerTracking, private readonly lead: LeadLifecycle, private readonly outcomes: OutcomeTracking) {
    this.push = new PushDelivery(core, lead, outcomes);
  }

  private get deps(): FlowDeps { return this.core.deps; }
  private get journal(): Journal { return this.core.journal; }
  private get delivered(): Set<string> { return this.core.delivered; }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    this.owners.drainOutbox();
    // Reuse this pass's pane observation for reporting, delivery, and push. A restart invalidates it.
    let paneSample: Promise<Pane | undefined> | undefined;
    const readPane = () => paneSample ??= listPanes(this.deps.run).then((panes) => panes.find((p) => p.pane_id === this.deps.config.leadPane));
    // One pass starts at most one lead turn: a later batch or pointer in it joins the turn the first one started.
    let woke = false;
    this.outcomes.markDelivered();
    await this.outcomes.tick(this.deps.registry, async () => {
      const pane = await readPane();
      return pane?.agent ? pane.agent_status : undefined;
    });
    for (;;) {
      if (this.journal.restart) {
        await this.lead.restart(this.journal.restart);
        woke = true;
        paneSample = undefined;
        this.outcomes.markDelivered();
        continue;
      }
      const policy = this.deps.config.eventPolicy;
      // engine-only events stay in the journal (dedupe, counts) but never reach the lead.
      const pending = this.journal.events.filter((event) => !this.delivered.has(event.id) && forLead(eventClass(event.line, policy)));
      const request = pendingLeadRestart(this.deps.config.stateDir);
      if (request) {
        const pane = await readPane();
        if (!pane) throw new TransientSuperviseError(`lead pane ${this.deps.config.leadPane} does not exist`);
        const cwd = pane.cwd ?? this.deps.config.defaultCwd;
        const models = request.models.map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> ");
        if ((!pane.agent || pane.agent_status === "idle" || pane.agent_status === "done") &&
            !(pane.agent && await this.lead.deferForChildren(cwd, "request", `${request.id} ${models}`))) {
          await this.lead.noteRestart("request", `dori lead-restart ${request.id} ${models}`);
          this.lead.setRestart({ session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size, phase: "stopping", request });
          continue;
        }
      }
      // Digest-only traffic must not touch the delivery log or even inspect the lead, until its oldest
      // event has waited digestMaxDelayMin. It survives a supervisor restart in the existing durable inbox.
      const now = this.deps.clock.now();
      // A sweep warning waits for real traffic: a failure that persists must not restart an idle lead every hour.
      const overdue = (event: Event) => event.at !== undefined && now - event.at >= this.deps.config.digestMaxDelayMin * 60_000 && !/^\S*_WARN\b/.test(event.line);
      const urgent = pending.filter((event) => eventPriority(event.line, policy) === "urgent");
      const due = urgent.length > 0 || pending.some(overdue);
      await this.lead.resumePaused(readPane);
      if (await this.lead.stuckRestart(pending, readPane)) continue;
      if (!due) {
        if (this.journal.awaitingAck?.some((entry) => !entry.quarantined && entry.since === undefined && this.delivered.has(latest(entry)))) {
          const pane = await readPane();
          if (!pane) throw new TransientSuperviseError(`lead pane ${this.deps.config.leadPane} does not exist`);
          if (!pane.agent) {
            await this.lead.noteRestart("no-agent", `no agent runs in lead pane ${pane.pane_id} while owner messages wait for their read window`);
            this.lead.setRestart({ session: randomUUID(), events: [], offset: statSync(this.core.eventLog).size, phase: "stopping" });
            continue;
          }
          if (pane?.agent && (pane.agent_status === "idle" || pane.agent_status === "done")) this.owners.markReadable();
        }
        // Everything due is in the log now: the push step makes sure the lead takes it.
        if (await this.push.tick(pending, readPane, woke)) continue;
        return;
      }
      const pane = await readPane();
      if (!pane) throw new TransientSuperviseError(`lead pane ${this.deps.config.leadPane} does not exist`);
      // Blocked/unknown is not idle. Do not terminate an approval dialog or an unclassified agent.
      if (pane.agent_status === "working" || (pane.agent && pane.agent_status !== "idle" && pane.agent_status !== "done")) {
        this.owners.record(pending);
        this.outcomes.markDelivered();
        continue;
      }
      const cwd = pane.cwd ?? this.deps.config.defaultCwd;
      // A LEAD_UNRESPONSIVE alone says the restart cap holds: it must not cold-start the lead the cap spares.
      const capped = pending.every((event) => event.line.startsWith("LEAD_UNRESPONSIVE "));
      const cold = pane.agent ? (capped ? undefined : await this.lead.coldReason(cwd)) : { kind: "no-agent", detail: `no agent runs in lead pane ${pane.pane_id}`, tokens: 0 };
      // A lead waiting on its own children takes the events in place: a cold start would kill them (bounded deferral).
      if (!cold || (pane.agent && await this.lead.deferForChildren(cwd, cold.kind, cold.detail))) {
        this.owners.record(pending, true);
        this.outcomes.markDelivered();
        if (!woke) this.core.wakes.record(this.lead.warmSession, pending, urgent.length ? urgent : pending.filter(overdue));
        woke = true;
        continue;
      }
      if (cold.kind === "hard-cap") console.log(`LEAD_HARD_CAP ${cold.tokens}`);
      await this.lead.noteRestart(cold.kind, cold.detail);
      this.lead.setRestart({ session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size, phase: "stopping" });
    }
  }
}

export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
export const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Wraps lead delivery so a transient lead state retries with bounded exponential backoff instead of
 * ending the supervisor. Events and the restart journal stay exactly as persisted. The same failure
 * streak reports once after STUCK_AFTER_MS; a fatal error is rethrown.
 */
export class RetryingDelivery {
  private failures = 0;
  private since = 0;
  private retryAt = 0;
  private stuck = false;

  constructor(private readonly io: {
    readonly now: () => number;
    readonly flush: () => Promise<void>;
    readonly repair: () => Promise<unknown>;
    readonly enqueue: (id: string, line: string) => void;
    readonly notify: (text: string) => Promise<void>;
    readonly log: (line: string) => void;
  }, private readonly boot: string) {}

  get nextAttemptAt(): number { return this.retryAt; }

  get due(): boolean { return this.io.now() >= this.retryAt; }

  async tick(): Promise<void> {
    try {
      await this.io.flush();
      this.failures = 0;
      this.stuck = false;
      this.retryAt = 0;
    } catch (e) {
      if (!(e instanceof TransientSuperviseError)) throw e;
      const now = this.io.now();
      if (this.failures === 0) this.since = now;
      this.failures++;
      const delay = Math.min(BACKOFF_MIN_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
      this.retryAt = now + delay;
      this.io.log(`SUPERVISOR_RETRY ${e.message}; attempt ${this.failures}, next in ${delay / 1000}s`);
      try { await this.io.repair(); } catch (r) { this.io.log(`SUPERVISOR_REPAIR_FAILED ${r instanceof Error ? r.message : String(r)}`); }
      if (!this.stuck && now - this.since >= STUCK_AFTER_MS) {
        this.stuck = true;
        const text = `SUPERVISOR_STUCK ${e.message}`;
        this.io.enqueue(`stuck:${this.boot}:${this.since}`, text);
        // The lead gets the raw reason; the channel post loses home paths and pane ids like every automatic post.
        try { await this.io.notify(scrubForThread(text, homedir())); } catch (n) { this.io.log(`SUPERVISOR_STUCK_NOTIFY_FAILED ${n instanceof Error ? n.message : String(n)}`); }
      }
    }
  }
}
