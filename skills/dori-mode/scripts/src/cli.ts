#!/usr/bin/env bun
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { alertsChannelOf, configPath, loadConfig } from "./config.ts";
import { envFilePath, resolveCredential } from "./credentials.ts";
import { discordThreadOf, resolveTarget, withThreadParent } from "./messenger/target.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { displayTime } from "./display-time.ts";
import { claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick } from "./host-guard.ts";
import { type GuardMachine, listGuardMachines, machineKind, type MachineKind, removeGuardAgents } from "./remote-guard.ts";
import type { Json, KeyPrompter } from "./config-keys.ts";
import { adoptLane, doneRepos, type LaunchInput, launchLane, launchNextLine, LaunchError, SandboxRefusal, validateLaunch } from "./launch.ts";
import { postSandboxNotice, postSkippedNotices } from "./sandbox-notice.ts";
import { assembleBrief, generatedBriefPath, launchBriefArgs, ownerMessageText, writeGeneratedBrief } from "./brief-from-message.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { LANE_MODES, type LaneMode, Registry, statusOf } from "./registry.ts";
import { Repos, ReposError } from "./repos.ts";
import { realClock, run, setDefaultRunTimeout } from "./run.ts";
import { remoteRunnerCli, remoteRunnerService } from "./runner/service.ts";
import { syncRegistry } from "./sync.ts";
import { dequeueLaunch, enqueueLaunch, launchQueue, recordLaunchVerdict } from "./routing.ts";
import {
  candidatesLine, checkMachine, LOCAL_MACHINE, placementLine, placementTable, planLaunch, resolvePlacement, type RunnerPlacement,
  runnerPlacements, verdictLine,
} from "./placement.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Discord, discordPresence, openDiscordGateway } from "./messenger/discord.ts";
import { acquireDiscordGateway, DiscordGatewayOwnedError } from "./messenger/discord-lock.ts";
import { closeThreadButton, DiscordCommands } from "./messenger/discord-commands.ts";
import { buttonRow } from "./messenger/discord-buttons.ts";
import { discordOwnerConfigured, discordThread } from "./messenger/discord-inbound.ts";
import { lookupQuotaResults, NO_CLAUDE, quotaReport, readUsage, usageLine } from "./claude-quota.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { supervise, SUPERVISE_STOP_DEADLINE_MS } from "./supervise-loop.ts";
import { lookupStatus } from "./status.ts";
import { Waits } from "./waits.ts";
import { LeadRestartError, requestLeadRestart } from "./lead-restart.ts";
import { recoverLanes } from "./recover.ts";
import { ack, AckError, AWAITING_NOTE_MAX, recordHandled } from "./ack.ts";
import { checklistLine, InboxError, take, takeAwaitingReminders, takeCarriedReminders, takeOutput, staleOwnerEvents, unreadAfterAck } from "./inbox.ts";
import { checkMemory, MemoryCheckError, needsAction, renderMemoryReport } from "./memory-check.ts";
import { StoreError } from "./store.ts";
import { openOperations, operationLine, type OperationState, settleOperation } from "./operations.ts";
import { LaneMessageError } from "./lane-messages.ts";
import { oneLine, openLaneReports } from "./lane-reports.ts";
import { publicSpec, queueEmit, readSourceStatus, SourceError, SourceSpecs, sourceViews } from "./event-sources.ts";
import { nextSlot, queueRunNow, SCHEDULE_ACTION, scheduleRow, type ScheduleSpec } from "./schedule.ts";
import { updateInstall } from "./update.ts";
import { refreshBootPrep } from "./boot-prep-install.ts";
import { refreshLaneSandbox } from "./lane-sandbox-install.ts";
import { laneOps, type LaneOps, LaneOpsError } from "./lane-ops.ts";
import { type CliRunnerCall, cliRunnerCall, cliSocketPath } from "./runner/cli-relay.ts";
import { RunnerUnavailable } from "./runner/call.ts";
import { defaultRunnerDir, RUNNER_PATHS } from "./runner/fs-safety.ts";
import { heavyDirOf, laneCliMain } from "./runner/lane-cli.ts";
import { LANE_SOCKET } from "./runner/lane-socket.ts";
import { readLaneIdentity } from "./runner/lane-identity.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import type { Connector, Transport } from "./runner/transport.ts";
import { connectUnix } from "./runner/unix-transport.ts";
import { BUILT_IN } from "./tunables.ts";

/** How long the lane-mode check waits for the lane socket's whoami answer before it falls back to the runner's lane record. */
const WHOAMI_TIMEOUT_MS = 500;

/** The lane socket's whoami for `pane`; `answered` only when the runner replied ok (with or without a key). */
const whoami = async (pane: string, socketPath: string, connect: Connector): Promise<{ answered: boolean; key: string | undefined }> => {
  if (!existsSync(socketPath)) return { answered: false, key: undefined };
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

/**
 * Lane mode (design 5, D11; gate B1): `DORI_LANE_KEY` names the lane; else the runner's lane socket is asked which lane
 * holds `HERDR_PANE_ID` (`{kind:"whoami", pane}`), and when it names none (no socket, no answer within
 * WHOAMI_TIMEOUT_MS, a failed reply, no key) the runner's own record `<runnerDir>/lanes.json` is read, so an adopted
 * lane (no DORI_LANE_KEY) stays a lane while its runner is down. Lead mode only when neither maps the pane. A record
 * that cannot be read while the socket did not answer exits 2 LANE_IDENTITY_UNKNOWN: a transport failure never grants
 * lead authority. Reads nothing but the environment, the socket and lanes.json.
 */
const laneContext = async (env: Readonly<Record<string, string | undefined>>, runnerDir: string, socketPath: string, connect: Connector): Promise<string | undefined> => {
  const named = env.DORI_LANE_KEY?.trim();
  if (named) return named;
  const pane = env.HERDR_PANE_ID?.trim();
  if (!pane) return undefined;
  const asked = await whoami(pane, socketPath, connect);
  if (asked.key) return asked.key;
  const recorded = readLaneIdentity(runnerDir, pane);
  if (recorded.kind === "lane") return recorded.key;
  if (recorded.kind === "unreadable" && !asked.answered) {
    console.error(`LANE_IDENTITY_UNKNOWN pane ${pane}: the runner's lane socket did not answer and its lane record cannot be read (${recorded.detail}); dori will not run as the lead from a pane that may be a lane. Bring the runner back (its lane socket answers whoami) or repair the lane record.`);
    process.exit(2);
  }
  return undefined;
};

// The lane-mode gate runs before anything else (help, setup, runner *, loadConfig): inside a lane dori takes only
// report, claim-done, report ack, lane status and heavy, all over the runner's lane socket, and opens no registry,
// store, journal, inbox or state-dir file.
{
  const laneRunnerDir = defaultRunnerDir();
  const laneSocket = join(laneRunnerDir, RUNNER_PATHS.sock, LANE_SOCKET);
  const laneKey = await laneContext(process.env, laneRunnerDir, laneSocket, connectUnix(laneSocket));
  if (laneKey !== undefined) {
    process.exit(await laneCliMain(process.argv.slice(2), {
      env: process.env, laneKey, connect: connectUnix(laneSocket),
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    }));
  }
}

const USAGE = `dori <command> [options]

  doctor                                                         read-only health check: OK/WARN/FAIL with the exact fix; exit 1 on any FAIL
  status [--json | --page N]                                     one-screen summary: services, lead, lanes, waits, repos, gateway (also /status in Discord); --page N lists more lanes, --json every lane with its latest report
  setup  [--yes] [--token-file F] [--channel ID] [--autostart] [--set KEY=VALUE ...] [--unset KEY ...] [--migrate]
                                       interactive install: token, channels, herdr, autostart; --set/--unset set or delete config.json
                                       keys as given without asking; keys config.json no longer reads are warned about once, then removed (backup config.json.<time>.bak);
                                       --migrate only removes those and asks keys never shown before (dori setup --help)
  quota [--json]                                                 Claude 5h/7d usage of every account with reset times
  launch <key> --title T (--brief FILE | --from-message CHANNEL MESSAGE_ID ... [--note TEXT ...]) --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
                [--from-message CHANNEL MESSAGE_ID]   repeatable, instead of --brief: the brief is "# <title>", "## Owner request" with those owner messages (latest edit) in order,
                                       then "## Lead notes" with each --note as a bullet; written to <stateDir>/briefs/<key>.md; a deleted, visitor or unknown message exits 1
                [--mode ulw|mass-ulw]   ulw (default): clear, contained work; mass-ulw: wide changes or vague instructions that need investigation
                [--share-thread] [--allow-repo-mismatch]   refused when another open lane has the thread or the git checkout, or cwd's repo is not in Done
                [--sandbox]   every lane runs in the sandbox (--sandbox is accepted and changes nothing): a local one (--pane too) in laneSandbox.command after a --check preflight, a --machine one under its runner's sandboxed profile; a missing or broken sandbox refuses the launch (SANDBOX_MISSING / SANDBOX_BROKEN / SANDBOX_UNAVAILABLE) and warns on Discord; only Windows runners (no lane sandbox exists there) and machines opted in with runners.<label>.allowUnsandboxed run unsandboxed, with SANDBOX_SKIPPED and a Discord warning each time
                HOLD (exit 4) on host limits queues the launch in launch-hold.json until it launches or is dropped
                [--machine LABEL-OR-ID] [--pane ID | --workspace ID]   target a saved machine; run in an existing idle shell pane instead of a new tab; cwd defaults to the pane's
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--cwd DIR] [--machine LABEL-OR-ID] [--share-thread] [--allow-repo-mismatch]   with --machine, --cwd is the remote directory
  hold list | hold drop <key>          the launches waiting after a HOLD (JSON), or drop one
  sync   [--write] [--full]            registry vs live panes: summary and drift (--full adds the table); read-only unless --write
  recover [key]                        recover missing or wrong-model working lane panes
  claim-done <key> --evidence TEXT    inside a lane: its own key only, as a done report through its runner; the lead names any lane
  object-done <key> --reason TEXT [--reason TEXT ...]
  lane status [<key>]                  a lane's status, its last objection's reasons and its done claim (JSON); inside a lane its own (from its runner), the lead names the lane
  ops [list] [--lane KEY] [--all] [--json]   operation rows: open, failed and ambiguous ones; --all adds verified
  ops resolve <id> --as verified|retry  the lead's answer for an ambiguous or failed operation after checking the world by hand
  close  <key> [--note TEXT] [--force] close now (Done signals must read back live; unpushed, uncommitted or untracked work refuses unless --force)
  close  <key> --cancelled --reason TEXT [--force]   lead-only: close a lane whose work was cancelled or whose Done can never hold;
                                       Done signals are not checked, the lane is recorded closed as cancelled with the reason
                                       inside a lane (DORI_LANE_KEY, or a pane its runner knows) dori takes only report, claim-done, report ack,
                                       lane status and heavy (anything else: DORI_CLI_LANE_ONLY, exit 2); lane commands of the lead need the
                                       supervisor (RUNNER_UNAVAILABLE, exit 2, while it is down)
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  watch                                long-running: emits LANE_* lines every 30 s
  supervise                            own inbound/sweeps and restart a cold idle lead
  runner serve [--label LABEL] [--enroll] [--listen HOST:PORT]
                                       a worker listens on its private address; the local runner connects over
                                       ~/.dori/runner/sock/control; signed handshake, heartbeats, reports lane
                                       observations; commands are checked against ~/.dori/runner/runner-config.json;
                                       --enroll reads code= and fingerprint= lines on stdin first; --enroll-only enrolls and exits
  runner install (TARGET [--label LABEL] | --machine LABEL) [--set KEY=VALUE ...] [--unset KEY ...] [--yes]
                                       install or upgrade the runner on a Linux worker over ssh (bundle, unit, linger, enrollment
                                       through ssh stdin/stdout); listens on the worker's private IP, port 7411.
                                       TARGET is user@ip, ip or user@host; LABEL defaults to a slug of the host (100.64.1.2 -> 100-64-1-2)
                                       and the machine is remembered in <stateDir>/runner-machines.json;
                                       then runs runner setup --new for it with --set/--unset (--yes: ask nothing)
  runner setup [--machine LABEL] [--set KEY=VALUE ...] [--unset KEY ...] [--yes] [--new]
                                       edit runner-config.json (the local runner's, or LABEL's over ssh): --set/--unset are applied
                                       as given (an empty VALUE unsets), every other key is asked with [required]/[optional] and its
                                       current value (Enter keeps it; required keys with a value are not asked again); keys the file no longer reads are removed (backup in
                                       runner-config.json.bak); --new asks only keys never shown before; --yes asks nothing
  runner remove LABEL                  stop and delete the runner on that worker over ssh, revoke its key and forget its endpoint (RUNNER_REMOVED)
  runner probe [--json]                on a runner host: alive/stalled/dead from ~/.dori/runner/health; exit 0 only when healthy
  runner enroll --machine LABEL        a one-time enrollment code (10 min) and the supervisor key fingerprint, on stdout only
  runner revoke LABEL                  delete the runner's key, close its connection, refuse its hellos (RUNNER_REVOKED)
  runner rotate LABEL                  have the connected runner switch to a new key; prints the new key fingerprint
  runner reset-gen LABEL               forget the runner's highest gen (after restoring its state from a backup)
  runner herdr start|restart|stop|status --machine LABEL [--yes]
                                       the machine's herdr through its runner (proto 4; LABEL local is the lead host);
                                       restart and stop end every lane pane there: they list the open lanes and need --yes;
                                       stop keeps herdr down (the runner does not start it again) until start
  lead-restart [--model ID] [--thinking LEVEL]   request a cold start at the next idle moment
  update [--dev] [--force]             fast-forward this install's checkout to origin/main (--dev: origin/dev), keep local changes,
                                       bun install on a lockfile change, restart dori-supervisor when HEAD moved (--force: always);
                                       also runs dori setup --migrate, and runner setup --new for every runner (RUNNER_POLICY_MISSING);
                                       ends with UPDATE_SUMMARY (changed, failed); exit 2 when a step failed (migrate degraded)
  store import                         with the supervisor stopped: move supervisor.json into supervisor.sqlite (verified field by field);
                                       the store follows the files in the state dir
  store export                         with the supervisor stopped: write supervisor.json, lead-events.log and github-events.json back
                                       from supervisor.sqlite (rollback); the store follows the files in the state dir
  wait <key> --until SIGNAL --note TEXT [--thread REF] [--every SEC] [--timeout MIN] [--machine M --cwd DIR]
  wait --list | --cancel <key>          durable supervisor-owned follow-ups
  emit <KIND> --text T [--id ID]       journal one event (dedupe by --id); its class comes from eventPolicy
  source list [--json]                 event sources: built-ins and registered ones, with their last event and error
  source add <name> --type poll --command CMD --every SEC --match RE --kind KIND [--cwd DIR] [--machine M]
                                       CMD is a shell line, or a JSON argv array; each stdout line matching RE is one event
  source add <name> --type webhook --port P --kind KIND [--secret S]   POST to 127.0.0.1:P with X-Dori-Secret (secret printed once when generated)
  source add <name> --type file --path FILE --match RE --kind KIND     each new line of FILE matching RE is one event
  source remove <name>                 stop and forget a registered source
  schedule add <name> (--cron EXPR | --every SEC) (--text T | --command CMD [--cwd DIR] [--machine M] [--heavy] [--timeout SEC]) --kind KIND
               [--tz ZONE] [--catch-up once|skip]   a scheduled job: emit <KIND> T, or run CMD and emit its result;
                                       cron in ZONE (default Asia/Seoul); a missed slot runs once after downtime (or is skipped)
  schedule list [--json] | schedule remove <name> | schedule run-now <name>   jobs with their next and last run; run one now
  repos add/remove <owner/repo>        manage this machine's GitHub watched repos
  repos list                          print this machine's watched repos as JSON
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  placement [--repo owner/repo] [--cwd D] [--done "..."] [--json]
                                       without flags: the repos each runner declares (WORKSPACE, one per runner; a repo several
                                       runners declare launches on one of them), the repos only detected under its allowedRoots
                                       (DETECTED, information) and the default machine; with flags: where a launch would go
                                       (PLACEMENT line, PLACEMENT_CANDIDATES when several runners declare the repo)
  can-launch [--machine M] [--cwd D] [--done "..."] [--all]
                                       exit 0 if the machine a launch with these flags is placed on (none: placement.defaultMachine)
                                       has room for a new lane, else print why and exit 4; --all checks local and every listed machine
  memory check                         read-only: the lead's human.md size vs memoryCheck.maxKb and Open items naming closed lanes
                                       or merged PRs; exit 1 when action is needed, 2 when it cannot check
  report <key> <progress|question|blocked|milestone|done> --text T [--evidence E]
                                       inside a lane: its structured report (own key only), sent through its runner to the supervisor
  report ack <id>                      inside a lane: confirm a supervisor message to this lane by its ID (CI follow-up, done-claim notice, objection)
  inbox take [--max-bytes N] [--peek]  the lead's read path: delivered events past the take cursor as id<TAB>line, whole lines
                                       up to N bytes (INBOX_MORE <lines> <bytes> when more wait, INBOX_EMPTY when none); writes a take receipt
  reported <key> --text TEXT [--final] [--to TARGET] [--thread ID] [--note TEXT]
                                       post a finished lane's outcome (after LANE_CLOSED or CI_MERGED) to the owner in the lane's thread
                                       (--to/--thread override it, as for send) and, once the post returns a message id, record the receipt;
                                       without it the supervisor sends urgent UNREPORTED <key> after reportTimeoutMin;
                                       --final adds the owner's close-thread button unless the thread still has work or already got it
                                       (REPORT_BUTTON_WITHHELD); without --final, supervise posts it once the thread's work is finished
  reported <key> --append TEXT [--note TEXT]
                                       a follow-up after the report (merge result, Toodo done): appended to the lane's last report
                                       by editing it (else its status message), no new post (REPORT_APPENDED)
                                       a report, append or send into a thread the owner closed goes to its parent channel instead
                                       (the owner channel when the parent is unknown),
                                       as one line linking the thread (REPORT_REDIRECTED / SENT_REDIRECTED); the thread stays closed
  resolved <eventId> [...] [--note TEXT] the lead's receipt that it decided a decision event (a lane question or blocked report, LANE_NOT_DONE,
                                       WAIT_*, DEAD_PANE; config resolveKinds); without it urgent UNRESOLVED <eventId> after resolveTimeoutMin
  ack <channel> <messageId> [...]      the lead's read receipt (one <channel> <messageId> pair per message) on a Discord owner message:
                                       hourglass off, eyes on; the ack is recorded for the supervisor
  handled <channel> <messageId> [--tasks N] [--lane KEY ...] [--reply] [--all] [--awaiting [--note TEXT]]
                                       link what handled an owner message, or park it on the owner's answer (--awaiting)
  send [discord] --to TARGET --text TEXT [--thread ID] [--edit ID | --buttons JSON] [--force]
                                       post or edit a Discord message (the platform defaults to discord) (token from DORI_DISCORD_TOKEN);
                                       --to alerts is config alertsChannel, else the first discordChannels entry. A new post is refused with
                                       SEND_STALE <n> (the unseen owner events follow, exit 3) when the destination got owner messages
                                       you have not taken, acked or seen in an ack preview; merge them and resend. --force skips the
                                       check; --edit is never checked
  thread [discord] --to CHANNEL [--message ID] --name NAME
                                       start a Discord thread (on a message, else standalone) with discord.ownerId added as a member;
                                       prints THREAD discord:<channel>/<thread>
  typing [discord] <channel>           show the typing indicator in a Discord channel or lane thread ref (about 10 s, or until the bot posts)
  presence [discord]                   keep the bot shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const helpCommand = process.argv[2] ?? "";
if (helpCommand !== "setup" && process.argv.slice(3).some((arg) => arg === "--help" || arg === "-h")) {
  const lines = USAGE.split("\n");
  const entry = (prefix: string): number =>
    lines.findIndex((line) => helpCommand !== "" && line.startsWith(prefix) && /\s/.test(line[prefix.length] ?? ""));
  const sub = process.argv[3] ?? "";
  const subStart = helpCommand === "runner" && sub && !sub.startsWith("-") ? entry(`  runner ${sub}`) : -1;
  const start = subStart >= 0 ? subStart : entry(`  ${helpCommand}`);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^  \S/.test(lines[end] ?? "")) end++;
    console.log(lines.slice(start, end).join("\n").trimEnd());
    process.exit(0);
  }
}

if (process.argv[2] === "setup") {
  const { setupMain } = await import("./setup-cli.ts");
  process.exit(await setupMain(process.argv.slice(3)));
}

if (process.argv[2] === "doctor") process.exit(await (await import("./doctor.ts")).doctorMain());
if (process.argv[2] === "status") {
  const args = process.argv.slice(3);
  const json = args.length === 1 && args[0] === "--json";
  const paged = args.length === 2 && args[0] === "--page" && /^[1-9]\d*$/.test(args[1] ?? "");
  if (args.length && !json && !paged) { console.error("usage: dori status [--json | --page N]"); process.exit(1); }
  const page = paged ? Number(args[1]) : 1;
  const { collectStatus, statusPage } = await import("./status.ts");
  const cfg = await loadConfig();
  setDefaultRunTimeout(cfg.runTimeoutMs);
  const status = await collectStatus({ run, clock: realClock, config: cfg, tunables: BUILT_IN, registry: new Registry(cfg.stateDir), runnerDir: defaultRunnerDir() });
  console.log(json ? JSON.stringify(status, null, 2) : statusPage(status, page));
  process.exit(0);
}

let ttyKeyPrompter: KeyPrompter | undefined;

/**
 * `dori runner setup` against the local runner (no machine) or a saved machine over ssh; the keys shown are recorded in
 * <stateDir>/runner-setup-keys/<label|local>.json. Returns runRunnerSetup's code; an unknown machine kind or a remote IO
 * failure throws.
 */
const runnerSetupNow = async (
  stateDir: string, machine: GuardMachine | undefined,
  o: { readonly patch: Json; readonly unset: readonly string[]; readonly interactive: boolean; readonly mode: "full" | "new"; readonly requireFile?: boolean },
): Promise<number> => {
  const { localRunnerConfigIO, remoteRunnerConfigIO, runRunnerSetup } = await import("./runner/runner-setup.ts");
  const { defaultsPrompter, ttyPrompter } = await import("./setup-cli.ts");
  let io = localRunnerConfigIO(defaultRunnerDir());
  if (machine !== undefined) {
    const kind = await machineKind(run, machine);
    if (!kind.ok) throw new Error(`RUNNER_SETUP_FAILED ${machine.label}: ${kind.detail}`);
    io = remoteRunnerConfigIO(run, machine, kind.kind);
  }
  return runRunnerSetup({
    io, prompt: o.interactive ? (ttyKeyPrompter ??= ttyPrompter()) : defaultsPrompter, interactive: o.interactive,
    log: (line) => { console.log(line); }, seenPath: join(stateDir, "runner-setup-keys", `${machine?.label ?? "local"}.json`), mode: o.mode,
    requireFile: o.requireFile,
  }, { patch: o.patch, unset: o.unset });
};

/**
 * `dori update`'s worker migration: first the old standalone guard agent files are removed from every machine (their
 * failures are logged and never change the exit code), then each worker runner gets the new bundle through
 * `dori runner install`'s path, one at a time, each confirmed by a hello with a higher gen within 2 minutes. The local
 * runner is the supervisor's child, so the supervisor restart that `dori update` already did restarted it on the
 * updated checkout. A runner that already reports this checkout's version is skipped. Then every runner, upgraded or
 * not (the local one and each worker the hub knows), gets runner setup in "new" mode (asks only keys never shown
 * before): a worker without runner-config.json, a missing required key or a failed check is reported.
 * Returns 1 when any runner failed to upgrade or its policy check found a gap (the others still ran), else 0.
 */
const upgradeRunnersNow = async (cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<number> => {
  const { readRunnerRows } = await import("./runner/hub.ts");
  const { checkRunnerPolicies, staleRunnerLabels, upgradeRunners } = await import("./runner/upgrade.ts");
  const { gitVersion } = await import("./runner/version.ts");
  const { buildBundle, installRunner } = await import("./runner/install.ts");
  const { runnerListenAddress } = await import("./runner/endpoints.ts");
  const { SupervisorAuth } = await import("./runner/auth.ts");
  const rows = readRunnerRows(cfg.stateDir);
  const genOf = (label: string): number => readRunnerRows(cfg.stateDir).find((r) => r.label === label)?.maxGen ?? 0;
  const machines = await listGuardMachines(run, cfg.guardMachines, cfg.stateDir);
  try { await removeGuardAgents(run, machines, (line) => console.log(line)); } catch (e) { console.log(`WARN guard agents: ${e instanceof Error ? e.message : String(e)}`); }
  let bundle: string | undefined;
  const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
  const before = new Map(rows.map((r) => [r.label, r.maxGen]));
  try {
    const result = await upgradeRunners({
      labels: staleRunnerLabels(rows, LOCAL_RUNNER, await gitVersion(run, import.meta.dir)),
      install: async (label) => {
        const machine = machines.find((m) => m.label === label);
        if (!machine) return { ok: false, detail: `no machine ${label}` };
        bundle ??= await buildBundle(run, undefined, cfg.stateDir)();
        const done = await installRunner({ run, bundle: async () => bundle as string }, {
          machine, label, listenAddress: await runnerListenAddress(machine.target), stateDir: cfg.stateDir,
          agentCommand: cfg.agentCommand,
          issue: () => ({ code: auth.issueCode(label).code, fingerprint: auth.fingerprint }),
          enroll: (body) => auth.enroll(body),
        });
        if (!done.ok) return { ok: false, detail: `${done.code} ${done.detail}` };
        return { ok: true, version: done.version };
      },
      confirm: async (label) => {
        for (const until = realClock.now() + 120_000; realClock.now() < until; await realClock.sleep(2_000)) {
          if (genOf(label) > (before.get(label) ?? 0)) return true;
        }
        return false;
      },
      log: (line) => console.log(line),
    });
    const policy = await checkRunnerPolicies({
      labels: [LOCAL_RUNNER, ...new Set(readRunnerRows(cfg.stateDir).map((r) => r.label).filter((l) => l !== LOCAL_RUNNER))],
      check: async (label) => {
        const local = label === LOCAL_RUNNER;
        const machine = local ? undefined : machines.find((m) => m.label === label);
        if (!local && !machine) throw new Error(`no machine ${label}`);
        return runnerSetupNow(cfg.stateDir, machine, { patch: {}, unset: [], interactive: Boolean(process.stdin.isTTY), mode: "new", requireFile: !local });
      },
      log: (line) => console.log(line),
    });
    return result.failed.length || policy.missing.length || policy.failed.length ? 1 : 0;
  } finally {
    auth.close();
  }
};

if (process.argv[2] === "runner") {
  // serve and probe run on runner hosts and live in runner/main.ts, which the worker bundle (runner/bin.ts) also runs.
  if (process.argv[3] === "serve" || process.argv[3] === "probe") {
    const { runnerHostMain } = await import("./runner/main.ts");
    process.exit(await runnerHostMain(process.argv.slice(3)));
  }
  // enroll, install, revoke, rotate, reset-gen and upgrade run on the supervisor host against <stateDir>.
  const usage = "usage: dori runner serve [--label LABEL] [--enroll | --enroll-only] [--listen HOST:PORT] | probe [--json] | enroll --machine LABEL | install (TARGET [--label LABEL] | --machine LABEL) [--set KEY=VALUE ...] [--unset KEY ...] [--yes] | setup [--machine LABEL] [--set KEY=VALUE ...] [--unset KEY ...] [--yes] [--new] | remove LABEL | revoke LABEL | rotate LABEL | reset-gen LABEL | upgrade | herdr start|restart|stop|status --machine LABEL [--yes]";
  const parsed = parseArgs({
    args: process.argv.slice(3), allowPositionals: true,
    options: {
      machine: { type: "string" }, label: { type: "string" }, yes: { type: "boolean" },
      set: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, new: { type: "boolean" },
    },
  });
  const [sub = "", target, ...extra] = parsed.positionals;
  if (extra.length) die(usage);
  const { LABEL_PATTERN } = await import("./runner/protocol.ts");
  const labelArg = (value: string | undefined): string => {
    if (!value || !LABEL_PATTERN.test(value)) die(usage);
    return value as string;
  };
  if (parsed.values.yes && sub !== "herdr" && sub !== "setup" && sub !== "install") die(usage);
  if (parsed.values.label !== undefined && sub !== "install") die(usage);
  if ((parsed.values.set !== undefined || parsed.values.unset !== undefined) && sub !== "setup" && sub !== "install") die(usage);
  if (parsed.values.new && sub !== "setup") die(usage);
  /** --set/--unset against runner-config.json's keys; an unknown key or bad value stops before anything runs. */
  const runnerKeys = async (): Promise<{ patch: Json; unset: readonly string[] }> => {
    const { ConfigKeyError, parseSetArgs, RUNNER_CONFIG_KEYS } = await import("./config-keys.ts");
    try {
      return parseSetArgs(RUNNER_CONFIG_KEYS, parsed.values.set ?? [], parsed.values.unset ?? []);
    } catch (e) {
      if (!(e instanceof ConfigKeyError)) throw e;
      return die(`RUNNER_SETUP_FAILED ${e.message}`);
    }
  };
  const setupInteractive = !parsed.values.yes && Boolean(process.stdin.isTTY);
  if (sub === "setup") {
    if (target !== undefined) die(usage);
    const keys = await runnerKeys();
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    let machine: GuardMachine | undefined;
    if (parsed.values.machine !== undefined) {
      const label = labelArg(parsed.values.machine);
      const { readGuardMachines } = await import("./remote-guard.ts");
      const machines = await readGuardMachines(run, cfg.guardMachines, cfg.stateDir);
      machine = machines.machines.find((m) => m.label === label) ?? die(`RUNNER_UNKNOWN_MACHINE ${label}${machines.ok ? "" : `: ${machines.detail}`}`);
    }
    let code: number;
    try {
      code = await runnerSetupNow(cfg.stateDir, machine, { ...keys, interactive: setupInteractive, mode: parsed.values.new ? "new" : "full" });
    } catch (e) {
      code = die(e instanceof Error ? e.message : String(e));
    }
    process.exit(code);
  }
  if (sub === "herdr") {
    const label = labelArg(parsed.values.machine);
    const cfg = await loadConfig();
    const { readRunnerRows } = await import("./runner/hub.ts");
    const { runnerHerdrMain } = await import("./runner/herdr-cli.ts");
    process.exit(await runnerHerdrMain({ action: target, machine: label, yes: parsed.values.yes === true }, {
      calls: cliRunnerCall(cliSocketPath(defaultRunnerDir())),
      rows: () => readRunnerRows(cfg.stateDir),
      lanes: async () => (await new Registry(cfg.stateDir).open()).filter((lane) => statusOf(lane) !== "closed"),
      out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
    }));
  }
  if (sub === "upgrade") {
    if (target !== undefined || parsed.values.machine !== undefined) die(usage);
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    process.exit(await upgradeRunnersNow(cfg));
  }
  if (sub === "enroll") {
    // The code and fingerprint go to stdout only: the installer pipes them into the runner's stdin over ssh.
    const label = labelArg(parsed.values.machine);
    if (target !== undefined) die(usage);
    const cfg = await loadConfig();
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      const issued = auth.issueCode(label);
      process.stdout.write(`code=${issued.code}\nfingerprint=${auth.fingerprint}\n`);
      process.stderr.write(`RUNNER_ENROLL_CODE runner=${label} expiresAt=${new Date(issued.expiresAt).toISOString()}\n`);
    } finally {
      auth.close();
    }
    process.exit(0);
  }
  if (sub === "install") {
    // Exactly one of a positional ssh target (user@ip, ip, user@host) or --machine LABEL.
    if ((target === undefined) === (parsed.values.machine === undefined)) die(usage);
    if (parsed.values.machine !== undefined && parsed.values.label !== undefined) die(usage);
    const { labelFromHost, parseInstallTarget, writeRunnerMachine } = await import("./runner/machines.ts");
    let direct: { label: string; target: string } | undefined;
    if (target !== undefined) {
      try {
        const parsedTarget = parseInstallTarget(target);
        direct = { label: parsed.values.label === undefined ? labelFromHost(parsedTarget.host) : labelArg(parsed.values.label), target: parsedTarget.target };
      } catch (e) {
        die(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
    }
    const label = direct?.label ?? labelArg(parsed.values.machine);
    const keys = await runnerKeys();
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    const { readGuardMachines } = await import("./remote-guard.ts");
    const machines = await readGuardMachines(run, cfg.guardMachines, cfg.stateDir);
    const machine = direct ?? machines.machines.find((m) => m.label === label)
      ?? die(`RUNNER_UNKNOWN_MACHINE ${label}${machines.ok ? "" : `: ${machines.detail}`}`);
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const { buildBundle, herdrInstallNote, installRunner } = await import("./runner/install.ts");
    const { runnerListenAddress } = await import("./runner/endpoints.ts");
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      // The code is issued in this process and handed to the installer as data; it never enters an argv.
      const result = await installRunner({ run, bundle: buildBundle(run), progress: (line) => { console.log(line); } }, {
        machine, label, listenAddress: await runnerListenAddress(machine.target), stateDir: cfg.stateDir,
        agentCommand: cfg.agentCommand,
        issue: () => ({ code: auth.issueCode(label).code, fingerprint: auth.fingerprint }),
        enroll: (body) => auth.enroll(body),
      });
      if (!result.ok) die(`${result.code} runner=${label} ${result.detail}`);
      if (direct) writeRunnerMachine(cfg.stateDir, direct.label, direct.target);
      console.log(`RUNNER_INSTALLED runner=${label} version=${result.ok ? result.version : ""} ${herdrInstallNote(result.ok ? result.herdr : undefined)}`);
    } finally {
      auth.close();
    }
    const setup = await runnerSetupNow(cfg.stateDir, machine, { ...keys, interactive: setupInteractive, mode: "new" })
      .catch((e: unknown) => { console.log(e instanceof Error ? e.message : String(e)); return 1; });
    if (setup !== 0) {
      console.log(`RUNNER_SETUP_AFTER_INSTALL_FAILED runner=${label} run: dori runner setup --machine ${label}`);
      process.exit(setup);
    }
    process.exit(0);
  }
  if (sub === "remove") {
    if (parsed.values.machine !== undefined) die(usage);
    const label = labelArg(target);
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    const { readGuardMachines } = await import("./remote-guard.ts");
    const machines = await readGuardMachines(run, cfg.guardMachines, cfg.stateDir);
    const { hasLocalRunnerState, planRemove, removeRunner } = await import("./runner/remove.ts");
    // A label dropped from herdr and config but still known locally (keys, hub row, endpoint) is cleaned up here only.
    const plan = planRemove(machines, label, hasLocalRunnerState(cfg.stateDir, label));
    if (plan.kind === "unknown") die(`RUNNER_UNKNOWN_MACHINE ${label}${plan.detail === undefined ? "" : `: ${plan.detail}`}`);
    const { runnerOf } = await import("./lane-ops.ts");
    const busy = (await new Registry(cfg.stateDir).open()).filter((lane) => statusOf(lane) !== "closed" && runnerOf(lane) === label);
    if (busy.length) die(`RUNNER_REMOVE_BUSY runner=${label} open lanes: ${busy.map((lane) => lane.key).join(",")}; close them or run dori runner evacuate ${label} first`);
    const { stepper } = await import("./runner/steps.ts");
    const step = stepper((line) => { console.log(line); }, label);
    if (plan.kind === "remote") {
      const result = await removeRunner({ run, progress: (line) => { console.log(line); } }, { machine: plan.machine, label });
      if (!result.ok) die(`${result.code} runner=${label} ${result.detail}`);
    } else {
      step("uninstall", "skipped", "no saved machine; the worker is not touched");
    }
    step("cleanup", "start", "key, supervisor link, endpoint, machine, hub row");
    // Only after the worker is clean: the key, a live supervisor's link, the endpoint and the remembered machine go.
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const { queueRunnerAdmin } = await import("./runner/serve.ts");
    const { removeRunnerEndpoint } = await import("./runner/endpoints.ts");
    const { removeRunnerMachine } = await import("./runner/machines.ts");
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      auth.revoke(label);
    } finally {
      auth.close();
    }
    queueRunnerAdmin(cfg.stateDir, "revoke", label, realClock.now());
    removeRunnerEndpoint(cfg.stateDir, label);
    removeRunnerMachine(cfg.stateDir, label);
    const { forgetRunner } = await import("./runner/hub.ts");
    forgetRunner(cfg.stateDir, label);
    step("cleanup", "done");
    console.log(`RUNNER_REMOVED runner=${label}${plan.kind === "local" ? " local-only (no saved machine; the worker was not touched)" : ""}`);
    process.exit(0);
  }
  if (sub === "evacuate") {
    const label = labelArg(target);
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    const { machineKind, readGuardMachines, sshArgv } = await import("./remote-guard.ts");
    const { openLaneReports } = await import("./lane-reports.ts");
    const { evacuate } = await import("./runner/evacuate.ts");
    const machine = (await readGuardMachines(run, cfg.guardMachines, cfg.stateDir)).machines.find((m) => m.label === label);
    if (!machine) die(`RUNNER_UNKNOWN_MACHINE ${label}`);
    const sshTarget = (machine as NonNullable<typeof machine>).target;
    // The worker's commands take the form of its kind (POSIX sh or Windows PowerShell); found once, on first use.
    let kind: Promise<MachineKind> | undefined;
    const kindOf = (): Promise<MachineKind> => (kind ??= machineKind(run, machine as NonNullable<typeof machine>).then((k) => {
      if (!k.ok) throw new Error(`machine kind: ${k.detail}`);
      return k.kind;
    }));
    const store = openLaneReports(cfg);
    // The notice goes through the runner being evacuated (D9), so it is sent before the runner is stopped.
    const ops = laneOps(cliRunnerCall(cliSocketPath(defaultRunnerDir())), { now: realClock.now, log: (line) => { console.error(line); } });
    try {
      const lines = await evacuate({
        hub: {
          stateDir: cfg.stateDir, registry: new Registry(cfg.stateDir), reports: () => store,
          now: realClock.now, emit: (_id, line) => { console.log(line); },
          // Evacuation imports events without dispatching inventory recovery. Like the supervisor's
          // absent-inventory path, preparation carries no attachments.
          prepareRecovery: async (_label, key) => ({ cmdId: `recover:${key}:${realClock.now()}`, notes: [] }),
          recover: () => undefined,
        },
        exportOutbox: async () => {
          const r = await run(sshArgv(sshTarget, remoteRunnerCli("runner export-outbox", await kindOf())), { timeoutMs: 30_000 });
          if (r.code !== 0) throw new Error(`export-outbox exit ${r.code}: ${(r.err || r.out).trim().split("\n").at(-1) ?? ""}`);
          return JSON.parse(r.out.trim().split("\n").at(-1) ?? "[]");
        },
        tellLane: async (lane, text) => (await ops.send(lane, text)) !== "failed",
        stopRunner: async () => {
          const r = await run(sshArgv(sshTarget, remoteRunnerService("stop", await kindOf())), { timeoutMs: 30_000 });
          return { ok: r.code === 0, detail: (r.err || r.out).trim().split("\n").at(-1) || `exit ${r.code}` };
        },
      }, label);
      for (const line of lines) console.log(line);
    } finally {
      store.close();
    }
    process.exit(0);
  }
  if (sub === "revoke" || sub === "rotate" || sub === "reset-gen") {
    const label = labelArg(target);
    const cfg = await loadConfig();
    if (sub === "reset-gen") {
      const { resetRunnerGen } = await import("./runner/hub.ts");
      if (!resetRunnerGen(cfg.stateDir, label)) die(`RUNNER_UNKNOWN ${label}`);
      console.log(`RUNNER_GEN_RESET runner=${label}`);
      process.exit(0);
    }
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const { queueRunnerAdmin, runnerAdminResult } = await import("./runner/serve.ts");
    // The supervisor's runners task answers queued requests every few seconds.
    const waitFor = async <T>(read: () => T | undefined, ms: number): Promise<T | undefined> => {
      for (const until = realClock.now() + ms; realClock.now() < until; await realClock.sleep(500)) {
        const value = read();
        if (value !== undefined) return value;
      }
      return read();
    };
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      if (sub === "revoke") {
        // The key is deleted here at once, so later hellos are refused even with the supervisor down; the live link
        // closes when the supervisor takes the request.
        if (!auth.revoke(label)) die(`RUNNER_UNKNOWN ${label} is not enrolled`);
        const id = queueRunnerAdmin(cfg.stateDir, "revoke", label, realClock.now());
        const result = await waitFor(() => runnerAdminResult(cfg.stateDir, id), 15_000);
        console.log(`RUNNER_REVOKED runner=${label} link=${result ?? "pending (supervisor has not answered)"}`);
        process.exit(0);
      }
      const before = auth.key(label);
      if (!before?.pubKey) die(`RUNNER_UNKNOWN ${label} is not enrolled`);
      const id = queueRunnerAdmin(cfg.stateDir, "rotate", label, realClock.now());
      const result = await waitFor(() => runnerAdminResult(cfg.stateDir, id), 15_000);
      if (!result?.startsWith("sent ")) die(`RUNNER_ROTATE_FAILED runner=${label} ${result ?? "the supervisor did not answer"}`);
      const rotated = await waitFor(() => {
        const row = auth.key(label);
        return row?.pubKey && row.pubKey !== before?.pubKey ? row.pubKey : undefined;
      }, 15_000);
      if (!rotated) die(`RUNNER_ROTATE_PENDING runner=${label} ${result} (the runner has not answered yet)`);
      const { fingerprint } = await import("./runner/auth.ts");
      console.log(`RUNNER_KEY_ROTATED runner=${label} key=${fingerprint(rotated as string)}`);
      process.exit(0);
    } finally {
      auth.close();
    }
  }
  die(usage);
}

const config = await loadConfig();
setDefaultRunTimeout(config.runTimeoutMs);
// Lane operations go through the supervisor's CLI relay; built on first use, so commands that touch no lane never connect.
let cliCall: CliRunnerCall | undefined;
const relay = (): CliRunnerCall => (cliCall ??= cliRunnerCall(cliSocketPath(defaultRunnerDir())));
let cliOps: LaneOps | undefined;
const deps: FlowDeps = {
  run, clock: realClock, registry: new Registry(config.stateDir), config, tunables: BUILT_IN,
  get ops(): LaneOps { return cliOps ??= laneOps(relay(), { now: realClock.now, log: (line) => { console.error(line); } }); },
};

/** RUNNER_UNAVAILABLE (exit 2) at once when the supervisor's CLI relay does not answer: every lane operation needs it (D7). */
const needSupervisor = async (): Promise<void> => {
  try { await relay().refresh(LOCAL_RUNNER); }
  catch (e) { if (e instanceof RunnerUnavailable) die(e.message, 2); throw e; }
};
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, mode: { type: "string" }, thinking: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, workspace: { type: "string" }, machine: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, full: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, append: { type: "string" }, edit: { type: "string" }, name: { type: "string" }, message: { type: "string" },
    until: { type: "string" }, every: { type: "string" }, timeout: { type: "string" },
    list: { type: "boolean" }, final: { type: "boolean" }, cancel: { type: "string" }, "share-thread": { type: "boolean" }, "allow-repo-mismatch": { type: "boolean" }, sandbox: { type: "boolean" }, json: { type: "boolean" }, force: { type: "boolean" }, cancelled: { type: "boolean" },
    lane: { type: "string" }, as: { type: "string" }, all: { type: "boolean" },
    type: { type: "string" }, command: { type: "string" }, match: { type: "string" }, kind: { type: "string" }, path: { type: "string" },
    port: { type: "string" }, secret: { type: "string" }, id: { type: "string" },
    cron: { type: "string" }, tz: { type: "string" }, "catch-up": { type: "string" }, heavy: { type: "boolean" },
    dev: { type: "boolean" }, buttons: { type: "string" }, repo: { type: "string" },
  },
});
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
const key = flags.positionals[0];
const loopMin = Number(opt("loop") ?? 0);

/** Runner label -> true when its runner is not connected, from the hub table (`runners.sqlite`) the way `dori status` reads it; undefined: no such runner. */
const runnerOffline = async (stateDir: string, label: string): Promise<boolean | undefined> => {
  const { readRunnerRows } = await import("./runner/hub.ts");
  const { runnerView } = await import("./status.ts");
  const row = readRunnerRows(stateDir).find((r) => r.label === label);
  if (!row) return undefined;
  const state = runnerView(row, Date.now()).state;
  return state === "offline" || state === "lost" || state === "revoked";
};

/** `--machine`: undefined when absent or `local`; else a runner label known to the hub, otherwise the command dies. */
const machineOpt = async (stateDir: string): Promise<{ machine: string; offline: boolean } | undefined> => {
  const machine = opt("machine");
  if (machine === undefined || machine === "local") return undefined;
  const offline = await runnerOffline(stateDir, machine);
  if (offline === undefined) die(`RUNNER_UNKNOWN_MACHINE ${machine}: no runner with that label has enrolled; see them with \`dori status\` or \`dori runner probe\``);
  return { machine, offline: offline === true };
};
/** What every runner reported about its repos, `online` unless its runner is offline, lost or revoked (as runnerOffline). */
const placementReports = async (stateDir: string): Promise<RunnerPlacement[]> => {
  const { readRunnerRows } = await import("./runner/hub.ts");
  const { runnerView } = await import("./status.ts");
  const now = Date.now();
  return runnerPlacements(readRunnerRows(stateDir), (row) => !["offline", "lost", "revoked"].includes(runnerView(row, now).state));
};
const offlineWarn = (machine: string, what: "wait" | "source" | "schedule"): string =>
  `WARN runner ${machine} is not connected; the ${what} is kept and runs when it reconnects`;

/** `--command`: a JSON argv array, else a shell line run with `sh -c`. */
const commandArgv = (command: string | undefined): unknown => {
  if (!command) return die("--command is required");
  if (!command.startsWith("[")) return ["sh", "-c", command];
  try { return JSON.parse(command) as unknown; } catch { return die("--command starting with [ must be a JSON argv array"); }
};

// Lead mode from here on: lane mode (DORI_LANE_KEY, or a pane its runner knows) was handled before loadConfig, so every
// command below runs for the lead and may name any lane.

const lane = async (k: string) => {
  const found = await deps.registry.read(k);
  if (!found) return die(`no registered lane "${k}"`);
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

const messengerToken = (name: string): string => resolveCredential(name) ?? die(`${name} is not set in the environment or in ${envFilePath()}`);

/**
 * A launch's `--thread` as the lane stores it: `discord:<channel>/<thread>`, the parent read from Discord when the value names
 * only the thread. Without a token or an answer it is kept in ref form (`discord:<id>`), with THREAD_PARENT_UNKNOWN on stderr.
 */
const laneThreadRef = async (value: string | undefined, channels: readonly string[]): Promise<string | undefined> => {
  if (value === undefined || value === "none") return value;
  const token = resolveCredential("DORI_DISCORD_TOKEN");
  return withThreadParent(value, channels, async (id) => {
    if (!token) { console.error(`THREAD_PARENT_UNKNOWN ${id}: DORI_DISCORD_TOKEN is not set; the lane keeps discord:${id}`); return undefined; }
    try { return discordThread(await new Discord(fetchHttp, realClock, token).call("GET", `/channels/${id}`))?.parent; }
    catch (e) { console.error(`THREAD_PARENT_UNKNOWN ${id}: ${e instanceof Error ? e.message : String(e)}; the lane keeps discord:${id}`); return undefined; }
  });
};

/** Posts `text` to a resolved Discord target and returns the new message's id. */
const postMessage = async (to: string, text: string, components?: readonly unknown[]): Promise<string> =>
  // Each post is its own message: without a unique id Discord would dedupe a repeat of the same text.
  new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN")).send(to, text, randomUUID(), components);

const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

try {
  switch (command) {
    case "recover": {
      if (flags.positionals.length > 1 || Object.keys(flags.values).length) die("usage: dori recover [key]");
      if (key && !(await deps.registry.read(key))) die(`no registered lane "${key}"`);
      await needSupervisor();
      for (const line of await recoverLanes(deps, key)) console.log(line);
      break;
    }
    case "store": {
      const [action, ...extra] = flags.positionals;
      if (extra.length || Object.keys(flags.values).length || (action !== "import" && action !== "export")) die("usage: dori store import|export");
      if (action === "export") {
        const { exportStore } = await import("./store-export.ts");
        const report = exportStore(config.stateDir, realClock.now());
        console.log(JSON.stringify(report, null, 2));
        console.log(`STORE_EXPORTED ${config.stateDir}; the supervisor now uses the json store`);
        break;
      }
      const { importStore } = await import("./store-import.ts");
      const report = importStore(config.stateDir, realClock.now());
      console.log(JSON.stringify(report, null, 2));
      console.log(`STORE_IMPORTED ${report.database}; the supervisor now uses the sqlite store`);
      break;
    }
    case "lead-restart": {
      if (flags.positionals.length || Object.keys(flags.values).some((name) => name !== "model" && name !== "thinking") ||
          ("model" in flags.values && !opt("model")) || ("thinking" in flags.values && !opt("thinking"))) {
        die("usage: dori lead-restart [--model ID] [--thinking LEVEL]");
      }
      const request = requestLeadRestart(config, realClock.now(), opt("model"), opt("thinking"));
      console.log(`LEAD_RESTART_REQUESTED ${request.id} ${request.models[0]?.model}`);
      break;
    }
    case "update": {
      if (flags.positionals.length || Object.entries(flags.values).some(([name, v]) => (name !== "dev" && name !== "force") || v !== true)) {
        die("usage: dori update [--dev] [--force]");
      }
      const code = await updateInstall({
        run, sleep: realClock.sleep, log: (line) => console.log(line),
        // A fresh process: this one still holds the modules it loaded before the pull, which may refer to files the pull
        // removed or exports the pulled code no longer has.
        // stdin is inherited so runner setup and `dori setup --migrate` can ask new keys on a terminal.
        upgradeRunners: async () => Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "runner", "upgrade"], { stdio: ["inherit", "inherit", "inherit"] }).exited,
        // stdout is passed through as it arrives (prompts included) and kept for the update summary.
        migrateConfig: async () => {
          const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "setup", "--migrate"], { stdio: ["inherit", "pipe", "inherit"] });
          const decoder = new TextDecoder();
          let output = "";
          for await (const chunk of p.stdout) { process.stdout.write(chunk); output += decoder.decode(chunk, { stream: true }); }
          return { code: await p.exited, output };
        },
        refreshLaneSandbox: () => refreshLaneSandbox(homedir()),
        refreshBootPrep: () => refreshBootPrep(homedir()),
      },
        { packageDir: join(import.meta.dir, ".."), branch: flags.values.dev ? "dev" : "main", force: flags.values.force === true });
      process.exit(code);
    }
    case "repos": {
      const [action, repo, ...extra] = flags.positionals;
      const repos = new Repos(config.stateDir);
      if (Object.keys(flags.values).length || extra.length ||
          (action === "list" ? repo !== undefined : !repo || (action !== "add" && action !== "remove"))) {
        die("usage: dori repos add/remove <owner/repo> | dori repos list");
      }
      switch (action) {
        case "add": repos.add(repo ?? die("repos add needs owner/repo")); break;
        case "remove": repos.remove(repo ?? die("repos remove needs owner/repo")); break;
        case "list": break;
        default: die("usage: dori repos add/remove <owner/repo> | dori repos list");
      }
      console.log(JSON.stringify(repos.list(), null, 2));
      break;
    }
    case "wait": {
      const waits = new Waits(config.stateDir);
      if (flags.values.list) {
        if (key || opt("cancel") || opt("until")) die("usage: dori wait --list");
        console.log(JSON.stringify(waits.list(), null, 2));
      } else if (opt("cancel")) {
        if (key || opt("until")) die("usage: dori wait --cancel <key>");
        const cancelled = need("cancel");
        if (!waits.cancel(cancelled)) die(`no wait "${cancelled}"`);
        console.log(`WAIT_CANCELLED ${cancelled}`);
      } else {
        const target = await machineOpt(config.stateDir);
        if (target && !opt("cwd")) die("dori wait --machine needs --cwd (a directory on that machine)");
        const wait = waits.register({
          key: key ?? die("wait needs a key"), until: need("until"), note: need("note"),
          thread: opt("thread"), every: opt("every"), timeout: opt("timeout"), cwd: target ? need("cwd") : process.cwd(),
          ...(target ? { machine: target.machine } : {}),
        }, realClock.now());
        console.log(`WAIT_REGISTERED ${wait.key}${target ? ` machine=${target.machine}` : ""}`);
        if (target?.offline) console.log(offlineWarn(target.machine, "wait"));
      }
      break;
    }
    case "emit": {
      const kind = key;
      if (!kind || flags.positionals.length > 1 || Object.keys(flags.values).some((name) => name !== "text" && name !== "id")) die("usage: dori emit <KIND> --text T [--id ID]");
      const id = queueEmit(config.stateDir, kind ?? "", need("text"), realClock.now(), opt("id"));
      console.log(`EMIT_QUEUED ${id}`);
      break;
    }
    case "source": {
      const [action, name, ...extra] = flags.positionals;
      const specs = new SourceSpecs(config.stateDir);
      const usage = "usage: dori source list [--json] | dori source add <name> --type poll|webhook|file ... [--machine M] | dori source remove <name>";
      if (extra.length) die(usage);
      if (action === "list" && name === undefined) {
        const view = sourceViews(config.stateDir);
        const registered = new Map(specs.list().map((spec) => [spec.name, publicSpec(spec)]));
        const rows = view.sources.map((source) => ({ ...source, ...(registered.get(source.name) ?? {}) }));
        const offline = new Map<string, boolean | undefined>();
        for (const row of rows) if (row.machine && !offline.has(row.machine)) offline.set(row.machine, await runnerOffline(config.stateDir, row.machine));
        if (flags.values.json) console.log(JSON.stringify(rows, null, 2));
        else for (const row of rows) console.log(`${row.name} ${row.type}${row.kind ? ` ${row.kind}` : ""} events=${row.events ?? 0} duplicates=${row.duplicates ?? 0} last=${row.lastEventAt === undefined ? "never" : `${row.lastKind} ${new Date(row.lastEventAt).toISOString()}`}${row.failing ? ` FAILING ${row.lastError}` : ""}${"identity" in row && row.identity ? ` identity=${row.identity}` : ""}${row.machine ? ` machine=${row.machine}${offline.get(row.machine) ? " (runner offline)" : ""}` : ""}`);
        break;
      }
      if (action === "remove" && name) {
        if (!specs.remove(name)) die(`no source "${name}"`);
        console.log(`SOURCE_REMOVED ${name}`);
        break;
      }
      if (action !== "add" || !name) die(usage);
      const type = need("type");
      const command = opt("command");
      const generated = type === "webhook" && !opt("secret") ? randomBytes(24).toString("hex") : undefined;
      const target = await machineOpt(config.stateDir);
      if (target && type !== "poll") die("--machine is for --type poll sources (a webhook or file source runs on the supervisor host)");
      const spec = specs.add({
        name, type, kind: need("kind"),
        ...(type === "poll" ? {
          command: commandArgv(command),
          everySec: Number(need("every")), match: need("match"), ...(opt("cwd") ? { cwd: opt("cwd") } : {}),
          ...(target ? { machine: target.machine } : {}),
        } : {}),
        ...(type === "webhook" ? { port: Number(need("port")), secret: generated ?? need("secret") } : {}),
        ...(type === "file" ? { path: need("path"), match: need("match") } : {}),
      });
      console.log(JSON.stringify(publicSpec(spec), null, 2));
      if (generated) console.log(`WEBHOOK_SECRET ${generated} (shown once; send it as X-Dori-Secret)`);
      console.log(`SOURCE_ADDED ${spec.name}`);
      if (target?.offline) console.log(offlineWarn(target.machine, "source"));
      break;
    }
    case "schedule": {
      const [action, name, ...extra] = flags.positionals;
      const specs = new SourceSpecs(config.stateDir);
      const usage = "usage: dori schedule list [--json] | dori schedule add <name> (--cron EXPR | --every SEC) (--text T | --command CMD [--cwd DIR] [--machine M] [--heavy] [--timeout SEC]) --kind KIND [--tz ZONE] [--catch-up once|skip] | dori schedule remove <name> | dori schedule run-now <name>";
      if (extra.length) die(usage);
      const now = realClock.now();
      const find = (job: string): ScheduleSpec => {
        const spec = specs.list().find((s) => s.name === job);
        return spec?.type === "schedule" ? spec : die(`no schedule "${job}"`);
      };
      const at = (ms: number | undefined): string => (ms === undefined ? "never" : displayTime(ms, config.displayTimeZone, "short"));
      if (action === "list" && name === undefined) {
        const status = readSourceStatus(config.stateDir)?.sources ?? {};
        const rows = specs.list().filter((spec): spec is ScheduleSpec => spec.type === "schedule").map((spec) => scheduleRow(spec, status[spec.name], now));
        const offline = new Map<string, boolean | undefined>();
        for (const row of rows) if (row.machine && !offline.has(row.machine)) offline.set(row.machine, await runnerOffline(config.stateDir, row.machine));
        if (flags.values.json) console.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) console.log("SCHEDULES none");
        else for (const row of rows) console.log(`${row.name} ${row.kind} ${row.when}${row.heavy ? " heavy" : ""} catch-up=${row.catchUp} next=${row.waiting ? `waiting for a ${row.waiting}` : at(row.nextRunAt)} last=${at(row.lastRunAt)}${row.lastResult ? ` ${row.lastResult}` : ""}${row.machine ? ` machine=${row.machine}${offline.get(row.machine) ? " (runner offline)" : ""}` : ""}`);
        break;
      }
      if (action === "remove" && name) {
        find(name);
        specs.remove(name);
        console.log(`SCHEDULE_REMOVED ${name}`);
        break;
      }
      if (action === "run-now" && name) {
        find(name);
        queueRunNow(config.stateDir, name, now);
        console.log(`SCHEDULE_RUN_QUEUED ${name}; the supervisor runs it on its next pass`);
        break;
      }
      if (action !== "add" || !name) die(usage);
      const every = opt("every");
      const timeout = opt("timeout");
      const target = await machineOpt(config.stateDir);
      const spec = specs.add({
        name, type: "schedule", kind: need("kind"), since: now,
        ...(opt("cron") ? { cron: opt("cron") } : {}), ...(every !== undefined ? { everySec: Number(every) } : {}),
        ...(opt("text") !== undefined ? { text: opt("text") } : {}),
        ...(opt("command") !== undefined ? { command: commandArgv(opt("command")) } : {}),
        ...(opt("cwd") ? { cwd: opt("cwd") } : {}), ...(flags.values.heavy ? { heavy: true } : {}),
        ...(target ? { machine: target.machine } : {}),
        ...(timeout !== undefined ? { timeoutSec: Number(timeout) } : {}),
        ...(opt("tz") ? { tz: opt("tz") } : {}), ...(opt("catch-up") ? { catchUp: opt("catch-up") } : {}),
      });
      console.log(JSON.stringify(spec, null, 2));
      console.log(`SCHEDULE_ADDED ${spec.name} next ${at(spec.type === "schedule" ? nextSlot(spec, now) : undefined)}`);
      if (target?.offline) console.log(offlineWarn(target.machine, "schedule"));
      break;
    }
    case "supervise": {
      const controller = new AbortController();
      // A stop exits within SUPERVISE_STOP_DEADLINE_MS even when a shutdown step hangs, so systemd never waits out its
      // stop timeout (90 s by default) while the owner's clicks and messages have no process to reach.
      const stop = () => {
        if (controller.signal.aborted) return;
        controller.abort();
        setTimeout(() => {
          console.error(`SUPERVISOR_STOP_FORCED shutdown still running ${SUPERVISE_STOP_DEADLINE_MS} ms after the stop signal; exiting`);
          process.exit(0);
        }, SUPERVISE_STOP_DEADLINE_MS).unref();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // dori update runs the code it started with, so the supervisor it restarts installs the new checkout's sandbox.
      try { const line = refreshLaneSandbox(homedir()); if (line) console.log(line); }
      catch (e) { console.error(`WARN lane sandbox: ${e instanceof Error ? e.message : String(e)}`); }
      try { await supervise(deps, controller.signal, { configFile: configPath() }); }
      finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      // Shutdown is done: leftover timers, sockets or child pipes must not hold the process.
      console.log("SUPERVISOR_STOPPED");
      process.exit(0);
    }
    case "quota": {
      const read = await readUsage(lookupQuotaResults(), realClock.now(), AbortSignal.timeout(30_000));
      if (flags.values.json) console.log(JSON.stringify({ usage: read.usage ?? null }, null, 2));
      else console.log(`${read.usage ? usageLine(read.usage, config.displayTimeZone) : NO_CLAUDE}\n\n${read.text}`);
      break;
    }
    case "launch": {
      const mode = opt("mode");
      if (mode !== undefined && !(LANE_MODES as readonly string[]).includes(mode)) die(`--mode must be one of ${LANE_MODES.join(", ")}`);
      if (flags.values["no-sandbox"]) console.error("LAUNCH_NO_SANDBOX_REMOVED --no-sandbox was removed and is ignored: every lane runs in the sandbox unless its machine is opted in with runners.<label>.allowUnsandboxed");
      const sandbox = flags.values.sandbox ? (true as const) : undefined;
      if (flags.values["toodo-start"] !== undefined) die("LAUNCH_TOODO_START_REMOVED --toodo-start was removed: launch the lane with --cwd like any other and record the task in Toodo yourself over MCP");
      const fromArgs = (() => { try { return launchBriefArgs(rest); } catch (e) { return die(e instanceof Error ? e.message : String(e)); } })();
      const fromMessage = fromArgs.refs.length > 0;
      if (fromMessage === (flags.values.brief !== undefined)) die("launch needs exactly one of --brief FILE or --from-message <channel> <messageId> (repeatable)");
      if (!fromMessage && fromArgs.notes.length) die("--note goes with --from-message; with --brief put lead notes in the brief file");
      const title = need("title");
      const generated = fromMessage ? (() => {
        try {
          return { path: generatedBriefPath(config.stateDir, key ?? ""), text: assembleBrief(title, fromArgs.refs.map((ref) => ownerMessageText(config.stateDir, ref)), fromArgs.notes) };
        } catch (e) { return die(e instanceof Error ? e.message : String(e)); }
      })() : undefined;
      const input: LaunchInput = { key: key ?? "", title, brief: generated ? generated.path : need("brief"), done: need("done"), thread: await laneThreadRef(opt("thread"), config.discordChannels), model: opt("model"), ...(mode ? { mode: mode as LaneMode } : {}), cwd: opt("cwd"), pane: opt("pane"), workspace: opt("workspace"), machine: opt("machine"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]), ...(sandbox === undefined ? {} : { sandbox }) };
      await validateLaunch(deps, input);
      if (generated) writeGeneratedBrief(generated.path, generated.text);
      const reports = await placementReports(config.stateDir);
      const plan = await planLaunch(input, config.placement, (machine) => checkMachine(deps.ops, config, machine), reports);
      for (const line of plan.lines) console.log(line);
      const target = plan.check.machine;
      const machine = target === LOCAL_MACHINE ? undefined : target;
      // A remote launch without --cwd starts in the checkout its owning runner declared.
      const cwd = input.cwd ?? (machine && plan.placement.machine === target ? plan.placement.cwd : undefined);
      if (!machine && config.guard.panesMax <= 0) console.log(`LAUNCH_WARN guard.panesMax is ${config.guard.panesMax}: the pane-count limit is off, so nothing caps concurrent lanes; set guard.panesMax to re-enable it`);
      if (!plan.check.verdict.ok) {
        const repos = doneRepos(input.done);
        const queue = enqueueLaunch(config.stateDir, {
          key: input.key, title: input.title, done: input.done, brief: input.brief, queuedAt: new Date().toISOString(), reasons: [plan.check.verdict.reasons.join(" | ")],
          ...(cwd ? { cwd } : {}), ...(repos.length ? { repos } : {}), ...(input.thread ? { thread: input.thread } : {}), ...(input.model ? { model: input.model } : {}),
          ...(input.mode === "mass-ulw" ? { mode: input.mode } : {}),
          ...(machine ? { machine } : {}), ...(input.pane ? { pane: input.pane } : {}), ...(input.workspace ? { workspace: input.workspace } : {}),
        });
        console.log(verdictLine(target, plan.check.verdict));
        console.log(`QUEUED ${input.key} (${queue.length} waiting; dori hold list)`);
        process.exit(4);
      }
      // A refused sandbox and an allowed unsandboxed run both reach the owner on Discord (sandbox-notice.ts) before the exit.
      const r = await launchLane(deps, { ...input, machine, ...(cwd ? { cwd } : {}) }).catch(async (e: unknown) => {
        if (e instanceof SandboxRefusal) for (const line of await postSandboxNotice(deps, input, e.message)) console.error(line);
        throw e;
      });
      dequeueLaunch(config.stateDir, input.key);
      for (const note of r.notes) console.log(note);
      for (const line of await postSkippedNotices(deps, input, r.notes)) console.error(line);
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      const next = launchNextLine(r.lane.key, r.startup); if (next) console.log(next);
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "hold": {
      const [action, dropKey, ...extra] = flags.positionals;
      if (Object.keys(flags.values).length || extra.length || (action === "list" ? dropKey !== undefined : action !== "drop" || !dropKey)) die("usage: dori hold list | dori hold drop <key>");
      if (action === "list") console.log(JSON.stringify(launchQueue(config.stateDir), null, 2));
      else if (dequeueLaunch(config.stateDir, dropKey ?? "")) console.log(`HOLD_DROPPED ${dropKey}`);
      else die(`no queued launch "${dropKey}"`);
      break;
    }
    case "adopt": {
      if (opt("mode") !== undefined) die("--mode applies to launch only");
      const adoptInput = { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), pane: need("pane"), machine: opt("machine"), cwd: opt("cwd"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]) };
      await needSupervisor();
      const l = await adoptLane(deps, { ...adoptInput, thread: await laneThreadRef(opt("thread"), config.discordChannels) });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "sync": {
      await needSupervisor();
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      if (flags.values.full) {
        console.log("key | thread | pane | session | status");
        for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      } else {
        const counts = new Map<string, number>();
        for (const row of r.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
        const byStatus = [...counts].map(([status, count]) => `${status} ${count}`).join(", ");
        const unregisteredPanes = r.unregistered.length ? `: ${r.unregistered.map((row) => row.pane).join(" ")}` : "";
        console.log(`LANES ${r.rows.length}${byStatus ? ` (${byStatus})` : ""}; UNREGISTERED ${r.unregistered.length}${unregisteredPanes}; --full for the table`);
      }
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "claim-done": {
      // Inside a lane claim-done is lane mode's (a done report over the lane socket); the lead names the lane.
      const target = await lane(key ?? die("claim-done needs a lane key"));
      const evidence = need("evidence");
      await needSupervisor();
      console.log(await claimDone(deps, target, evidence));
      break;
    }
    case "lane": {
      const [action, laneKey, ...extra] = flags.positionals;
      if (action !== "status" || !laneKey || extra.length || Object.keys(flags.values).length) die("usage: dori lane status <key> (inside a lane: dori lane status)");
      const found = (await deps.registry.read(laneKey ?? "")) ?? die(`no registered lane "${laneKey}"`);
      console.log(JSON.stringify({ key: found.key, status: statusOf(found), objection: found.objection ?? null, claim: found.claim ?? null }, null, 2));
      break;
    }
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      const target = await lane(key ?? die("object-done needs a lane key"));
      await needSupervisor();
      console.log(await objectDone(deps, target, reasons));
      break;
    }
    case "ops": {
      const [action = "list", id, ...extra] = flags.positionals;
      const store = openOperations(config);
      try {
        if (action === "list" && id === undefined && !extra.length) {
          const states: OperationState[] | undefined = flags.values.all ? undefined : ["planned", "attempted", "failed", "ambiguous"];
          const ops = store.list({ ...(opt("lane") ? { lane: opt("lane") } : {}), ...(states ? { states } : {}) });
          if (flags.values.json) console.log(JSON.stringify(ops, null, 2));
          else console.log(ops.length ? ops.map(operationLine).join("\n") : "OPS none");
          break;
        }
        const as = opt("as");
        if (action !== "resolve" || !id || extra.length || (as !== "verified" && as !== "retry")) die("usage: dori ops [list] [--lane KEY] [--all] [--json] | dori ops resolve <id> --as verified|retry");
        const op = store.get(id ?? "");
        if (!op) die(`no operation "${id}"`);
        if (op?.state !== "ambiguous" && op?.state !== "failed") die(`operation ${id} is ${op?.state}; only an ambiguous or failed operation is resolved by hand`);
        const done = settleOperation(store, realClock.now(), id ?? "", as === "verified" ? "verified" : "planned",
          as === "verified" ? "resolved by the lead: the effect is in place" : "resolved by the lead: the effect did not happen; may retry");
        if (done) console.log(operationLine(done));
        console.log(op?.action === SCHEDULE_ACTION ? `OPS_RESOLVED ${id}${as === "retry" ? "; the supervisor runs it again on its next pass" : ""}`
          : `OPS_RESOLVED ${id}; run dori close ${op?.lane} to finish its close`);
      } finally { store.close(); }
      break;
    }
    case "close": {
      let cancelled: { reason: string } | undefined;
      if (!flags.values.cancelled && flags.values.reason !== undefined) {
        die("--reason goes with --cancelled: dori close <key> --cancelled --reason TEXT");
      }
      if (flags.values.cancelled) {
        const reasons = (Array.isArray(flags.values.reason) ? flags.values.reason : []).filter((r): r is string => typeof r === "string" && r.trim() !== "");
        if (!reasons.length) die("usage: dori close <key> --cancelled --reason TEXT [--force]");
        cancelled = { reason: reasons.map((r) => r.trim()).join("; ") };
      }
      const note = opt("note") ?? (cancelled ? `cancelled: ${cancelled.reason}` : "closed by the lead");
      const target = await lane(key ?? die("close needs a lane key"));
      await needSupervisor();
      const r = await closeLane(deps, target, note, { force: Boolean(flags.values.force), ...(cancelled ? { cancelled } : {}) });
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "pause":
    case "resume": {
      const act = command === "pause" ? pauseLane : resumeLane;
      const target = await lane(key ?? die(`${command} needs a lane key`));
      await needSupervisor();
      const r = await act(deps, target, opt("note") ?? `${command}d by the lead`);
      for (const line of r.lines) console.log(line);
      process.exit(r.code);
    }
    case "watch": {
      let lastWatchWarnings = new Set<string>();
      console.log("LANE_WATCH_READY");
      for (;;) {
        const lines = await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`]);
        const warnings = new Set(lines.filter((line) => line.startsWith("LANE_WATCH_WARN ")));
        for (const line of lines) {
          if (!warnings.has(line) || !lastWatchWarnings.has(line)) console.log(line);
        }
        lastWatchWarnings = warnings;
        await Bun.sleep(30_000);
      }
    }
    case "freshness":
      // A one-shot run fails closed with the supervisor down; a loop warns per pass and retries (D7).
      if (loopMin <= 0) await needSupervisor();
      await every(loopMin, async () => {
        const reports = openLaneReports(deps.config);
        try {
          for (const a of await freshnessTick(deps, undefined, reports)) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
        } finally { reports.close(); }
      });
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      const paneState = newDeadPaneState();
      if (loopMin <= 0) await needSupervisor();
      await every(loopMin, async () => {
        for (const line of await deadPaneTick(deps.ops, config, seen, new Date().toISOString().slice(0, 13), paneState, await deps.registry.open())) console.log(line);
      });
      break;
    }
    case "guard": {
      if (key === "machines" || key === "install") {
        die(`GUARD_REMOVED dori guard ${key} is gone: each worker's runner reports its host now (dori status shows the readings); dori update removes old agents`, 2);
      }
      // The lead host's load, memory, disk and pane count as the local runner samples them (q.machine.observe); the
      // lanes-by-memory detail is the supervisor's (from guard.sample), not this loop's.
      const state = { alerting: false };
      if (loopMin <= 0) await needSupervisor();
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        const observed = await deps.ops.observeMachine();
        for (const line of guardTick(observed.sample, config.guard, state)) console.log(line);
      });
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
      // One slot directory per host (D17), shared with the lanes' `dori heavy` and the supervisor's scheduled heavy jobs.
      const load = async () => loadavg()[0] ?? 0;
      const slot = await acquireSlot({ dir: heavyDirOf(), slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "can-launch": {
      const listed = flags.values.all ? await listGuardMachines(run, config.guardMachines, config.stateDir) : [];
      const reports = flags.values.all ? [] : await placementReports(config.stateDir);
      const input = { machine: opt("machine"), cwd: opt("cwd"), done: opt("done") ?? "" };
      const p = flags.values.all ? undefined : resolvePlacement(input, config.placement, reports);
      const machines = p ? [p.machine] : [LOCAL_MACHINE, ...listed.map((m) => m.label)];
      // An offline owning runner holds the launch without observing anything, and several declaring runners are picked
      // among exactly as a launch would: both through planLaunch.
      const planned = p && (p.online === false || p.candidates) ? await planLaunch(input, config.placement, (m) => checkMachine(deps.ops, config, m), reports) : undefined;
      for (const line of planned?.lines.filter((l) => l.startsWith("PLACEMENT_CANDIDATES ")) ?? []) console.error(line);
      const checks = planned ? [planned.check] : await Promise.all(machines.map((m) => checkMachine(deps.ops, config, m)));
      const at = Date.now();
      for (const c of checks) {
        recordLaunchVerdict(config.stateDir, c.verdict, at, c.machine);
        console.log(verdictLine(c.machine, c.verdict));
      }
      process.exit(checks.every((c) => c.verdict.ok) ? 0 : 4);
    }
    case "placement": {
      if (flags.positionals.length) die("usage: dori placement [--repo owner/repo] [--cwd D] [--done \"...\"] [--json]", 2);
      const reports = await placementReports(config.stateDir);
      const repo = opt("repo");
      if (repo === undefined && opt("cwd") === undefined && opt("done") === undefined) {
        if (flags.values.json) console.log(JSON.stringify({ runners: reports, defaultMachine: config.placement.defaultMachine, fallback: config.placement.fallback }, null, 2));
        else for (const line of placementTable(reports, config.placement)) console.log(line);
        process.exit(0);
      }
      // --repo reads as a Done line naming that repo, so it matches exactly what a launch with that repo would.
      const done = [opt("done"), repo ? `merged ${repo}#0` : undefined].filter(Boolean).join("; ");
      const p = resolvePlacement({ cwd: opt("cwd"), done }, config.placement, reports);
      if (flags.values.json) console.log(JSON.stringify(p));
      else {
        console.log(placementLine(p));
        // Without checking room, the preferred candidate (online, defaultMachine first) stands for the pick.
        if (p.candidates) console.log(candidatesLine(p, p.online === false ? "none" : p.machine));
        if (p.online === false) console.log(`HOLD machine=${p.machine} runner ${p.machine} that owns ${p.rule} is offline; the launch waits for it`);
      }
      process.exit(0);
    }
    case "memory": {
      if (key !== "check" || flags.positionals.length > 1 || Object.keys(flags.values).length) die("usage: dori memory check", 2);
      try {
        const report = await checkMemory(deps, process.env.HOME ?? "");
        console.log(renderMemoryReport(report));
        process.exit(needsAction(report) ? 1 : 0);
      } catch (e) {
        if (e instanceof MemoryCheckError) die(`MEMORY_CHECK_ERROR ${e.message}`, 2);
        throw e;
      }
    }
    case "event": {
      // `dori event trace <id> [--json]`: enqueued -> delivered -> taken -> acked/handled or reported (event-trace.ts).
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
      const [action, id, ...extra] = parsed.positionals;
      if (action !== "trace" || !id || extra.length) die("usage: dori event trace <eventId> [--json]");
      const { buildTrace, loadTrace, traceText } = await import("./event-trace.ts");
      const sources = loadTrace(config.stateDir, id ?? "");
      if (!sources) die(`EVENT_TRACE_UNAVAILABLE the journal store in ${config.stateDir} cannot be read`, 2);
      const trace = sources && buildTrace(id ?? "", sources);
      if (!trace) die(`EVENT_NOT_FOUND ${id}: no journaled, pruned or delivered event has this id`);
      else if (parsed.values.json) console.log(JSON.stringify(trace));
      else for (const line of traceText(trace)) console.log(line);
      break;
    }
    case "inbox": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { "max-bytes": { type: "string" }, peek: { type: "boolean" } } });
      const raw = parsed.values["max-bytes"];
      const maxBytes = raw === undefined ? BUILT_IN.delivery.push.takeMaxBytes : Number(raw);
      if (parsed.positionals.join(" ") !== "take" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) die("usage: dori inbox take [--max-bytes N (positive integer)] [--peek]");
      try {
        const result = take(config.stateDir, { maxBytes, peek: parsed.values.peek === true, now: realClock.now(), session: process.env.PI_SESSION_ID });
        // What the last cold start carried over, finished lanes still owed to the owner and open decisions are listed every
        // time, before the INBOX_MORE / INBOX_EMPTY sentinel.
        const { takeReminders } = await import("./lane-outcomes.ts");
        const { takeDecisionReminders } = await import("./decision-obligations.ts");
        const lines = takeOutput(result);
        const sentinel = /^INBOX_(MORE|EMPTY)\b/.test(lines.at(-1) ?? "") ? lines.splice(-1) : [];
        const reminders = [...takeCarriedReminders(config.stateDir, new Set(result.events.map((event) => event.id))), ...takeReminders(config.stateDir), ...takeDecisionReminders(config.stateDir)];
        // Owner chat mixed with lane outcomes: one checklist line first, so answering the chat cannot hide the report owed.
        const checklist = checklistLine([...result.events.map((event) => `${event.id}\t${event.line}`), ...reminders]);
        // Messages parked on the owner's answer are information, not work: listed last and kept out of the checklist.
        for (const line of [...(checklist ? [checklist] : []), ...lines, ...reminders, ...takeAwaitingReminders(config.stateDir), ...sentinel]) console.log(line);
      } catch (e) {
        if (e instanceof InboxError) die(e.message, 2);
        throw e;
      }
      break;
    }
    case "ack": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { tasks: { type: "string" } } });
      // Each message is named explicitly as a <channel> <messageId> pair; --tasks applies to one message only.
      const pairs = parsed.positionals;
      if (!pairs.length || pairs.length % 2 || (pairs.length > 2 && parsed.values.tasks !== undefined)) {
        die("usage: dori ack <channel> <messageId> [<channel> <messageId> ...] [--tasks N, one message only]");
      }
      const tasks = parsed.values.tasks === undefined ? undefined : Number(parsed.values.tasks);
      let discord: Discord | undefined;
      for (let i = 0; i < pairs.length; i += 2) {
        const [channel = "", message = ""] = [pairs[i], pairs[i + 1]];
        discord ??= new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`));
        await ack(config.stateDir, discord, channel, message, realClock.now(), tasks);
        console.log(`ACKED ${channel} ${message}`);
      }
      // Read-only: unread owner events in the acked channels, so follow-ups are seen before the reply. Never fails the ack.
      const acked: { channel: string; message: string }[] = [];
      for (let i = 0; i < pairs.length; i += 2) acked.push({ channel: pairs[i] ?? "", message: pairs[i + 1] ?? "" });
      for (const line of unreadAfterAck(config.stateDir, acked)) console.log(line);
      break;
    }
    case "report":
      // A report is the lane's own voice, sent by its runner over the lane socket (lane mode); the lead has no lane to
      // report as.
      die(`DORI_CLI_LANE_COMMAND dori report${flags.positionals[0] === "ack" ? " ack" : ""} runs only inside a lane (DORI_LANE_KEY, or a pane its runner knows)`, 2);
      break;
    case "reported": {
      // `dori reported <key> --text T`: post lane <key>'s outcome to the owner (the lane's thread unless --to/--thread),
      // then record the receipt. A failed post records nothing, so the obligation stays open.
      const { recordReported } = await import("./lane-outcomes.ts");
      const options = ["text", "append", "to", "thread", "note"];
      const final = flags.values.final === true;
      const append = opt("append");
      if (!key || flags.positionals.length > 1 || Object.keys(flags.values).some((name) => !options.includes(name) && name !== "final") || options.some((name) => name in flags.values && !opt(name))
        || !opt("text") === (append === undefined) || (append !== undefined && (final || "to" in flags.values || "thread" in flags.values))) {
        die("usage: dori reported <key> --text TEXT [--final] [--to TARGET] [--thread ID] [--note TEXT] | dori reported <key> --append TEXT [--note TEXT]");
      }
      const found = (await deps.registry.read(key ?? "")) ?? die(`no registered lane "${key}"`);
      const followUps = await import("./thread-followup.ts");
      const discord = new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN"));
      const owner = config.discordChannels[0];
      const note = opt("note");
      const receipt = (posted: { message: string; target: string; thread?: string; button?: boolean; followUp?: boolean }): void => {
        recordReported(config.stateDir, found.key, realClock.now(), note ? oneLine(note) : undefined, posted);
      };
      // A thread the owner closed is never posted into: one line linking it goes to its parent channel (else the owner
      // channel), and the thread stays archived.
      const redirect = async (thread: string, text: string, parent: string | undefined): Promise<void> => {
        const target = parent ?? owner;
        if (!target) die(`REPORT_NOT_POSTED ${found.key}: thread ${thread} was closed by the owner, its parent channel is unknown and no discordChannels entry names the owner channel; nothing recorded`);
        const message = await discord.send(target ?? "", followUps.closedThreadLine(thread, text), randomUUID());
        receipt({ message, target: `discord:${target}`, followUp: true });
        console.log(`REPORT_REDIRECTED ${found.key} ${message}: thread ${thread} was closed by the owner, so one line linking it went to ${parent ? "its parent channel" : "the owner channel"} ${target}`);
      };
      if (append !== undefined) {
        // The follow-up edits the lane's last report (else its [System] status message): nothing new lands in the thread.
        const status = found.statusMessageId && found.thread.startsWith("discord:") ? { channel: resolveTarget("discord", found.thread).to, message: found.statusMessageId } : undefined;
        const last = followUps.readLastReports(config.stateDir)[found.key] ?? status
          ?? die(`REPORT_APPEND_NO_MESSAGE ${found.key}: this lane has no report or status message to append to; post the report with --text`);
        const closed = await followUps.closedByOwner(config.stateDir, discord, last.channel);
        if (closed) { await redirect(last.channel, append, closed.parent); break; }
        const archived = await discord.threadArchived(last.channel).catch(() => false);
        if (!(await followUps.appendToMessage(discord, last.channel, last.message, append, archived))) {
          die(`REPORT_APPEND_TOO_LONG ${found.key}: the report with this text would pass Discord's message limit; shorten it, or post a new report with --text`);
        }
        receipt({ message: last.message, target: `discord:${last.channel}`, followUp: true });
        console.log(`REPORT_APPENDED ${found.key} ${last.message}`);
        break;
      }
      const bound = found.thread && found.thread !== "none" ? found.thread : undefined;
      const ref = opt("to") ?? bound ?? die(`lane ${key} has no bound thread; name where to post with --to TARGET (a thread ref such as discord:<channel>/<thread>)`);
      // A Discord ref posts there; a bare --to id posts on Discord only when the lane's bound thread is a Discord one.
      const isDiscord = (r: string | undefined): boolean => r?.startsWith("discord:") === true;
      if (!isDiscord(ref) && (ref.includes(":") || !isDiscord(bound))) die(`cannot tell the platform of "${ref}"; use a thread ref such as discord:<channel>/<thread>`);
      const platform = "discord";
      const { to, thread } = resolveTarget(platform, ref, opt("thread"));
      // Only a --final report posted into a thread with nothing left on it carries the owner's close-thread button
      // (handled by `dori supervise`); otherwise it posts without one. `dori supervise` also posts the button itself once
      // the thread's work is finished and reported, so one it posted after this lane closed withholds this one.
      const { finalityBlockers, readCloseButtons } = await import("./thread-finality.ts");
      // `discord:<thread>` and a bare thread id count as a thread too, unless the id is a configured channel.
      const threadId = opt("thread") ?? discordThreadOf(ref, config.discordChannels);
      const closed = threadId === to ? await followUps.closedByOwner(config.stateDir, discord, to) : undefined;
      if (closed) { await redirect(to, opt("text") ?? "", closed.parent); break; }
      let withheld: string[] = [];
      if (final) {
        const { publishedDecisions } = await import("./decision-obligations.ts");
        withheld = threadId !== to ? ["the report is not posted into a thread"] : finalityBlockers({
          lane: found, thread: to, open: await deps.registry.open(), waits: new Waits(config.stateDir).list(), decisions: publishedDecisions(config.stateDir),
        });
        const posted = readCloseButtons(config.stateDir)[to];
        if (!withheld.length && posted !== undefined && found.closedAt && posted >= Date.parse(found.closedAt)) withheld = ["the close button is already posted on this thread"];
      }
      const button = final && !withheld.length;
      const message = await postMessage(to, opt("text") ?? "", button ? closeThreadButton(to) : undefined);
      if (!message) die(`REPORT_NOT_POSTED ${key}: ${platform} returned no message id; nothing recorded`);
      if (withheld.length) console.log(`REPORT_BUTTON_WITHHELD ${found.key}: ${withheld.join("; ")}`);
      // The message a later --append edits.
      if (threadId === to) followUps.recordLastReport(config.stateDir, found.key, { channel: to, message, at: realClock.now() });
      // The lane's thread for the supervisor's close-button check: the thread that got this report's button, else its bound
      // thread, else the thread this report went into.
      const laneThread = button ? to : (bound && isDiscord(bound) ? discordThreadOf(bound, config.discordChannels) : undefined) ?? (threadId === to ? to : undefined);
      receipt({
        message, target: `${platform}:${to}${thread ? `/${thread}` : ""}`, ...(laneThread ? { thread: laneThread } : {}), ...(button ? { button } : {}),
      });
      console.log(`REPORTED_RECORDED ${found.key} ${message}`);
      break;
    }
    case "resolved": {
      // `dori resolved <eventId> [...] [--note T]`: the lead has decided these decision events (decision-obligations.ts). An
      // id with no open obligation is still recorded (its event may not have arrived yet) and named as unmatched.
      const { publishedDecisions, recordResolved, validEventId } = await import("./decision-obligations.ts");
      const ids = flags.positionals;
      if (!ids.length || !ids.every(validEventId) || Object.keys(flags.values).some((name) => name !== "note") || ("note" in flags.values && !opt("note"))) {
        die("usage: dori resolved <eventId> [<eventId> ...] [--note TEXT]");
      }
      const open = new Set(publishedDecisions(config.stateDir).map((item) => item.id));
      const note = opt("note");
      const at = realClock.now();
      for (const id of ids) recordResolved(config.stateDir, id, at, note ? oneLine(note) : undefined);
      for (const id of ids) console.log(open.has(id) ? `RESOLVED_RECORDED ${id}` : `RESOLVED_UNMATCHED ${id}: no open decision has this id; recorded anyway`);
      break;
    }
    case "handled": {
      const parsed = parseArgs({
        args: rest, allowPositionals: true,
        options: {
          lane: { type: "string", multiple: true }, reply: { type: "boolean" }, all: { type: "boolean" }, tasks: { type: "string" },
          awaiting: { type: "boolean" }, note: { type: "string" },
        },
      });
      const [channel, message, ...extra] = parsed.positionals;
      if (!channel || !message || extra.length) die("usage: dori handled <channel> <messageId> [--tasks N] [--lane key ...] [--reply] [--all] [--awaiting [--note TEXT]]");
      for (const key of parsed.values.lane ?? []) {
        if (!(await deps.registry.read(key))) die(`no registered lane "${key}"`);
      }
      const reply = parsed.values.reply === true;
      recordHandled(config.stateDir, channel ?? "", message ?? "", realClock.now(), {
        tasks: parsed.values.tasks === undefined ? undefined : Number(parsed.values.tasks),
        lanes: parsed.values.lane, reply, ...(parsed.values.all ? { all: true } : {}),
        ...(parsed.values.awaiting ? { awaiting: true } : {}),
        ...(parsed.values.note !== undefined ? { note: oneLine(parsed.values.note).slice(0, AWAITING_NOTE_MAX) } : {}),
      });
      console.log(parsed.values.awaiting ? `HANDLED_AWAITING ${channel} ${message}` : `HANDLED_LINKED ${channel} ${message}`);
      break;
    }
    case "send": {
      const platform = key ?? "discord";
      if (platform !== "discord") die(`unknown platform ${platform}`);
      // `--to alerts`: the system-notice channel (config alertsChannel, else the main channel), read from the config now.
      const target = need("to");
      const ref = target === "alerts" ? alertsChannelOf(config) ?? die("SEND_NOT_POSTED --to alerts: neither alertsChannel nor discordChannels is configured") : target;
      const { to } = resolveTarget("discord", ref, opt("thread"));
      const text = need("text");
      const edit = opt("edit");
      const buttons = opt("buttons");
      if (buttons !== undefined && edit) die("--buttons cannot be used with --edit");
      let components: unknown[] | undefined;
      try { components = buttons === undefined ? undefined : buttonRow(buttons); } catch (e) { die(e instanceof Error ? e.message : String(e)); }
      if (!edit) {
        if (flags.values.force !== true) {
          const stale = staleOwnerEvents(config.stateDir, to);
          if (stale.count) {
            console.log(`SEND_STALE ${stale.count}`);
            for (const line of stale.lines) console.log(line);
            process.exit(3);
          }
        }
      }
      const discord = new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN"));
      const { closedByOwner, closedThreadLine } = await import("./thread-followup.ts");
      // A thread the owner closed is never posted into (a post would reopen it): one line linking it goes to its parent
      // channel, else the owner channel.
      const closed = await closedByOwner(config.stateDir, discord, to);
      if (closed) {
        const target = closed.parent ?? config.discordChannels[0]
          ?? die(`SEND_NOT_POSTED thread ${to} was closed by the owner, its parent channel is unknown and no discordChannels entry names the owner channel`);
        const sent = await discord.send(target, closedThreadLine(to, text), randomUUID(), components);
        console.log(`SENT_REDIRECTED ${sent}: thread ${to} was closed by the owner, so one line linking it went to ${closed.parent ? "its parent channel" : "the owner channel"} ${target}`);
        break;
      }
      if (!edit) {
        const sent = await postMessage(to, text, components);
        console.log(`SENT ${sent}`);
      } else await discord.edit(to, edit, text);
      break;
    }
    case "thread": {
      // `dori thread [discord] --to CHANNEL [--message ID] --name NAME`: start a thread (on a message, else standalone) and
      // make discord.ownerId a member. The thread ref is printed either way; a failed add prints THREAD_OWNER_FAILED and exits 1.
      if ((key ?? "discord") !== "discord") die(`unknown platform ${key}`);
      if (flags.positionals.length > 1 || Object.keys(flags.values).some((name) => !["to", "message", "name"].includes(name))) {
        die("usage: dori thread [discord] --to CHANNEL [--message ID] --name NAME");
      }
      const { to } = resolveTarget("discord", need("to"));
      const owner = config.discord?.ownerId;
      if (!discordOwnerConfigured(owner)) console.error("THREAD_OWNER_SKIPPED discord.ownerId is not configured; the thread is created without adding the owner");
      const { id, member } = await new Discord(fetchHttp, realClock, messengerToken("DORI_DISCORD_TOKEN")).startThread(to, opt("message"), need("name"), discordOwnerConfigured(owner) ? owner : undefined);
      console.log(`THREAD discord:${to}/${id}`);
      if (member === "added") console.log(`THREAD_OWNER_ADDED ${id}`);
      else if (member === "already") console.log(`THREAD_OWNER_ALREADY_MEMBER ${id}: Discord joined the owner as the thread started (the starter message mentions them), so no "added" line shows`);
      else if (member !== "skipped") {
        console.log(`THREAD_OWNER_FAILED ${id} ${owner}: ${member.failed}`);
        process.exitCode = 1;
      }
      break;
    }
    case "typing": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { off: { type: "boolean" } } });
      const [target, ...extra] = parsed.positionals;
      const on = parsed.values.off !== true;
      const channel = target === "discord" ? extra[0] : target;
      if (channel && extra.length === (target === "discord" ? 1 : 0) && on) {
        const { to, thread } = resolveTarget("discord", channel);
        const id = thread ?? to;
        const dc = new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`));
        await dc.typing(id);
        console.log(`TYPING discord ${id} on`);
      } else die("usage: dori typing [discord] <channel>");
      break;
    }
    case "presence": {
      if ((key ?? "discord") === "discord") {
        const token = resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`);
        const release = acquireDiscordGateway(token);
        let presence: ReturnType<typeof discordPresence> | undefined;
        try {
          if (!config.discord) console.warn("PRESENCE_WARNING discord slash commands skipped: config.discord is missing; run dori setup");
          const commands = config.discord ? new DiscordCommands(fetchHttp, token, config.discord, quotaReport(lookupQuotaResults()), undefined, config.discordChannels, lookupStatus({ ...deps, runnerDir: defaultRunnerDir() })) : undefined;
          await commands?.register();
          presence = discordPresence(openDiscordGateway, token, realTimers, commands ? (data) => commands.handle(data) : undefined);
          console.log("PRESENCE_READY discord");
          await new Promise<void>((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
          });
        } finally {
          presence?.close();
          await presence?.settled();
          release();
        }
      } else die(`unknown platform ${key}`);
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  // The supervisor (and with it every runner) is unreachable, or a runner answered RUNNER_UNAVAILABLE: fail closed (D7).
  if (e instanceof RunnerUnavailable || (e instanceof LaneOpsError && e.code === "RUNNER_UNAVAILABLE")) die(e.message, 2);
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof ReposError || e instanceof DiscordGatewayOwnedError || e instanceof AckError || e instanceof LeadRestartError || e instanceof StoreError || e instanceof LaneMessageError || e instanceof SourceError) die(e.message);
  throw e;
}
