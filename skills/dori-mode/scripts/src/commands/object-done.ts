import { objectDone } from "../done-flow.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori object-done <key> --reason TEXT ...`: object to a lane's done claim. */
export const objectDoneCommand: CliCommand = {
  options: {
    reason: { type: "string", multiple: true },
  },
  run: async ({ deps, flags, key, needSupervisor, lane }) => {
    const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (!reasons.length) die("--reason is required");
    const target = await lane(key ?? die("object-done needs a lane key"));
    await needSupervisor();
    console.log(await objectDone(deps, target, reasons));
  },
};
