import { realClock } from "../run.ts";
import { oneLine } from "../line-text.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori resolved <eventId> ... [--note TEXT]`: the lead decided these decision events. */
export const resolvedCommand: CliCommand = {
  options: {
    note: { type: "string" },
  },
  run: async ({ config, deps, flags, opt }) => {
    // `dori resolved <eventId> [...] [--note T]`: the lead has decided these decision events (decision-obligations.ts). An
    // id with no open obligation is still recorded (its event may not have arrived yet) and named as unmatched, unless the
    // store knows its event as one that opens none (or pruned it, which an open one never is): then nothing is recorded.
    const { opensObligation, publishedDecisions, recordResolved, validEventId } = await import("../decision-obligations.ts");
    const { loadTrace } = await import("../event-trace.ts");
    const ids = flags.positionals;
    if (!ids.length || !ids.every(validEventId) || Object.keys(flags.values).some((name) => name !== "note") || ("note" in flags.values && !opt("note"))) {
      die("usage: dori resolved <eventId> [<eventId> ...] [--note TEXT]");
    }
    const open = new Set(publishedDecisions(config.stateDir).map((item) => item.id));
    const note = opt("note");
    const at = realClock.now();
    for (const id of new Set(ids)) {
      const known = open.has(id) ? undefined : loadTrace(config.stateDir, id);
      if (known?.event && !opensObligation(known.event.line, deps.tunables)) {
        console.log(`RESOLVED_NOT_NEEDED ${id}: this event opens no decision; nothing recorded`);
        continue;
      }
      if (known && !known.event && known.tombstoned) {
        console.log(`RESOLVED_NOT_NEEDED ${id}: this event was pruned and has no open decision; nothing recorded`);
        continue;
      }
      recordResolved(config.stateDir, id, at, note ? oneLine(note) : undefined);
      console.log(open.has(id) || known?.event ? `RESOLVED_RECORDED ${id}` : `RESOLVED_UNMATCHED ${id}: no open decision has this id; recorded anyway`);
    }
  },
};
