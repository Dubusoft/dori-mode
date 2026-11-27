import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acquireSlot, pidAlive } from "../heavy-slot.ts";
import { watchSimulators } from "../heavy-simulators.ts";
import { sampleLoad1 } from "../host-guard.ts";
import { decisionChoicesProblem, inputRequestProblem, serializeDecisionText, serializeRequestText } from "./decision-text.ts";
import { isReportKind } from "./report-kinds.ts";
import { realClock, run as realRun, type Clock, type Runner } from "../run.ts";
import { SECRET_NAME } from "../secret-name.ts";
import type { Connector, Transport } from "./transport.ts";

/**
 * The `dori` a lane runs on a worker machine (design 3.4): the runner bundle in lane mode, set by `DORI_LANE_KEY`. It
 * takes only `report` (and `report ack <id>`), `claim-done`, `lane status`, `heavy`, `secret env`, `secret run` (alias `host <op>`) and the read-only
 * `toodo get|search|guidelines`, and only for the lane's own
 * key; any other subcommand exits 2 with `DORI_CLI_LANE_ONLY <cmd>`. A report goes to the runner's lane socket with the lane's token, read from
 * the file `DORI_LANE_TOKEN_FILE` names (or, for a lane an older runner started, `DORI_LANE_TOKEN` itself), so the
 * runner accepts it only from the lane it started. `heavy` uses the host's `~/.dori/heavy/slot.N` directories,
 * the same ones `dori heavy` on the host takes, so every footer on a machine shares one slot count.
 */

export const LANE_CLI_COMMANDS = ["report", "claim-done", "lane", "heavy", "secret", "host", "toodo"] as const;

/** How long a request keeps retrying a missing or refusing lane socket (a supervisor/runner restart), and how often. */
export const LANE_SOCKET_RETRY_MS = 60_000;
export const LANE_SOCKET_RETRY_STEP_MS = 1_000;

export type LaneCliDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly connect: Connector;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Writes raw text (a secret command's output) to the lane's stdout or stderr; default `process.stdout`/`process.stderr`. */
  readonly write?: (stream: "stdout" | "stderr", text: string) => void;
  /** Whether `out` reaches a terminal; `secret env` then refuses rather than leave values in scrollback. Default false. */
  readonly stdoutIsTTY?: boolean;
  readonly heavyDir?: string;
  readonly clock?: Clock;
  readonly spawn?: (argv: readonly string[]) => Promise<number>;
  readonly readFile?: (path: string) => string;
  /** The runner directory holding `briefs/<key>.token`; default `~/.dori/runner`. */
  readonly runnerDir?: string;
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
  () => sampleLoad1(platform, run, runnerDir);

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

const LANE_ONLY_TEXT = "inside a lane dori takes only report, claim-done, report ack, lane status and heavy, plus secret env, secret run (alias host <op>) and toodo get|search|guidelines";

const TOODO_USAGE = "usage: dori toodo get [<task id>] | dori toodo search <query> | dori toodo guidelines (read-only: Toodo writes go through dori report)";

const REPORT_USAGE = "usage: dori report <key> <progress|blocked|milestone|done> --text \"...\" [--evidence \"...\"] | dori report <key> question --text \"<question>\" --option \"<A>\" --option \"<B>\" --recommend N --reason \"<why>\" [--waiting \"<what is paused>\"] [--nonblocking] | dori report <key> request --text \"<what you need from the owner>\" --reason \"<why>\" [--file <path>] [--waiting \"<what is paused>\"] [--nonblocking]";
const CLAIM_DONE_USAGE = "usage: dori claim-done <key> --evidence \"<merge SHA, ...>\"";

/** What `--help` (or `-h`) prints for each lane command. */
const LANE_HELP: Record<(typeof LANE_CLI_COMMANDS)[number], string> = {
  report: [
    REPORT_USAGE,
    "  question needs 2-9 --option values, --recommend N (1-based, in range) and --reason; --waiting names what is paused",
    "  (with --nonblocking: what goes ahead on the recommendation). An open-ended blocker without choices is: blocked --text ...",
    "  request asks the owner for input only they can give (a one-time code such as 2FA, login or device codes, a file or a value)",
    "  in its own thread; the owner replies there. A long-lived secret (password, API key, token) is never asked for in Discord:",
    "  --file <path> names where the owner writes it (chmod 600), and a request naming one without --file is refused",
    "usage: dori report ack <id>",
  ].join("\n"),
  "claim-done": CLAIM_DONE_USAGE,
  lane: "usage: dori lane status [<key>]",
  heavy: "usage: dori heavy <label> -- <command ...>",
  secret: [
    "usage: dori secret env",
    "usage: dori secret run <op>",
    "  every stored secret arrives in the lane environment at launch; GH_TOKEN supplies GitHub access directly",
    "  secret env is only for eval \"$(dori secret env)\": with stdout on a terminal it prints no values and exits 2",
    "  production deploys and host work use dori secret run <op> or dori host <op>",
  ].join("\n"),
  host: [
    "usage: dori host <op>",
    "  same as dori secret run <op>: the supervisor host runs the registered command config secretCommands.<op> (a sandbox",
    "  probe, systemctl --user daemon-reload) outside the lane and prints its redacted output, exiting with its code.",
    "  On a worker, an op in its runner-config hostCommands runs on that worker host instead.",
    "  A refused op lists the ops this lane may run.",
  ].join("\n"),
  toodo: [
    TOODO_USAGE,
    "  get without an id shows this lane's own task (description, criteria, notes, refs) with its dependencies and related tasks",
    "  search looks through the titles, descriptions and refs of the tasks in the lane task's workspace",
    "  guidelines lists that workspace's rules and memories",
    "  A lane reads its own task, the tasks it depends on or is related to, and its workspace; anything else is refused.",
  ].join("\n"),
};

/** `text` as one single-quoted POSIX shell word. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

export const laneCliMain = async (args: readonly string[], deps: LaneCliDeps): Promise<number> => {
  const [sub = "", ...rest] = args;
  if (!(LANE_CLI_COMMANDS as readonly string[]).includes(sub) || (sub === "lane" && rest[0] !== "status")) {
    deps.err(`DORI_CLI_LANE_ONLY ${sub === "lane" ? `lane ${rest[0] ?? ""}`.trim() : sub || "(none)"}: ${LANE_ONLY_TEXT}`);
    return 2;
  }
  // `--help` before a `--` (after it, the arguments belong to the command heavy runs) prints the usage.
  const sep = rest.indexOf("--");
  if ((sep >= 0 ? rest.slice(0, sep) : rest).some((arg) => arg === "--help" || arg === "-h")) {
    deps.out(LANE_HELP[sub as (typeof LANE_CLI_COMMANDS)[number]]);
    return 0;
  }
  const own = deps.env.DORI_LANE_KEY?.trim() ?? "";
  const clock = deps.clock ?? realClock;
  const withoutOk = ({ ok: _ok, ...others }: Reply): object => others;
  /** One authenticated request for the lane's own key; `done` prints on success. */
  const send = async (verb: object, done: (reply: Reply) => void): Promise<number> => {
    const token = laneToken(deps, own);
    if (!token) { deps.err("RUNNER_LANE_AUTH_FAILED no lane token: DORI_LANE_TOKEN_FILE unreadable or empty, no DORI_LANE_TOKEN, and no briefs/<key>.token"); return 1; }
    let reply: Reply;
    try { reply = await request(deps.connect, { ...verb, key: own, token }, clock); } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.err(sub === "secret" && rest[0] === "env" && !/^RUNNER_[A-Z_]+ /.test(detail) ? `RUNNER_SECRET_FAILED ${detail}` : detail);
      return 1;
    }
    if (!reply.ok) { deps.err(`${reply.code ?? "RUNNER_LANE_REFUSED"} ${reply.detail ?? ""}`.trim()); return 1; }
    done(reply);
    return 0;
  };
  if ((sub === "secret" && rest[0] === "run") || sub === "host") {
    const [op, ...extra] = sub === "host" ? rest : rest.slice(1);
    if (!op || extra.length || !/^[a-z][a-z0-9-]{0,63}$/.test(op)) { deps.err(sub === "host" ? "usage: dori host <op>" : "usage: dori secret run <op>"); return 2; }
    let result: Reply = { ok: true };
    const code = await send({ kind: "secret-run", op }, (reply) => { result = reply; });
    if (code !== 0) return code;
    const write = deps.write ?? ((stream, text) => { (stream === "stdout" ? process.stdout : process.stderr).write(text); });
    if (typeof result.stdout === "string" && result.stdout) write("stdout", result.stdout);
    if (typeof result.stderr === "string" && result.stderr) write("stderr", result.stderr);
    if (result.truncated === true) deps.err(`dori: ${op} output was truncated at 64 KiB per stream`);
    return typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : 1;
  }
  if (sub === "toodo") {
    const [op, ...args] = rest;
    const query = args.join(" ").trim();
    let verb: object | undefined;
    if (op === "guidelines" && !args.length) verb = { op };
    else if (op === "get" && args.length <= 1) {
      const id = args[0] === undefined ? undefined : Number(args[0].replace(/^#/, ""));
      if (id === undefined || (Number.isSafeInteger(id) && id >= 0)) verb = id === undefined ? { op } : { op, id };
    } else if (op === "search" && query) verb = { op, query };
    if (!verb) { deps.err(TOODO_USAGE); return 2; }
    let reply: Reply = { ok: true };
    const code = await send({ kind: "toodo", ...verb }, (r) => { reply = r; });
    if (code !== 0) return code;
    if (typeof reply.text === "string") deps.out(reply.text);
    if (reply.truncated === true) deps.err("dori: the Toodo answer was cut at 256 KiB");
    return 0;
  }
  if (sub === "secret") {
    if (rest.length !== 1 || rest[0] !== "env") { deps.err("usage: dori secret env | dori secret run <op>"); return 2; }
    if (deps.stdoutIsTTY === true) {
      deps.err("SECRET_ENV_TTY_REFUSED dori secret env prints every secret in plain text, so it refuses a terminal: use eval \"$(dori secret env)\" (the values are already in the lane environment)");
      return 2;
    }
    let values: unknown;
    const code = await send({ kind: "secret" }, (reply) => { values = reply.values; });
    if (code !== 0) return code;
    if (typeof values !== "object" || values === null || Array.isArray(values) || !Object.entries(values).every(([name, value]) => SECRET_NAME.test(name) && typeof value === "string")) {
      deps.err("RUNNER_SECRET_FAILED the runner's grant is not a map of secret names to values"); return 1;
    }
    for (const [name, value] of Object.entries(values)) deps.out(`export ${name}=${shellQuote(value as string)}`);
    return 0;
  }
  if (sub === "heavy") {
    const sep = rest.indexOf("--");
    const label = rest[0];
    const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
    if (!label || label === "--" || !cmd.length) { deps.err("usage: dori heavy <label> -- <command ...>"); return 2; }
    const slots = Number(deps.env.DORI_HEAVY_SLOTS ?? "1");
    const dir = deps.heavyDir ?? heavyDirOf();
    const platform = deps.platform ?? process.platform;
    const slot = await acquireSlot({
      dir, slots: Number.isSafeInteger(slots) && slots > 0 ? slots : 1, maxLoad: heavyMaxLoad(deps.env.DORI_HEAVY_MAX_LOAD),
      clock, load: heavyLoad(deps.platform ?? process.platform, deps.run ?? realRun, deps.runnerDir), alive: pidAlive, pid: process.pid,
      ...(deps.platform ? { platform: deps.platform } : {}),
    }, `${own}:${label}`);
    const finish = await watchSimulators({ run: deps.run ?? realRun, dir, platform, alive: (pid) => pidAlive(pid), now: clock.now, pid: process.pid, err: deps.err }, slot);
    try {
      return await (deps.spawn ?? (async (argv) => Bun.spawn([...argv], { stdout: "inherit", stderr: "inherit", stdin: "inherit" }).exited))(cmd);
    } finally {
      await finish();
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
  const parsed = parseArgs({ args: [...rest], allowPositionals: true, options: {
    text: { type: "string" }, evidence: { type: "string" },
    option: { type: "string", multiple: true }, recommend: { type: "string" }, reason: { type: "string" }, waiting: { type: "string" }, nonblocking: { type: "boolean" },
    file: { type: "string" },
  } });
  const [key, kindArg, ...extra] = parsed.positionals;
  // A request travels as a question report in the REQUEST v1 text form, so the runner protocol is unchanged.
  const isRequest = sub === "report" && kindArg === "request";
  const kind = sub === "claim-done" ? "done" : isRequest ? "question" : kindArg;
  if (!key || extra.length || (sub === "claim-done" && kindArg !== undefined) || !isReportKind(kind)) {
    deps.err(sub === "claim-done" ? CLAIM_DONE_USAGE : REPORT_USAGE);
    return 2;
  }
  if (key !== own) {
    deps.err(`LANE_PERMISSION_DENIED lane ${own || "(none)"} may report only for itself, not ${key}`);
    return 1;
  }
  const text = parsed.values.text ?? (kind === "done" ? parsed.values.evidence ?? "" : "");
  if (!text) { deps.err("--text is required"); return 2; }
  const { option, recommend, reason, waiting, nonblocking, file } = parsed.values;
  let sentText = text;
  if (file !== undefined && !isRequest) { deps.err("usage: --file goes only with the request kind"); return 2; }
  if (isRequest) {
    if (option !== undefined || recommend !== undefined) { deps.err("usage: a request takes no --option or --recommend; to ask the owner to choose use the question kind"); return 2; }
    const asked = { need: text, reason, waiting: waiting ?? `레인 ${key} 진행`, ...(file !== undefined ? { file } : {}) };
    const problem = inputRequestProblem(asked);
    if (problem) {
      deps.err(`REPORT_REFUSED request needs --text (what is needed) and --reason; not sent (${problem})`);
      return 2;
    }
    sentText = serializeRequestText({ ...asked, reason: reason as string, blocking: !nonblocking });
  } else if (kind !== "question") {
    if (option !== undefined || recommend !== undefined || reason !== undefined || waiting !== undefined || nonblocking !== undefined) {
      deps.err("usage: --option, --recommend, --reason, --waiting and --nonblocking go only with the question and request kinds");
      return 2;
    }
  } else {
    const choices = { question: text, options: option ?? [], recommend, reason, waiting: waiting ?? `레인 ${key} 진행` };
    const problem = decisionChoicesProblem(choices);
    if (problem) {
      deps.err(`REPORT_REFUSED question needs --option (2-9), --recommend N and --reason; a question without choices is not sent (${problem}). For an open-ended blocker use: dori report ${key} blocked --text ...`);
      return 2;
    }
    sentText = serializeDecisionText({ ...choices, recommend: Number((recommend as string).trim()), reason: reason as string, blocking: !nonblocking });
  }
  return send({ kind, text: sentText, ...(parsed.values.evidence ? { evidence: parsed.values.evidence } : {}) }, () => { deps.out(`LANE_REPORTED ${key} ${isRequest ? "request" : kind} (through the runner)`); });
};
