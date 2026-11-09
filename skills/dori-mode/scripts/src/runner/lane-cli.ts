import { readFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acquireSlot, pidAlive, releaseSlot } from "../heavy-slot.ts";
import { sampleLoad1 } from "../host-guard.ts";
import { isReportKind } from "./report-kinds.ts";
import { realClock, run as realRun, type Clock, type Runner } from "../run.ts";
import type { Connector, Transport } from "./transport.ts";

/**
 * The `dori` a lane runs on a worker machine (design 3.4): the runner bundle in lane mode, set by `DORI_LANE_KEY`. It
 * takes only `report` (and `report ack <id>`), `claim-done`, `lane status` and `heavy`, and only for the lane's own
 * key; any other subcommand exits 2 with `DORI_CLI_LANE_ONLY <cmd>`. A report goes to the runner's lane socket with the lane's token, read from
 * the file `DORI_LANE_TOKEN_FILE` names (or, for a lane an older runner started, `DORI_LANE_TOKEN` itself), so the
 * runner accepts it only from the lane it started. `heavy` uses the host's `~/.dori/heavy/slot.N` directories,
 * the same ones `guard-agent.sh heavy` takes, so old and new footers share one slot count per machine.
 */

export const LANE_CLI_COMMANDS = ["report", "claim-done", "lane", "heavy"] as const;

/** How long a request keeps retrying a missing or refusing lane socket (a supervisor/runner restart), and how often. */
export const LANE_SOCKET_RETRY_MS = 60_000;
export const LANE_SOCKET_RETRY_STEP_MS = 1_000;

export type LaneCliDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly connect: Connector;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly heavyDir?: string;
  readonly clock?: Clock;
  readonly spawn?: (argv: readonly string[]) => Promise<number>;
  readonly readFile?: (path: string) => string;
  /** The runner directory holding `briefs/<key>.token`; default `~/.dori/runner`. */
  readonly runnerDir?: string;
  /** The lane's own key when it is not in `DORI_LANE_KEY` (a lane found through the socket's whoami). */
  readonly laneKey?: string;
  /** Defaults to `process.platform`. */
  readonly platform?: string;
  /** Runs the Windows load sampler; default the real runner. */
  readonly run?: Runner;
};

/**
 * The lane's token: the content of `DORI_LANE_TOKEN_FILE`, else `DORI_LANE_TOKEN`, else `<runnerDir>/briefs/<key>.token`
 * (an adopted lane has no env var); undefined when none gives one.
 */
const laneToken = (deps: LaneCliDeps, key: string): string | undefined => {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const fromFile = (path: string): string | undefined => { try { return read(path).trim() || undefined; } catch { return undefined; } };
  const file = deps.env.DORI_LANE_TOKEN_FILE;
  if (file) return fromFile(file);
  if (deps.env.DORI_LANE_TOKEN) return deps.env.DORI_LANE_TOKEN;
  return key ? fromFile(join(deps.runnerDir ?? join(homedir(), ".dori", "runner"), "briefs", `${key}.token`)) : undefined;
};

const heavyMaxLoad = (raw: string | undefined): number => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};

export const heavyDirOf = (home: string = homedir()): string => join(home, ".dori", "heavy");

type Reply = { ok: boolean; code?: string; detail?: string; [k: string]: unknown };

/** The heavy admission load: the sampler's load1 on win32 (`loadavg()` is all zeros there), else the 1-minute load average. */
export const heavyLoad = (platform: string, run: Runner, runnerDir?: string): (() => Promise<number>) =>
  platform === "win32" ? () => sampleLoad1(platform, run, runnerDir) : async () => loadavg()[0] ?? 0;

export const retryable = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  const text = `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : String(error)}`;
  return /ENOENT|ECONNREFUSED|EPIPE|ECONNRESET/.test(text);
};

/** Connects, retrying a missing or refusing socket every second for up to 60 s on the injected clock. */
const connectWithRetry = async (connect: Connector, clock: Clock): Promise<Transport> => {
  const started = clock.now();
  for (;;) {
    try {
      return await connect();
    } catch (error) {
      if (!retryable(error)) throw error;
      if (clock.now() - started >= LANE_SOCKET_RETRY_MS) {
        throw new Error(`RUNNER_LANE_SOCKET_UNAVAILABLE the lane socket did not accept a connection for ${LANE_SOCKET_RETRY_MS / 1000} s`);
      }
      await clock.sleep(LANE_SOCKET_RETRY_STEP_MS);
    }
  }
};

const request = async (connect: Connector, body: object, clock: Clock = realClock): Promise<Reply> => {
  const link = await connectWithRetry(connect, clock);
  try {
    const reply = new Promise<string>((resolve, reject) => {
      link.onLine(resolve);
      link.onClose(() => reject(new Error("RUNNER_LANE_SOCKET_CLOSED the runner closed the lane socket without an answer")));
    });
    // The socket carries newline-ended lines; without the newline the runner never sees the request.
    link.send(`${JSON.stringify(body)}\n`);
    return JSON.parse(await reply) as Reply;
  } finally {
    link.close("done");
  }
};

const LANE_ONLY_TEXT = "inside a lane dori takes only report, claim-done, report ack, lane status and heavy";

export const laneCliMain = async (args: readonly string[], deps: LaneCliDeps): Promise<number> => {
  const [sub = "", ...rest] = args;
  if (!(LANE_CLI_COMMANDS as readonly string[]).includes(sub) || (sub === "lane" && rest[0] !== "status")) {
    deps.err(`DORI_CLI_LANE_ONLY ${sub === "lane" ? `lane ${rest[0] ?? ""}`.trim() : sub || "(none)"}: ${LANE_ONLY_TEXT}`);
    return 2;
  }
  const own = deps.laneKey ?? deps.env.DORI_LANE_KEY ?? "";
  const clock = deps.clock ?? realClock;
  const withoutOk = ({ ok: _ok, ...others }: Reply): object => others;
  /** One authenticated request for the lane's own key; `done` prints on success. */
  const send = async (verb: object, done: (reply: Reply) => void): Promise<number> => {
    const token = laneToken(deps, own);
    if (!token) { deps.err("RUNNER_LANE_AUTH_FAILED no lane token: DORI_LANE_TOKEN_FILE unreadable or empty, no DORI_LANE_TOKEN, and no briefs/<key>.token"); return 1; }
    let reply: Reply;
    try { reply = await request(deps.connect, { ...verb, key: own, token }, clock); } catch (error) {
      deps.err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (!reply.ok) { deps.err(`${reply.code ?? "RUNNER_LANE_REFUSED"} ${reply.detail ?? ""}`.trim()); return 1; }
    done(reply);
    return 0;
  };
  if (sub === "heavy") {
    const sep = rest.indexOf("--");
    const label = rest[0];
    const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
    if (!label || label === "--" || !cmd.length) { deps.err("usage: dori heavy <label> -- <command ...>"); return 2; }
    const slots = Number(deps.env.DORI_HEAVY_SLOTS ?? "1");
    const slot = await acquireSlot({
      dir: deps.heavyDir ?? heavyDirOf(), slots: Number.isSafeInteger(slots) && slots > 0 ? slots : 1, maxLoad: heavyMaxLoad(deps.env.DORI_HEAVY_MAX_LOAD),
      clock, load: heavyLoad(deps.platform ?? process.platform, deps.run ?? realRun, deps.runnerDir), alive: pidAlive, pid: process.pid,
      ...(deps.platform ? { platform: deps.platform } : {}),
    }, `${own}:${label}`);
    try {
      return await (deps.spawn ?? (async (argv) => Bun.spawn([...argv], { stdout: "inherit", stderr: "inherit", stdin: "inherit" }).exited))(cmd);
    } finally {
      releaseSlot(slot);
    }
  }
  if (sub === "lane") {
    const [, key = own, ...extra] = rest;
    if (extra.length) { deps.err("usage: dori lane status [<key>]"); return 2; }
    if (key !== own) { deps.err(`LANE_PERMISSION_DENIED lane ${own || "(none)"} may read only its own status, not ${key}`); return 1; }
    return send({ kind: "status" }, (reply) => { deps.out(JSON.stringify(withoutOk(reply))); });
  }
  if (sub === "report" && rest[0] === "ack") {
    const [, id, ...extra] = rest;
    if (!id || extra.length) { deps.err("usage: dori report ack <id>"); return 2; }
    return send({ kind: "ack", id }, () => { deps.out(`LANE_ACKED ${own} ${id}`); });
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
  const text = parsed.values.text ?? (kind === "done" ? parsed.values.evidence ?? "" : "");
  if (!text) { deps.err("--text is required"); return 2; }
  return send({ kind, text, ...(parsed.values.evidence ? { evidence: parsed.values.evidence } : {}) }, () => { deps.out(`LANE_REPORTED ${key} ${kind} (through the runner)`); });
};
