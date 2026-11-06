# Runner protocol

The runner is a small per-machine process (`dori runner serve`) that talks to the supervisor over one line-based
connection: a unix socket on the lead host, or a WebSocket on a private address for other machines. Both sides
authenticate every connection. A runner reports what it sees on its machine and owns every lane there: it starts,
steers and closes them (below), local lanes included. Each runner also guards
its host: it samples memory, load and disk, and under critical memory kills its lanes' heavy processes. Commands it
does not carry out are answered with a refusal or `RUNNER_CMD_UNSUPPORTED`.
The modules live in `scripts/src/runner/`; see [development.md](development.md) for the module table and
[scripts.md](scripts.md) for the commands.

## Envelope

Every frame is one JSON object followed by `\n`, at most 1 MiB (`MAX_FRAME_BYTES`). The envelope is:

| Field | Meaning |
|---|---|
| `v` | envelope version, currently `1` |
| `runner` | the runner label, `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (no `:`) |
| `gen` | the runner's boot generation, bumped and committed once per process start |
| `epoch` | the supervisor's epoch, bumped and committed once per hub start |
| `seq` | runner events only: the durable outbox sequence, starting at 1 |
| `cmdSeq` | supervisor commands only: the command sequence |
| `type` | the frame type |
| `body` | the type's body |
| `mac` | base64 HMAC-SHA256 of the frame without `mac`, under the session key; required on every frame after the handshake |

Validation is strict. An unknown envelope or body field, an unknown type, a type sent by the wrong side, `seq` on a
non-event, `cmdSeq` on a non-command, a missing or zero sequence, a wrong field shape or a bad label is rejected
with `RUNNER_FRAME_INVALID <rule> <detail>`. Integers must be non-negative safe integers. On the hub an invalid
frame closes the connection without an ack.

## Types

Control frames, used in this release:

- Runner to supervisor: `enroll`, `hello {proto, gen, label, hostId, cmdAck, version?, inventory?, nonce, dh}`,
  `auth.proof {sig}`, `runner.rotated {cmdId, runnerPubKey, sig}`, `heartbeat {outbox?: {unacked, oldestAgeMs}}`,
  `cmd.status.result {cmdId, state, detail?}`, `q.result {qid, ok, detail, result?}` (protocol 3, see [Queries](#queries)).
- Supervisor to runner: `enroll.ok`, `hello.challenge {nonce, dh, sig, keyFp}`, `hello.ok {proto, epoch, eventAck}`,
  `hello.reject {code, detail}`, `rotate.ok`, `ack {eventAck}`, `cmd.status {cmdId}`, and the queries `q.panes`,
  `q.screen`, `q.process`, `q.stat`, `q.lane.inspect`, `q.machine.observe` (protocol 3).

`hello` must be the first frame on a connection (after an `enroll` connection has closed). After the handshake
(below) the hub applies its hello rules: `RUNNER_PROTO_MISMATCH` when the protocol version isn't accepted, then the
fencing rules in [Fencing](#fencing).

Runner events are defined for `lane.started`, `lane.state`, `lane.report`, `lane.asking`, `lane.progress`,
`lane.ack`, `wait.result`, `job.result`, `guard.sample`, `guard.alert`, `guard.critical`, `herdr.state`, `herdr.start`, `heavy.state` and `cmd.result`. Today
a runner publishes `lane.state`, `lane.progress`, `cmd.result` and, on a worker, `lane.started`, `lane.report` and
the three `guard.*` events. Supervisor commands (`lane.start`, `lane.stop`, `lane.pause`, `lane.resume`,
`lane.recover`, `lane.send`, `lane.close`, `lane.observe`, `wait.check`, `job.run`, `guard.kill`, `host.herdr`, `runner.rotate`)
are part of the schema. A worker's runner carries out `lane.start`, `lane.stop`, `lane.close`, `lane.send`,
`lane.recover`, `lane.observe` and `guard.kill` (see [Runner-owned lanes](#runner-owned-lanes)); `runner.rotate` is
handled by the connection itself. Every command the runner receives goes through the command policy (below): a refused one is
answered `cmd.result failed RUNNER_CMD_REJECTED <rule>`, a carried-out one `cmd.result verified <detail>`, and an
accepted one that this release cannot carry out yet `cmd.result failed RUNNER_CMD_UNSUPPORTED <type>`. Both get an
intent row and a final row, so `cmdAck` moves past them and they are not sent again. A command with an unknown type
or field still gets an answer instead of being dropped.

Protocol 3 adds, all optional on existing frames:

| Frame | Addition |
|---|---|
| `lane.state` | `reason` (`pane-missing` or `agent-gone`) for a `dead` lane |
| `lane.ack {key, id}` | new event: the lane confirmed the supervisor's lane message `id` |
| `guard.sample` | `panes` (herdr's pane count, -1 when the runner could not read herdr) and `lanes [{key, rssKb, top [{comm, rssKb, count}]}]` |
| `cmd.result` | `result`: the effect's structured result (any JSON value; below) |
| `lane.start` | `keywords`, `session`, `target {pane?, workspace?}`, `heavySlots`, `heavyMaxLoad` |
| `lane.adopt {key, pane, cwd?, mode, model}` | new command: take an existing pane as lane `key` |
| `lane.pause` | `step` (`goal`, `stop` or `both`, default `both`) |
| `lane.recover` | `session` (resume that agent session when relaunching) |
| `lane.send` | `mode` (`verified` or `guarded`), `refuseWhileAsking` |
| `lane.notify {key, status, objection?: {at, reasons}, claim?: {at, evidence}}` | new command: the lane's status as the supervisor holds it |
| `lane.git {key, op, root, path?, branch?, remote?}` | new command: `worktree-remove`, `branch-delete` or `remote-branch-delete` in `root` |

Protocol 4 adds `guard.sample.herdr?: {state: up|down|hung, instance?: string, since: number}`,
`herdr.state {state, instance?, detail}` on transitions, and `herdr.start {ok, detail}` for managed-unit start
outcomes. `since` is the runner's wall time; the supervisor records its own receipt time for shared state.
The supervisor continues to infer outages from `panes: -1` for protocol 3 runners. Protocol 4 samples without
`herdr` have no effect on herdr state (the watch may still be confirming its first failure).

Protocol 4 also adds the command `host.herdr {action: start|restart|stop|status}` (see [herdr outages](#herdr-outages)),
verified with `{action, state: up|down|hung, instance?, managed, paused}` as read after the action. A protocol 3
runner is never sent it: the call fails at once as `RUNNER_UNAVAILABLE runner=<label> outdated`.

A verified `cmd.result` carries `result` per command type: `lane.start` and `lane.recover` `{pane, tab, startup?:
{verdict, detail}}` (plus `relaunched`, `resumed` for recover), `lane.adopt` `{pane, tab, tokenFile}`, `lane.stop` and
`lane.close` `{closed: tab|pane|none, gone}`, `lane.pause` `{goal?, working?, stopped?}`, `lane.resume` `{goal}`,
`lane.send` `{delivery, refusal?}`, `lane.notify` `{}`, `lane.git` `{code, out, err}` (each capped at 4 KiB),
`lane.observe` `{status}`, `guard.kill` `{killed [{pid, lane?, comm, rssKb}]}`, `host.herdr` `{action, state, instance?,
managed, paused}`. A runner effect that only returns a
detail sends no `result`. The supervisor never sends a protocol 3 command or any query to a runner that said hello
with protocol 2: such a call fails at once as `RUNNER_UNAVAILABLE runner=<label> outdated`.

## Queries

Reads (screens, pane lists, process info, path existence, lane and machine facts) are control frames, not commands:
they carry no `seq` or `cmdSeq`, go through no outbox and no journal, get no intent or result row, and are not
epoch-fenced (they change nothing). Each `q.*` body has a `qid`; the runner answers it with one `q.result {qid, ok,
detail, result?}` on the same connection, sealed like every frame. A query sent while the link is down is not sent at
all, and an answer whose connection has closed is dropped: the caller times out and asks again on its next pass.

| Query | Body | `result` when `ok` |
|---|---|---|
| `q.panes` | `{qid}` | `{panes}`: herdr's pane list of the runner's host |
| `q.screen` | `{qid, pane, lines, source: visible\|recent}` | `{text}` (at most 400 lines; `lines` ignored for `visible`) |
| `q.process` | `{qid, pane}` | `{info?, error?}`: herdr's process-info |
| `q.stat` | `{qid, paths}` | `{exists}`, one boolean per path |
| `q.lane.inspect` | `{qid, key, cwd?, git?, roots?, branches?, done?, doneCwd?, session?, sessionsDir?}` | `{status, pane?, process?, cwd, cwdExists, git?, done?, session?}` |
| `q.machine.observe` | `{qid}` | `{os, sampledAt, sample, panes}` |

A `q.result` must fit one frame (1 MiB). `ok: false` carries the reason in `detail`.

## Authentication

Each side has an Ed25519 key pair. The supervisor's lives in `<stateDir>/runner-keys/supervisor.key`; the runner's in
`<runnerDir>/keys/runner.key`, next to the pinned `keys/supervisor.pub`. Enrolled runner keys and enrollment codes
are kept in `<stateDir>/runners.sqlite` (`runner_keys`, `enroll_codes`). There is no TLS: confidentiality is left to
the private network.

**Enrollment.** `dori runner enroll --machine <label>` issues a one-time code (32 random bytes, valid 10 minutes,
bound to that label) and prints it with the supervisor key fingerprint as `code=<code>` and
`fingerprint=sha256:<hex>` lines on stdout. That text is fed to `dori runner serve --enroll` on stdin, never in argv
or the environment. The runner makes its key pair and sends `enroll {label, hostId, runnerPubKey, proof}`, where
`proof` is an HMAC keyed with the code, so the code itself never crosses the connection. The supervisor accepts it
only for an unused, unexpired code of that label, marks the code used, stores the key and `hostId`, and answers
`enroll.ok` with its public key and its own proof. The runner checks that key against the fingerprint from stdin and
the proof, pins it, and closes. A refusal is `RUNNER_ENROLL_REFUSED`. The local runner on the lead host is enrolled
by the supervisor in-process when the hub opens, unless it is already enrolled to this supervisor or was revoked.

**Connection handshake.** The runner sends `hello` with a nonce and an ephemeral X25519 key. The supervisor answers
`hello.challenge` with its nonce, its ephemeral key and a signature over the handshake transcript; the runner
verifies it with the pinned key and answers `auth.proof`, its own signature over the transcript, which the supervisor
verifies with the stored key. A failed signature on either side closes the connection with `RUNNER_AUTH_FAILED`; an
unenrolled label or another host is refused the same way, a revoked one with `RUNNER_REVOKED`. The session key is
HKDF over the X25519 shared secret, salted with both nonces, with both identity keys as info, so someone who only
watched the handshake cannot compute it. From then on every frame both ways carries a `mac`, compared in constant
time; a frame with a missing or wrong `mac` is dropped and logged `RUNNER_AUTH_FAILED ... bad mac`. Authentication is
always on for the unix socket and the WebSocket listener alike.

**Rotation.** `dori runner rotate <label>` sends `runner.rotate` to the connected runner. It writes a new key pair
next to the old one and answers `runner.rotated`, signed with the new key. The supervisor stores the new key and
answers `rotate.ok`; on that ack the runner replaces the old key, which is refused from then on. If the ack is lost,
the next `hello.challenge` names the new key's fingerprint and the runner switches then. The command prints
`RUNNER_KEY_ROTATED runner=<label> key=<fingerprint>`.

**Revocation.** `dori runner revoke <label>` deletes the stored key at once and has the live hub close the
connection; every later hello is refused with `RUNNER_REVOKED`. A revoked runner comes back only by enrolling again.

`rotate` and `revoke` reach the running supervisor through a request table (`runner_admin` in `runners.sqlite`) that
the `runners` task drains every 5 seconds; a request not answered within 2 minutes is answered `expired`.

## Network listener

With `runners.listen` set (`host:port`), the supervisor also listens for runners on a WebSocket at that address,
next to the local unix socket. The host must be a single private address: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
192.168.0.0/16, 100.64.0.0/10 (tailnet), fd00::/8 or ::1, IPv6 written `[addr]:port`. A wildcard such as `0.0.0.0`,
a hostname or a public address fails config loading with `CONFIG_RUNNER_LISTEN_INVALID`. If the address cannot be
bound the supervisor logs `RUNNER_LISTEN_FAILED` and keeps serving the local socket. A remote runner connects with
`dori runner serve --connect ws://<host>:<port>` and reconnects with backoff: 1 s doubling to 60 s, scaled by a
random 0.8 to 1.2.

## Command policy

The runner checks every command against `<runnerDir>/runner-config.json` before it records or runs anything. The
file is optional; without it there are no agent profiles and no allowed roots, so every command that needs one is
refused. `dori runner install` writes a starter file when the worker has none: `agents.default` is the lead's
`agentCommand` (the profile every runner launch names) and `allowedRoots` is the worker's `$HOME` plus its temp
directory (`/tmp` on Linux, `/private/tmp` on macOS). An existing file is never rewritten. A `lane.start` the runner
refuses or fails leaves the lane without an agent and raises `RUNNER_LAUNCH_FAILED <key> runner=<label> <detail>`
(urgent); the supervisor's own recovery never relaunches a runner-owned lane, which only its runner recovers
(`lane.recover`).

| Key | Meaning | Default |
|---|---|---|
| `agents` | profile name to argv; `lane.start.agentProfile` must name one | none |
| `allowedRoots` | directories every `cwd` must be under | none |
| `sandbox` | `required` refuses `lane.start` with `sandbox: false` | `optional` |
| `jobs` | `deny` refuses `job.run`, `wait.check`, `lane.git` and a `q.lane.inspect` with `done` | `allow` |
| `guard` | this host's guard thresholds (`loadAlert`, `loadOk`, `memFreeMinPct`, `memFreeCritPct`, `swapFreeCritPct`, `diskFreeMinGb`, `panesMax`), each optional | the config's `guard` |
| `heavyKill` | command-line patterns killed under critical memory | the config's `heavyKill` |

A refusal is `RUNNER_CMD_REJECTED <rule>` with one of these rules: a schema rule from frame validation (such as
`unknown-field` or `unknown-type`), `agent-profile`, `cwd-missing` (the path does not resolve), `cwd-outside-roots`
(compared by path segment after resolving symlinks on both sides, so `/data/repos-evil` is not under `/data/repos`),
`sandbox-required`, `command-not-argv` (a `job.run` command that is not an array of strings) or `jobs-denied`.
`guard.kill` accepts only lane keys. Every `cwd` (`lane.start`, `lane.adopt`, `job.run`, `wait.check`) and
`lane.git.root` is checked the same way: absolute, resolving, under `allowedRoots`.

## Fencing

The runner's `gen` is bumped and committed before its first hello; the supervisor's `epoch` before its hub opens.

- The runner keeps the highest epoch it has seen and re-reads it right before any command's effect. A command from
  a lower epoch is refused there with `RUNNER_CMD_REJECTED stale-epoch`, even if it was accepted earlier.
- The hub keeps each label's `hostId` and highest `gen`. A hello from another `hostId` for the same label is refused
  `RUNNER_CONFLICT`, as is a lower `gen` on the same host, or the same `gen` while that connection is still live. A
  higher `gen` on the same host replaces the old connection (`RUNNER_REPLACED`).
- After restoring a runner's state from a backup, `dori runner reset-gen <label>` clears the stored `gen` (the
  `hostId` stays) so its next hello is accepted.

Only the supervisor's key makes a supervisor: a second supervisor started from another state directory has a
different key, and every runner refuses it. Moving the lead to another host therefore means moving
`<stateDir>/runner-keys/` with it, or enrolling every runner again.

## Cursors and ordering

There are two cursors, each owned by the side that commits it.

- `eventAck` (supervisor): the highest runner `seq` committed to the hub's journal. It's persisted per label in
  `runners.sqlite` and sent in `hello.ok` and every `ack`.
- `cmdAck` (runner): the highest `cmdSeq` such that every command from 1 up to it has a final result row. It's
  persisted in the runner's `state.sqlite` and sent in `hello`. No commands flow yet, so it stays 0.

The rule is commit before ack. The runner appends each event to its outbox and only sends it once the row is
committed. When the hub receives `seq`:

- `seq <= eventAck`: a duplicate. Nothing is committed and the current `eventAck` is acked again.
- `seq == eventAck + 1`: the event is committed under the journal id `runner:<label>:<seq>`, then `eventAck` is
  persisted, then the ack goes out. An id already in the journal counts as committed.
- `seq > eventAck + 1`: a gap. Nothing is committed, the unchanged `eventAck` is acked, and the supervisor logs
  `RUNNER_EVENT_GAP runner=<label> seq=<n> eventAck=<n>` and closes the connection. Only a hello replays from
  `eventAck`, so a gap left open would hold back every later event, `cmd.result` included, for as long as the
  connection lives; the runner reconnects with its backoff and the replay fills it.

If the commit throws, `eventAck` doesn't move and no ack is sent. So `eventAck` never runs ahead of the journal,
and the journal holds events in `seq` order. After a reconnect the runner replays every outbox row above the
`eventAck` from `hello.ok`, in order, before sending anything new. A lower ack than the runner already holds is
ignored.

Runner events land in the hub's own `runner_events` table, never in the lead's journal, and are pruned after 7 days.

## Outbox

`<runnerDir>/outbox.sqlite` holds every event the runner publishes. The `seq` is never reused, even after pruning.

- Acked rows are kept for 7 days, then pruned.
- `lane.report.text` and `job.result.output` larger than 8 KiB move to `bodies/<seq>.body`; the row keeps the path
  and a sha256. Texts over 256 KiB are cut at 256 KiB with a `[truncated by the runner outbox]` marker. On the wire
  the text is sent inline and `lane.report` carries `bodyRef {sha256, bytes, truncated}`. Body file paths never
  leave the runner's host.
- `RUNNER_OUTBOX_LARGE unacked=<n> oldestAgeMs=<n>` flags an outbox with 100,000 or more unacked rows or an oldest
  unacked row over 24 hours old.

The heartbeat carries the outbox backlog so `dori status` can show it.

## Runner directory

Everything lives under `~/.dori/runner`:

| Path | What |
|---|---|
| `runner.json` | identity `{id, label, hostId}` |
| `state.sqlite` (+ `-wal`, `-shm`) | `gen`, highest seen epoch, command rows with their detail and structured result (kept 30 days) |
| `outbox.sqlite` (+ `-wal`, `-shm`) | the outbox |
| `bodies/<seq>.body` | moved report and job bodies |
| `keys/runner.key`, `keys/supervisor.pub` | the runner's private key and the pinned supervisor key (`keys/runner.next.key` during a rotation) |
| `runner-config.json` | the command policy (optional) |
| `health` | `{pid, gen, monotonicMs, wallAt}`, rewritten every 15 s |
| `bin/dori.js` | the runner bundle, on workers installed by `dori runner install` |
| `sock/control` | the unix socket the supervisor listens on and the runner connects to |

The hub's table is `<stateDir>/runners.sqlite` on the supervisor side.

Directories must be 0700 and files 0600 (under `bin/` and `bun/`, where `dori runner install` puts the wrapper and
bun, 0600 or 0700), owned by the runner's uid, with no symlinks anywhere. `dori runner serve`
checks this with lstat before opening anything; on the first bad entry it prints `RUNNER_DIR_UNSAFE <path> <reason>`
to stderr and exits 1. It never repairs permissions. The supervisor creates `~/.dori/runner` and `sock/` as 0700
when they're missing, and the socket itself is 0600.

There's no peer credential check on the socket. Bun's unix sockets don't expose the peer's uid (no `SO_PEERCRED`).
The 0700 `sock/` directory keeps other users out, and the signed handshake keeps another process of the same user
from posing as the supervisor or the runner.

## Remote install

`dori runner install --machine <label>` puts a runner on a Linux or macOS worker. The machine is looked up like the guard's
machines (herdr's saved machines plus `guardMachines`), and `runners.listen` must be set; otherwise it stops with
`RUNNER_INSTALL_NO_LISTEN`. The supervisor issues the enrollment code in its own process and runs
`ssh <target> sh -s`. That command line never changes: everything else goes on ssh's stdin as one sh script.

- The bundle is `bun build src/runner/bin.ts --target=bun`, a single file holding only the runner. It is written to
  `~/.dori/runner/bin/dori.js` through a temporary file and `mv`. A Linux worker needs `bun` on its PATH. A macOS
  worker takes it from the PATH, `~/.dori/runner/bun/bun`, `/opt/homebrew/bin`, `/usr/local/bin` or `~/.bun/bin`, and
  otherwise downloads the latest release into `~/.dori/runner/bun`.
- On Linux, `~/.config/systemd/user/dori-runner.service` (from `templates/dori-runner-remote.service`) runs
  `bun ~/.dori/runner/bin/dori.js runner serve --label <label> --connect ws://<runners.listen>`. It has no
  `EnvironmentFile`: a worker holds no supervisor or Discord credentials.
- The enrollment code and the supervisor fingerprint are shell variables in the script. They reach
  `runner serve --enroll-only` through a pipe from the `printf` builtin, so they appear in no process's argv on either
  machine. A worker that already has `~/.dori/runner/keys/supervisor.pub` skips enrollment: a reinstall or an upgrade
  keeps its keys.
- On macOS, the launchd user agent `~/Library/LaunchAgents/com.dori.runner.plist` (from
  `templates/dori-runner-launchd.plist`, `KeepAlive`) runs the same command, also without credentials. While it
  serves, the runner holds `caffeinate -i -w <its pid>` so an idle Mac does not sleep: asleep, it runs the runner only
  in short DarkWake windows, heartbeats stop and the supervisor drops the link every few minutes. A closed lid still
  sleeps the Mac. When `caffeinate` cannot start or exits, the runner logs `RUNNER_AWAKE_FAILED` and keeps serving.
- Then, on Linux, linger is turned on and the unit is enabled and restarted. On macOS the agent is loaded into
  `gui/<uid>` (`user/<uid>` when there is no GUI session or it refuses the agent), enabled first and kickstarted, and the domain is recorded in
  `~/.dori/runner/launchd-domain`. Either way a new bundle takes effect.

**herdr.** The worker's herdr gets a unit of its own, so it is up after a reboot and restarted after a crash:

- `herdr` must be on the PATH of the user's login shell (`$SHELL -lc`), read before anything is written; without it
  the install stops with `RUNNER_INSTALL_NO_HERDR`. That login PATH and `$SHELL` become the herdr unit's `PATH` and
  `SHELL`, which every lane shell herdr opens inherits.
- On Linux, `~/.config/systemd/user/herdr-server.service` (from `templates/herdr-runner-remote.service`) runs
  `herdr server` with `Restart=on-failure`, like the lead host's unit but without its `OnFailure=` hook. The runner
  unit has `Wants=herdr-server.service` and `After=herdr-server.service`, never `Requires=` or `BindsTo=`: herdr
  starts first at boot, a herdr failure leaves the runner up, and a runner restart never restarts herdr. Both units are
  enabled.
- On macOS, the agent `~/Library/LaunchAgents/com.dori.herdr.plist` (from `templates/dori-herdr-launchd.plist`,
  `KeepAlive`, `ThrottleInterval` 30, output to `~/.dori/runner/herdr.log`) goes into the runner's launchd domain. A
  second `herdr server` on a socket another server holds prints `herdr server is already running` and exits 1 at once,
  so the throttle spaces out KeepAlive's retries while another server holds the socket.
- The install never stops or restarts a running herdr, because that ends every lane on the host. A herdr the unit
  already runs is left alone: a reinstall or `dori update` only rewrites the unit file (`daemon-reload` on Linux; on
  macOS launchd reads the plist at its next load). A herdr started by hand keeps running: the unit is enabled but not
  started (on macOS the agent is loaded with `RunAtLoad` false), and the unit takes over once that herdr stops. On
  Linux the runner is then restarted with `--job-mode=ignore-dependencies`, so its `Wants=` does not start the herdr
  unit beside it. Only when no herdr answers is the unit started (`systemctl --user start`, after `reset-failed`; on
  macOS by loading the agent).

It prints `RUNNER_INSTALLED runner=<label> version=<first 12 hex of the bundle's sha256> herdr=<started|managed|unmanaged> (...)`
(`unmanaged`: a herdr not from the unit is running, and the unit takes over when it stops), or exits 1 with
`RUNNER_INSTALL_UNREACHABLE` (ssh failed or timed out), `RUNNER_INSTALL_UNSUPPORTED` (neither Linux nor macOS, or no POSIX shell),
`RUNNER_INSTALL_NO_BUN` (on macOS: none found and the download failed), `RUNNER_INSTALL_NO_HERDR` (no `herdr` on the
login PATH), `RUNNER_INSTALL_ENROLL_FAILED` or `RUNNER_INSTALL_FAILED` (with the systemd, linger or launchd step
named when that failed).

## Guard

A worker's runner (one started with `--connect`) samples its host every 30 seconds with the same readings the
supervisor takes of its own host, judged against `runner-config.json`'s `guard` thresholds:

- `guard.sample {level, reasons, sampledAt, load1, memFreePct, diskFreeGb, swapFreeGb, swapTotalGb, os}` goes out once
  a minute and on every level change (`ok`, `alert`, `critical`); `guard.alert {reasons}` on entering alert or
  critical. The supervisor saves each sample's readings on the runner's row in `runners.sqlite` (`machine`), which
  `dori status` shows as that machine's CPU load, free memory, disk and swap.
- Under critical memory the runner kills by itself. It targets only processes whose command line matches a
  `heavyKill` pattern and that belong to a lane on the host (`DORI_LANE_KEY` in their own or an ancestor's
  environment). The runner and its ancestors are never targets. Each gets SIGTERM, then SIGKILL after 5 seconds. The
  kills go out in `guard.critical {killed, paused, reasons, rssKb, cmds}`.
- `guard.kill {keys}` runs the same kill limited to those lanes. The supervisor sends lane keys, never patterns.

The local runner on the lead host does none of this: the supervisor's own guard sweep samples and kills there.

On the supervisor, the machine-guard sweep takes a runner's sample when it is at most 90 seconds old and then makes
no ssh call to that machine. The sample goes through the same transitions as an ssh sample, so `HOST_GUARD ALERT`,
`CLEAR`, `OFFLINE`, `ONLINE` and `LAUNCH_READY machine=<label>` read exactly as before. A runner machine never reads
as `OUTDATED`, because it has no guard agent. Its critical stage reports the runner's kills (`HOST_GUARD CRITICAL
machine=<label> ...; killed ...`), tells the lanes, and pauses the newest lane on entering critical with nothing
killed, but it kills nothing over ssh. Without a fresh runner sample (no runner, or it went quiet) the machine is
sampled over ssh again, as before.

## herdr outages

Each runner, including the local runner, watches herdr on the existing 30 s guard sampling timer. A readable pane
list means `up`; a failed list and no server process means `down`; a failed list with a server process (or an
unreadable process table) means `hung`. Two consecutive failures spanning at least 30 s are required. A gap longer
than three sampling intervals resets the failure window and discards the first failed sample after waking.

The runner starts an installed `herdr-server.service` on Linux or kickstarts `com.dori.herdr` in its saved launchd
domain on macOS only while `down`. Attempts wait one minute, doubling to a thirty minute cap; `up` resets the
cooldown. Each attempt is durably reported as `HERDR_START machine=<label> ok|failed <detail>`. An absent unit
is reported through the down state without starting anything. A hung server is reported and left running. While the
pause marker `~/.dori/runner/herdr-paused` exists (`dori runner herdr stop`), a down herdr is reported but not started.

`dori runner herdr <start|restart|stop|status> --machine <label> [--yes]` sends `host.herdr` to that machine's runner
(`local` is the lead host) through the supervisor's CLI relay:

- `status` only reads: `RUNNER_HERDR machine=<label> action=status state=<up|down|hung> managed=<bool> paused=<bool> ...`.
- `start` removes the pause marker and starts the installed unit when herdr is down, then waits up to 15 s for the pane
  list to read. It refuses a hung server (`HERDR_HUNG`, use restart) and a host without a herdr unit (`HERDR_UNMANAGED`).
- `restart` ends the server and starts the unit again. It refuses at once, before ending anything, on a host without a
  herdr unit. It stops the unit (Linux `systemctl --user stop`, macOS `launchctl bootout`), sends `SIGTERM` to any
  `herdr server` process of the user still running, `SIGKILL` after 10 s, then starts the unit (on macOS the agent is
  bootstrapped again before the kickstart).
- `stop` writes the pause marker first, then ends the server the same way and starts nothing.
- `restart` and `stop` end every pane herdr runs on that machine. The CLI first prints
  `RUNNER_HERDR_LANES machine=<label> ...` with the machine's open lanes (and the lead pane for `local`), and sends the
  command only with `--yes`; without it, it exits 2 with `RUNNER_HERDR_CONFIRM`. After a restart the recovery sweep
  relaunches those lanes in new tabs on their sessions; after a stop their recovery is held until `start`.
- A runner whose hub row shows protocol 3 is refused before anything is sent: `RUNNER_HERDR_UNSUPPORTED` names
  `dori runner install --machine <label>` to upgrade it.

The supervisor consumes explicit `herdr.state` transitions and `guard.sample.herdr` snapshots from protocol 4,
with `HERDR_DOWN` / `HERDR_HUNG` (urgent) and `HERDR_UP ... server=<instance>` (digest). For protocol 3 runners:

- Two committed samples in a row with `panes: -1` mark the machine's herdr `down`: `HERDR_DOWN machine=<label> ...`
  (urgent), once. Protocol 3 cannot tell a stopped herdr from a hung one, and -1 also covers a pane list that timed
  out or did not parse. One unreadable sample between readable ones changes nothing.
- The next sample with a pane count marks it `up` again: `HERDR_UP machine=<label> ... after <n> s down` (digest), once.
  A runner's first readable sample is saved as `up` and says nothing. A sample without `panes` changes nothing.
- The state and the time it was entered are saved on the runner's row in `runners.sqlite` (`herdr`, `herdrSince`),
  so they survive a supervisor restart and other `dori` processes read them.
- While a machine's herdr is down or hung the recovery sweep leaves that machine's lanes alone: nothing is read or relaunched
  and no recovery attempt is counted. `dori recover <key>` for such a lane prints `LANE_RECOVERY_HELD <key> ...`.
  After `HERDR_UP` the next sweep recovers them as usual, on their recorded session when they have one.
- `dori launch --machine <label>` is refused at once with `HERDR_DOWN machine=<label> ...`, before any placement
  check or runner call.
- `dori status` shows `herdr <정상|다운|멈춤|미확인>` on each machine line.
- `dori doctor`'s `runner <label>` check is FAIL while that machine's herdr is down (fix `dori runner herdr start
  --machine <label>`) or hung (fix `dori runner herdr restart --machine <label> --yes`); a protocol 3 runner's fix
  starts with `dori runner install --machine <label>`. Its local `herdr` check points a worker machine (a runner
  labelled other than `local` in `~/.dori/runner/runner.json`) at the lead host's `dori runner herdr start` or, without
  a herdr unit, `dori runner install`; the lead host keeps `systemctl --user start herdr-server.service`.
- On the lead host the local runner reports as `machine=local`. While that herdr is down or hung the supervisor does
  not create the lead pane again (`LEAD_PANE_HELD`, once per outage); it does after `HERDR_UP`.

Lane records store `herdrInstance` from the current user's herdr server pids and process start times (`pgrep` /
`ps`). Multiple matching server processes contribute to one sorted identity, so any such process changing
conservatively invalidates old records. `terminalId`, when herdr provides it, additionally fences replacement
terminals within the same server. Unknown server identity refuses a new launch or adoption. A record from an older
runner acquires identity only when its pane exists and a foreground process from that pane's `process-info`
is positively attributed to its key through `DORI_LANE_KEY` ancestry. Persist the stamp once; records already
carrying `herdrInstance` do not request `process-info` for migration. Migration only reads pane state and writes
the lane record. An unproven legacy record counts as absent and recovery opens a new tab without reusing or
mutating its old pane, even if that pane is now an idle shell. Prompt text in argv alone is not ownership proof.

Observe, recover, send, pause, resume, close, asking-screen reads and lane inspection compare the saved identity
before touching the recorded pane. A mismatch means missing (`RUNNER_LANE_ABSENT` for steering); close forgets
the lane without closing a reused pane. Recover resumes the saved session in a new tab, or reuses the restored
tab only if its label still equals the lane key and it contains exactly one idle shell without an agent or
foreground job. Other tabs are left alone. Remote launches without `tabWorkspace` find or create the workspace
labelled `lanes`, so a fresh headless server needs no focused workspace.

## Health and probe

The runner rewrites `~/.dori/runner/health` (`{pid, gen, monotonicMs, wallAt}`, 0600) at start and then every
15 seconds, on a timer of its own. `dori runner probe [--json]` runs on the runner's host and reads it. The age comes
from the file's mtime, so it is measured on the host's own clock.

| Verdict | When | Exit |
|---|---|---|
| `healthy` | the pid is alive and the file is at most 60 s old | 0 |
| `stalled` | the pid is alive and the file is 60 to 120 s old | 1 |
| `dead` | no file, no such process, or the file is older than 120 s | 1 |

The probe also reads the host's herdr once and adds `herdr` (`herdr=` in the text line): `up` when
`herdr workspace list` answers, otherwise `hung` when a `herdr server` process exists (`pgrep -f 'herdr server'`),
`down` when none does, and `unknown` when pgrep cannot tell. It is one reading for diagnosis; the verdict and the exit
code stay the runner's alone.

## Shadow mode (removed)

Shadow mode is gone. The supervisor always opens the hub, `dori supervise` always spawns the local runner as its
child (label `local`), and every lane is runner-owned. A leftover `runners.mode` in the config is ignored, with one
`CONFIG_RUNNERS_MODE_REMOVED` warning per process. `dori runner shadow-report` was removed with it, nothing is
compared against a legacy path any more, and a `shadow_diffs` table left in `runners.sqlite` is ignored.

## Liveness rule

A lane's agent is alive when its pane is in herdr's pane list and its `agent_status` is `idle`, `working`, `blocked`
or `done` (`paneAlive` in `panes.ts`). Both sides use that rule: the runner reports no pane as `missing`, a pane
whose agent is not alive as `dead`, and an alive one as `working` or `idle`; the supervisor applies it to its own
pane list for the runner's machine. A paused lane whose pane is gone is therefore not alive on either side.

## Compatibility

Because validation rejects unknown fields, a new field, optional or not, is a protocol change. Add it as optional
in the schema and bump `PROTO`. The hub accepts runners at its own protocol version and one below (N and N-1),
so a supervisor can be upgraded before its runners. An older runner never sends the new field, and code reading it
must handle its absence. On disk, new hub columns are added with `ALTER TABLE` and read back as optional.

The current protocol is 4, so a supervisor accepts runners at 4 and 3. The runner's `state.sqlite` gained the
nullable `commands.result_json` column in protocol 3; an older file gets it on open and its rows read with no result.

## Liveness and restarts

The supervisor judges each runner by when its heartbeats arrive, on its own monotonic clock; a runner's wall clock is
never used. A supervisor start counts as the last time it saw each runner it knows.

| Silent for | What happens |
|---|---|
| 60 s | `RUNNER_STALE machine=<label>` (digest), once |
| 180 s | `HOST_GUARD OFFLINE machine=<label> runner heartbeat missing ...`, once, and restart decisions start |
| 30 min offline, or the restart circuit open | the runner is lost: `LANE_RUNNER_LOST <key> runner=<label>` (urgent) once for each open lane it owns; nothing is moved |

Each decision runs `dori runner probe --json` on the runner's host: over ssh for a worker, using
`~/.dori/runner/bin/dori.js`, and directly for the local runner. It ends one of three ways:

- **Unreachable** (ssh fails or times out after 20 s, the machine is unknown, or there is no probe answer): no
  restart; the next decision waits 2 min, doubling to 30 min.
- **Alive** (`healthy` or `stalled`): the runner is fine and only its connection is down, so it is not restarted.
  `RUNNER_UNREACHABLE machine=<label>` (digest) is said once per outage.
- **Dead**: a restart is planned as operations row `runner:<label>/restart/<epoch>-<n>`, and then
  the runner's service is restarted on that host (`systemctl --user restart dori-runner.service`, or
  `launchctl kickstart -k` on the recorded launchd domain on macOS). A hello with a higher gen within 2 minutes
  verifies it: `RUNNER_RESTARTED`. Without one the row fails, `RUNNER_RESTART_FAILED` is said, and the next decision
  follows the backoff.

The restart circuit allows 3 restarts per runner per hour. A heartbeat or hello ends an outage, with
`HOST_GUARD ONLINE machine=<label>` when it had gone offline. The runner's unit is separate from herdr's (it only
`Wants=` and is `After=` the herdr unit), so a restart never touches a lane's pane.

`dori status` shows the restarts of the last hour on the runner's machine line (`restarts1h` in `--json`). `dori doctor` checks the listen address, the local
runner directory, and each runner's protocol, outbox backlog and restart circuit.

`dori update` restarts the supervisor first. Only once it is active again does it move the runners, one at a time.
The local runner's unit is restarted; every other runner gets the new bundle the way `dori runner install` sends it.
The update then waits up to 2 minutes for a hello with a higher gen before it goes to the next runner. The first
runner that fails stops the rollout with `RUNNER_UPGRADE_FAILED runner=<label> ...` (urgent), and the runners after
it keep their version.

The urgent runner events are `LANE_RUNNER_LOST`, `LANE_ORPHAN`, `RUNNER_LAUNCH_FAILED`, `RUNNER_FORGED_EVENT`, `RUNNER_AUTH_FAILED`,
`RUNNER_OUTBOX_LARGE` and `RUNNER_UPGRADE_FAILED`. `RUNNER_STALE`, `RUNNER_UNREACHABLE`, `RUNNER_RESTARTED`,
`RUNNER_RESTART_FAILED`, `RUNNER_PROTO_MISMATCH` and `RUNNER_CONFLICT` are digest.

## Command durability

The runner commits a command's intent before the effect and its result after it. A runner that stops between the two
never runs the command again on restart. It settles it from what herdr shows:

- **`lane.start`:** a pane whose process carries `DORI_LANE_KEY=<key>` makes it `verified`, no such pane makes it
  `failed`, and herdr not answering leaves it `ambiguous`.
- **Other commands:** they are `ambiguous`.

Each outcome goes out as `cmd.result` (`RUNNER_CMD_RECOVERED` in the runner's log).

A command whose `cmdId` already has a final record is not checked or run again: the runner answers it once more with
that record's `cmd.result` (state, detail and stored `result`, with the record's `cmdSeq`) and logs
`RUNNER_CMD_REPLAYED`, so a supervisor that resends an operation gets its answer. A `cmdId` still at `intent` (its
effect is running, or a restart will settle it as above) is left alone.

After its own restart the supervisor reads an attempted command back with `cmd.status`. A runner with no record of
it (`unknown`, for example after its state was lost) is not sent the same command again. The supervisor asks
`lane.observe` instead:

- the lane present makes the command `verified`;
- its absence proven allows one more attempt;
- anything else is `OPERATION_AMBIGUOUS` for the lead, and nothing is resent.

Command records are kept 30 days.

## Runner-owned lanes

Every lane is runner-owned. `dori launch` starts a local lane through the local runner, the supervisor's child, and
`dori launch --machine <label>` starts it through that machine's runner. There's no direct herdr path and no mode
that picks one: `runners.mode` is ignored (`CONFIG_RUNNERS_MODE_REMOVED`). A lane whose runner is down waits for it,
and losing a runner never hands the lane back to the supervisor.

**Launch.** `dori launch` registers the lane at once with `runner: <label>` and appends the runner footer to the
brief. It then queues `lane.start` for the supervisor (`runner_admin` in `runners.sqlite`), which sends it once the
runner is connected; a request waits at most 2 minutes. A runner launch needs `--cwd` and takes no `--pane`,
`--workspace` or `--toodo-start`. On the worker, the runner:

- checks the command against `runner-config.json` (the `cwd` must be under `allowedRoots`);
- opens a herdr tab labelled with the key, writes the brief to `~/.dori/runner/briefs/<key>.md` and issues the lane a
  fresh 32-byte token;
- runs the agent of its own profile `default` (`agents.default`, with `{prompt}`, `{model}` and `{brief}` filled in),
  with `DORI_LANE_KEY` and `DORI_LANE_TOKEN` in front of it. The lead never sends an argv.

The runner keeps only the token's sha256, with the lane's pane, tab and cwd, in `~/.dori/runner/lanes.json`; that is
its hello inventory. Its `lane.started` gives the supervisor the pane and tab. `lane.close` and `lane.stop` close the
tab, delete the brief and forget the token. `lane.recover` starts the lane again from its brief when its pane or agent
is gone, and leaves a live one alone. The agent runs in the herdr pane, not under the runner, so a runner restart
does not end a lane.

**Reporting.** A runner lane's footer has it report with `~/.dori/runner/bin/dori` (a wrapper the installer puts there
for the bundle). In a lane that CLI takes only `report`, `claim-done` and `heavy`, and only for the lane's own key; any
other command exits 2 with `DORI_CLI_UNSUPPORTED_ON_RUNNER <cmd>`. A report goes over `~/.dori/runner/sock/lane`
with the lane's token. The runner refuses a token that is not that key's own (`RUNNER_LANE_AUTH_FAILED`) and puts an
accepted report in its outbox as `lane.report`. `heavy` takes the host's `~/.dori/heavy/slot.N`, the same slots
`guard-agent.sh heavy` uses, so old and new footers share one heavy count per machine.

**Ownership.** The supervisor takes a lane event only from the runner that `Lane.runner` names, over that runner's
authenticated connection. Anything else (another runner's lane, a lane no runner owns, a key the registry does not
have) is dropped as `RUNNER_FORGED_EVENT runner=<label> key=<key>` (urgent). A `lane.report` becomes a row of the lane
report store whose `source` is the event's journal id (`runner:<label>:<seq>`), so the same event never makes two
rows. From there it is routed exactly as a local `dori report`: a done report becomes the claim through `claimDone`
(the same evidence again is `LANE_DONE_ALREADY_CLAIMED`); the rest is journaled or posted to the thread. The
supervisor reads lane events back from the hub's own journal on every runners pass, from the start after a restart,
so an event acked just before a crash is still stored. The first report from a runner lane also ends the screen
scraping of its `[REPORT]` lines.

**Inventory.** On each hello the supervisor compares the runner's inventory with the registry:

- a lane the runner owns that the inventory lacks is marked `recoveryPending` and sent `lane.recover`;
- a key with no open lane in the registry is `LANE_ORPHAN <key>` and gets no registry entry;
- a lane in both whose pane, tab or session differs takes the runner's values for those three only.

**Evacuate.** `dori runner evacuate <label>` is the forced rollback for a runner that cannot be used. In order:

1. It fetches the runner's unacked events over ssh (`runner export-outbox`) and takes them as if they had arrived,
   so a report already received is not stored twice.
2. It types a footer update into each lane's pane: go back to printing `[REPORT]` lines.
3. It clears `Lane.runner`, which puts the lane back on the screen-scraping path.
4. It stops the runner's service: the systemd unit on Linux, or on macOS the launchd agent (disabled and booted out).

The lanes keep running. A step that fails is reported, and the later steps still run.
