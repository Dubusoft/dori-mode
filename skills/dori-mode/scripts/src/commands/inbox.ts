import { parseArgs } from "node:util";

import { realClock } from "../run.ts";
import { checklistLine, InboxError, take, takeAwaitingReminders, takeCarriedReminders, takeOutput } from "../inbox.ts";
import { BUILT_IN } from "../tunables.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori inbox take [--max-bytes N] [--peek]`: the lead's read path. */
export const inboxCommand: CliCommand = {
  options: {},
  ownFlags: true,
  run: async ({ config, deps, rest }) => {
    const parsed = parseArgs({ args: rest, allowPositionals: true, options: { "max-bytes": { type: "string" }, peek: { type: "boolean" } } });
    const raw = parsed.values["max-bytes"];
    const maxBytes = raw === undefined ? BUILT_IN.delivery.push.takeMaxBytes : Number(raw);
    if (parsed.positionals.join(" ") !== "take" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) die("usage: dori inbox take [--max-bytes N (positive integer)] [--peek]");
    try {
      const result = take(config.stateDir, { maxBytes, peek: parsed.values.peek === true, now: realClock.now(), session: process.env.PI_SESSION_ID });
      // What the last cold start carried over, finished lanes still owed to the owner and open decisions are listed every
      // time, before the INBOX_MORE / INBOX_EMPTY sentinel.
      const { takeReminders } = await import("../lane-outcomes.ts");
      const { opensObligation, takeDecisionReminders } = await import("../decision-obligations.ts");
      const lines = takeOutput(result, (line) => opensObligation(line, deps.tunables));
      const sentinel = /^INBOX_(MORE|EMPTY)\b/.test(lines.at(-1) ?? "") ? lines.splice(-1) : [];
      const reminders = [...takeCarriedReminders(config.stateDir, new Set(result.events.map((event) => event.id))), ...takeReminders(config.stateDir), ...takeDecisionReminders(config.stateDir)];
      // Owner chat mixed with lane outcomes: one checklist line first, so answering the chat cannot hide the report owed.
      const checklist = checklistLine([...result.events.map((event) => `${event.id}\t${event.line}`), ...reminders]);
      // Messages parked on the owner's answer are information, not work: listed last and kept out of the checklist.
      // Owner decisions still open are information too: the owner has not answered, or the answer is an UNRESOLVED reminder.
      const { takeOwnerDecisionLines } = await import("../owner-decisions.ts");
      const decisionLines = takeOwnerDecisionLines(config.stateDir, realClock.now());
      for (const line of [...(checklist ? [checklist] : []), ...lines, ...reminders, ...takeAwaitingReminders(config.stateDir), ...decisionLines, ...sentinel]) console.log(line);
    } catch (e) {
      if (e instanceof InboxError) die(e.message, 2);
      throw e;
    }
  },
};
