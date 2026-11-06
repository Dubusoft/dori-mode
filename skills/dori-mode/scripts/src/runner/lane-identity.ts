import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which lane a herdr pane is, read from the runner's own record (`<runnerDir>/lanes.json`, written by lanes.ts
 * `RunnerLanes`), for the CLI's lane-mode gate when the lane socket cannot answer (gate B1): an adopted lane has no
 * `DORI_LANE_KEY`, so a runner outage must not turn its pane into the lead. Read-only; imports no store and no runner
 * module, so the gate stays free of supervisor state.
 *
 * - `lane`: a record holds `pane`.
 * - `none`: the file is absent, or no record holds `pane`.
 * - `unreadable`: the file exists but cannot be read, is not JSON, or is not a key -> {key, pane} map; the caller
 *   fails closed rather than guess.
 */

/** Must equal lanes.ts `LANES_FILE`; not imported so this reader stays free of lanes.ts's herdr and screen imports. */
export const LANE_IDENTITY_FILE = "lanes.json";

export type LaneIdentity =
  | { readonly kind: "lane"; readonly key: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly detail: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const readLaneIdentity = (runnerDir: string, pane: string): LaneIdentity => {
  const file = join(runnerDir, LANE_IDENTITY_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", detail: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let records: unknown;
  try { records = JSON.parse(text); } catch (error) {
    return { kind: "unreadable", detail: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObject(records)) return { kind: "unreadable", detail: `${file}: not a lane record map` };
  let found: string | undefined;
  for (const record of Object.values(records)) {
    if (!isObject(record) || typeof record.key !== "string" || !record.key || typeof record.pane !== "string") {
      return { kind: "unreadable", detail: `${file}: malformed lane record` };
    }
    if (record.pane === pane) found ??= record.key;
  }
  return found === undefined ? { kind: "none" } : { kind: "lane", key: found };
};
