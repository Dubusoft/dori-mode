import { existsSync, type FSWatcher, realpathSync, watch } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { laneCliMain } from "./lane-cli.ts";
import { type Observation, pruneCommandRecords, resolveInterrupted } from "./durability.ts";
import { RunnerLanes } from "./lanes.ts";
import { connectLaneSocket, LANE_SOCKET_DIR, laneSocketPath, type LaneSocketLanes, legacyLaneSocketPath, serveLaneSocket } from "./lane-socket.ts";
import { appendSecretAudit, laneRepoOf, secretAuditPath, secretGranter } from "./secret-grant.ts";
import { remoteSecretGranter, remoteSecretRunner } from "./remote-secrets.ts";
import { secretCommandRunner } from "./secret-run.ts";
import { SecretStore } from "../secret-store.ts";
import { addKnownSecrets, replaceKnownSecrets } from "../redact.ts";
import { laneGitEffect } from "./lane-git.ts";
import { runnerPolicy } from "./local-policy.ts";
import { policyReloader } from "./policy-reload.ts";
import { watchConfigFiles } from "../config-watch.ts";
import { workspaceReport, type WorkspaceReport } from "./workspaces.ts";
import { queryDispatcher } from "./queries.ts";
import { checkFileBody } from "./lane-files.ts";
import { ensureRunnerSubdir, RUNNER_PATHS } from "./fs-safety.ts";
import { connectUnix as connectLane, listenUnix } from "./unix-transport.ts";
import { diskGuardPath, readWinSample, runnerSampleArgv, sampleHost, winSampleSource } from "../host-guard.ts";
import { sampleProcs } from "../lane-memory.ts";
import type { Pane } from "../panes.ts";
import { parseArgs } from "node:util";
import { configPath, loadConfig } from "../config.ts";
import { realClock, run, type Runner, setDefaultRunTimeout } from "../run.ts";
import { runnerVersion } from "./version.ts";
import { enrollOverStdio, enrollRunner, RunnerAuth } from "./auth.ts";
import { GUARD_SAMPLE_MS, RunnerGuard } from "./guard.ts";
import { removeLegacyGuardAgent } from "./legacy-guard.ts";
import { jobRunEffect, waitCheckEffect } from "./jobs.ts";
import { HerdrWatch } from "./herdr-watch.ts";
import { selectPlatform } from "./platform.ts";
import { CLEANUP_STATUS_FILE, cleanupPaths, inUsePaths, runCleanup, startCleanup } from "./cleanup.ts";
import { herdrPaused, hostHerdr } from "./herdr-control.ts";
import type { HerdrAction } from "./protocol.ts";
import { HEARTBEAT_MS, RunnerClient } from "./client.ts";
import { defaultRunnerDir, holdServeLock, runStartupCheck, SERVE_LOCK } from "./fs-safety.ts";
import { probe, probeHerdr, startHealth } from "./health.ts";
import { observeHost } from "./observe.ts";
import { Outbox, OUTBOX_MAINTENANCE_MS, outboxMaintenance } from "./outbox.ts";
import { POLICY_FILE } from "./policy.ts";
import { commandDispatcher, type DispatchDeps, LOCAL_RUNNER, loadIdentity, parseEnrollInput, realEvery, serveRunner, trackedConnector } from "./serve.ts";
import { RunnerState } from "./state.ts";
import { connectUnix, controlSocketPath } from "./unix-transport.ts";
import { acceptWs } from "./ws-transport.ts";

/**
 * The commands a runner host runs: `runner serve` and `runner probe`. `dori runner ...` hands these two to this module,
 * and `bin.ts` runs it on its own, so the bundle installed on worker machines holds only the runner and not the rest of
 * the CLI. Returns the process exit code.
 */

export const RUNNER_HOST_USAGE = "usage: runner serve [--label LABEL] [--enroll | --enroll-only] [--listen HOST:PORT] | runner probe [--json]";

class Exit extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const fail = (message: string, code = 1): never => { throw new Exit(code, message); };

const probeMain = async (json: boolean): Promise<number> => {
  const result = { ...probe({ runnerDir: defaultRunnerDir(), now: realClock.now }), herdr: await probeHerdr(run) };
  console.log(json ? JSON.stringify(result) : `RUNNER_PROBE ${result.verdict} process=${result.process} age=${result.healthAgeMs ?? "-"}ms gen=${result.gen ?? "-"} herdr=${result.herdr}`);
  return result.verdict === "healthy" ? 0 : 1;
};

/**
 * The effect of every durable command a runner carries out (design 2.3, section 4): the lane verbs on its own lanes,
 * `lane.git` in the given root, and `guard.kill` limited to the named lanes. Each resolves to `{detail, result}`.
 */
export const runnerEffects = (deps: {
  readonly lanes: RunnerLanes; readonly guard: Pick<RunnerGuard, "killLanes">; readonly run: Runner;
  readonly herdr?: ReturnType<typeof hostHerdr>;
  /** Where wait.result and job.result go; a caller that never receives those commands may omit it. */
  readonly publish?: ConstructorParameters<typeof RunnerLanes>[0]["publish"];
}): DispatchDeps["effects"] => {
  const effectPublish: NonNullable<typeof deps.publish> = deps.publish ?? (() => { throw new Error("runner publish is not wired"); });
  return {
  ...(deps.herdr ? { "host.herdr": async (command: { readonly body: { readonly action: HerdrAction } }) => (deps.herdr as ReturnType<typeof hostHerdr>)(command.body.action) } : {}),
  "guard.kill": async (command) => {
    const killed = await deps.guard.killLanes(command.body.keys);
    return { detail: `killed ${killed.length}`, result: { killed: killed.map((k) => ({ pid: k.pid, comm: k.comm, rssKb: k.rssKb, ...(k.lane ? { lane: k.lane } : {}) })) } };
  },
  "lane.start": async (command) => deps.lanes.start(command.body),
  "lane.adopt": async (command) => deps.lanes.adopt(command.body),
  "lane.stop": async (command) => deps.lanes.close(command.body.key),
  "lane.close": async (command) => deps.lanes.close(command.body.key),
  "lane.send": async (command) => deps.lanes.send(command.body.key, command.body.text, command.body.verify, {
    ...(command.body.mode ? { mode: command.body.mode } : {}), ...(command.body.refuseWhileAsking !== undefined ? { refuseWhileAsking: command.body.refuseWhileAsking } : {}),
  }),
  "lane.pause": async (command) => deps.lanes.pause(command.body.key, command.body.step),
  "lane.resume": async (command) => deps.lanes.resume(command.body.key),
  "lane.notify": async (command) => deps.lanes.notify(command.body),
  "lane.git": async (command) => laneGitEffect(deps.run, command.body),
  "lane.recover": async (command) => {
    if (command.body.files) checkFileBody(command.body.key, command.body);
    return deps.lanes.recover(command.body.key, command.body.session, command.body.tabWorkspace, command.body.briefText, command.body.files);
  },
  "lane.observe": async (command) => deps.lanes.observe(command.body.key),
  "wait.check": waitCheckEffect({ run: deps.run, publish: effectPublish }),
  "job.run": jobRunEffect({ run: deps.run, publish: effectPublish }),
  };
};

const serveMain = async (values: { label?: string; enroll?: boolean; "enroll-only"?: boolean; listen?: string }): Promise<number> => {
  const runnerDir = defaultRunnerDir();
  // RUNNER_DIR_UNSAFE on stderr and exit 1 before anything is opened.
  let exitCode: number | undefined;
  if (!runStartupCheck(runnerDir, { stderr: (text) => { process.stderr.write(text); }, exit: (code) => { exitCode = code; } })) return exitCode ?? 1;
  const cfg = await loadConfig();
  setDefaultRunTimeout(cfg.runTimeoutMs);
  const identity = loadIdentity(runnerDir, values.label ?? LOCAL_RUNNER, hostname());
  const auth = new RunnerAuth(runnerDir);
  const enrollOnly = values["enroll-only"] === true;
  if (enrollOnly) {
    const text = await Bun.stdin.text();
    const input = parseEnrollInput(text);
    if (!input) return fail("RUNNER_ENROLL_INPUT_INVALID stdin must carry code=<code> and fingerprint=sha256:<hex> lines");
    const reply = /^reply=(\S+)$/m.exec(text)?.[1];
    const request = enrollOverStdio({
      auth, ...input, expectedFingerprint: input.fingerprint, label: identity.label, hostId: identity.hostId,
    }, reply);
    if (request) {
      console.log(`RUNNER_ENROLL_REQUEST ${request}`);
      return 9;
    }
    console.log(`RUNNER_ENROLLED runner=${identity.label} supervisor=${input.fingerprint}`);
    return 0;
  }
  const accepting = values.listen ? acceptWs(values.listen) : undefined;
  const connector = accepting?.connect ?? connectUnix(controlSocketPath(runnerDir));
  const endpoint = values.listen ?? controlSocketPath(runnerDir);
  try {
    if (values.enroll) {
      // The one-time code and the supervisor fingerprint arrive on stdin (`dori runner enroll` output), never in argv.
      const input = parseEnrollInput(await Bun.stdin.text());
      if (!input) fail("RUNNER_ENROLL_INPUT_INVALID stdin must carry code=<code> and fingerprint=sha256:<hex> lines");
      const enrolled = await enrollRunner({
        auth, connect: connector, code: input?.code as string, label: identity.label, hostId: identity.hostId,
        expectedFingerprint: input?.fingerprint as string,
      });
      if (!enrolled.ok) fail(`${enrolled.code} ${enrolled.detail}`);
      console.log(`RUNNER_ENROLLED runner=${identity.label} supervisor=${enrolled.ok ? enrolled.supervisorFingerprint : ""}`);
    }
    if (!auth.enrolled) fail(`RUNNER_NOT_ENROLLED runner=${identity.label}: start once with --enroll (the local runner is enrolled by the supervisor)`);
    const remote = values.listen !== undefined;
    // The runner's own copy: a config reload rewrites it in place, so every part below that holds it sees the change.
    const policy = structuredClone(runnerPolicy(runnerDir, remote, cfg, (line) => { console.log(line); }));
    // Before the gen bump: a second serve on this directory exits here and leaves the running one's gen alone.
    const releaseServeLock = holdServeLock(runnerDir);
    if (!releaseServeLock) fail(`RUNNER_ALREADY_SERVING another runner serve holds ${join(runnerDir, SERVE_LOCK)}; stop it (e.g. a leftover dori-runner.service next to dori supervise) before starting this one`);
    const state = new RunnerState(runnerDir, { now: realClock.now });
    const gen = state.boot();
    const outbox = new Outbox(runnerDir, { now: realClock.now });
    // Every runner owns the lanes it starts and observes its host's lanes from herdr and /proc.
    type InventoryLane = { key: string; pane: string; tab: string; session?: string };
    // The lanes only observed (not owned), as of the last observe pass; the owned part is read fresh in each hello.
    let observedOnly: InventoryLane[] = [];
    const currentInventory = (): InventoryLane[] => {
      const owned = runnerLanes?.inventory() ?? [];
      return [...owned, ...observedOnly.filter((l) => !owned.some((o) => o.key === l.key))];
    };
    // The lanes this runner started are attributed from its own records, whatever runs in their panes now.
    const ownedPanes = async (panes: readonly Pane[]): Promise<Map<string, string>> => {
      const owned = new Map<string, string>();
      for (const record of Object.values(runnerLanes.records())) {
        const pane = await runnerLanes.currentPane(record, panes);
        if (pane) owned.set(pane.pane_id, record.key);
      }
      return owned;
    };
    const observedLanes = () => observeHost({ run, owned: ownedPanes, ...(winSample ? { procs: hostProcs } : {}) });
    const observe = async () => {
      const lanes = await observedLanes();
      const observed = lanes.map(({ status: _status, ...lane }) => lane);
      // The lanes this runner started come first; the rest are lanes it only observes on its host.
      observedOnly = observed;
      // An owned lane waiting on an on-screen question goes out as one lane.asking per question.
      await runnerLanes.askTick().catch((e: unknown) => { log(`RUNNER_LANE_ASK_FAILED ${e instanceof Error ? e.message : String(e)}`); });
      return lanes;
    };
    const version = await runnerVersion(run, import.meta.dir);
    const log = (line: string): void => { console.log(line); };
    const platform = selectPlatform(process.platform, { log });
    const dataPath = remote ? homedir() : diskGuardPath(cfg);
    // On Windows one sampler run per guard tick feeds the host sample and the process table; lanes are seeded on the
    // shell pids their records carry.
    const winSample = platform.os === "win32" ? winSampleSource(() => readWinSample(run, runnerSampleArgv(runnerDir, dataPath)), realClock.now) : undefined;
    const laneShells = (): Map<number, string> =>
      new Map(Object.values(runnerLanes.records()).flatMap((r) => (r.shellPid ? [[r.shellPid, r.key] as const] : [])));
    const hostProcs = winSample ? () => sampleProcs(run, undefined, false, { sample: winSample.procs, seeds: laneShells }) : () => sampleProcs(run);
    const tracked = trackedConnector(connector);
    let client: RunnerClient | undefined;
    const publish: ConstructorParameters<typeof RunnerLanes>[0]["publish"] = (type, body) => {
      if (!client) throw new Error("runner client is not initialized");
      client.publish(type, body);
    };
    // Every runner owns its host's lanes: the local runner on the lead host as well as a worker's.
    const runnerLanes = new RunnerLanes({ runnerDir, run, clock: realClock, policy, publish, remote, ...(winSample ? { procs: hostProcs } : {}) });
    // Every runner guards its host, the local one included: the supervisor reads its samples and kills from the board
    // and does not kill by itself. Thresholds and heavyKill come from runner-config.json, else the config defaults.
    const herdr = new HerdrWatch({ run, now: realClock.now, monotonic: () => performance.now(), publish, paused: () => herdrPaused(runnerDir) });
    const paneCount = () => herdr.sample();
    const guard = new RunnerGuard({
      herdr: () => herdr.snapshot(),
      sample: winSample ? () => sampleHost(run, dataPath, paneCount, undefined, "win32", winSample.host) : () => sampleHost(run, dataPath, paneCount),
      thresholds: { ...cfg.guard, ...policy.guard }, heavyKill: policy.heavyKill ?? cfg.heavyKill,
      procs: hostProcs, self: process.pid, now: realClock.now, os: process.platform,
      kill: { clock: realClock, alive: platform.pidAlive, signal: platform.signal },
      publish: (type, body) => { client?.publish(type, body); },
    });
    try {
      const removed = removeLegacyGuardAgent(homedir());
      if (removed.length) log(`RUNNER_GUARD_AGENT_REMOVED ${removed.join(",")}`);
    } catch (error) {
      log(`RUNNER_GUARD_AGENT_REMOVE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
    const dispatch = commandDispatcher({
      state, policy, realpath: realpathSync, runnerDir, log,
      publish: (body) => { client?.publish("cmd.result", body); },
      effects: runnerEffects({
        lanes: runnerLanes, guard, run, publish,
        herdr: hostHerdr({ run, runnerDir, now: realClock.now, sleep: realClock.sleep, signal: platform.signal }),
      }),
    });
    // Read-only q.* control frames: answered on this host, never queued or recorded.
    const onQuery = queryDispatcher({
      files: (key) => runnerLanes.reportFiles(key),
      run, clock: realClock, policy, log, dataPath, os: process.platform,
      lane: (key) => { const r = runnerLanes.records()[key]; return r ? { pane: r.pane, cwd: r.cwd } : undefined; },
      currentPane: async (key, panes) => { const r = runnerLanes.records()[key]; return r ? runnerLanes.currentPane(r, panes) : undefined; },
      reply: (body) => { client?.control("q.result", body); },
    });
    // A hello reuses the last report until a rescan drops it, so a reconnect storm does not rescan the roots.
    let report: WorkspaceReport | undefined;
    const workspaces = (): WorkspaceReport => (report ??= workspaceReport(policy, { realpath: realpathSync, log }));
    // New workspaces reach the supervisor only in a hello: rescan and reconnect when the report changed.
    const rescan = (): void => {
      const sent = report;
      report = undefined;
      if (!Bun.deepEquals(sent, workspaces())) client?.rehello();
    };
    // reposRoot is watched (non-recursive) for repos added, removed or renamed; events settle for 2 s before a rescan.
    let reposWatch: { root: string; watcher: FSWatcher } | undefined;
    let reposDebounce: ReturnType<typeof setTimeout> | undefined;
    const unwatchRepos = (): void => { reposWatch?.watcher.close(); reposWatch = undefined; };
    const watchRepos = (): void => {
      const root = policy.reposRoot;
      if (reposWatch && (reposWatch.root !== root || !existsSync(reposWatch.root))) unwatchRepos();
      if (reposWatch || root === undefined || !existsSync(root)) return;
      try {
        const watcher = watch(root, () => { clearTimeout(reposDebounce); reposDebounce = setTimeout(rescan, 2000); });
        watcher.on("error", (e: unknown) => {
          log(`RUNNER_REPOS_WATCH_FAILED ${e instanceof Error ? e.message : String(e)}`);
          if (reposWatch?.watcher === watcher) unwatchRepos();
        });
        reposWatch = { root, watcher };
      } catch (e) {
        log(`RUNNER_REPOS_WATCH_FAILED ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    watchRepos();
    client = new RunnerClient(
      { label: identity.label, hostId: identity.hostId, ...(version ? { version } : {}) },
      { connect: tracked.connect, outbox, state, clock: realClock, inventory: currentInventory, workspaces, auth, log, onCommand: dispatch, onInvalidCommand: dispatch, onQuery },
    );
    // A command a crash left between its intent and its result is settled by looking at herdr, never run again.
    const observeLane = async (key: string): Promise<Observation> => {
      try { return (await observeHost({ run })).some((l) => l.key === key) ? "present" : "absent"; } catch { return "unknown"; }
    };
    for (const line of await resolveInterrupted({ state, observeLane, publish: (body) => { client?.publish("cmd.result", body); } })) log(line);
    const pruneCommands = (): void => {
      const pruned = pruneCommandRecords(state, realClock.now());
      if (pruned > 0) log(`RUNNER_CMD_PRUNED ${pruned} command records past retention`);
    };
    pruneCommands();
    const stopPrune = realEvery(24 * 60 * 60_000, pruneCommands);
    const outboxTick = outboxMaintenance(outbox, realClock.now, log);
    outboxTick();
    const stopOutboxTick = realEvery(OUTBOX_MAINTENANCE_MS, outboxTick);
    // The fallback for missed watch events, and the retry for a watch that failed or a reposRoot that did not exist.
    const stopRescan = realEvery(5 * 60_000, () => { watchRepos(); rescan(); });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => { accepting?.close(); }, { once: true });
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    console.log(`RUNNER_SERVE label=${identity.label} gen=${gen} mode=owner endpoint=${endpoint}`);
    const stopAwake = platform.holdAwake({ pid: process.pid, log });
    const stopHealth = startHealth({ runnerDir, pid: process.pid, gen, now: realClock.now, monotonic: () => Math.round(performance.now()), every: realEvery, log });
    let guarding = false;
    const guardTick = (): void => {
      if (guarding) return;
      guarding = true;
      void guard.tick().catch((e: unknown) => { log(`RUNNER_GUARD_FAILED ${e instanceof Error ? e.message : String(e)}`); }).finally(() => { guarding = false; });
    };
    guardTick();
    const stopGuard = realEvery(GUARD_SAMPLE_MS, guardTick);
    // The daily cleanup sweep of this host's caches and temp (cleanup.ts); `logs/cleanup.json` holds the last report.
    const stopCleanup = startCleanup({
      statusFile: join(ensureRunnerSubdir(runnerDir, RUNNER_PATHS.logs), CLEANUP_STATUS_FILE),
      now: realClock.now, every: realEvery, log,
      delay: (ms, fn) => { const timer = setTimeout(fn, ms); return () => { clearTimeout(timer); }; },
      sweep: () => {
        const owned = Object.values(runnerLanes.records()).map((r) => ({ key: r.key, cwd: r.cwd }));
        return runCleanup({
          paths: cleanupPaths(process.platform, process.env, homedir()), now: realClock.now(), run, log,
          repos: workspaces().workspaces.map((w) => w.path),
          openLanes: [...owned, ...observedOnly.map((l) => ({ key: l.key }))],
          keepAgents: [cfg.leadCwd],
          inUse: () => inUsePaths(process.platform, run, process.getuid?.()),
          uid: process.getuid?.(),
        });
      },
    });
    ensureRunnerSubdir(runnerDir, RUNNER_PATHS.sock);
    // A lane.start without cwd is checked against `lanes/` (an allowed root) before its own directory exists.
    ensureRunnerSubdir(runnerDir, RUNNER_PATHS.lanes);
    ensureRunnerSubdir(join(runnerDir, RUNNER_PATHS.sock), LANE_SOCKET_DIR);
    const laneListeners = [listenUnix(laneSocketPath(runnerDir)), listenUnix(legacyLaneSocketPath(runnerDir))];
    // The local runner hands out store secrets itself; a remote one asks the supervisor over the authenticated link.
    let laneSocketLanes: LaneSocketLanes = runnerLanes;
    if (remote) {
      const linked = client;
      laneSocketLanes = {
        tokenFor: (key, token) => runnerLanes.tokenFor(key, token),
        notice: (key) => runnerLanes.notice(key),
        keyForPane: (pane) => runnerLanes.keyForPane(pane),
        reportFiles: (key) => runnerLanes.reportFiles(key),
        secrets: remoteSecretGranter({
          client: linked, laneRepo: laneRepoOf(run, (key) => runnerLanes.cwdOf(key)), log, onGranted: addKnownSecrets,
        }),
        // Proxy execution runs on the supervisor host: secret.run over the link.
        secretRun: remoteSecretRunner({ client: linked, laneRepo: laneRepoOf(run, (key) => runnerLanes.cwdOf(key)), log }),
      };
    } else {
      const auditFile = appendSecretAudit(secretAuditPath(cfg.stateDir), log);
      const secretStore = new SecretStore();
      const runOp = secretCommandRunner({
        store: secretStore,
        commands: async () => (await loadConfig()).secretCommands,
        rules: async () => (await loadConfig()).secrets,
        laneRepo: laneRepoOf(run, (key) => runnerLanes.cwdOf(key)),
        audit: auditFile, log, runner: identity.label, now: realClock.now, onGranted: addKnownSecrets,
      });
      laneSocketLanes = {
        tokenFor: (key, token) => runnerLanes.tokenFor(key, token),
        notice: (key) => runnerLanes.notice(key),
        keyForPane: (pane) => runnerLanes.keyForPane(pane),
        reportFiles: (key) => runnerLanes.reportFiles(key),
        secretRun: (key, op) => runOp(key, op),
        secrets: secretGranter({
          store: secretStore,
          rules: async () => (await loadConfig()).secrets,
          laneRepo: laneRepoOf(run, (key) => runnerLanes.cwdOf(key)),
          audit: (entry) => {
            auditFile(entry);
            log(`${entry.allowed ? "RUNNER_SECRET_GRANTED" : "RUNNER_SECRET_DENIED"} lane=${entry.lane} names=${entry.names.join(",")}${entry.reason ? ` reason=${entry.reason}` : ""}`);
          },
          runner: identity.label, now: realClock.now, onGranted: addKnownSecrets,
        }),
      };
      // Store values are masked in this runner's output from the start, not only once a lane asked for them.
      void new SecretStore().readAll().then((m) => { replaceKnownSecrets(m.values()); }, () => {});
    }
    const stopLaneServes = laneListeners.map((listener) => serveLaneSocket(listener, laneSocketLanes, publish, log));
    const stopLaneSocket = (): void => {
      for (const stop of stopLaneServes) stop();
      for (const listener of laneListeners) listener.close();
    };
    // runner-config.json (and, on the local runner, the config.json its policy and guard defaults come from) apply
    // without a restart: a valid edit rewrites the live policy, an invalid one keeps the last good policy.
    const reloadPolicy = policyReloader({
      policy,
      load: async () => {
        const next = remote ? cfg : await loadConfig();
        const reloaded = runnerPolicy(runnerDir, remote, next, log);
        guard.reconfigure({ ...next.guard, ...reloaded.guard }, reloaded.heavyKill ?? next.heavyKill);
        return { policy: reloaded, restart: !remote && diskGuardPath(next) !== dataPath ? ["stateDir"] : [] };
      },
      applied: () => { watchRepos(); rescan(); },
      publish: (body) => { client?.publish("runner.config", body); },
      log,
    });
    const stopConfigWatch = watchConfigFiles(remote ? [join(runnerDir, POLICY_FILE)] : [join(runnerDir, POLICY_FILE), configPath()], reloadPolicy, { log });
    try {
      await serveRunner({
        client, latest: tracked.latest, clock: realClock, every: realEvery, heartbeatMs: HEARTBEAT_MS,
        observe, log,
      }, controller.signal);
    } finally {
      stopConfigWatch();
      stopRescan();
      clearTimeout(reposDebounce);
      unwatchRepos();
      stopLaneSocket();
      stopGuard();
      stopCleanup();
      stopPrune();
      stopOutboxTick();
      stopHealth();
      stopAwake();
      outbox.close();
      state.close();
      releaseServeLock?.();
    }
    return 0;
  } finally {
    accepting?.close();
  }
};

/** Runs `serve` or `probe` from `args` (the words after `runner`). */
export const runnerHostMain = async (args: readonly string[]): Promise<number> => {
  // Inside a lane this bundle is the lane-mode `dori`: report, claim-done and heavy for the lane's own key, nothing else.
  if (process.env.DORI_LANE_KEY) {
    return laneCliMain(args, {
      env: process.env, connect: connectLaneSocket(defaultRunnerDir(), (path) => connectLane(path)),
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    });
  }
  try {
    const parsed = parseArgs({
      args: [...args], allowPositionals: true,
      options: { label: { type: "string" }, enroll: { type: "boolean" }, "enroll-only": { type: "boolean" }, listen: { type: "string" }, json: { type: "boolean" } },
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
