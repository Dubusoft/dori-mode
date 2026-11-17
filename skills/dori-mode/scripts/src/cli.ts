#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, loadavg, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configPath, loadConfig } from "./config.ts";
import { envFilePath, resolveCredential } from "./credentials.ts";
import { withThreadParent } from "./messenger/target.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { displayTime } from "./display-time.ts";
import { claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive } from "./heavy-slot.ts";
import { watchSimulators } from "./heavy-simulators.ts";
import { guardTick } from "./host-guard.ts";
import { listGuardMachines } from "./remote-guard.ts";
import { adoptLane, attachLaneFiles, type LaunchInput, launchNextLine, LaunchError, parseLaneTask, validateLaunch } from "./launch.ts";
import { admitLaunch, placeLaunch, placementReports } from "./launch-service.ts";
import { assembleBrief, generatedBriefPath, launchBriefArgs, linkLaunchMessages, ownerMessageText, writeGeneratedBrief } from "./brief-from-message.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { LANE_MODES, type LaneMode, Registry, statusOf } from "./registry.ts";
import { Repos, ReposError } from "./repos.ts";
import { realClock, run, setDefaultRunTimeout } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { dequeueLaunch, launchQueue, recordLaunchVerdict } from "./routing.ts";
import {
  candidatesLine, checkMachine, LOCAL_MACHINE, placementLine, placementTable, planLaunch, resolvePlacement, verdictLine,
} from "./placement.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Discord } from "./messenger/discord.ts";
import { discordPresence, openDiscordGateway } from "./messenger/discord-gateway.ts";
import { acquireDiscordGateway, DiscordGatewayOwnedError } from "./messenger/discord-lock.ts";
import { DiscordCommands } from "./messenger/discord-commands.ts";
import { discordThread } from "./messenger/discord-inbound.ts";
import { NO_CLAUDE, quotaProvidersFor, quotaReport, readUsage, skippedText, usageLine } from "./claude-quota.ts";
import { sharedQuotaLookup } from "./quota-cache.ts";
import { cacheNoteLines } from "./quota-presentation.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { supervise, SUPERVISE_STOP_DEADLINE_MS, watchSecretStore } from "./supervise-loop.ts";
import { SecretStore, SecretStoreError } from "./secret-store.ts";
import { lookupStatus } from "./status.ts";
import { Waits } from "./waits.ts";
import { requestLeadRestart } from "./lead-restart.ts";
import { recoverLanes } from "./recover.ts";
import { AckError } from "./ack.ts";
import { checklistLine, InboxError, take, takeAwaitingReminders, takeCarriedReminders, takeOutput } from "./inbox.ts";
import { checkMemory, MemoryCheckError, needsAction, renderMemoryReport } from "./memory-check.ts";
import { StoreError } from "./store.ts";
import { convertJsonState } from "./store-convert.ts";
import { openOperations, operationLine, type OperationState, settleOperation } from "./operations.ts";
import { LaneMessageError } from "./lane-messages.ts";
import { oneLine, openLaneReports } from "./lane-report-store.ts";
import { publicSpec, queueEmit, readSourceStatus, SourceError, SourceSpecs, sourceViews } from "./event-sources.ts";
import { nextSlot, queueRunNow, SCHEDULE_ACTION, scheduleRow, type ScheduleSpec } from "./schedule.ts";
import { updateInstall } from "./update.ts";
import { writeUpdateResult } from "./auto-update.ts";
import { refreshBootPrep } from "./boot-prep-install.ts";
import { refreshLaneSandbox } from "./lane-sandbox-install.ts";
import { laneOps, type LaneOps, LaneOpsError } from "./lane-ops.ts";
import { type CliRunnerCall, cliRunnerCall, cliSocketPath } from "./runner/cli-relay.ts";
import { RunnerUnavailable } from "./runner/call.ts";
import { defaultRunnerDir, RUNNER_PATHS } from "./runner/fs-safety.ts";
import { heavyDirOf, laneCliMain } from "./runner/lane-cli.ts";
import { connectLaneSocket } from "./runner/lane-socket.ts";
import { resolveLaneContext } from "./runner/lane-identity.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import type { Connector } from "./runner/transport.ts";
import { connectUnix } from "./runner/unix-transport.ts";
import { BUILT_IN } from "./tunables.ts";

/** The lane-mode gate's answer: a pane whose lane cannot be told (resolveLaneContext) exits 2 LANE_IDENTITY_UNKNOWN. */
const laneContext = async (env: Readonly<Record<string, string | undefined>>, runnerDir: string, connect: Connector): Promise<string | undefined> => {
  const resolved = await resolveLaneContext(env, runnerDir, connect);
  if (typeof resolved !== "object") return resolved;
  const { pane, recorded } = resolved;
  console.error(`LANE_IDENTITY_UNKNOWN pane ${pane}: the runner's lane socket did not answer and its lane record cannot be read (${recorded.detail}); dori will not run as the lead from a pane that may be a lane. Bring the runner back (its lane socket answers whoami) or repair the lane record.`);
  process.exit(2);
};

// The lane-mode gate runs before anything else (help, setup, runner *, loadConfig): inside a lane dori takes only
// report, claim-done, report ack, lane status, heavy and secret env, all over the runner's lane socket, and opens no registry,
// store, journal, inbox or state-dir file.
{
  const laneRunnerDir = defaultRunnerDir();
  const connectLane = connectLaneSocket(laneRunnerDir, (path) => connectUnix(path));
  const laneKey = await laneContext(process.env, laneRunnerDir, connectLane);
  if (laneKey !== undefined) {
    process.exit(await laneCliMain(process.argv.slice(2), {
      env: process.env, laneKey, connect: connectLane,
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
                                       then "## Lead notes" with each --note as a bullet; written to <stateDir>/briefs/<key>.md; a deleted, visitor or unknown message exits 1;
                                       once launched, each message is recorded as dori handled <channel> <messageId> --lane <key> (HANDLED_LINKED)
                [--no-handled]   with --from-message: link no message (a question-only message you park with dori handled --awaiting)
                [--mode ulw|mass-ulw]   ulw (default): clear, contained work; mass-ulw: wide changes or vague instructions that need investigation
                [--task ID]   the Toodo task the lane works on (a positive integer, not looked up), recorded on the lane and shown by status;
                                       an autopilot lane gets its reservation's task without it
                [--share-thread] [--allow-repo-mismatch]   refused when another open lane has the thread or the git checkout, or cwd's repo is not in Done
                [--grant NAME]   repeatable: a named path grant from the lane's runner's runner-config.json grants table (write/read paths the sandbox opens
                                       for this lane only; the hide list still wins); an unknown name, an unsandboxed lane or an older runner refuses the launch
                [--sandbox]   every lane runs in the sandbox (--sandbox is accepted and changes nothing): a local one (--pane too) in laneSandbox.command after a --check preflight, a --machine one under its runner's sandboxed profile; a missing or broken sandbox refuses the launch (SANDBOX_MISSING / SANDBOX_BROKEN / SANDBOX_UNAVAILABLE) and warns on Discord; only Windows runners (no lane sandbox exists there) and machines opted in with runners.<label>.allowUnsandboxed run unsandboxed, with SANDBOX_SKIPPED and a Discord warning each time
                HOLD (exit 4) on host limits queues the launch in launch-hold.json until it launches or is dropped
                [--machine LABEL-OR-ID] [--pane ID | --workspace ID]   target a saved machine; run in an existing idle shell pane instead of a new tab; cwd defaults to the pane's
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--cwd DIR] [--machine LABEL-OR-ID] [--share-thread] [--allow-repo-mismatch]   with --machine, --cwd is the remote directory
  hold list | hold drop <key>          the launches waiting after a HOLD (JSON), or drop one
  autopilot candidates [--tasks 12,13] [--json]
                                       lead-only, read-only: judge every planned toodo task marked for autopilot, plus --tasks
                                       (LAUNCH/HOLD/REFUSE with reasons, LAUNCH capped by the host's free slots); the supervisor
                                       runs the same every autopilot.tickSec (autopilot is always on; pause is the only stop)
  autopilot launch <taskId> [--launched <laneKey> | --failed | --ambiguous] [--note TEXT]
                                       lead-only, under a lock: re-judge the task and on LAUNCH reserve attempt <n> as lane
                                       ap-<taskId>-<n> (planned ledger row; exit 1 with the verdict otherwise); a settle flag closes
                                       the reservation as launched, failed or ambiguous (never retried by itself); a reserve
                                       refuses while autopilot is paused
  autopilot pause [--reason TEXT] | autopilot resume
                                       lead-only: stop new autopilot reservations and AUTOPILOT_READY wakes until resume (running
                                       lanes go on to claim); kept in <stateDir>/autopilot-pause.json
  merge pause --reason TEXT | merge resume | merge status
                                       lead-only rollback: the supervisor makes no gh pr merge (exempt PRs and merge lanes too)
                                       until resume; reviews go on, waiting lanes stay held, status lines show "merge paused: <reason>";
                                       after resume merges pass the full review gate again; kept in <stateDir>/review-merge-pause.json
  review audit [--json]                read-only audit of the stored review history (jobs, exemptions, merges): exit 1 when a violation exists; --json prints it
  sync   [--write] [--full]            registry vs live panes: summary and drift (--full adds the table); read-only unless --write
  recover [key]                        recover missing or wrong-model working lane panes
  attach <key> <path> [<path> ...]    add lead files or directories under the attachment roots to a running lane's briefs/<key>.files
                                       (local or remote, launch caps and checks); prints the path the lane reads each at; tell the lane
  claim-done <key> --evidence TEXT    inside a lane: its own key only, as a done report through its runner; the lead names any lane
  object-done <key> --reason TEXT [--reason TEXT ...]
  lane status [<key>]                  a lane's status, its last objection's reasons and its done claim (JSON); inside a lane its own (from its runner), the lead names the lane
  ops [list] [--lane KEY] [--all] [--json]   operation rows: open, failed and ambiguous ones; --all adds verified
  ops resolve <id> --as verified|retry  the lead's answer for an ambiguous or failed operation after checking the world by hand
  close  <key> [--note TEXT] [--force] close now (Done signals must read back live; unpushed, uncommitted or untracked work refuses unless --force)
  close  <key> --cancelled --reason TEXT [--force]   lead-only: close a lane whose work was cancelled or whose Done can never hold;
                                       Done signals are not checked, the lane is recorded closed as cancelled with the reason
                                       inside a lane (DORI_LANE_KEY, or a pane its runner knows) dori takes only report, claim-done, report ack,
                                       lane status, heavy, secret env and secret run (alias host <op>) (anything else: DORI_CLI_LANE_ONLY, exit 2); lane commands of the lead need the
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
  wait <key> --until SIGNAL --note TEXT [--thread REF] [--every SEC] [--timeout MIN] [--on-success wake|digest|silent] [--machine M --cwd DIR]
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
  secret add NAME | secret update NAME   store a secret shared with every lane at launch; the value is read from stdin only (hidden prompt on a terminal), never argv
  secret list [--json]                 stored secret names and backend (cred or plain); values are never printed
  secret delete NAME                   remove a stored secret
  secret env                          inside a lane: export every stored secret as POSIX shell lines (loaded at launch)
  secret run <op> | host <op>          inside a lane: the supervisor host runs config secretCommands.<op> and prints its redacted output
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
                                       inside a lane: its structured report (own key only), sent through its runner to the supervisor;
                                       a question or request opens its own [결정]/[요청] thread, or is posted in the lane's thread when
                                       that thread already sits in decisionsChannel (and the owner has not closed it)
  report ack <id>                      inside a lane: confirm a supervisor message to this lane by its ID (CI follow-up, done-claim notice, objection)
  inbox take [--max-bytes N] [--peek]  the lead's read path: delivered events past the take cursor as id<TAB>line, whole lines
                                       up to N bytes (INBOX_MORE <lines> <bytes> when more wait, INBOX_EMPTY when none); writes a take receipt
  reported <key> --text TEXT [--to TARGET] [--thread ID] [--note TEXT]
                                       post a finished lane's outcome (after LANE_CLOSED or CI_MERGED) to the owner in the lane's thread
                                       (--to/--thread override it, as for send) and, once the post returns a message id, record the receipt;
                                       without it the supervisor sends urgent UNREPORTED <key> after reportTimeoutMin;
                                       supervise closes the thread itself once its work is finished and reported (--final is ignored)
  reported <key> --append TEXT [--note TEXT] [--no-redirect]
                                       a follow-up after the report (merge result, Toodo done): appended to the lane's last report
                                       by editing it (else its status message), no new post (REPORT_APPENDED)
                                       a report, append or send into a thread the owner closed goes to its parent channel instead
                                       (the owner channel when the parent is unknown),
                                       as one line linking the thread (REPORT_REDIRECTED / SENT_REDIRECTED); the thread stays closed;
                                       --append --no-redirect (fact lines: merge, Toodo done) posts nothing anywhere for a closed
                                       thread and keeps the text in the receipt (REPORT_NOT_REDIRECTED)
  resolved <eventId> [...] [--note TEXT] the lead's receipt that it decided a decision event (a lane question or blocked report, LANE_NOT_DONE,
                                       WAIT_*, DEAD_PANE; config resolveKinds); without it urgent UNRESOLVED <eventId> after resolveTimeoutMin;
                                       inbox take marks such lines [resolve]; a known event that opens none prints
                                       RESOLVED_NOT_NEEDED and records nothing
  decision open --question TEXT --option TEXT --option TEXT [...] --recommend N --reason TEXT --waiting TEXT
                [--task N] [--lane KEY | --relay-to KEY] [--thread REF | --no-origin] [--nonblocking] [--from-event EVENT_ID]
                                       lead-only: ask the owner one question with 2-9 numbered options, a recommendation and its
                                       reason in its own thread in decisionsChannel (else the asking thread's channel, else the
                                       first discordChannels entry); a link line goes into --thread (else --lane's thread);
                                       with neither it is refused (DECISION_REFUSED no origin) unless --no-origin says the
                                       question came from no thread (DECISION_LINK_SKIPPED);
                                       --task defaults to the ap-<task>-<n> lane's task; --nonblocking: work goes ahead on the
                                       recommendation; --from-event resolves that decision event (DECISION_SOURCE_RESOLVED);
                                       --relay-to KEY: --lane KEY, and the close types --text into that lane;
                                       a bad or missing field exits 2 DECISION_REFUSED
  decision open --request --question "<what is needed>" --reason TEXT --waiting TEXT [--file PATH] [...]
                                       lead-only: ask the owner for input only they can give (a one-time code, a file or value) in a
                                       [요청] thread, answered and closed like a decision; a long-lived secret (password, API key,
                                       token) needs --file, the path the owner writes it to (chmod 600), never a reply in Discord
  decision close <id> --text TEXT [--choice N] [--from CHANNEL/MESSAGE] [--cancel] [--tasks N] [--force]
                                       lead-only, the first call on the owner's answer: ack the answer messages, post the outcome
                                       into the decision's thread (the reply; no separate dori send there), archive it, resolve its
                                       OWNER_DECISION_ANSWERED event and record each answer handled --reply (DECISION_ACKED,
                                       DECISION_HANDLED <ch> <msg> coverage=1/N); --tasks N: the answer asks for N tasks, the rest
                                       go to dori handled --lane; --from names an answer given outside the thread; unseen owner
                                       messages there exit 3 DECISION_STALE with UNREAD lines (--force closes anyway); a decision
                                       in a lane's own thread covers only its first answer (DECISION_ANSWER_LEFT for the rest);
                                       a closed one records missing handled receipts and exits 2 DECISION_ALREADY_CLOSED; a
                                       lane's own question or request, or a --relay-to decision, gets --text typed into the lane
                                       (DECISION_RELAYED, DECISION_RELAY_SKIPPED, or DECISION_RELAY_RETRYING: the supervisor
                                       retries; hand it over yourself only on DECISION_RELAY_FAILED)
  decision list [--all] [--json]       lead-only: decisions not closed, oldest first (DECISION_NONE when none); --all adds those
                                       closed in the last 7 days
  ack <channel> <messageId> [...]      the lead's read receipt (one <channel> <messageId> pair per message) on a Discord owner message:
                                       hourglass off, eyes on; the ack is recorded for the supervisor
  handled <channel> <messageId> [--tasks N] [--lane KEY ...] [--reply] [--all] [--awaiting [--note TEXT]]
                                       link what handled an owner message, or park it on the owner's answer (--awaiting);
                                       acks it first (warning HANDLED_AUTO_ACKED) when no dori ack was recorded
  send [discord] --to TARGET --text TEXT [--thread ID] [--edit ID | --buttons JSON] [--force] [--no-redirect]
                                       post or edit a Discord message (the platform defaults to discord) (token from DORI_DISCORD_TOKEN);
                                       --to alerts is config alertsChannel, else the first discordChannels entry. A new post is refused with
                                       SEND_STALE <n> (the unseen owner events follow, exit 3) when the destination got owner messages
                                       you have not taken, acked or seen in an ack preview; merge them and resend. --force skips the
                                       check; --edit is never checked. --no-redirect: a thread the owner closed gets nothing (no
                                       SENT_REDIRECTED line in its parent channel); prints SEND_NOT_REDIRECTED and exits 5
  thread [discord] --to CHANNEL [--message ID] --name NAME [--drop-notice]
                                       start a Discord thread (on a message, else standalone) with discord.ownerId added as a member;
                                       prints THREAD discord:<channel>/<thread>. --drop-notice: delete the "started a thread" notice
                                       Discord leaves in the channel (THREAD_NOTICE_REMOVED); when that fails it only warns
                                       (THREAD_NOTICE_KEPT on stderr) and the thread stays as created
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
  await convertJsonState(cfg.stateDir);
  setDefaultRunTimeout(cfg.runTimeoutMs);
  try {
    const status = await collectStatus({ run, clock: realClock, config: cfg, tunables: BUILT_IN, registry: new Registry(cfg.stateDir), runnerDir: defaultRunnerDir() });
    console.log(json ? JSON.stringify(status, null, 2) : statusPage(status, page));
  } catch (e) {
    // A state dir whose json store did not convert has no database to read (STORE_CONVERT_FAILED was printed above).
    if (e instanceof StoreError) die(e.message);
    throw e;
  }
  process.exit(0);
}

if (process.argv[2] === "runner") {
  // serve and probe run on runner hosts and live in runner/main.ts, which the worker bundle (runner/bin.ts) also runs.
  if (process.argv[3] === "serve" || process.argv[3] === "probe") {
    const { runnerHostMain } = await import("./runner/main.ts");
    process.exit(await runnerHostMain(process.argv.slice(3)));
  }
  // evacuate reads the lane reports store, so a json state dir converts first, as for the lead commands below.
  if (process.argv[3] === "evacuate") await convertJsonState((await loadConfig()).stateDir);
  const { runnerAdminMain } = await import("./runner-admin-cli.ts");
  process.exit(await runnerAdminMain({ die }));
}

const config = await loadConfig();
await convertJsonState(config.stateDir);
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
    model: { type: "string" }, mode: { type: "string" }, task: { type: "string" }, thinking: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, workspace: { type: "string" }, machine: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, full: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, append: { type: "string" }, edit: { type: "string" }, name: { type: "string" }, message: { type: "string" },
    until: { type: "string" }, every: { type: "string" }, timeout: { type: "string" }, "on-success": { type: "string" },
    list: { type: "boolean" }, final: { type: "boolean" }, cancel: { type: "string" }, "share-thread": { type: "boolean" }, "allow-repo-mismatch": { type: "boolean" }, sandbox: { type: "boolean" }, json: { type: "boolean" }, force: { type: "boolean" }, cancelled: { type: "boolean" },
    lane: { type: "string" }, as: { type: "string" }, all: { type: "boolean" }, grant: { type: "string", multiple: true },
    type: { type: "string" }, command: { type: "string" }, match: { type: "string" }, kind: { type: "string" }, path: { type: "string" },
    port: { type: "string" }, secret: { type: "string" }, id: { type: "string" },
    cron: { type: "string" }, tz: { type: "string" }, "catch-up": { type: "string" }, heavy: { type: "boolean" },
    dev: { type: "boolean" }, buttons: { type: "string" }, repo: { type: "string" }, result: { type: "string" },
    "no-redirect": { type: "boolean" }, "drop-notice": { type: "boolean" }, "no-handled": { type: "boolean" },
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
      const result = opt("result");
      if (flags.positionals.length || ("result" in flags.values && !result) ||
          Object.entries(flags.values).some(([name, v]) => name !== "result" && ((name !== "dev" && name !== "force") || v !== true))) {
        die("usage: dori update [--dev] [--force] [--result PATH]");
      }
      const logged: string[] = [];
      const code = await updateInstall({
        run, sleep: realClock.sleep, log: (line) => { console.log(line); logged.push(line); },
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
      // The supervisor's automatic update (update.ts AutoUpdate) reads its outcome from here.
      if (result) writeUpdateResult(result, { at: Date.now(), code, lines: logged });
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
    case "secret": {
      const [action, name, ...extra] = flags.positionals;
      const usage = "usage: dori secret add NAME | dori secret update NAME | dori secret list [--json] | dori secret delete NAME";
      if (action === "env") die("SECRET_ENV_LANE_ONLY dori secret env runs inside a lane", 2);
      if (extra.length || Object.keys(flags.values).some((flag) => flag !== "json" || action !== "list")) die(usage, 2);
      const store = new SecretStore();
      try {
        if (action === "list" && name === undefined) {
          const entries = store.list();
          if (flags.values.json) console.log(JSON.stringify(entries.map(({ name: n, backend }) => ({ name: n, backend })), null, 2));
          else for (const entry of entries) console.log(`${entry.name} ${entry.backend}`);
        } else if (action === "delete" && name) {
          store.delete(name);
          console.log(`SECRET_DELETED ${name}`);
        } else if ((action === "add" || action === "update") && name) {
          let value: string;
          if (process.stdin.isTTY) {
            const { ttyPrompter } = await import("./setup-cli.ts");
            value = await ttyPrompter().secret(`value for ${name}`, false);
          } else {
            const text = await Bun.stdin.text();
            value = text.endsWith("\n") ? text.slice(0, -1) : text;
          }
          const entry = action === "add" ? await store.add(name, value) : await store.update(name, value);
          console.log(`${action === "add" ? "SECRET_ADDED" : "SECRET_UPDATED"} ${entry.name} backend=${entry.backend}`);
        } else die(usage, 2);
      } catch (e) {
        if (e instanceof SecretStoreError) die(e.message);
        throw e;
      }
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
          thread: opt("thread"), every: opt("every"), timeout: opt("timeout"), onSuccess: opt("on-success"), cwd: target ? need("cwd") : process.cwd(),
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
      const stopSecretWatch = await watchSecretStore();
      try { await supervise(deps, controller.signal, { configFile: configPath() }); }
      finally { stopSecretWatch(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      // Shutdown is done: leftover timers, sockets or child pipes must not hold the process.
      console.log("SUPERVISOR_STOPPED");
      process.exit(0);
    }
    case "quota": {
      const { quotaSummary } = await import("./autopilot-cli.ts");
      const { quotaAccountText, quotaSplit } = await import("./autopilot.ts");
      const signal = AbortSignal.timeout(30_000);
      const looked = await sharedQuotaLookup(config)(signal);
      const read = await readUsage(async () => looked, realClock.now(), signal);
      // Autopilot judges the accounts of the provider serving defaultModel: it launches while any of them has room.
      const judged = quotaSummary((await readUsage(async () => looked, realClock.now(), signal, quotaProvidersFor(config.defaultModel))).usage);
      const notes = cacheNoteLines(read.cache, realClock.now(), config.displayTimeZone).map((line) => `\n${line}`).join("");
      const { over, room } = quotaSplit(judged);
      const autopilot = { readable: judged.readable, over, room };
      const skipped = read.skipped.length ? `\nQUOTA | skipped ${skippedText(read.skipped)}` : "";
      const verdict = `\nQUOTA | autopilot ${!judged.readable ? "unreadable" : `room: ${room.map(quotaAccountText).join(", ") || "none"}${over.length ? `; spent: ${over.map(quotaAccountText).join(", ")}` : ""}`}`;
      if (flags.values.json) console.log(JSON.stringify({ usage: read.usage ?? null, skipped: read.skipped, autopilot, cache: read.cache ?? null }, null, 2));
      else console.log(`${read.usage ? usageLine(read.usage, config.displayTimeZone) : NO_CLAUDE}${notes}${skipped}${verdict}\n\n${read.text}`);
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
      if (!fromMessage && flags.values["no-handled"]) die("--no-handled goes with --from-message; a --brief launch links no owner message");
      const taskArg = opt("task");
      const flagTask = taskArg === undefined ? undefined : (parseLaneTask(taskArg) ?? die(`--task must be a positive integer (a Toodo task id), got ${JSON.stringify(taskArg)}`));
      // An autopilot lane carries its reservation's task id; a --task naming another task is refused.
      const reservedTask = await (async () => {
        const { ledgerRows, reservedTaskOf } = await import("./autopilot.ts");
        const store = openOperations(config);
        try { return reservedTaskOf(ledgerRows(store), key ?? ""); } finally { store.close(); }
      })();
      if (flagTask !== undefined && reservedTask !== undefined && flagTask !== reservedTask) die(`LAUNCH_TASK_MISMATCH lane ${key} is reserved by autopilot for task #${reservedTask}, not --task ${flagTask}`);
      const task = flagTask ?? reservedTask;
      const grantArgs = (flags.values.grant as string[] | undefined ?? []).map((g) => g.trim());
      const { GRANT_NAME } = await import("./runner/policy.ts");
      for (const g of grantArgs) if (!GRANT_NAME.test(g)) die(`--grant ${JSON.stringify(g)} is not a grant name (${GRANT_NAME.source})`);
      const grants = [...new Set(grantArgs)];
      const title = need("title");
      const generated = fromMessage ? (() => {
        try {
          return { path: generatedBriefPath(config.stateDir, key ?? ""), text: assembleBrief(title, fromArgs.refs.map((ref) => ownerMessageText(config.stateDir, ref)), fromArgs.notes) };
        } catch (e) { return die(e instanceof Error ? e.message : String(e)); }
      })() : undefined;
      const input: LaunchInput = { key: key ?? "", title, brief: generated ? generated.path : need("brief"), done: need("done"), thread: await laneThreadRef(opt("thread"), config.discordChannels), model: opt("model"), ...(mode ? { mode: mode as LaneMode } : {}), ...(task !== undefined ? { task } : {}), cwd: opt("cwd"), pane: opt("pane"), workspace: opt("workspace"), machine: opt("machine"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]), ...(sandbox === undefined ? {} : { sandbox }), ...(grants.length ? { grants } : {}) };
      await validateLaunch(deps, input);
      if (generated) writeGeneratedBrief(generated.path, generated.text);
      const placed = await placeLaunch(deps, input);
      for (const line of placed.lines) console.log(line);
      const r = await admitLaunch(deps, input, placed, (line) => { console.error(line); });
      if (r.kind === "held") {
        console.log(verdictLine(r.target, r.verdict));
        console.log(`QUEUED ${input.key} (${r.queued} waiting; dori hold list)`);
        process.exit(4);
      }
      for (const note of r.notes) console.log(note);
      for (const line of r.notices) console.error(line);
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      const next = launchNextLine(r.lane.key, r.startup); if (next) console.log(next);
      // The lane is registered whatever its startup check said, so it covers the owner messages it was launched from.
      if (fromMessage && !flags.values["no-handled"]) {
        const discord = (): Discord => new Discord(fetchHttp, realClock, resolveCredential("DORI_DISCORD_TOKEN") ??
          (() => { throw new AckError(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`); })());
        const linked = await linkLaunchMessages(config.stateDir, r.lane.key, fromArgs.refs, discord, realClock.now());
        for (const line of linked.out) console.log(line);
        for (const line of linked.err) console.error(line);
      }
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "autopilot": {
      const { autopilotMain, liveJudgeDeps } = await import("./autopilot-cli.ts");
      const { acquireStateLock } = await import("./state-lock.ts");
      const store = openOperations(config);
      const code = await autopilotMain(rest, {
        ...liveJudgeDeps(deps, store), now: realClock.now,
        lock: () => acquireStateLock(join(config.stateDir, "autopilot-launch.lock.sqlite")),
        out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
      });
      store.close();
      process.exit(code);
    }
    case "merge": {
      const { mergePauseMain } = await import("./merge-pause.ts");
      process.exit(mergePauseMain(rest, {
        stateDir: config.stateDir, now: realClock.now, who: `lead (${userInfo().username})`,
        out: (line) => { console.log(line); }, err: (line) => { console.error(line); },
      }));
    }
    case "review": {
      const [action, ...extra] = flags.positionals;
      if (action !== "audit" || extra.length || Object.keys(flags.values).some((k) => k !== "json")) die("usage: dori review audit [--json]", 2);
      const { auditReviewHistory, formatReviewAudit } = await import("./review-audit.ts");
      const audit = auditReviewHistory(config.stateDir);
      console.log(flags.values.json ? JSON.stringify(audit, null, 2) : formatReviewAudit(audit));
      process.exit(audit.violations.length > 0 ? 1 : 0);
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
    case "attach": {
      const paths = flags.positionals.slice(1);
      if (!key || !paths.length || Object.keys(flags.values).length) die("usage: dori attach <key> <path> [<path> ...]");
      const target = await lane(key ?? "");
      await needSupervisor();
      try { for (const line of await attachLaneFiles(deps, target, paths.map((p) => resolve(p)))) console.log(line); }
      catch (e) { die(e instanceof Error ? e.message : String(e)); }
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
      // A cancelled autopilot lane's task gets its blocker note here (task-finish.ts taskBlocker), as in the supervisor.
      const { taskBlocker } = await import("./task-finish.ts");
      const { ToodoWriter } = await import("./toodo-client.ts");
      const blockTask = taskBlocker(new ToodoWriter(deps.tunables.toodoWriter));
      const r = await closeLane({ ...deps, blockTask }, target, note, { force: Boolean(flags.values.force), ...(cancelled ? { cancelled } : {}) });
      for (const line of r.lines) console.log(line);
      // Owner decisions still open for this lane never block the close; they are named so the lead closes or keeps them.
      const { openOwnerDecisions } = await import("./owner-decisions.ts");
      const pending = openOwnerDecisions(config.stateDir).filter((d) => d.lane === target.key).map((d) => d.id);
      if (pending.length) console.log(`CLOSE_NOTE open decisions: ${pending.join(" ")}`);
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
      const dir = heavyDirOf();
      const slot = await acquireSlot({ dir, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      const finish = await watchSimulators({ run, dir, platform: process.platform, alive: (pid) => pidAlive(pid), now: realClock.now, pid: process.pid, err: (line) => console.error(line) }, slot);
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        await finish();
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
        const { opensObligation, takeDecisionReminders } = await import("./decision-obligations.ts");
        const lines = takeOutput(result, (line) => opensObligation(line, deps.tunables));
        const sentinel = /^INBOX_(MORE|EMPTY)\b/.test(lines.at(-1) ?? "") ? lines.splice(-1) : [];
        const reminders = [...takeCarriedReminders(config.stateDir, new Set(result.events.map((event) => event.id))), ...takeReminders(config.stateDir), ...takeDecisionReminders(config.stateDir)];
        // Owner chat mixed with lane outcomes: one checklist line first, so answering the chat cannot hide the report owed.
        const checklist = checklistLine([...result.events.map((event) => `${event.id}\t${event.line}`), ...reminders]);
        // Messages parked on the owner's answer are information, not work: listed last and kept out of the checklist.
        // Owner decisions still open are information too: the owner has not answered, or the answer is an UNRESOLVED reminder.
        const { takeOwnerDecisionLines } = await import("./owner-decisions.ts");
        const decisionLines = takeOwnerDecisionLines(config.stateDir, realClock.now());
        for (const line of [...(checklist ? [checklist] : []), ...lines, ...reminders, ...takeAwaitingReminders(config.stateDir), ...decisionLines, ...sentinel]) console.log(line);
      } catch (e) {
        if (e instanceof InboxError) die(e.message, 2);
        throw e;
      }
      break;
    }
    case "report":
      // A report is the lane's own voice, sent by its runner over the lane socket (lane mode); the lead has no lane to
      // report as.
      die(`DORI_CLI_LANE_COMMAND dori report${flags.positionals[0] === "ack" ? " ack" : ""} runs only inside a lane (DORI_LANE_KEY, or a pane its runner knows)`, 2);
      break;
    case "resolved": {
      // `dori resolved <eventId> [...] [--note T]`: the lead has decided these decision events (decision-obligations.ts). An
      // id with no open obligation is still recorded (its event may not have arrived yet) and named as unmatched, unless the
      // store knows its event as one that opens none (or pruned it, which an open one never is): then nothing is recorded.
      const { opensObligation, publishedDecisions, recordResolved, validEventId } = await import("./decision-obligations.ts");
      const { loadTrace } = await import("./event-trace.ts");
      const ids = flags.positionals;
      if (!ids.length || !ids.every(validEventId) || Object.keys(flags.values).some((name) => name !== "note") || ("note" in flags.values && !opt("note"))) {
        die("usage: dori resolved <eventId> [<eventId> ...] [--note TEXT]");
      }
      const open = new Set(publishedDecisions(config.stateDir).map((item) => item.id));
      const note = opt("note");
      const at = realClock.now();
      for (const id of new Set(ids)) {
        const known = open.has(id) ? undefined : loadTrace(config.stateDir, id);
        if (known?.event && !opensObligation(known.event.line, deps.tunables)) {
          console.log(`RESOLVED_NOT_NEEDED ${id}: this event opens no decision; nothing recorded`);
          continue;
        }
        if (known && !known.event && known.tombstoned) {
          console.log(`RESOLVED_NOT_NEEDED ${id}: this event was pruned and has no open decision; nothing recorded`);
          continue;
        }
        recordResolved(config.stateDir, id, at, note ? oneLine(note) : undefined);
        console.log(open.has(id) || known?.event ? `RESOLVED_RECORDED ${id}` : `RESOLVED_UNMATCHED ${id}: no open decision has this id; recorded anyway`);
      }
      break;
    }
    case "decision": {
      const { decisionMain } = await import("./decision-cli.ts");
      const code = await decisionMain(rest, { flow: deps, die, messengerToken });
      if (code !== 0) process.exit(code);
      break;
    }
    case "ack":
    case "reported":
    case "handled":
    case "send":
    case "thread":
    case "typing": {
      const { discordMain } = await import("./discord-cli.ts");
      const code = await discordMain(process.argv.slice(2), { flow: deps, die, messengerToken, flags, opt, need, key });
      if (code !== 0) process.exit(code);
      break;
    }
    case "presence": {
      if ((key ?? "discord") === "discord") {
        const token = resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`);
        const release = acquireDiscordGateway(token);
        let presence: ReturnType<typeof discordPresence> | undefined;
        try {
          if (!config.discord) console.warn("PRESENCE_WARNING discord slash commands skipped: config.discord is missing; run dori setup");
          const commands = config.discord ? new DiscordCommands(fetchHttp, token, config.discord, quotaReport(sharedQuotaLookup(config), config.displayTimeZone), undefined, config.discordChannels, lookupStatus({ ...deps, runnerDir: defaultRunnerDir() })) : undefined;
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
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof ReposError || e instanceof DiscordGatewayOwnedError || e instanceof AckError || e instanceof StoreError || e instanceof LaneMessageError || e instanceof SourceError) die(e.message);
  throw e;
}
