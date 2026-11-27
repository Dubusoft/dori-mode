import { homedir } from "node:os";
import { join } from "node:path";
import { addKnownSecrets } from "./redact.ts";
import { SecretStore } from "./secret-store.ts";
import { ToodoClient } from "./toodo-client.ts";
import { laneToodoReader } from "./toodo-lane-read.ts";
import { alertsChannelOf, loadConfig } from "./config.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { readRunnerRows } from "./runner/hub.ts";
import { fileOutageStore, LivenessMonitor, livenessIo } from "./runner/liveness.ts";
import { type LaneHubDeps, reconcileInventory, runnerJournalHead } from "./runner/lanes-hub.ts";
import type { RunnerGuardBoard } from "./runner/guard.ts";
import { type RunnerCall, RunnerUnavailable } from "./runner/call.ts";
import { runnerOf } from "./lane-ops.ts";
import { supervisorCommandRunner, supervisorGranter, supervisorSecretHandler } from "./runner/secret-serve.ts";
import { cliSocketPath, serveCliRelay } from "./runner/cli-relay.ts";
import { type LocalChild, type LocalChildDeps, localRunnerArgv, spawnProcess, startLocalRunner } from "./runner/local-child.ts";
import type { InventoryLane } from "./runner/protocol.ts";
import type { LaneMessageStore } from "./lane-messages.ts";
import { drainRunnerAdmin, LOCAL_RUNNER } from "./runner/serve.ts";
import { closedLanesOf } from "./runner/cleanup.ts";
import type { Listener } from "./runner/transport.ts";
import { listenUnix } from "./runner/unix-transport.ts";
import type { FlowDeps } from "./done-flow.ts";
import { scrubForThread } from "./freshness.ts";
import { listGuardMachines } from "./remote-guard.ts";
import type { OperationStore } from "./operations.ts";
import type { LaneReportStore } from "./lane-report-store.ts";
import { laneEventReader, openRunnerHub, readBackRunnerStarts, readLaneCursor, type RunnerHubHandle } from "./supervise-hub.ts";

/** How often the runners task tries to open a runner hub that failed to open. */
export const RUNNER_HUB_RETRY_MS = 30_000;
/** How often the runners task drops old rows from the hub's runner event journal. */
const RUNNER_JOURNAL_PRUNE_MS = 60 * 60_000;

/** Lane operations go through the hub's RunnerCalls; until the hub is open every call fails closed. */
export const runnerCallsOf = (hub: () => RunnerHubHandle | undefined): RunnerCall => ({
  call: (label, type, body, opts) => {
    const handle = hub();
    if (!handle) return Promise.reject(new RunnerUnavailable(label, "disconnected", "the runner hub is not open"));
    return handle.calls.call(label, type, body, opts);
  },
  query: (label, type, body, opts) => {
    const handle = hub();
    if (!handle) return Promise.reject(new RunnerUnavailable(label, "disconnected", "the runner hub is not open"));
    return handle.calls.query(label, type, body, opts);
  },
  connected: (label) => hub()?.calls.connected(label) ?? false,
});

/** What the supervisor's runner side reads and reports through. */
export type RunnersContext = {
  readonly deps: FlowDeps;
  readonly home: string;
  readonly operations: OperationStore;
  /** This supervisor run's id, in the ids of the lines it enqueues. */
  readonly boot: string;
  /** Enqueues a line for the lead (the sweeps source). */
  readonly emit: (id: string, line: string) => void;
  readonly reports: () => LaneReportStore | undefined;
  readonly laneMessages: () => LaneMessageStore;
  readonly settleWait: (label: string, waitId: string) => void;
  readonly systemPost: (channel: string, text: string, id?: string) => Promise<void>;
  /** Starts the local runner child (default Bun.spawn). */
  readonly spawnRunner?: LocalChildDeps["spawn"];
  readonly signal: AbortSignal;
};

/**
 * The supervisor's runner hub and everything opened with it: the CLI relay, the local runner child, the liveness monitor
 * and the lane event reader. The hub always opens: every lane is runner-owned, and the local runner is this process's
 * child. An unsafe runner directory or a busy socket costs the hub, never the supervisor: the lead gets
 * RUNNER_HUB_DISABLED, every lane operation fails closed, and the runners task tries again every RUNNER_HUB_RETRY_MS
 * until it opens.
 */
export class SupervisorRunners {
  private hub?: RunnerHubHandle;
  private liveness?: LivenessMonitor;
  private localRunner?: LocalChild;
  private relayListener?: Listener;
  private stopRelay?: () => void;
  private takeLaneEvents: () => Promise<void> = async () => {};
  /** Why the hub is not open, while it is not; the lead hears of the outage once and of its end once. */
  private down?: string;
  private lastAttempt: number;
  private lastJournalPrune = -Infinity;

  constructor(private readonly ctx: RunnersContext) {
    this.lastAttempt = ctx.deps.clock.now();
  }

  get handle(): RunnerHubHandle | undefined { return this.hub; }
  get guard(): RunnerGuardBoard | undefined { return this.hub?.guard; }

  /** Opens the hub, or reports it disabled; each startup step is timed through `step`. */
  async tryOpen(step: <T>(name: string, work: () => T) => T): Promise<void> {
    const { deps, boot, emit } = this.ctx;
    this.lastAttempt = deps.clock.now();
    try { await this.open(step); }
    catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`RUNNER_HUB_DISABLED ${why}`);
      if (this.down === undefined) {
        emit(`runner-hub-disabled:${boot}:${this.lastAttempt}`, `RUNNER_HUB_DISABLED ${why}; every lane operation fails until the runner hub opens, the supervisor tries again every ${RUNNER_HUB_RETRY_MS / 1_000} s`);
      }
      this.down = why;
      return;
    }
    if (this.down !== undefined) {
      console.log("RUNNER_HUB_OPENED");
      emit(`runner-hub-opened:${boot}:${this.lastAttempt}`, `RUNNER_HUB_OPENED the runner hub is open again (it had failed: ${this.down})`);
      this.down = undefined;
    }
  }

  /** One runners task pass: reopen a failed hub, then liveness, lane events, runner admin and journal pruning. */
  async pass(): Promise<void> {
    const { deps } = this.ctx;
    if (!this.hub && deps.clock.now() - this.lastAttempt >= RUNNER_HUB_RETRY_MS) await this.tryOpen((_name, work) => work());
    const handle = this.hub;
    if (!handle) return;
    try { await this.liveness?.tick(); } catch (e) { console.error(`RUNNER_LIVENESS_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    try { await this.takeLaneEvents(); } catch (e) { console.error(`RUNNER_LANE_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    // `dori runner revoke|rotate` queue their request for the live hub; answer them first.
    try { for (const line of drainRunnerAdmin(deps.config.stateDir, handle.accept, deps.clock.now(), (label) => { this.liveness?.untrack(label); })) console.log(line); }
    catch (e) { console.error(`RUNNER_ADMIN_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    if (deps.clock.now() - this.lastJournalPrune >= RUNNER_JOURNAL_PRUNE_MS) {
      this.lastJournalPrune = deps.clock.now();
      // Rows at or past the cursor are never pruned, so an unreadable cursor keeps the whole journal.
      const cursor = readLaneCursor(deps.config.stateDir, "pruning no runner journal rows") ?? 0;
      handle.journal.prune(this.lastJournalPrune, cursor);
    }
  }

  /** Closes whatever is open, so a retry starts clean and nothing half-open answers calls. */
  async close(): Promise<void> {
    this.stopRelay?.();
    this.stopRelay = undefined;
    this.relayListener?.close();
    this.relayListener = undefined;
    await this.localRunner?.stop();
    this.localRunner = undefined;
    this.hub?.close();
    this.hub = undefined;
    this.liveness = undefined;
    this.takeLaneEvents = async () => {};
  }

  private async open(step: <T>(name: string, work: () => T) => T): Promise<void> {
    const { deps, home, operations, boot, emit, reports, laneMessages, settleWait, systemPost, spawnRunner, signal } = this.ctx;
    try {
      const runnerDir = defaultRunnerDir(home || undefined);
      // Heartbeats and hellos feed the liveness monitor, built right after the hub because it needs the hub's epoch.
      let monitor: LivenessMonitor | undefined;
      // Lane events and hellos are taken one at a time, in arrival order, so a lane.started lands before its reports.
      let laneWork: Promise<void> = Promise.resolve();
      const laneDeps: LaneHubDeps = {
        stateDir: deps.config.stateDir,
        registry: deps.registry, reports, now: deps.clock.now,
        emit,
        prepareRecovery: async (label, key) => {
          // Inventory absence means RUNNER_LANE_UNKNOWN; only ordinary recovery scans for a relaunch.
          this.hub?.accept.checkFileCapability(label, "lane.recover");
          return { cmdId: `recover:${key}:${deps.clock.now()}`, notes: [] };
        },
        recover: (label, key, prepared) => this.hub?.accept.command(label, "lane.recover", {
          cmdId: prepared.cmdId, key, ...(prepared.briefText !== undefined ? { briefText: prepared.briefText } : {}),
          ...(prepared.files ? { files: prepared.files } : {}),
        }),
        close: (label, key, cmdId) => this.hub?.accept.command(label, "lane.close", { cmdId, key, worktreeChecks: false }),
        journalHead: () => runnerJournalHead(deps.config.stateDir),
        // A lane's `dori report ack` arrives as lane.ack and is applied to the lane message store.
        messages: laneMessages,
        // At each hello the runner gets every owned lane's notice back, for `dori lane status` inside the lane.
        notify: (_label, lane) => deps.ops.notify(lane, {
          status: lane.status ?? "working",
          ...(lane.objection ? { objection: lane.objection } : {}),
          ...(lane.claim ? { claim: { at: lane.claim.at, evidence: lane.claim.evidence } } : {}),
        }),
      };
      // After a supervisor restart, a lane.start an earlier run sent and never saw answered is read back (design 5.6).
      const readBackStarts = async (label: string, inventory: readonly InventoryLane[]): Promise<void> => {
        if (this.hub) await readBackRunnerStarts(this.hub, deps.registry, label, inventory, emit, (line) => { console.log(line); });
      };
      // A failed liveness update (operations store, emit, outage write) is this runner's error, logged like a failed tick.
      const livenessFailed = (what: string) => (e: unknown): void => {
        console.error(`RUNNER_LIVENESS_ERROR ${what} ${e instanceof Error ? e.message : String(e)}`);
      };
      const inOrder = (what: string, work: () => Promise<void>): void => {
        laneWork = laneWork.then(work).catch((e: unknown) => { console.error(`RUNNER_LANE_ERROR ${what} ${e instanceof Error ? e.message : String(e)}`); });
      };
      const hub = this.hub = step("runners", () => openRunnerHub(deps.config.stateDir, runnerDir, deps.clock.now, () => performance.now(), (line) => { console.log(line); }, {
        onHeartbeat: (label) => { void monitor?.heartbeat(label).catch(livenessFailed(`heartbeat runner=${label}`)); },
        // A runner's cleanup sweep asks for its closed lanes (lanes.closed): local lanes carry no machine, a remote runner's carry its label.
        onClosedLanes: async (label) => closedLanesOf(await deps.registry.archived(), label === LOCAL_RUNNER ? undefined : label),
        // A remote runner's secret.get: decided here with the registry, config and this host's store (secret-serve.ts).
        onSecret: supervisorSecretHandler({
          laneOwner: async (key) => { const lane = (await deps.registry.open()).find((l) => l.key === key); return lane && runnerOf(lane); },
          runnerUnsandboxed: (label) => deps.config.runners?.[label]?.allowUnsandboxed === true,
          granter: supervisorGranter({ store: new SecretStore(), onGranted: addKnownSecrets }),
          // A remote runner's secret.run: the op runs here, outside any lane; only its redacted output goes back.
          commandRunner: supervisorCommandRunner({
            store: new SecretStore(), onGranted: addKnownSecrets,
            commands: async () => (await loadConfig()).secretCommands,
            log: (line) => { console.log(line); },
          }),
          // A remote lane's toodo.read: read here with this host's Toodo token, within the lane's scope (toodo-lane-read.ts).
          toodoReader: laneToodoReader({ client: () => new ToodoClient(deps.tunables.toodoEvents), log: (line) => { console.log(line); } }),
          log: (line) => { console.log(line); },
        }),
        // A runner-owned wait that the runner saw met ends here (deduped with the check's own result by its event id);
        // `job.result` is kept in the runner journal only.
        onEvent: (label, frame) => {
          // A runner's own config reload (runner-config.json): reloaded, kept the last good one, or needs a restart.
          if (frame.type === "runner.config") {
            const kind = { reloaded: "RUNNER_CONFIG_RELOADED", invalid: "RUNNER_CONFIG_INVALID", restart: "RUNNER_CONFIG_RESTART_NEEDED" }[frame.body.state];
            emit(`runner-config:${label}:${frame.gen}:${frame.seq}`, `${kind} runner=${label} ${frame.body.detail}`);
            return;
          }
          if (frame.type !== "wait.result" || frame.body.outcome !== "WAIT_DONE") return;
          try { settleWait(label, frame.body.waitId); }
          catch (e) { console.error(`WAIT_ERROR runner=${label} wait=${frame.body.waitId} ${e instanceof Error ? e.message : String(e)}`); }
        },
        onHello: (label, body) => {
          void monitor?.hello(label, body.gen).catch(livenessFailed(`hello runner=${label}`));
          inOrder(`hello ${label}`, async () => {
            await reconcileInventory(laneDeps, label, body.inventory ?? []);
            // Off the lane-event queue: the read-back awaits the runner's answers, which arrive as lane events too.
            void readBackStarts(label, body.inventory ?? []).catch((e: unknown) => {
              console.error(`RUNNER_READBACK_ERROR runner=${label} ${e instanceof Error ? e.message : String(e)}`);
            });
          });
        },
      }));
      // The lead's `dori` CLI reaches the runners through this process: <runnerDir>/sock/cli next to the control socket.
      this.relayListener = listenUnix(cliSocketPath(runnerDir));
      this.stopRelay = serveCliRelay(this.relayListener, hub.calls, (line) => { console.error(line); });
      // The local runner: `dori runner serve` as this process's child, restarted with backoff, stopped with it.
      const child = this.localRunner = startLocalRunner({
        spawn: spawnRunner ?? spawnProcess, argv: localRunnerArgv(join(import.meta.dir, "cli.ts")),
        env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
        clock: deps.clock, log: (line) => { console.log(line); },
      }, signal);
      // Resume after successfully processed events; an upgrade with no cursor reads the retained journal once.
      const readLaneEvents = laneEventReader(deps.config.stateDir, laneDeps);
      this.takeLaneEvents = () => {
        inOrder("journal", readLaneEvents);
        return laneWork;
      };
      let livenessSeq = 0;
      const io = livenessIo(deps.run, LOCAL_RUNNER, async () => listGuardMachines(deps.config.guardMachines, deps.config.stateDir));
      monitor = this.liveness = new LivenessMonitor({
        monotonic: () => performance.now(), now: deps.clock.now, epoch: hub.hub.epoch, operations,
        probe: io.probe,
        // The local runner is restarted as this process's child, a worker's over ssh.
        restart: async (label) => {
          if (label !== LOCAL_RUNNER) return io.restart(label);
          await child.restart();
          return { ok: true, detail: "child restart" };
        },
        ownedLanes: async (label) => (await deps.registry.open()).filter((l) => l.runner === label).map((l) => l.key),
        emit: (line) => { emit(`runner-liveness:${deps.clock.now()}:${++livenessSeq}`, line); },
        // A runner outage the lead is woken for is also a system notice in the alerts channel. Not awaited: a hung post
        // must not stop the liveness tick.
        alert: (text) => {
          const channel = alertsChannelOf(deps.config);
          if (!channel) return;
          void systemPost(channel, scrubForThread(text, homedir()), `runner-liveness-alert:${boot}:${++livenessSeq}`)
            .catch((e: unknown) => { console.error(`RUNNER_ALERT_NOTIFY_FAILED ${e instanceof Error ? e.message : String(e)}`); });
        },
        // Escalated outages outlive this process: a restart neither wakes the lead again nor loses the ONLINE.
        outages: fileOutageStore(deps.config.stateDir),
      });
      for (const row of readRunnerRows(deps.config.stateDir)) monitor.track(row.label, row.maxGen);
    } catch (e) {
      await this.close();
      throw e;
    }
  }
}
