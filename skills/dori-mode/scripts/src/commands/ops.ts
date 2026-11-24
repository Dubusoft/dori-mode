import { realClock } from "../run.ts";
import { openOperations, operationLine, type OperationState, settleOperation } from "../operations.ts";
import { SCHEDULE_ACTION } from "../schedule.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori ops [list] ... | dori ops resolve <id> --as verified|retry`: operation rows. */
export const opsCommand: CliCommand = {
  options: {
    lane: { type: "string" },
    as: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  },
  run: async ({ config, flags, opt }) => {
    const [action = "list", id, ...extra] = flags.positionals;
    const store = openOperations(config);
    try {
      if (action === "list" && id === undefined && !extra.length) {
        const states: OperationState[] | undefined = flags.values.all ? undefined : ["planned", "attempted", "failed", "ambiguous"];
        const ops = store.list({ ...(opt("lane") ? { lane: opt("lane") } : {}), ...(states ? { states } : {}) });
        if (flags.values.json) console.log(JSON.stringify(ops, null, 2));
        else console.log(ops.length ? ops.map(operationLine).join("\n") : "OPS none");
        return;
      }
      const as = opt("as");
      if (action !== "resolve" || !id || extra.length || (as !== "verified" && as !== "retry")) die("usage: dori ops [list] [--lane KEY] [--all] [--json] | dori ops resolve <id> --as verified|retry");
      const op = store.get(id ?? "");
      if (!op) die(`no operation "${id}"`);
      if (op?.state !== "ambiguous" && op?.state !== "failed") die(`operation ${id} is ${op?.state}; only an ambiguous or failed operation is resolved by hand`);
      const done = settleOperation(store, realClock.now(), id ?? "", as === "verified" ? "verified" : "planned",
        as === "verified" ? "resolved by the lead: the effect is in place" : "resolved by the lead: the effect did not happen; may retry");
      if (done) console.log(operationLine(done));
      console.log(op?.action === SCHEDULE_ACTION ? `OPS_RESOLVED ${id}${as === "retry" ? "; the supervisor runs it again on its next pass" : ""}`
        : `OPS_RESOLVED ${id}; run dori close ${op?.lane} to finish its close`);
    } finally { store.close(); }
  },
};
