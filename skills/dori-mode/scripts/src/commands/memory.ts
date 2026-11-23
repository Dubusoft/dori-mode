import { checkMemory, MemoryCheckError, needsAction, renderMemoryReport } from "../memory-check.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori memory check`: the lead's memory size and stale Open items. */
export const memoryCommand: CliCommand = {
  options: {},
  run: async ({ deps, flags, key }) => {
    if (key !== "check" || flags.positionals.length > 1 || Object.keys(flags.values).length) die("usage: dori memory check", 2);
    try {
      const report = await checkMemory(deps, process.env.HOME ?? "");
      console.log(renderMemoryReport(report));
      process.exit(needsAction(report) ? 1 : 0);
    } catch (e) {
      if (e instanceof MemoryCheckError) die(`MEMORY_CHECK_ERROR ${e.message}`, 2);
      throw e;
    }
  },
};
