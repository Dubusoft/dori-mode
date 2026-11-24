import { parseArgs } from "node:util";

import { type CliCommand, die } from "./context.ts";

/** `dori event trace <eventId> [--json]`: one event's path through the inbox. */
export const eventCommand: CliCommand = {
  options: {},
  ownFlags: true,
  run: async ({ config, rest }) => {
    // `dori event trace <id> [--json]`: enqueued -> delivered -> taken -> acked/handled or reported (event-trace.ts).
    const parsed = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
    const [action, id, ...extra] = parsed.positionals;
    if (action !== "trace" || !id || extra.length) die("usage: dori event trace <eventId> [--json]");
    const { buildTrace, loadTrace, traceText } = await import("../event-trace.ts");
    const sources = loadTrace(config.stateDir, id ?? "");
    if (!sources) die(`EVENT_TRACE_UNAVAILABLE the journal store in ${config.stateDir} cannot be read`, 2);
    const trace = sources && buildTrace(id ?? "", sources);
    if (!trace) die(`EVENT_NOT_FOUND ${id}: no journaled, pruned or delivered event has this id`);
    else if (parsed.values.json) console.log(JSON.stringify(trace));
    else for (const line of traceText(trace)) console.log(line);
  },
};
