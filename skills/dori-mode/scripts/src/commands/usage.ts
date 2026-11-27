/** The lead's `dori` usage: printed for an unknown command, and sliced per command for `dori <command> --help`. */
export const USAGE = `dori <command> [options]

  doctor                                                         read-only health check: OK/WARN/FAIL with the exact fix; exit 1 on any FAIL
  status [--json | --page N]                                     one-screen summary: services, lead, lanes, waits, repos, gateway (also /status in Discord); --page N lists more lanes, --json every lane with its latest report
  setup  [--yes] [--token-file F] [--channel ID] [--autostart] [--set KEY=VALUE ...] [--unset KEY ...] [--migrate]
                                       interactive install: token, channels, autostart; --set/--unset set or delete config.json
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
                [--sandbox]   every lane runs in the sandbox (--sandbox is accepted and changes nothing): a local one in laneSandbox.command after a --check preflight, a --machine one under its runner's sandboxed profile; a missing or broken sandbox refuses the launch (SANDBOX_MISSING / SANDBOX_BROKEN / SANDBOX_UNAVAILABLE) and warns on Discord; only Windows runners (no lane sandbox exists there) and machines opted in with runners.<label>.allowUnsandboxed run unsandboxed, with SANDBOX_SKIPPED and a Discord warning each time
                HOLD (exit 4) on host limits queues the launch in launch-hold.json until it launches or is dropped
                [--machine LABEL]   target a saved machine
                [--worktree REPO [--base REMOTE/BRANCH]]   instead of --cwd: create <worktree root>/<repo name>-<key> on the placed machine, detached at the
                                       fetched base (default origin/dev), from the checkout of REPO (owner/repo or name) its runner declares or detects;
                                       an existing path refuses the launch (LAUNCH_WORKTREE_EXISTS); removed again when the launch registers no lane
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--cwd DIR] [--machine LABEL] [--share-thread] [--allow-repo-mismatch]   with --machine, --cwd is the remote directory
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
  autopilot rearm <taskId> [--note TEXT]
                                       lead-only, on the owner's word: the task's attempts so far stop refusing it already-attempted,
                                       so it launches as attempt n+1 once it judges LAUNCH again (a pause and then a wait that
                                       ended do this without it); refused while an attempt runs
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
  lane send <key> --text TEXT          types TEXT into the lane once through its runner (local or remote) as a lead message it acks; refused while the lane shows a question prompt; prints LANE_SEND_DELIVERED, LANE_SEND_UNCONFIRMED, or LANE_SEND_REFUSED/LANE_SEND_FAILED (exit 1, nothing typed, not retried)
  ops [list] [--lane KEY] [--all] [--json]   operation rows: open, failed and ambiguous ones; --all adds verified
  ops resolve <id> --as verified|retry  the lead's answer for an ambiguous or failed operation after checking the world by hand
  close  <key> [--note TEXT] [--force] close now (Done signals must read back live; unpushed, uncommitted or untracked work refuses unless --force)
  close  <key> --cancelled --reason TEXT [--force]   lead-only: close a lane whose work was cancelled or whose Done can never hold;
                                       Done signals are not checked, the lane is recorded closed as cancelled with the reason
                                       inside a lane (DORI_LANE_KEY, or a pane its runner knows) dori takes only report, claim-done, report ack,
                                       lane status, heavy, secret env and secret run (alias host <op>) (anything else: DORI_CLI_LANE_ONLY, exit 2); lane commands of the lead need the
                                       supervisor (RUNNER_UNAVAILABLE, exit 2, while it is down)
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status; an agent that exited is relaunched
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
  secret env                          inside a lane: export every stored secret as POSIX shell lines for eval "$(dori secret env)" (loaded at launch; refuses a terminal stdout)
  secret run <op> | host <op>          inside a lane: the supervisor host runs config secretCommands.<op> (a worker runs its runner-config hostCommands.<op> itself) and prints its redacted output
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
  memory check                         read-only: the lead's human.md size and system/ tokens vs memoryLimits, and Open items naming closed lanes
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
                                       once its work is finished and reported, supervise puts the owner's close button on the thread's last report
                                       and closes it after threadCloseAfterHours with no click (--final is ignored)
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

/**
 * `dori <command> ... --help` (or `-h`): that command's USAGE entry (`runner <sub>` first), or undefined when the command
 * has none or prints its own help (setup).
 */
export const commandHelp = (argv: readonly string[]): string | undefined => {
  const helpCommand = argv[0] ?? "";
  if (helpCommand === "setup" || !argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) return undefined;
  const lines = USAGE.split("\n");
  const entry = (prefix: string): number =>
    lines.findIndex((line) => helpCommand !== "" && line.startsWith(prefix) && /\s/.test(line[prefix.length] ?? ""));
  const sub = argv[1] ?? "";
  const subStart = helpCommand === "runner" && sub && !sub.startsWith("-") ? entry(`  runner ${sub}`) : -1;
  const start = subStart >= 0 ? subStart : entry(`  ${helpCommand}`);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^  \S/.test(lines[end] ?? "")) end++;
  return lines.slice(start, end).join("\n").trimEnd();
};
