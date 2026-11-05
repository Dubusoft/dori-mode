import { readFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acquireSlot, pidAlive, releaseSlot } from "../heavy-slot.ts";
import { isReportKind } from "../lane-reports.ts";
import { realClock, type Clock } from "../run.ts";
import type { Connector } from "./transport.ts";

/**
 * The `dori` a lane runs on a worker machine (design 3.4): the runner bundle in lane mode, set by `DORI_LANE_KEY`. It
 * takes only `report`, `claim-done` and `heavy`, and only for the lane's own key; any other subcommand exits 2 with
 * `DORI_CLI_UNSUPPORTED_ON_RUNNER <cmd>`. A report goes to the runner's lane socket with the lane's token, read from
 * the file `DORI_LANE_TOKEN_FILE` names (or, for a lane an older runner started, `DORI_LANE_TOKEN` itself), so the
 * runner accepts it only from the lane it started. `heavy` uses the host's `~/.dori/heavy/slot.N` directories,
 * the same ones `guard-agent.sh heavy` takes, so old and new footers share one slot count per machine.
 */

export const LANE_CLI_COMMANDS = ["report", "claim-done", "heavy"] as const;

export type LaneCliDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly connect: Connector;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly heavyDir?: string;
  readonly clock?: Clock;
  readonly spawn?: (argv: readonly string[]) => Promise<number>;
  readonly readFile?: (path: string) => string;
};

/** The lane's token: the content of `DORI_LANE_TOKEN_FILE`, else `DORI_LANE_TOKEN`; undefined when neither gives one. */
const laneToken = (deps: LaneCliDeps): string | undefined => {
  const file = deps.env.DORI_LANE_TOKEN_FILE;
  if (file) {
    try { return (deps.readFile ?? ((p) => readFileSync(p, "utf8")))(file).trim() || undefined; } catch { return undefined; }
  }
  return deps.env.DORI_LANE_TOKEN || undefined;
};

export const heavyDirOf = (home: string = homedir()): string => join(home, ".dori", "heavy");

const request = async (connect: Connector, body: object): Promise<{ ok: boolean; code?: string; detail?: string }> => {
  const link = await connect();
  try {
    const reply = new Promise<string>((resolve, reject) => {
      link.onLine(resolve);
      link.onClose(() => reject(new Error("RUNNER_LANE_SOCKET_CLOSED the runner closed the lane socket without an answer")));
    });
    // The socket carries newline-ended lines; without the newline the runner never sees the request.
    link.send(`${JSON.stringify(body)}\n`);
    return JSON.parse(await reply) as { ok: boolean; code?: string; detail?: string };
  } finally {
    link.close("done");
  }
};

export const laneCliMain = async (args: readonly string[], deps: LaneCliDeps): Promise<number> => {
  const [sub = "", ...rest] = args;
  if (!(LANE_CLI_COMMANDS as readonly string[]).includes(sub)) {
    deps.err(`DORI_CLI_UNSUPPORTED_ON_RUNNER ${sub || "(none)"}: on a runner a lane may run only ${LANE_CLI_COMMANDS.join(", ")}`);
    return 2;
  }
  const own = deps.env.DORI_LANE_KEY ?? "";
  if (sub === "heavy") {
    const sep = rest.indexOf("--");
    const label = rest[0];
    const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
    if (!label || label === "--" || !cmd.length) { deps.err("usage: dori heavy <label> -- <command ...>"); return 2; }
    const slots = Number(deps.env.DORI_HEAVY_SLOTS ?? "1");
    const slot = await acquireSlot({
      dir: deps.heavyDir ?? heavyDirOf(), slots: Number.isSafeInteger(slots) && slots > 0 ? slots : 1, maxLoad: Infinity,
      clock: deps.clock ?? realClock, load: async () => loadavg()[0] ?? 0, alive: pidAlive, pid: process.pid,
    }, `${own}:${label}`);
    try {
      return await (deps.spawn ?? (async (argv) => Bun.spawn([...argv], { stdout: "inherit", stderr: "inherit", stdin: "inherit" }).exited))(cmd);
    } finally {
      releaseSlot(slot);
    }
  }
  const parsed = parseArgs({ args: [...rest], allowPositionals: true, options: { text: { type: "string" }, evidence: { type: "string" } } });
  const [key, kindArg, ...extra] = parsed.positionals;
  const kind = sub === "claim-done" ? "done" : kindArg;
  if (!key || extra.length || (sub === "claim-done" && kindArg !== undefined) || !isReportKind(kind)) {
    deps.err(sub === "claim-done" ? "usage: dori claim-done <key> --evidence \"<merge SHA, ...>\"" : "usage: dori report <key> <progress|question|blocked|milestone|done> --text \"...\" [--evidence \"...\"]");
    return 2;
  }
  if (key !== own) {
    deps.err(`LANE_PERMISSION_DENIED lane ${own || "(none)"} may report only for itself, not ${key}`);
    return 1;
  }
  const token = laneToken(deps);
  if (!token) { deps.err(`RUNNER_LANE_AUTH_FAILED no lane token: DORI_LANE_TOKEN_FILE unreadable or empty, and no DORI_LANE_TOKEN`); return 1; }
  const text = parsed.values.text ?? (kind === "done" ? parsed.values.evidence ?? "" : "");
  if (!text) { deps.err("--text is required"); return 2; }
  const reply = await request(deps.connect, { key, token, kind, text, ...(parsed.values.evidence ? { evidence: parsed.values.evidence } : {}) });
  if (!reply.ok) { deps.err(`${reply.code ?? "RUNNER_LANE_REFUSED"} ${reply.detail ?? ""}`.trim()); return 1; }
  deps.out(`LANE_REPORTED ${key} ${kind} (through the runner)`);
  return 0;
};
