import { realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { laneCliMain } from "./lane-cli.ts";
import { LANE_SOCKET, RunnerLanes, serveLaneSocket } from "./lanes.ts";
import { ensureRunnerSubdir, RUNNER_PATHS } from "./fs-safety.ts";
import { connectUnix as connectLane, listenUnix } from "./unix-transport.ts";
import { sampleHost } from "../host-guard.ts";
import { sampleProcs } from "../lane-memory.ts";
import { parseArgs } from "node:util";
import { loadConfig, runnerMode } from "../config.ts";
import { listPanes } from "../panes.ts";
import { Registry } from "../registry.ts";
import { realClock, run, setDefaultRunTimeout } from "../run.ts";
import { enrollRunner, RunnerAuth } from "./auth.ts";
import { GUARD_SAMPLE_MS, RunnerGuard } from "./guard.ts";
import { HEARTBEAT_MS, RunnerClient } from "./client.ts";
import { defaultRunnerDir, runStartupCheck } from "./fs-safety.ts";
import { pidAlive, probe, startHealth } from "./health.ts";
import { observeHost } from "./observe.ts";
import { Outbox } from "./outbox.ts";
import { loadPolicy } from "./policy.ts";
import { commandDispatcher, LOCAL_RUNNER, loadIdentity, observeLanes, parseEnrollInput, realEvery, serveRunner, trackedConnector } from "./serve.ts";
import { RunnerState } from "./state.ts";
import { connectUnix, controlSocketPath } from "./unix-transport.ts";
import { connectWs } from "./ws-transport.ts";

/**
 * The commands a runner host runs: `runner serve` and `runner probe`. `dori runner ...` hands these two to this module,
 * and `bin.ts` runs it on its own, so the bundle installed on worker machines holds only the runner and not the rest of
 * the CLI. Returns the process exit code.
 */

export const RUNNER_HOST_USAGE = "usage: runner serve [--label LABEL] [--enroll | --enroll-only] [--connect ws://HOST:PORT] | runner probe [--json]";

class Exit extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const fail = (message: string, code = 1): never => { throw new Exit(code, message); };

const probeMain = (json: boolean): number => {
  const result = probe({ runnerDir: defaultRunnerDir(), now: realClock.now });
  console.log(json ? JSON.stringify(result) : `RUNNER_PROBE ${result.verdict} process=${result.process} age=${result.healthAgeMs ?? "-"}ms gen=${result.gen ?? "-"}`);
  return result.verdict === "healthy" ? 0 : 1;
};

const serveMain = async (values: { label?: string; enroll?: boolean; "enroll-only"?: boolean; connect?: string }): Promise<number> => {
  const runnerDir = defaultRunnerDir();
  // RUNNER_DIR_UNSAFE on stderr and exit 1 before anything is opened.
  let exitCode: number | undefined;
  if (!runStartupCheck(runnerDir, { stderr: (text) => { process.stderr.write(text); }, exit: (code) => { exitCode = code; } })) return exitCode ?? 1;
  const cfg = await loadConfig();
  setDefaultRunTimeout(cfg.runTimeoutMs);
  const identity = loadIdentity(runnerDir, values.label ?? LOCAL_RUNNER, hostname());
  const connector = values.connect ? connectWs(values.connect) : connectUnix(controlSocketPath(runnerDir));
  const endpoint = values.connect ?? controlSocketPath(runnerDir);
  const auth = new RunnerAuth(runnerDir);
  const enrollOnly = values["enroll-only"] === true;
  if (values.enroll || enrollOnly) {
    // The one-time code and the supervisor fingerprint arrive on stdin (`dori runner enroll` output), never in argv.
    const input = parseEnrollInput(await Bun.stdin.text());
    if (!input) fail("RUNNER_ENROLL_INPUT_INVALID stdin must carry code=<code> and fingerprint=sha256:<hex> lines");
    const enrolled = await enrollRunner({
      auth, connect: connector, code: input?.code as string, label: identity.label, hostId: identity.hostId,
      expectedFingerprint: input?.fingerprint as string,
    });
    if (!enrolled.ok) fail(`${enrolled.code} ${enrolled.detail}`);
    console.log(`RUNNER_ENROLLED runner=${identity.label} supervisor=${enrolled.ok ? enrolled.supervisorFingerprint : ""}`);
    if (enrollOnly) return 0;
  }
  if (!auth.enrolled) fail(`RUNNER_NOT_ENROLLED runner=${identity.label}: start once with --enroll (the local runner is enrolled by the supervisor)`);
  const policy = loadPolicy(runnerDir);
  const state = new RunnerState(runnerDir, { now: realClock.now });
  const gen = state.boot();
  const outbox = new Outbox(runnerDir, { now: realClock.now });
  // A runner started with --connect runs on a worker machine: it has no dori config or registry there, so it always
  // observes its host's lanes from herdr and /proc. Observing changes nothing; the supervisor compares only the
  // labels its own runners.mode marks shadow. The local runner observes only in shadow mode, from the registry.
  const remote = values.connect !== undefined;
  const mode = remote ? "shadow" : runnerMode(cfg, identity.label);
  let inventory: { key: string; pane: string; tab: string; session?: string }[] = [];
  const observedLanes = remote
    ? () => observeHost({ run })
    : mode === "shadow"
      ? (() => { const registry = new Registry(cfg.stateDir); return async () => observeLanes(identity.label, await registry.open(), await listPanes(run)); })()
      : undefined;
  const observe = observedLanes ? async () => {
    const lanes = await observedLanes();
    const observed = lanes.map(({ status: _status, reportHash: _hash, ...lane }) => lane);
    // The lanes this runner started come first; the rest are lanes it only observes for the shadow comparison.
    const owned = runnerLanes?.inventory() ?? [];
    inventory = [...owned, ...observed.filter((l) => !owned.some((o) => o.key === l.key))];
    return lanes;
  } : undefined;
  const head = await run(["git", "-C", import.meta.dir, "rev-parse", "--short", "HEAD"], { timeoutMs: 5_000 }).catch(() => undefined);
  const version = head?.code === 0 ? head.out.trim() || undefined : undefined;
  const log = (line: string): void => { console.log(line); };
  const tracked = trackedConnector(connector);
  let client: RunnerClient | undefined;
  const publish: ConstructorParameters<typeof RunnerLanes>[0]["publish"] = (type, body) => { client?.publish(type, body); };
  // Lanes started through this runner exist only on a worker; the lead host's lanes keep their own launch path.
  const runnerLanes = remote ? new RunnerLanes({ runnerDir, run, clock: realClock, policy, publish }) : undefined;
  if (runnerLanes) inventory = runnerLanes.inventory();
  // Only a worker's runner guards its host: on the lead host the supervisor's own guard sweep samples and kills, and
  // two killers there would race. Thresholds and heavyKill come from runner-config.json, else the config defaults.
  const guard = remote ? new RunnerGuard({
    sample: () => sampleHost(run, homedir()), thresholds: { ...cfg.guard, ...policy.guard }, heavyKill: policy.heavyKill ?? cfg.heavyKill,
    procs: () => sampleProcs(run), self: process.pid, now: realClock.now, os: process.platform,
    kill: { clock: realClock, alive: pidAlive, signal: (pid, sig) => { process.kill(pid, sig); } },
    publish: (type, body) => { client?.publish(type, body); },
  }) : undefined;
  const dispatch = commandDispatcher({
    state, policy, realpath: realpathSync, log,
    publish: (body) => { client?.publish("cmd.result", body); },
    effects: {
      ...(guard ? { "guard.kill": async (command) => `killed ${(await guard.killLanes(command.body.keys)).length}` } : {}),
      ...(runnerLanes ? {
        "lane.start": async (command) => runnerLanes.start(command.body),
        "lane.stop": async (command) => runnerLanes.close(command.body.key),
        "lane.close": async (command) => runnerLanes.close(command.body.key),
        "lane.send": async (command) => runnerLanes.send(command.body.key, command.body.text, command.body.verify),
        "lane.recover": async (command) => runnerLanes.recover(command.body.key),
        "lane.observe": async (command) => runnerLanes.observe(command.body.key),
      } : {}),
    },
  });
  client = new RunnerClient(
    { label: identity.label, hostId: identity.hostId, ...(version ? { version } : {}) },
    { connect: tracked.connect, outbox, state, clock: realClock, inventory: () => inventory, auth, log, onCommand: dispatch, onInvalidCommand: dispatch },
  );
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  console.log(`RUNNER_SERVE label=${identity.label} gen=${gen} mode=${mode} endpoint=${endpoint}`);
  const stopHealth = startHealth({ runnerDir, pid: process.pid, gen, now: realClock.now, monotonic: () => Math.round(performance.now()), every: realEvery, log });
  let guarding = false;
  const guardTick = (): void => {
    if (!guard || guarding) return;
    guarding = true;
    void guard.tick().catch((e: unknown) => { log(`RUNNER_GUARD_FAILED ${e instanceof Error ? e.message : String(e)}`); }).finally(() => { guarding = false; });
  };
  guardTick();
  const stopGuard = guard ? realEvery(GUARD_SAMPLE_MS, guardTick) : () => {};
  let stopLaneSocket = (): void => {};
  if (runnerLanes) {
    ensureRunnerSubdir(runnerDir, RUNNER_PATHS.sock);
    const laneListener = listenUnix(join(runnerDir, RUNNER_PATHS.sock, LANE_SOCKET));
    const stop = serveLaneSocket(laneListener, runnerLanes, publish, log);
    stopLaneSocket = () => { stop(); laneListener.close(); };
  }
  try {
    await serveRunner({
      client, latest: tracked.latest, clock: realClock, every: realEvery, heartbeatMs: HEARTBEAT_MS,
      ...(observe ? { observe } : {}), log,
    }, controller.signal);
  } finally {
    stopLaneSocket();
    stopGuard();
    stopHealth();
    outbox.close();
    state.close();
  }
  return 0;
};

/** Runs `serve` or `probe` from `args` (the words after `runner`). */
export const runnerHostMain = async (args: readonly string[]): Promise<number> => {
  // Inside a lane this bundle is the lane-mode `dori`: report, claim-done and heavy for the lane's own key, nothing else.
  if (process.env.DORI_LANE_KEY) {
    return laneCliMain(args, {
      env: process.env, connect: connectLane(join(defaultRunnerDir(), RUNNER_PATHS.sock, LANE_SOCKET)),
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    });
  }
  try {
    const parsed = parseArgs({
      args: [...args], allowPositionals: true,
      options: { label: { type: "string" }, enroll: { type: "boolean" }, "enroll-only": { type: "boolean" }, connect: { type: "string" }, json: { type: "boolean" } },
    });
    const [sub, ...extra] = parsed.positionals;
    if (extra.length) fail(RUNNER_HOST_USAGE, 2);
    if (sub === "probe") return probeMain(parsed.values.json === true);
    if (sub === "export-outbox") {
      // For `dori runner evacuate` over ssh: every event this runner has not had acked, as the frames it would send.
      const runnerDir = defaultRunnerDir();
      const identity = loadIdentity(runnerDir, parsed.values.label ?? LOCAL_RUNNER, hostname());
      const outbox = new Outbox(runnerDir, { now: realClock.now });
      try {
        const frames = outbox.unacked(0).map((row) => ({ v: 1, runner: identity.label, gen: 0, epoch: 0, seq: row.seq, type: row.type, body: row.body }));
        console.log(JSON.stringify(frames));
      } finally {
        outbox.close();
      }
      return 0;
    }
    if (sub === "serve") return await serveMain(parsed.values);
    return fail(RUNNER_HOST_USAGE, 2);
  } catch (error) {
    if (error instanceof Exit) { console.error(error.message); return error.code; }
    if (error instanceof TypeError && /option|argument/i.test(error.message)) { console.error(`${error.message}\n${RUNNER_HOST_USAGE}`); return 2; }
    throw error;
  }
};
