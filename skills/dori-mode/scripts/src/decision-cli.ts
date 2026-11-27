import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { ack, ackRecorded, handled } from "./ack.ts";
import type { FlowDeps } from "./done-flow.ts";
import { staleOwnerEvents } from "./inbox.ts";
import { Discord } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { realClock } from "./run.ts";
import { oneLine } from "./line-text.ts";

export type DecisionCliDeps = {
  readonly flow: FlowDeps;
  readonly die: (message: string, code?: number) => never;
  readonly messengerToken: (name: string) => string;
};

/** `dori decision open|close|list` for the lead; a refusal or failure ends the process through die. */
export const decisionMain = async (rest: string[], { flow: deps, die, messengerToken }: DecisionCliDeps): Promise<number> => {
  const { config } = deps;
  // `dori decision open|close|list`: owner decisions (owner-decisions.ts), lead-only.
  const { callerLane, laneDecisionRefusal } = await import("./lane-perms.ts");
  const refusal = laneDecisionRefusal(callerLane());
  if (refusal) die(refusal);
  const od = await import("./owner-decisions.ts");
  const ds = await import("./decision-store.ts");
  const { decisionChoicesProblem, inputRequestProblem } = await import("./runner/decision-text.ts");
  const [sub, ...subArgs] = rest;
  /** Discord is reached only when a call needs it; `token` already resolved, else read on first use. */
  const decisionContext = (token?: string, withReceipts = false): import("./owner-decisions.ts").DecisionContext => {
    let transport: Discord | undefined;
    const discord = (): Discord => transport ??= new Discord(fetchHttp, realClock, token ?? messengerToken("DORI_DISCORD_TOKEN"));
    // close settles the owner's answer messages with the same stale guard, ack and handled as dori send/ack/handled.
    const receipts: import("./owner-decisions.ts").DecisionReceipts = {
      unseen: (channel) => staleOwnerEvents(config.stateDir, channel),
      acked: (channel, message) => ackRecorded(config.stateDir, channel, message),
      ack: (channel, message) => ack(config.stateDir, discord(), channel, message, realClock.now()),
      handled: async (channel, message, tasks) => {
        const outcome = await handled(config.stateDir, discord, channel, message, realClock.now(), { reply: true, ...(tasks > 1 ? { tasks } : {}) });
        if (outcome.autoAck === "failed") console.error(`DECISION_ACK_FAILED ${channel} ${message}: ${outcome.error}; handled is recorded anyway`);
      },
    };
    return {
      config, now: realClock.now, home: homedir(),
      get transport() { return discord(); },
      ...(withReceipts ? { receipts } : {}),
    };
  };
  if (sub === "open") {
    const usage = "usage: dori decision open --question TEXT --option TEXT --option TEXT [...] --recommend N --reason TEXT --waiting TEXT [--task N] [--lane KEY | --relay-to KEY] [--thread REF | --no-origin] [--nonblocking] [--from-event EVENT_ID]\n       dori decision open --request --question \"<what is needed>\" --reason TEXT --waiting TEXT [--file PATH] [--task N] [--lane KEY | --relay-to KEY] [--thread REF | --no-origin] [--nonblocking] [--from-event EVENT_ID]";
    const refuse = (reason: string): never => {
      console.error(`DECISION_REFUSED ${reason}`);
      return die(usage, 2);
    };
    const parsed = (() => {
      try {
        return parseArgs({
          args: subArgs, allowPositionals: false, strict: true,
          options: {
            question: { type: "string" }, option: { type: "string", multiple: true }, recommend: { type: "string" }, reason: { type: "string" },
            waiting: { type: "string" }, task: { type: "string" }, lane: { type: "string" }, thread: { type: "string" },
            nonblocking: { type: "boolean" }, "from-event": { type: "string" }, request: { type: "boolean" }, file: { type: "string" },
            "no-origin": { type: "boolean" }, "relay-to": { type: "string" },
          },
        });
      } catch (e) { return refuse(e instanceof Error ? e.message : String(e)); }
    })();
    const v = parsed.values;
    const request = v.request === true;
    if (request && (v.option !== undefined || v.recommend !== undefined)) refuse("a --request takes no --option or --recommend");
    if (!request && v.file !== undefined) refuse("--file goes only with --request");
    const problem = request
      ? inputRequestProblem({ need: v.question, reason: v.reason, waiting: v.waiting, ...(v.file !== undefined ? { file: v.file } : {}) })
      : decisionChoicesProblem({ question: v.question, options: v.option, recommend: v.recommend, reason: v.reason, waiting: v.waiting });
    if (problem) refuse(problem);
    let task: number | undefined;
    if (v.task !== undefined) {
      if (!/^[1-9]\d*$/.test(v.task.trim())) refuse(`--task must be a positive integer, got "${v.task}"`);
      task = Number(v.task.trim());
    }
    // --relay-to names the lane as --lane does and also types the close text into it (decision-relay.ts).
    const relayTo = v["relay-to"]?.trim() || undefined;
    if (v["relay-to"] !== undefined && !relayTo) refuse("--relay-to needs a lane key");
    if (relayTo && v.lane?.trim() && v.lane.trim() !== relayTo) refuse(`--lane ${v.lane.trim()} and --relay-to ${relayTo} name different lanes`);
    const laneKey = relayTo ?? (v.lane?.trim() || undefined);
    const found = laneKey === undefined ? undefined : await deps.registry.read(laneKey);
    if (laneKey !== undefined && !found) refuse(`unknown ${relayTo ? "--relay-to" : "--lane"} ${laneKey}: no registered lane has this key`);
    task ??= found?.task ?? od.taskOfLane(laneKey);
    const thread = v.thread?.trim();
    if (thread !== undefined && !od.refIds(thread)) refuse(`--thread ${thread} is not a thread ref such as discord:<channel>/<thread>`);
    const laneThread = found?.thread && found.thread !== "none" ? found.thread : undefined;
    const noOrigin = v["no-origin"] === true;
    if (noOrigin && thread !== undefined) refuse("--no-origin cannot go with --thread");
    const origin = noOrigin ? undefined : thread ?? laneThread;
    // The link line cannot be added once the decision is posted, so a missing origin is said up front, never guessed.
    if (!origin && !noOrigin) refuse("no origin: pass --thread REF (the thread the question came from) or --no-origin");
    const fromEvent = v["from-event"]?.trim();
    const { recordResolved, validEventId } = await import("./decision-obligations.ts");
    if (fromEvent !== undefined && !validEventId(fromEvent)) refuse(`--from-event ${fromEvent} is not an event id`);
    const token = messengerToken("DORI_DISCORD_TOKEN");
    const asked = request
      ? od.requestSpec({ need: oneLine(v.question ?? ""), reason: oneLine(v.reason ?? ""), waiting: oneLine(v.waiting ?? ""), blocking: v.nonblocking !== true, ...(v.file !== undefined ? { file: oneLine(v.file) } : {}) })
      : { question: oneLine(v.question ?? ""), options: (v.option ?? []).map((text) => oneLine(text)), recommend: Number((v.recommend ?? "").trim()),
        reason: oneLine(v.reason ?? ""), waiting: oneLine(v.waiting ?? ""), blocking: v.nonblocking !== true };
    const opened = await od.openOwnerDecision(decisionContext(token), {
      ...asked, source: "lead",
      ...(task !== undefined ? { task } : {}), ...(laneKey ? { lane: laneKey } : {}), ...(relayTo ? { relayTo } : {}), ...(origin ? { origin } : {}),
    }).catch((e: unknown) => {
      if (e instanceof ds.OwnerDecisionError) die(e.message, 1);
      throw e;
    });
    const d = opened.decision;
    console.log(`DECISION_OPENED ${d.id} discord:${d.channel}/${d.thread ?? ""}${d.kind === "request" ? " request" : ""}`);
    if (d.attachedTo && !opened.duplicateOf) console.log(`DECISION_ATTACHED ${d.id} ${d.attachedTo}: posted in the thread of ${d.attachedTo}, the open blocking decision of the same lane or task`);
    if (opened.channel.unset) console.log(od.channelUnsetLine(opened.channel));
    if (opened.noticeKept) console.log(`DECISION_NOTICE_KEPT ${d.id}: the channel's "started a thread" notice could not be deleted: ${opened.noticeKept}`);
    const link = opened.link;
    if (link.kind === "linked") {
      const ids = od.refIds(d.origin);
      console.log(`DECISION_LINKED ${d.id} discord:${ids?.channel ? `${ids.channel}/` : ""}${link.origin} ${link.message}`);
    } else if (link.kind === "skipped") console.log(`DECISION_LINK_SKIPPED ${d.id}: ${link.reason}`);
    else if (link.kind === "failed") console.log(`DECISION_LINK_FAILED ${d.id} ${link.reason}`);
    else if (!d.origin && !d.inLaneThread) console.log(`DECISION_LINK_SKIPPED ${d.id}: no origin thread`);
    if (fromEvent !== undefined) {
      recordResolved(config.stateDir, fromEvent, realClock.now(), `decision ${d.id}`);
      console.log(`DECISION_SOURCE_RESOLVED ${d.id} ${fromEvent}`);
    }
    return 0;
  }
  if (sub === "close") {
    const usage = "usage: dori decision close <id> --text TEXT [--owner-text TEXT] [--choice N] [--from CHANNEL/MESSAGE] [--cancel] [--tasks N] [--force]";
    const parsed = (() => {
      try {
        return parseArgs({
          args: subArgs, allowPositionals: true, strict: true,
          options: {
            text: { type: "string" }, "owner-text": { type: "string" }, choice: { type: "string" }, from: { type: "string" }, cancel: { type: "boolean" },
            tasks: { type: "string" }, force: { type: "boolean" },
          },
        });
      } catch (e) { return die(`${e instanceof Error ? e.message : String(e)}\n${usage}`, 2); }
    })();
    const [id, ...extra] = parsed.positionals;
    const { text, "owner-text": ownerText, choice, from, cancel, tasks, force } = parsed.values;
    if (!id || extra.length || !text?.trim() || (ownerText !== undefined && !ownerText.trim()) || (choice !== undefined && !/^\d+$/.test(choice.trim()))
      || (from !== undefined && !/^\d+\/\d+$/.test(from.trim())) || (cancel && choice !== undefined)
      || (tasks !== undefined && !/^[1-9]\d*$/.test(tasks.trim()))) die(usage, 2);
    const closed = await od.closeOwnerDecision(decisionContext(undefined, true), id ?? "", {
      text: (text ?? "").trim(), ...(ownerText !== undefined ? { ownerText: ownerText.trim() } : {}), ...(choice !== undefined ? { choice: Number(choice.trim()) } : {}),
      ...(from !== undefined ? { from: from.trim() } : {}), ...(cancel ? { cancel: true } : {}),
      ...(tasks !== undefined ? { tasks: Number(tasks.trim()) } : {}), ...(force ? { force: true } : {}),
    }).catch((e: unknown) => {
      if (!(e instanceof ds.OwnerDecisionError)) throw e;
      // Like SEND_STALE: nothing was posted; the unseen messages are printed (and now seen), so a close after reading them goes through.
      if (e.code === "DECISION_STALE") {
        console.log(e.message);
        for (const line of e.lines) console.log(line);
        process.exit(3);
      }
      for (const line of e.lines) console.log(line);
      return die(e.message, e.code === "DECISION_NOT_CLOSED" ? 1 : 2);
    });
    const did = closed.decision.id;
    console.log(`DECISION_CLOSED ${did}`);
    if (closed.review) console.log(`DECISION_REVIEW_RECORDED ${did} job=${closed.review.jobId} outcome=${closed.review.outcome}`);
    const { relayDecisionClose, relayLine } = await import("./decision-relay.ts");
    const relayed = relayLine(await relayDecisionClose(deps, closed.decision));
    if (relayed) console.log(relayed);
    for (const line of closed.answers ? od.answerOutcomeLines(closed.answers) : []) console.log(line);
    if (closed.buttonsNote) console.log(`DECISION_BUTTONS_NOTE ${did}: ${closed.buttonsNote}`);
    if (closed.archivePending) console.log(`DECISION_ARCHIVE_PENDING ${did}: ${closed.archivePending}`);
    if (closed.resolved) console.log(`DECISION_RESOLVED_EVENT ${did} ${closed.resolved}`);
    if (closed.linkNote) console.log(`DECISION_LINK_NOTE ${did}: ${closed.linkNote}`);
    return 0;
  }
  if (sub === "list") {
    const usage = "usage: dori decision list [--all] [--json]";
    const parsed = (() => {
      try {
        return parseArgs({ args: subArgs, allowPositionals: false, strict: true, options: { all: { type: "boolean" }, json: { type: "boolean" } } });
      } catch (e) { return die(`${e instanceof Error ? e.message : String(e)}\n${usage}`, 2); }
    })();
    const now = realClock.now();
    const listed = ds.readDecisions(config.stateDir).decisions
      .filter((d) => d.state !== "closed" || (parsed.values.all === true && d.closedAt !== undefined && now - d.closedAt <= ds.DECISION_LIST_CLOSED_MS))
      .sort((a, b) => a.openedAt - b.openedAt);
    if (parsed.values.json) console.log(JSON.stringify(listed, null, 2));
    else if (!listed.length) console.log("DECISION_NONE");
    else for (const d of listed) console.log(od.decisionListLine(d, now));
    return 0;
  }
  die("usage: dori decision open|close|list (dori decision open --help)", 2);
  return 0;
};
