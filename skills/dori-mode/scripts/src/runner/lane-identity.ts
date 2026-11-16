import { readFileSync } from "node:fs";
import { join } from "node:path";

import { laneSocketExists } from "./lane-socket.ts";
import type { Connector, Transport } from "./transport.ts";

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

/** How long the lane-mode check waits for the lane socket's whoami answer before it falls back to the runner's lane record. */
const WHOAMI_TIMEOUT_MS = 500;

/** The lane socket's whoami for `pane`; `answered` only when the runner replied ok (with or without a key). */
const whoami = async (pane: string, socketExists: boolean, connect: Connector): Promise<{ answered: boolean; key: string | undefined }> => {
  if (!socketExists) return { answered: false, key: undefined };
  let link: Transport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await new Promise<string | undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), WHOAMI_TIMEOUT_MS);
      connect().then((opened) => {
        link = opened;
        opened.onLine(resolve);
        opened.onClose(() => resolve(undefined));
        opened.send(`${JSON.stringify({ kind: "whoami", pane })}\n`);
      }, () => resolve(undefined));
    });
    const parsed = reply === undefined ? undefined : JSON.parse(reply) as { ok?: unknown; key?: unknown };
    if (parsed?.ok !== true) return { answered: false, key: undefined };
    return { answered: true, key: typeof parsed.key === "string" && parsed.key ? parsed.key : undefined };
  } catch {
    return { answered: false, key: undefined };
  } finally {
    clearTimeout(timer);
    link?.close("whoami");
  }
};

/** A pane that may be a lane while neither its runner's lane socket nor its lane record names one: the gate fails closed. */
export type LaneContextUnknown = { readonly pane: string; readonly recorded: Extract<LaneIdentity, { kind: "unreadable" }> };

/**
 * Lane mode (design 5, D11; gate B1): `DORI_LANE_KEY` names the lane; else the runner's lane socket is asked which lane
 * holds `HERDR_PANE_ID` (`{kind:"whoami", pane}`), and when it names none (no socket, no answer within
 * WHOAMI_TIMEOUT_MS, a failed reply, no key) the runner's own record `<runnerDir>/lanes.json` is read, so an adopted
 * lane (no DORI_LANE_KEY) stays a lane while its runner is down. Lead mode only when neither maps the pane. A record
 * that cannot be read while the socket did not answer exits 2 LANE_IDENTITY_UNKNOWN: a transport failure never grants
 * lead authority. Reads nothing but the environment, the socket and lanes.json.
 */
export const resolveLaneContext = async (env: Readonly<Record<string, string | undefined>>, runnerDir: string, connect: Connector): Promise<string | undefined | LaneContextUnknown> => {
  const named = env.DORI_LANE_KEY?.trim();
  if (named) return named;
  const pane = env.HERDR_PANE_ID?.trim();
  if (!pane) return undefined;
  const asked = await whoami(pane, laneSocketExists(runnerDir), connect);
  if (asked.key) return asked.key;
  const recorded = readLaneIdentity(runnerDir, pane);
  if (recorded.kind === "lane") return recorded.key;
  if (recorded.kind === "unreadable" && !asked.answered) {
    return { pane, recorded };
  }
  return undefined;
};
