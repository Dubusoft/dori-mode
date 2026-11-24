import { statusOf } from "../registry.ts";
import { sendToLane } from "../lane-send.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori lane status <key> | dori lane send <key> --text TEXT`. */
export const laneCommand: CliCommand = {
  options: {
    text: { type: "string" },
  },
  run: async ({ deps, flags, need, needSupervisor, lane }) => {
    const [action, laneKey, ...extra] = flags.positionals;
    if (action === "send") {
      if (!laneKey || extra.length || Object.keys(flags.values).some((name) => name !== "text")) die("usage: dori lane send <key> --text TEXT");
      const text = need("text");
      const target = await lane(laneKey ?? "");
      await needSupervisor();
      const sent = await sendToLane(deps, target, text);
      console.log(sent.line);
      if (!sent.ok) process.exit(1);
      return;
    }
    if (action !== "status" || !laneKey || extra.length || Object.keys(flags.values).length) die("usage: dori lane status <key> | dori lane send <key> --text TEXT (inside a lane: dori lane status)");
    const found = (await deps.registry.read(laneKey ?? "")) ?? die(`no registered lane "${laneKey}"`);
    console.log(JSON.stringify({ key: found.key, status: statusOf(found), objection: found.objection ?? null, claim: found.claim ?? null }, null, 2));
  },
};
