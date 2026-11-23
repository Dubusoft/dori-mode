import { realClock } from "../run.ts";
import { NO_CLAUDE, quotaProvidersFor, readUsage, skippedText, usageLine } from "../claude-quota.ts";
import { sharedQuotaLookup } from "../quota-cache.ts";
import { cacheNoteLines } from "../quota-presentation.ts";
import { type CliCommand } from "./context.ts";

/** `dori quota [--json]`: Claude usage of every account and the autopilot verdict. */
export const quotaCommand: CliCommand = {
  options: {
    json: { type: "boolean" },
  },
  run: async ({ config, flags }) => {
    const { quotaSummary } = await import("../autopilot-cli.ts");
    const { quotaAccountText, quotaSplit } = await import("../autopilot.ts");
    const signal = AbortSignal.timeout(30_000);
    const looked = await sharedQuotaLookup(config)(signal);
    const read = await readUsage(async () => looked, realClock.now(), signal);
    // Autopilot judges the accounts of the provider serving defaultModel: it launches while any of them has room.
    const judged = quotaSummary((await readUsage(async () => looked, realClock.now(), signal, quotaProvidersFor(config.defaultModel))).usage);
    const notes = cacheNoteLines(read.cache, realClock.now(), config.displayTimeZone).map((line) => `\n${line}`).join("");
    const { over, room } = quotaSplit(judged);
    const autopilot = { readable: judged.readable, over, room };
    const skipped = read.skipped.length ? `\nQUOTA | skipped ${skippedText(read.skipped)}` : "";
    const verdict = `\nQUOTA | autopilot ${!judged.readable ? "unreadable" : `room: ${room.map(quotaAccountText).join(", ") || "none"}${over.length ? `; spent: ${over.map(quotaAccountText).join(", ")}` : ""}`}`;
    if (flags.values.json) console.log(JSON.stringify({ usage: read.usage ?? null, skipped: read.skipped, autopilot, cache: read.cache ?? null }, null, 2));
    else console.log(`${read.usage ? usageLine(read.usage, config.displayTimeZone) : NO_CLAUDE}${notes}${skipped}${verdict}\n\n${read.text}`);
  },
};
