import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isReportKind } from "../lane-reports.ts";
import { ASK_SCREEN_LINES, askingLine, screenQuestion, type ScreenQuestion } from "../ask-user.ts";
import { listPanes, paneAlive, readScreen, sendVerified } from "../panes.ts";
import type { Clock, Runner } from "../run.ts";
import { ensureRunnerSubdir, RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import type { RunnerPolicy } from "./policy.ts";
import type { InventoryLane, RunnerEventBodies, RunnerEventType, SupervisorCommandBodies } from "./protocol.ts";
import type { Listener, Transport } from "./transport.ts";

/**
 * The lanes a runner starts and owns on its host (design 3.3, 3.4, 9.1 P3b).
 *
 * `lane.start` opens a herdr tab labelled with the lane key, writes the brief to `~/.dori/runner/briefs/<key>.md` (not
 * /tmp), issues the lane a fresh 32-byte token, writes it to `briefs/<key>.token` (0600) and runs the agent of the
 * requested profile from `runner-config.json` with `DORI_LANE_KEY` and `DORI_LANE_TOKEN_FILE` in front of it, so the
 * token itself is never on a command line (shell history, process listings). Only the token's sha256 is kept, in
 * `lanes.json` (0600) with the lane's pane, tab and cwd; that file is the hello inventory. The agent runs inside the herdr pane, not as a
 * child of the runner, so a runner restart does not end it.
 *
 * The lane socket `sock/lane` takes one JSON request per line from the lane-mode CLI: `{key, token, kind, text,
 * evidence?}`. A token that is not the key's own is refused (`RUNNER_LANE_AUTH_FAILED`); an accepted report goes to the
 * outbox as `lane.report`, so it survives a disconnect. `lane.close` and `lane.stop` close the tab, delete the brief and
 * the token file and forget the token. `askTick` reads each owned lane's pane for an on-screen question (the same
 * `screenQuestion` the supervisor's ask-user sweep uses) and publishes one `lane.asking` per distinct question.
 */

export const LANES_FILE = "lanes.json";
export const LANE_SOCKET = "lane";

type Publish = <T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]) => void;

export type LaneRecord = {
  readonly key: string;
  readonly pane: string;
  readonly tab: string;
  readonly cwd: string;
  readonly tokenHash: string;
  readonly profile: string;
  readonly mode: string;
  readonly model: string;
  readonly startedAt: number;
  /** The on-screen question last published as `lane.asking` (see `questionKey`), absent when none is showing. */
  readonly lastAsk?: string;
};

export type RunnerLanesDeps = {
  readonly runnerDir: string;
  readonly run: Runner;
  readonly clock: Clock;
  readonly policy: RunnerPolicy;
  readonly publish: Publish;
  readonly token?: () => string;
};

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
/** One question across ticks, like ask-user's own key: header, text and options, not the pending count. */
const questionKey = (q: ScreenQuestion): string =>
  createHash("sha256").update(JSON.stringify(q.tabs && q.tabs.length > 1 ? [q.tabs] : [q.header ?? "", q.question, q.options])).digest("hex").slice(0, 16);
const quote = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** The agent argv of `profile`, each `{prompt}`, `{model}` and `{brief}` filled in. */
export const agentArgv = (policy: RunnerPolicy, profile: string, values: { readonly prompt: string; readonly model: string; readonly brief: string }): string[] => {
  const template = policy.agents[profile];
  if (!template?.length) throw new Error(`RUNNER_LANE_PROFILE_UNKNOWN ${profile}`);
  return template.map((part) => part.replaceAll("{prompt}", values.prompt).replaceAll("{model}", values.model).replaceAll("{brief}", values.brief));
};

export class RunnerLanes {
  constructor(private readonly deps: RunnerLanesDeps) {}

  private get file(): string { return join(this.deps.runnerDir, LANES_FILE); }

  records(): Record<string, LaneRecord> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, LaneRecord>) : {};
  }

  private save(records: Record<string, LaneRecord>): void {
    writeRunnerFile(this.file, `${JSON.stringify(records, null, 2)}\n`);
  }

  briefPath(key: string): string {
    return join(this.deps.runnerDir, RUNNER_PATHS.briefs, `${key}.md`);
  }

  /** The lane's token file, next to its brief in the owner-only briefs directory. */
  tokenPath(key: string): string {
    return join(this.deps.runnerDir, RUNNER_PATHS.briefs, `${key}.token`);
  }

  inventory(): InventoryLane[] {
    return Object.values(this.records()).map((r) => ({ key: r.key, pane: r.pane, tab: r.tab }));
  }

  /** Whether `token` is the one issued to lane `key`, compared in constant time. */
  tokenFor(key: string, token: string): boolean {
    const record = this.records()[key];
    if (!record) return false;
    const want = Buffer.from(record.tokenHash, "hex");
    const got = Buffer.from(hash(token), "hex");
    return want.length === got.length && timingSafeEqual(want, got);
  }

  async start(body: SupervisorCommandBodies["lane.start"]): Promise<string> {
    if (this.records()[body.key]) throw new Error(`RUNNER_LANE_EXISTS ${body.key}`);
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    writeRunnerFile(this.briefPath(body.key), body.briefText);
    return this.launch(body.key, body.cwd, body.agentProfile, body.mode, body.model);
  }

  private async launch(key: string, cwd: string, profile: string, mode: string, model: string): Promise<string> {
    const brief = this.briefPath(key);
    const prompt = `${mode === "mass-ulw" ? "mass-ulw" : "ulw"}. Read and execute the lane brief at ${brief} in full. You are the ${key} lane; report as the brief's footer says.`;
    const argv = agentArgv(this.deps.policy, profile, { prompt, model, brief });
    const created = await this.deps.run(["herdr", "tab", "create", "--cwd", cwd, "--label", key, "--no-focus"]);
    if (created.code !== 0) throw new Error(`herdr tab create failed: ${(created.err || created.out).trim()}`);
    const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
    const pane = made.root_pane.pane_id;
    const tab = made.tab_id ?? made.root_pane.tab_id ?? "";
    const token = (this.deps.token ?? (() => randomBytes(32).toString("base64url")))();
    ensureRunnerSubdir(this.deps.runnerDir, RUNNER_PATHS.briefs);
    const tokenFile = this.tokenPath(key);
    writeRunnerFile(tokenFile, token);
    // Only the value of each assignment is quoted, so /bin/sh still reads KEY=value as an assignment.
    const command = [`DORI_LANE_KEY=${quote(key)}`, `DORI_LANE_TOKEN_FILE=${quote(tokenFile)}`, ...argv.map(quote)].join(" ");
    const ran = await this.deps.run(["herdr", "pane", "run", pane, command]);
    if (ran.code !== 0) {
      rmSync(tokenFile, { force: true });
      await this.deps.run(["herdr", "tab", "close", tab]);
      throw new Error(`herdr pane run failed: ${(ran.err || ran.out).trim()}`);
    }
    this.save({ ...this.records(), [key]: { key, pane, tab, cwd, tokenHash: hash(token), profile, mode, model, startedAt: this.deps.clock.now() } });
    this.deps.publish("lane.started", { key, pane, tab, session: "" });
    return `started pane=${pane} tab=${tab}`;
  }

  private record(key: string): LaneRecord {
    const record = this.records()[key];
    if (!record) throw new Error(`RUNNER_LANE_UNKNOWN ${key}`);
    return record;
  }

  /** Closes the lane's tab, deletes its brief and token file and forgets its token. */
  async close(key: string): Promise<string> {
    const record = this.record(key);
    await this.deps.run(["herdr", "tab", "close", record.tab]);
    rmSync(this.briefPath(key), { force: true });
    rmSync(this.tokenPath(key), { force: true });
    const { [key]: _gone, ...rest } = this.records();
    this.save(rest);
    return `closed tab=${record.tab}`;
  }

  async send(key: string, text: string, verify: boolean): Promise<string> {
    const record = this.record(key);
    const delivery = await sendVerified(this.deps.run, this.deps.clock, record.pane, text, verify);
    if (delivery === "failed") throw new Error(`RUNNER_LANE_SEND_FAILED ${key}`);
    return `sent ${delivery}`;
  }

  async observe(key: string): Promise<string> {
    const record = this.record(key);
    const pane = (await listPanes(this.deps.run)).find((p) => p.pane_id === record.pane);
    // The same alive test as serve.ts laneStatus, so the runner and the supervisor call one pane the same.
    const status = !pane ? "missing" : !paneAlive(pane) ? "dead" : pane.agent_status === "working" ? "working" : "idle";
    this.deps.publish("lane.state", { key, status });
    if (!pane) throw new Error(`RUNNER_LANE_ABSENT ${key} pane ${record.pane} is gone`);
    return `observed ${status}`;
  }

  /**
   * Starts the lane again from its brief when its pane or agent is gone (`paneAlive`); a live lane is left alone. The old
   * record stays until the relaunch has a new pane, so a failed relaunch throws and a later recover can retry it. A live
   * lane publishes `lane.started` for its current record, which completes the supervisor's pending recovery.
   */
  async recover(key: string): Promise<string> {
    const record = this.record(key);
    const pane = (await listPanes(this.deps.run)).find((p) => p.pane_id === record.pane);
    if (paneAlive(pane)) {
      this.deps.publish("lane.started", { key, pane: record.pane, tab: record.tab, session: "" });
      return `alive pane=${record.pane}`;
    }
    if (pane) await this.deps.run(["herdr", "tab", "close", record.tab]);
    return this.launch(key, record.cwd, record.profile, record.mode, record.model);
  }

  /**
   * One pass over the owned lanes: a question prompt on a lane's screen not published yet goes out as `lane.asking`
   * and is remembered in the record (`lastAsk`); a lane whose prompt is gone forgets it, so its next question goes out
   * again. An empty or failed screen read changes nothing. Returns the keys published.
   */
  async askTick(): Promise<string[]> {
    const asked: string[] = [];
    for (const record of Object.values(this.records())) {
      const screen = await readScreen(this.deps.run, record.pane, ASK_SCREEN_LINES).catch(() => "");
      if (!screen.trim()) continue;
      const q = screenQuestion(screen);
      const seen = q ? questionKey(q) : undefined;
      if (seen === record.lastAsk) continue;
      if (q) { this.deps.publish("lane.asking", { key: record.key, text: askingLine(record.key, q) }); asked.push(record.key); }
      const current = this.records()[record.key];
      if (current) {
        const { lastAsk: _was, ...rest } = current;
        this.save({ ...this.records(), [record.key]: seen ? { ...rest, lastAsk: seen } : rest });
      }
    }
    return asked;
  }
}

export type LaneRequest = { readonly key: string; readonly token: string; readonly kind: string; readonly text: string; readonly evidence?: string };

/** Serves the lane socket on `listener`: each request line gets one reply line `{ok}` or `{ok:false, code, detail}`. */
export const serveLaneSocket = (listener: Listener, lanes: Pick<RunnerLanes, "tokenFor">, publish: Publish, log: (line: string) => void): (() => void) =>
  listener.onConnection((link: Transport) => {
    link.onLine((line) => {
      const reply = (body: object): void => {
        try { link.send(`${JSON.stringify(body)}\n`); }
        catch (e) { log(`RUNNER_LANE_REPLY_FAILED ${e instanceof Error ? e.message : String(e)}`); }
      };
      let req: LaneRequest;
      try { req = JSON.parse(line) as LaneRequest; } catch { reply({ ok: false, code: "RUNNER_LANE_BAD_REQUEST", detail: "not JSON" }); return; }
      if (typeof req.key !== "string" || typeof req.token !== "string" || typeof req.text !== "string" || !isReportKind(req.kind)) {
        reply({ ok: false, code: "RUNNER_LANE_BAD_REQUEST", detail: "needs key, token, a report kind and text" });
        return;
      }
      if (!lanes.tokenFor(req.key, req.token)) {
        log(`RUNNER_LANE_AUTH_FAILED key=${req.key}`);
        reply({ ok: false, code: "RUNNER_LANE_AUTH_FAILED", detail: `not ${req.key}'s lane token` });
        return;
      }
      publish("lane.report", { key: req.key, kind: req.kind, text: req.text, ...(typeof req.evidence === "string" && req.evidence ? { evidence: req.evidence } : {}) });
      reply({ ok: true });
    });
  });
