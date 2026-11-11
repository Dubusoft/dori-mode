import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acquireSlot, pidAlive, releaseSlot } from "../heavy-slot.ts";
import { sampleLoad1 } from "../host-guard.ts";
import { isReportKind } from "./report-kinds.ts";
import { realClock, run as realRun, type Clock, type Runner } from "../run.ts";
import { SECRET_NAME } from "../secret-name.ts";
import type { Connector, Transport } from "./transport.ts";

/**
 * The `dori` a lane runs on a worker machine (design 3.4): the runner bundle in lane mode, set by `DORI_LANE_KEY`. It
 * takes only `report` (and `report ack <id>`), `claim-done`, `lane status`, `heavy`, `secret exec` and `secret run`, and only for the lane's own
 * key; any other subcommand exits 2 with `DORI_CLI_LANE_ONLY <cmd>`. A report goes to the runner's lane socket with the lane's token, read from
 * the file `DORI_LANE_TOKEN_FILE` names (or, for a lane an older runner started, `DORI_LANE_TOKEN` itself), so the
 * runner accepts it only from the lane it started. `heavy` uses the host's `~/.dori/heavy/slot.N` directories,
 * the same ones `dori heavy` on the host takes, so every footer on a machine shares one slot count.
 */

export const LANE_CLI_COMMANDS = ["report", "claim-done", "lane", "heavy", "secret"] as const;

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
  readonly heavyDir?: string;
  readonly clock?: Clock;
  readonly spawn?: (argv: readonly string[]) => Promise<number>;
  /** Runs a command with exactly this environment and resolves to its exit code; default Bun.spawn with inherited stdio. */
  readonly spawnWithEnv?: (argv: readonly string[], env: Record<string, string>) => Promise<number>;
  readonly readFile?: (path: string) => string;
  /** Directory under which ssh-key secret files get their private temp dir; default `os.tmpdir()`. */
  readonly tempRoot?: string;
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

const LANE_ONLY_TEXT = "inside a lane dori takes only report, claim-done, report ack, lane status and heavy, plus secret exec and secret run";

/** `text` as one single-quoted POSIX shell word. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

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
  if (sub === "secret" && rest[0] === "run") {
    const [, op, ...extra] = rest;
    if (!op || extra.length || !/^[a-z][a-z0-9-]{0,63}$/.test(op)) { deps.err("usage: dori secret run <op>"); return 2; }
    let result: Reply = { ok: true };
    const code = await send({ kind: "secret-run", op }, (reply) => { result = reply; });
    if (code !== 0) return code;
    const write = deps.write ?? ((stream, text) => { (stream === "stdout" ? process.stdout : process.stderr).write(text); });
    if (typeof result.stdout === "string" && result.stdout) write("stdout", result.stdout);
    if (typeof result.stderr === "string" && result.stderr) write("stderr", result.stderr);
    if (result.truncated === true) deps.err(`dori: ${op} output was truncated at 64 KiB per stream`);
    return typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : 1;
  }
  if (sub === "secret") {
    const sep = rest.indexOf("--");
    const names = sep >= 0 ? rest.slice(1, sep) : rest.slice(1);
    const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
    if (rest[0] !== "exec") { deps.err(`DORI_CLI_LANE_ONLY ${`secret ${rest[0] ?? ""}`.trim()}: ${LANE_ONLY_TEXT}`); return 2; }
    if (!names.length || sep < 0 || !cmd.length || !names.every((n) => SECRET_NAME.test(n))) {
      deps.err("usage: dori secret exec NAME [NAME...] -- <command ...>");
      return 2;
    }
    let values: Record<string, string> = {};
    let kinds: Record<string, string> = {};
    const code = await send({ kind: "secret", names }, (reply) => {
      values = (reply.values ?? {}) as Record<string, string>;
      kinds = (reply.kinds ?? {}) as Record<string, string>;
    });
    if (code !== 0) return code;
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps.env)) if (typeof v === "string") base[k] = v;
    const childEnv: Record<string, string> = { ...base, ...values };
    // An ssh-key secret goes to a 0600 file in a private 0700 dir; the env carries the path, never the key.
    const keyNames = Object.keys(values).filter((n) => kinds[n] === "ssh-key");
    let dir: string | undefined;
    try {
      if (keyNames.length) {
        dir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), "dori-secret-"));
        for (const name of keyNames) {
          const path = join(dir, name);
          const value = values[name] as string;
          writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
          childEnv[name] = path;
        }
        if (keyNames.length === 1) childEnv.GIT_SSH_COMMAND = `ssh -i ${shellQuote(childEnv[keyNames[0] as string] as string)} -o IdentitiesOnly=yes -o IdentityAgent=none`;
      }
      return await (deps.spawnWithEnv ?? (async (argv, env) => Bun.spawn([...argv], { env, stdout: "inherit", stderr: "inherit", stdin: "inherit" }).exited))(cmd, childEnv);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
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
