# Runner protocol

The runner is a small per-machine process (`dori runner serve`) that talks to the supervisor over one line-based
connection: a unix socket on the lead host, or a WebSocket on a private address for other machines. Both sides
authenticate every connection. A runner reports what it sees on its machine. On a worker whose `runners.mode` is
`authoritative` it also starts, steers and closes the lanes launched there (below), and every worker's runner guards
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
  `cmd.status.result {cmdId, state, detail?}`.
- Supervisor to runner: `enroll.ok`, `hello.challenge {nonce, dh, sig, keyFp}`, `hello.ok {proto, epoch, eventAck}`,
  `hello.reject {code, detail}`, `rotate.ok`, `ack {eventAck}`, `cmd.status {cmdId}`.

`hello` must be the first frame on a connection (after an `enroll` connection has closed). After the handshake
(below) the hub applies its hello rules: `RUNNER_PROTO_MISMATCH` when the protocol version isn't accepted, then the
fencing rules in [Fencing](#fencing).

Runner events are defined for `lane.started`, `lane.state`, `lane.report`, `lane.asking`, `lane.progress`,
`wait.result`, `job.result`, `guard.sample`, `guard.alert`, `guard.critical`, `heavy.state` and `cmd.result`. Today
a runner publishes `lane.state`, `lane.progress`, `cmd.result` and, on a worker, `lane.started`, `lane.report` and
the three `guard.*` events. Supervisor commands (`lane.start`, `lane.stop`, `lane.pause`, `lane.resume`,
`lane.recover`, `lane.send`, `lane.close`, `lane.observe`, `wait.check`, `job.run`, `guard.kill`, `runner.rotate`)
are part of the schema. A worker's runner carries out `lane.start`, `lane.stop`, `lane.close`, `lane.send`,
`lane.recover`, `lane.observe` and `guard.kill` (see [Runner-owned lanes](#runner-owned-lanes)); `runner.rotate` is
handled by the connection itself. Every command the runner receives goes through the command policy (below): a refused one is
answered `cmd.result failed RUNNER_CMD_REJECTED <rule>`, a carried-out one `cmd.result verified <detail>`, and an
accepted one that this release cannot carry out yet `cmd.result failed RUNNER_CMD_UNSUPPORTED <type>`. Both get an
intent row and a final row, so `cmdAck` moves past them and they are not sent again. A command with an unknown type
or field still gets an answer instead of being dropped.

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
refused.

| Key | Meaning | Default |
|---|---|---|
| `agents` | profile name to argv; `lane.start.agentProfile` must name one | none |
| `allowedRoots` | directories every `cwd` must be under | none |
| `sandbox` | `required` refuses `lane.start` with `sandbox: false` | `optional` |
| `jobs` | `deny` refuses `job.run` and `wait.check` | `allow` |
| `guard` | this host's guard thresholds (`loadAlert`, `loadOk`, `memFreeMinPct`, `memFreeCritPct`, `swapFreeCritPct`, `diskFreeMinGb`, `panesMax`), each optional | the config's `guard` |
| `heavyKill` | command-line patterns killed under critical memory | the config's `heavyKill` |

A refusal is `RUNNER_CMD_REJECTED <rule>` with one of these rules: a schema rule from frame validation (such as
`unknown-field` or `unknown-type`), `agent-profile`, `cwd-missing` (the path does not resolve), `cwd-outside-roots`
(compared by path segment after resolving symlinks on both sides, so `/data/repos-evil` is not under `/data/repos`),
`sandbox-required`, `command-not-argv` (a `job.run` command that is not an array of strings) or `jobs-denied`.
`guard.kill` accepts only lane keys.

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
- `seq > eventAck + 1`: a gap. Nothing is committed and the unchanged `eventAck` is acked.

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
| `state.sqlite` (+ `-wal`, `-shm`) | `gen`, highest seen epoch, command rows (kept 30 days) |
| `outbox.sqlite` (+ `-wal`, `-shm`) | the outbox |
| `bodies/<seq>.body` | moved report and job bodies |
| `keys/runner.key`, `keys/supervisor.pub` | the runner's private key and the pinned supervisor key (`keys/runner.next.key` during a rotation) |
| `runner-config.json` | the command policy (optional) |
| `health` | `{pid, gen, monotonicMs, wallAt}`, rewritten every 15 s |
| `bin/dori.js` | the runner bundle, on workers installed by `dori runner install` |
| `sock/control` | the unix socket the supervisor listens on and the runner connects to |

The hub's table is `<stateDir>/runners.sqlite` on the supervisor side.

Directories must be 0700 and files 0600, owned by the runner's uid, with no symlinks anywhere. `dori runner serve`
checks this with lstat before opening anything; on the first bad entry it prints `RUNNER_DIR_UNSAFE <path> <reason>`
to stderr and exits 1. It never repairs permissions. The supervisor creates `~/.dori/runner` and `sock/` as 0700
when they're missing, and the socket itself is 0600.

There's no peer credential check on the socket. Bun's unix sockets don't expose the peer's uid (no `SO_PEERCRED`).
The 0700 `sock/` directory keeps other users out, and the signed handshake keeps another process of the same user
from posing as the supervisor or the runner.

## Remote install

`dori runner install --machine <label>` puts a runner on a Linux worker. The machine is looked up like the guard's
machines (herdr's saved machines plus `guardMachines`), and `runners.listen` must be set; otherwise it stops with
`RUNNER_INSTALL_NO_LISTEN`. The supervisor issues the enrollment code in its own process and runs
`ssh <target> sh -s`. That command line never changes: everything else goes on ssh's stdin as one sh script.

- The bundle is `bun build src/runner/bin.ts --target=bun`, a single file holding only the runner. It is written to
  `~/.dori/runner/bin/dori.js` through a temporary file and `mv`. The worker needs `bun` on its PATH.
- `~/.config/systemd/user/dori-runner.service` (from `templates/dori-runner-remote.service`) runs
  `bun ~/.dori/runner/bin/dori.js runner serve --label <label> --connect ws://<runners.listen>`. It has no
  `EnvironmentFile`: a worker holds no supervisor or Discord credentials.
- The enrollment code and the supervisor fingerprint are shell variables in the script. They reach
  `runner serve --enroll-only` through a pipe from the `printf` builtin, so they appear in no process's argv on either
  machine. A worker that already has `~/.dori/runner/keys/supervisor.pub` skips enrollment: a reinstall or an upgrade
  keeps its keys.
- Then linger is turned on and the unit is enabled and restarted, so a new bundle takes effect.

It prints `RUNNER_INSTALLED runner=<label> version=<first 12 hex of the bundle's sha256>`, or exits 1 with
`RUNNER_INSTALL_UNREACHABLE` (ssh failed or timed out), `RUNNER_INSTALL_UNSUPPORTED` (not Linux, or no POSIX shell),
`RUNNER_INSTALL_NO_BUN`, `RUNNER_INSTALL_ENROLL_FAILED` or `RUNNER_INSTALL_FAILED` (with the systemd or linger step
named when that failed).

## Guard

A worker's runner (one started with `--connect`) samples its host every 30 seconds with the same readings the
supervisor takes of its own host, judged against `runner-config.json`'s `guard` thresholds:

- `guard.sample {level, reasons, sampledAt, load1, memFreePct, diskFreeGb, swapFreeGb, swapTotalGb, os}` goes out once
  a minute and on every level change (`ok`, `alert`, `critical`); `guard.alert {reasons}` on entering alert or
  critical.
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

## Health and probe

The runner rewrites `~/.dori/runner/health` (`{pid, gen, monotonicMs, wallAt}`, 0600) at start and then every
15 seconds, on a timer of its own. `dori runner probe [--json]` runs on the runner's host and reads it. The age comes
from the file's mtime, so it is measured on the host's own clock.

| Verdict | When | Exit |
|---|---|---|
| `healthy` | the pid is alive and the file is at most 60 s old | 0 |
| `stalled` | the pid is alive and the file is 60 to 120 s old | 1 |
| `dead` | no file, no such process, or the file is older than 120 s | 1 |

## Shadow mode

A runner is in shadow mode when the config's `runners.mode` maps its label to `"shadow"`; unnamed labels are
`"off"`. Without a `runners` section the supervisor opens no hub and nothing changes. In shadow mode the local
runner reads the registry's open local lanes and herdr's pane list every 30 seconds, publishes
`lane.state {key, status, pane}` when a lane's status or pane changes, and sends the latest list as the hello
inventory. A lane it no longer sees is forgotten, so it is published again if it comes back. `pane` was added in
protocol 2; a protocol 1 runner leaves it out, and the supervisor then relies on the hello inventory alone. It never
starts, stops or edits a lane.

A lane's agent is alive when its pane is in herdr's pane list and its `agent_status` is `idle`, `working`, `blocked`
or `done` (`paneAlive` in `panes.ts`). Both sides use that rule: the runner reports no pane as `missing`, a pane
whose agent is not alive as `dead`, and an alive one as `working` or `idle`; the supervisor applies it to its own
pane list for the runner's machine. A paused lane whose pane is gone is therefore not alive on either side.

A runner started with `--connect` is a worker's runner. It has no registry, so it always observes its host on the
same 30-second timer. A pane belongs to a lane when one of its foreground processes (from `herdr pane
process-info`) has `DORI_LANE_KEY` in its environment or inherits it from an ancestor. For each such pane it also
hashes the newest `[REPORT]` line in the pane's last 200 lines and publishes `lane.progress {key, reportHash}` when
that hash changes. The line itself never leaves the host. The supervisor compares only the labels its own
`runners.mode` marks `shadow`. For a remote lane it also compares the runner's hash with the hash of the line its
own screen scraping recorded (`Lane.lastRemoteReport`), as `kind=lane.report field=latest`.

On the supervisor, the `runners` task (every 5 seconds, under the usual watchdog) compares what the runner reported
with what the legacy path sees. Per lane it compares the pane id (the registry's against the runner's, taken from
the hello inventory and replaced by the `pane` of each later `lane.state`) and whether the agent is alive. If the
supervisor can't read the pane list for a runner's machine in a pass, it logs the error and compares no lane states
for that runner in that pass. A lane that is closed (archived and no longer open) is dropped from the runner's side
and never reported; a key that is neither open nor archived is still `missing-in-legacy`.

The runner observes every 30 seconds while the supervisor compares every 5, so a difference is reported with its
class only once it has lasted the settle window of 65 seconds (two observation periods plus 5 seconds). One that goes
away sooner is logged once as `timing`. A reported difference that persists is reported again only after another
full settle window:

```
RUNNER_SHADOW_DIFF runner=<label> class=<c> kind=<k> lane=<key> gen=<n> field=<f> runnerHash=<h|-> legacyHash=<h|->
```

| Class | Meaning |
|---|---|
| `missing-in-runner` | the legacy path has the value, the runner doesn't |
| `missing-in-legacy` | the runner has the value, the legacy path doesn't |
| `value-differs` | both have it, with different values |
| `timing` | a difference that went away within the settle window; not a failure |

Every reported difference is also stored in `<stateDir>/runners.sqlite` (table `shadow_diffs`). `dori runner
shadow-report [--runner <label>]` prints one line per runner,
`RUNNER_SHADOW_REPORT runner=<label> failures=<n> missing-in-runner=<n> missing-in-legacy=<n> value-differs=<n> timing=<n>`,
where `failures` counts every class but `timing`, or `RUNNER_SHADOW_REPORT none` when nothing was recorded.

The `gen` in a `RUNNER_SHADOW_DIFF` line is the lane generation (the lane's `lastRecoveryAt`, or 0 for a lane never
recovered), not the runner's boot generation that `dori status` shows as `RUNNER <label> ... gen=<n>`.

Values are compared as short sha256 hashes. Guard verdicts compare level and reasons, never raw figures. If the
hub can't open (an unsafe directory, a bad socket file) the supervisor logs `RUNNER_HUB_DISABLED` and keeps running.

## Compatibility

Because validation rejects unknown fields, a new field, optional or not, is a protocol change. Add it as optional
in the schema and bump `PROTO`. The hub accepts runners at its own protocol version and one below (N and N-1),
so a supervisor can be upgraded before its runners. An older runner never sends the new field, and code reading it
must handle its absence. On disk, new hub columns are added with `ALTER TABLE` and read back as optional.

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
  `systemctl --user restart dori-runner.service` runs on that host. A hello with a higher gen within 2 minutes
  verifies it: `RUNNER_RESTARTED`. Without one the row fails, `RUNNER_RESTART_FAILED` is said, and the next decision
  follows the backoff.

The restart circuit allows 3 restarts per runner per hour. A heartbeat or hello ends an outage, with
`HOST_GUARD ONLINE machine=<label>` when it had gone offline. The runner's unit is separate from herdr's, so a
restart never touches a lane's pane.

`dori status` shows the restarts of the last hour (`restarts1h`). `dori doctor` checks the listen address, the local
runner directory, and each runner's protocol, outbox backlog and restart circuit.

`dori update` restarts the supervisor first. Only once it is active again does it move the runners, one at a time.
The local runner's unit is restarted; every other runner gets the new bundle the way `dori runner install` sends it.
The update then waits up to 2 minutes for a hello with a higher gen before it goes to the next runner. The first
runner that fails stops the rollout with `RUNNER_UPGRADE_FAILED runner=<label> ...` (urgent), and the runners after
it keep their version.

The urgent runner events are `LANE_RUNNER_LOST`, `LANE_ORPHAN`, `RUNNER_FORGED_EVENT`, `RUNNER_AUTH_FAILED`,
`RUNNER_OUTBOX_LARGE` and `RUNNER_UPGRADE_FAILED`. `RUNNER_STALE`, `RUNNER_UNREACHABLE`, `RUNNER_RESTARTED`,
`RUNNER_RESTART_FAILED`, `RUNNER_PROTO_MISMATCH` and `RUNNER_CONFLICT` are digest.

## Command durability

The runner commits a command's intent before the effect and its result after it. A runner that stops between the two
never runs the command again on restart. It settles it from what herdr shows:

- **`lane.start`:** a pane whose process carries `DORI_LANE_KEY=<key>` makes it `verified`, no such pane makes it
  `failed`, and herdr not answering leaves it `ambiguous`.
- **Other commands:** they are `ambiguous`.

Each outcome goes out as `cmd.result` (`RUNNER_CMD_RECOVERED` in the runner's log).

After its own restart the supervisor reads an attempted command back with `cmd.status`. A runner with no record of
it (`unknown`, for example after its state was lost) is not sent the same command again. The supervisor asks
`lane.observe` instead:

- the lane present makes the command `verified`;
- its absence proven allows one more attempt;
- anything else is `OPERATION_AMBIGUOUS` for the lead, and nothing is resent.

Command records are kept 30 days.

## Runner-owned lanes

`runners.mode.<label>` decides how new lanes start on a worker. With `authoritative`, `dori launch --machine <label>`
starts the lane through that machine's runner; `shadow`, `off` and no entry keep the direct herdr path. `off` stops
new runner launches only: a lane a runner already owns keeps reporting and being controlled through it until it
closes, so nothing it sends is lost.

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
have) is dropped as `RUNNER_FORGED_EVENT runner=<label> key=<key>` (urgent). The one exception is a shadow runner's
observation: a `lane.state` or `lane.progress` from a runner whose `runners.mode` is `shadow`, about an open lane that
no runner owns on that runner's own machine (no `machine` for the local runner, `machine` equal to the label for a
worker's), goes only to the shadow comparison and is not journaled. These two types only report what the runner sees.
The same runner's `lane.started`, `lane.report` or `lane.asking` about such a lane would act on it, so they are still
forged, as is an observation about a closed lane, another machine's lane, another runner's lane, or from a runner
not in shadow mode. A `lane.report` becomes a row of the lane
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
4. It stops the runner's service.

The lanes keep running. A step that fails is reported, and the later steps still run.
