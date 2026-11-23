import { syncRegistry } from "../sync.ts";
import { type CliCommand } from "./context.ts";

/** `dori sync [--write] [--full]`: registry vs live panes. */
export const syncCommand: CliCommand = {
  options: {
    write: { type: "boolean" },
    full: { type: "boolean" },
  },
  run: async ({ deps, flags, needSupervisor }) => {
    await needSupervisor();
    const r = await syncRegistry(deps, Boolean(flags.values.write));
    if (flags.values.full) {
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
    } else {
      const counts = new Map<string, number>();
      for (const row of r.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      const byStatus = [...counts].map(([status, count]) => `${status} ${count}`).join(", ");
      const unregisteredPanes = r.unregistered.length ? `: ${r.unregistered.map((row) => row.pane).join(" ")}` : "";
      console.log(`LANES ${r.rows.length}${byStatus ? ` (${byStatus})` : ""}; UNREGISTERED ${r.unregistered.length}${unregisteredPanes}; --full for the table`);
    }
    console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
    console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
  },
};
