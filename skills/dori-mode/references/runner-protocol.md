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

- Runner to supervisor: `enroll`, `hello {proto, gen, label, hostId, cmdAck, version?, inventory?, workspaces?, detected?, worktreeRoot?, nonce, dh}`,
  `auth.proof {sig}`, `runner.rotated {cmdId, runnerPubKey, sig}`, `heartbeat {outbox?: {unacked, oldestAgeMs}}`,
  `cmd.status.result {cmdId, state, detail?}`, `q.result {qid, ok, detail, result?}` (protocol 3, see [Queries](#queries)),
  `secret.get {rid, key, names, repo?}` and `secret.run {rid, key, op, repo?}` (protocol 6, see [Secrets](#secrets-over-the-link)).
- Supervisor to runner: `enroll.ok`, `hello.challenge {nonce, dh, sig, keyFp}`, `hello.ok {proto, epoch, eventAck}`,
  `hello.reject {code, detail}`, `rotate.ok`, `ack {eventAck}`, `cmd.status {cmdId}`, and the queries `q.panes`,
  `q.screen`, `q.process`, `q.stat`, `q.lane.inspect`, `q.machine.observe` (protocol 3), and `secret.value` and
  `secret.run.result {rid, ok, code?, detail?, sealed?: {n, c}}` (protocol 6). The secret frames are control frames: no
  `seq`/`cmdSeq`, never queued, journaled or logged.

`hello` must be the first frame on a connection (after an `enroll` connection has closed). After the handshake
(below) the hub applies its hello rules: `RUNNER_PROTO_MISMATCH` when the protocol version isn't accepted, then the
fencing rules in [Fencing](#fencing).

Runner events are defined for `lane.started`, `lane.state`, `lane.report`, `lane.asking`, `lane.progress`,
`lane.ack`, `wait.result`, `job.result`, `guard.sample`, `guard.alert`, `guard.critical`, `herdr.state`, `herdr.start`, `heavy.state` and `cmd.result`. Today
a runner publishes `lane.state`, `lane.progress`, `cmd.result`, `wait.result` and `job.result` and, on a worker, `lane.started`, `lane.report` and
the three `guard.*` events. Supervisor commands (`lane.start`, `lane.stop`, `lane.pause`, `lane.resume`,
`lane.recover`, `lane.send`, `lane.close`, `lane.observe`, `wait.check`, `job.run`, `guard.kill`, `host.herdr`, `runner.rotate`)
are part of the schema. A worker's runner carries out `lane.start`, `lane.stop`, `lane.close`, `lane.send`,
`lane.recover`, `lane.observe` and `guard.kill` (see [Runner-owned lanes](#runner-owned-lanes)); every runner, the local one
included, carries out `wait.check` and `job.run` (see [Runner-owned waits and jobs](#runner-owned-waits-and-jobs)); `runner.rotate` is
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
`lane.close` `{closed: tab|pane|none, gone}`, `lane.pause` `{goal?, working?, stopped?}`, `lane.resume` `{goal, execution?}` (`/goal resume`, then `/resume` when the pane shows omo's Esc-paused footer, then the turn read back: `running` or `held`),
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

## Network link

A worker's runner listens and the supervisor dials it. The runner runs
`dori runner serve --label <label> --listen <host>:<port>` and accepts one WebSocket connection at a time; a second
connection while one is open is refused. The supervisor reads `<stateDir>/runner-endpoints.json`, an object mapping
labels to `host:port` (`{"worker-a":"100.101.1.2:7411","worker-b":"[fd12::1]:7411"}`), dials each endpoint next to
its local unix socket, and redials after a failure or close with backoff: 1 s doubling to 60 s, scaled by a random
0.8 to 1.2. It rereads the file every second, so an added, changed or removed endpoint takes effect without a
restart; a removed one stops its retries and closes its connection. `dori runner install` writes the entry (mode 0600,
replaced atomically, other labels kept). The host is the worker's ssh target with the user and port stripped,
resolved on the supervisor to one private address: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
100.64.0.0/10 (tailnet), fd00::/8 or ::1. A wildcard or public result fails with `RUNNER_LISTEN_REFUSED`, a lookup
failure with `RUNNER_LISTEN_RESOLVE_FAILED`. The port is 7411. There is no `runners` config section any more.

## Command policy

The runner checks every command against `<runnerDir>/runner-config.json` before it records or runs anything. The
file is optional; without it there are no agent profiles and no allowed roots, so every command that needs one is
refused. `dori runner install` writes a starter file when the worker has none: `agents.default` is the lead's
`agentCommand` (the profile every runner launch names) and `allowedRoots` is the worker's `$HOME` plus its temp
directory (`/tmp` on Linux, `/private/tmp` on macOS). An existing file is never rewritten. A `lane.start` the runner
refuses or fails leaves the lane without an agent and raises `RUNNER_LAUNCH_FAILED <key> runner=<label> <detail>`
(urgent); the supervisor's own recovery never relaunches a runner-owned lane, which only its runner recovers
(`lane.recover`).

Edits apply without restarting the runner. It watches `runner-config.json` (the local runner also watches the
`config.json` its derived policy and guard defaults come from), debounced by 0.5 s, with a stat check every 30 s for
filesystems that miss watch events. A file that loads and validates replaces the live policy in place: the next command,
query and guard tick use it, and running lanes are left alone. `RUNNER_CONFIG_RELOADED <keys>` is logged and sent as a
`runner.config` event (`state` `reloaded`), which the supervisor journals for the lead as digest
`RUNNER_CONFIG_RELOADED runner=<label> <keys>`. When the reported workspaces change, the runner reconnects at once so
its next hello carries them; unacked events replay from the outbox as after any reconnect. A file that does not load
or validate keeps the last good policy: `RUNNER_CONFIG_INVALID <why>` (state `invalid`). On the local runner a changed
`diskGuardPath` applies only after a restart: `RUNNER_CONFIG_RESTART_NEEDED` (state `restart`).

| Key | Meaning | Default |
|---|---|---|
| `agents` | profile name to argv; `lane.start.agentProfile` must name one | none |
| `allowedRoots` | directories every `cwd` must be under, besides the lanes directory, `reposRoot` and the effective worktree root, which are always added; optional, see [Derived allowed roots](#derived-allowed-roots) | derived |
| `sandbox` | `required` refuses `lane.start` with `sandbox: false` | `optional` |
| `sandboxCheck` | argv run before a `lane.start` with `sandbox: true`; a non-zero exit refuses it with `sandbox-unavailable` and its stderr. `dori runner install` sets it to `lane-sandbox --check` on Linux and macOS, where it also ships the wrapper (bubblewrap on Linux, Seatbelt `sandbox-exec` on macOS) and sets `sandbox: required`; Windows has no lane sandbox, so it gets `sandbox: optional`, only the `default` profile and no `sandboxCheck` (an older install's `lane-sandbox` profile and check are removed); the lead starts its lanes unsandboxed with `SANDBOX_SKIPPED` | none |
| `jobs` | `deny` refuses `job.run`, `wait.check`, `lane.git` and a `q.lane.inspect` with `done` | `allow` |
| `guard` | this host's guard thresholds (`loadAlert`, `loadOk`, `memFreeMinPct`, `memFreeCritPct`, `swapFreeCritPct`, `diskFreeMinGb`, `panesMax`), each optional | the config's `guard` |
| `heavyKill` | command-line patterns killed under critical memory | the config's `heavyKill` |
| `reposRoot` | the directory whose direct children are this host's repos for placement, absolute or `~/...`; see [Workspace placement](#workspace-placement) | none |
| `worktreeRoot` | where lanes on this host create their git worktrees, absolute or `~/...`; reported in the hello | `<reposRoot>/worktrees` when `reposRoot` is set, else none |
| `workspaces` | overrides for discovered repos: `{"owner/repo": "<checkout path>"}`, absolute or `~/...`; an entry replaces the discovered path of that repo (case-insensitive) or adds a repo not under `reposRoot` | none |
| `detectWorkspaces` | `false` turns off the scan of `allowedRoots` for checkouts (`detected`); `dori runner setup` does not ask it (`--set detectWorkspaces=false`) | `true` |

A `lane.start` without `cwd` (`dori launch --machine M` with no `--cwd`) starts in its own directory `<runnerDir>/lanes/<key>`
(`~/.dori/runner/lanes/<key>`, `%USERPROFILE%\.dori\runner\lanes\<key>` on Windows). The runner fills it before the
`allowedRoots` check, creates it (0700) when the start runs, and the `lane.start` result reports it as `cwd`. The
runner creates `<runnerDir>/lanes` at start and always admits it as an allowed root (unless a listed root already holds
it); the runner-directory safety check audits each `lanes/<key>` directory itself but not what the lane puts in it.
A key that cannot name a directory is refused `cwd-missing`. The lane sandbox (Linux and macOS) lets such a lane read
and write its own directory; update the wrapper (`dori runner update`) on a host that still has an older one.

The former `defaultCwd` key is retired. A runner-config.json that still holds it loads as before, the key is ignored
and each load logs one `RUNNER_CONFIG_KEY_IGNORED defaultCwd: ...` line; `dori runner setup` removes it.

A refusal is `RUNNER_CMD_REJECTED <rule>` with one of these rules: a schema rule from frame validation (such as
`unknown-field` or `unknown-type`), `agent-profile`, `cwd-missing` (the path does not resolve), `cwd-outside-roots`
(compared by path segment after resolving symlinks on both sides, so `/data/repos-evil` is not under `/data/repos`),
`sandbox-required`, `sandbox-unavailable` (the `sandboxCheck` failed; it arrives inside a `RUNNER_CMD_FAILED` detail), `command-not-argv` (a `job.run` command that is not an array of strings) or `jobs-denied`.
`guard.kill` accepts only lane keys. Every `cwd` (`lane.start`, `lane.adopt`, `job.run`, `wait.check`) and
`lane.git.root` is checked the same way: absolute, resolving, under `allowedRoots`.

### Derived allowed roots

A runner-config.json without `allowedRoots` (or with `[]`) gets these roots instead, then `reposRoot` and the
effective worktree root as always:

- the runner's temp directory (`os.tmpdir()`: `$TMPDIR`, else `/tmp` on Linux; the per-user `$TMPDIR` on macOS;
  `%TEMP%` on Windows), where lanes and jobs keep scratch files;
- the runner's home only when the file sets neither `reposRoot` nor `worktreeRoot`. Such a file names no other place
  to work, and that is the root `dori runner install`'s starter gives. A file that does name a repo location keeps
  home out, because home would admit every file the runner's user owns, the runner directory and its keys included.

The lanes directory is added after these, so a `lane.start` without `cwd` passes the check on every host. A listed
`allowedRoots` is used as written and nothing is derived. A worker without any runner-config.json keeps no roots at all (it has no agent
profile either), and the local runner without the file keeps the policy derived from config.json.

### Workspace placement

A runner tells the supervisor which repos live on its host, and `dori launch` places work by it (see
`dori placement` in scripts.md). Each hello carries two optional lists of `{repo, path}`:

- `workspaces`: the declared repos. Every directory directly under `reposRoot` that holds a `.git` directory is one
  (symlinks not followed; dot folders, the effective worktree root and linked worktrees, whose `.git` is a file, are
  skipped), named by the owner/repo of its `origin`; a directory without an origin is skipped. When two directories
  share an origin (case-insensitive) the first by name is kept and each scan logs
  `RUNNER_WORKSPACE_DUPLICATE <repo> <kept> <skipped>`. Runner-config `workspaces` entries then replace the discovered
  path of their repo or add one. Each path must pass the same check as a `cwd` (absolute, resolving, under
  `allowedRoots`); one that fails is left out and logged `RUNNER_WORKSPACE_SKIPPED <repo> <rule> <path>`. These decide
  placement: a launch for a declared repo goes to that runner and holds while it is offline. A repo several runners
  declare is not an error: each is a candidate, and the launch takes the first with room (`dori launch` in scripts.md).
- `detected`: directories with a `.git` directory, up to three levels below an allowed root (dot folders,
  `node_modules` and, on macOS, the TCC-guarded home folders skipped; a worktree's `.git` file is not a checkout),
  whose `origin` names an owner/repo the runner does not declare, and not under the worktree root; at most 200.
  Information only: such a repo follows `placement.defaultMachine`.
- `worktreeRoot`: the effective worktree root, absolute (runner-config `worktreeRoot`, else `<reposRoot>/worktrees`;
  the local runner without either reports config.json `worktreeRoot`), sent only when there is one. A lane placed on this runner creates its worktrees there (its brief footer says so).

The runner caches the report and rescans when `reposRoot` changes: it watches `reposRoot` with `fs.watch`
(non-recursive; inotify on Linux, FSEvents on macOS), debounced by 2 s, rescans every 5 minutes as a fallback (also
re-arming a watch that failed, `RUNNER_REPOS_WATCH_FAILED <detail>`, or a `reposRoot` that did not exist yet), and
rescans after a runner-config reload. A report that changed is sent with a new hello.

The hub stores the three in the `runners.workspaces` column at each hello that carries any of them, and keeps the last report
while the runner is away. The local runner (no runner-config.json) reports the same way: a runner-config.json
holding only `workspaces`, `detectWorkspaces`, `reposRoot` and `worktreeRoot` adds them to the policy derived from
config.json; a file with any other key is the whole policy, as before. Every runner-config.json (a remote runner's
too) gets `reposRoot` and the effective worktree root added to `allowedRoots`, so they need not be listed. The fields need no protocol bump, but a supervisor older than them refuses
the hello `unknown-field`, so update the supervisor before its runners.

## Runner-owned waits and jobs

A wait (`dori wait --machine`), poll source or command schedule (`--machine`) that names a runner is carried out on
it. The supervisor keeps the scheduling, dedupe and journal; it sends each check or run over `RunnerCall` and waits
for the `cmd.result`. A runner that is not connected fails the call at once with `RUNNER_UNAVAILABLE`. Both commands
need protocol 5 (`NEEDS_PROTO`); there is no protocol bump. A runner without the handler answers `cmd.result failed
RUNNER_CMD_UNSUPPORTED <type>`. Under `jobs: deny` both are refused (`jobs-denied`), and `cwd` must be absolute,
existing and under `allowedRoots`.

| Command | Body | `cmd.result` result |
| --- | --- | --- |
| `wait.check` | `{cmdId, waitId, signal, cwd}` | `{met, error?}` |
| `job.run` | `{cmdId, opKey, name, command: string[], cwd, timeoutSec, heavy}` | `{exitCode, timedOut, output, err}` |

- `wait.check` runs the `Done =` signal once in `cwd`, bounded by 10 s. A met check also publishes
  `wait.result {waitId, outcome: WAIT_DONE, detail}` (detail at most 500 characters), which the supervisor settles as
  the same `WAIT_DONE` a local check gives; an unmet or failed check publishes nothing. A check that throws answers
  `{met: false, error}`. The supervisor allows 20 s past the check's bound.
- `job.run` runs the argv in `cwd`, killed after `timeoutSec`, and publishes one `job.result {opKey, state:
  verified|failed, exitCode, output}` per run (journal only). `output` is capped at 64 KiB and `err` at 4 KiB, cut on
  a UTF-8 character boundary. `heavy: true` is not supported on a runner and fails before anything runs. The
  supervisor allows 30 s past `timeoutSec`; a failed or malformed answer is `RUNNER_JOB_REFUSED runner=<label>`.

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

On Windows the runner dir is `%USERPROFILE%\.dori\runner` and the same walk checks DACLs instead of modes. Each
entry's owner must be the runner user's SID. Allow ACEs may name only that user, SYSTEM, Administrators, and
CREATOR OWNER when it's inherit-only; anything else gives `RUNNER_DIR_UNSAFE <path> acl allow=<sid>`. A wrong owner
gives `owner owner=<sid>`. The runner dir itself must be protected (inheritance off), or it fails with
`acl dacl=unprotected`, and a missing or null DACL fails too. Reparse points count as symlinks (junctions included),
except an AF_UNIX socket directly under `sock\`. UNC paths fail as `remote unc` before anything is read. There's no
chmod and the database lock-down is skipped. Socket paths over 107 UTF-8 bytes fail with
`RUNNER_SOCKET_PATH_TOO_LONG`. Mapped network drives aren't detected yet.

## Remote install

`dori runner install <target> [--label <label>]` or `dori runner install --machine <label>` puts a runner on a Linux, macOS or Windows worker (Windows is covered at the end of this section). With `--machine` the machine is looked up like the guard's
machines (herdr's saved machines plus `guardMachines`); a positional target is used as given and, once installed, is
saved in `<stateDir>/runner-machines.json` so the guard knows it too. The listen address comes from the target (see
[Network link](#network-link)) and is recorded in `runner-endpoints.json` only after enrollment and the service
install succeed. The supervisor issues the enrollment code in its own process and runs
`ssh <target> sh -s`. That command line never changes: everything else goes on ssh's stdin as one sh script.
`dori runner remove <label>` undoes an install: it removes the runner service and `~/.dori/runner` (keys included) on
the worker, leaves herdr running, and only then revokes the runner and drops it from both state files.

- The bundle is `bun build src/runner/bin.ts --target=bun`, a single file holding only the runner. It is written to
  `~/.dori/runner/bin/dori.js` through a temporary file and `mv`. A Linux worker needs `bun` on its PATH. A macOS
  worker takes it from the PATH, `~/.dori/runner/bun/bun`, `/opt/homebrew/bin`, `/usr/local/bin` or `~/.bun/bin`, and
  otherwise downloads the latest release into `~/.dori/runner/bun`.
- On Linux, `~/.config/systemd/user/dori-runner.service` (from `templates/dori-runner-remote.service`) runs
  `bun ~/.dori/runner/bin/dori.js runner serve --label <label> --listen <host>:7411`. It has no
  `EnvironmentFile`: a worker holds no supervisor or Discord credentials.
- The enrollment code and the supervisor fingerprint are shell variables in the script. They reach
  `runner serve --enroll-only` through a pipe from the `printf` builtin, so they appear in no process's argv on either
  machine. A worker that already has `~/.dori/runner/keys/supervisor.pub` skips enrollment: a reinstall or an upgrade
  keeps its keys.
- On macOS, the launchd user agent `~/Library/LaunchAgents/com.dori.runner.plist` (from
  `templates/dori-runner-launchd.plist`, `KeepAlive`) runs the same command, also without credentials. While it
  serves, the runner holds `caffeinate -i -s -w <its pid>` so an idle Mac does not sleep: asleep, it runs the runner
  only in short DarkWake windows, heartbeats stop and the supervisor drops the link every few minutes. `-s` is what
  keeps a DarkWake from going back to sleep, and macOS honors it only on AC power; on battery, and with the lid closed,
  the Mac still sleeps. When `caffeinate` cannot start or exits, the runner logs `RUNNER_AWAKE_FAILED` and keeps serving.
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


### Windows workers

The install first asks the machine what it is. A PowerShell host, or Git Bash/MSYS/Cygwin (`uname -s` gives
`MINGW*`, `MSYS*` or `CYGWIN*`), counts as Windows; a POSIX script that hits one of those exits 8 and the Windows path
runs instead. A machine with no usable shell fails as unsupported before any enrollment code is issued.

Prerequisites:

- Windows 10 1809 or Server 2019 (build 17763) or later, x64. Otherwise the script exits 4. ARM64 isn't supported.
- OpenSSH server, reachable the same way as for the guard.
- `herdr` on the PATH (exit 7). The install can't read its version, so the note says `herdr=unknown`.
- The runner runs as a scheduled task at logon, so the user has to be logged on. An always-on worker needs
  auto-logon.

Each pass uploads the script with scp to `%USERPROFILE%\.dori-runner-install-<hex>.ps1`, then runs a short
`powershell -EncodedCommand` over ssh with empty stdin that reads the file, deletes it (it holds the one-time
enrollment code) and runs it as a scriptblock. Progress goes to `%USERPROFILE%\.dori\runner-install.log`. An ssh
step times out after 600 s, and its `RUNNER_INSTALL_UNREACHABLE` detail points at that log. A failed scp is
`RUNNER_INSTALL_UNREACHABLE` (ssh-style failure or timeout) or `RUNNER_INSTALL_FAILED` (`scp: ...`). The enrollment
code and fingerprint reach `runner serve --enroll-only` through stdin, never an argv. The script then:

1. Locks `%USERPROFILE%\.dori\runner` with `icacls` (inheritance removed, full control for the user, SYSTEM and
   Administrators, owner set to the user) and creates `bin`, `bun`, `logs` and `evidence`.
2. Installs a pinned Bun (1.4.4) into `bun\<version>\bun.exe`, checked by SHA-256, trying the x64 build first and
   the baseline build second. `bin\bun.txt` names the one in use. If neither runs, it exits 3.
3. Writes `dori.js` (hash checked), the shims, `runner-task.ps1`, `runner-sample.ps1`, `uninstall.ps1` and the task
   XML, stops a running runner and moves the files into place, retrying while files are locked.
4. Writes a starter `runner-config.json` (roots `%USERPROFILE%` and `%TEMP%`) only if none exists, and enrolls unless
   `keys\supervisor.pub` exists (failure exits 5).
5. Registers and starts the Task Scheduler task `\dori\dori-runner` (failure exits 6): at logon, interactive token,
   least privilege, runs on battery, restarts every minute on failure. Its action runs `runner-task.ps1` as
   `conhost.exe --headless powershell.exe ...`, so no console window opens at logon: a console program started
   directly by the task always gets a window, and `-WindowStyle Hidden` only hides it after it has appeared (and not at
   all when Windows Terminal is the default terminal). The wrapper loops `bun dori.js runner serve`, logs to
   `logs\runner.log` (rotated at 10 MB between starts) and restarts after 5 s. It records its own pid in
   `runner-task-wrapper.pid` and the runner's in `runner-task.pid`.

Shims in `bin\`, all finding Bun through `bun.txt` next to them:

| Shell | Shim |
| --- | --- |
| PowerShell (pwsh or 5.1) | `dori.ps1` |
| cmd.exe | `dori.cmd` |
| Git Bash / MSYS | `dori` (sh, turns off MSYS path conversion) |

The supervisor drives the task with PowerShell: restart stops the task, kills the trees and starts it; stop disables
the task first. Stopping the task ends only the headless conhost, so every stop (restart, stop, install, remove,
`uninstall.ps1`) kills the wrapper by its recorded pid before the runner tree, so it can't bring Bun back.
`uninstall.ps1` removes the task and the install, and `-Purge` removes the whole runner dir.

On Windows the runner:

- stops processes with `taskkill /T` (graceful) and `taskkill /T /F`, so a stop is in practice a hard kill;
- keeps the machine awake with `SetThreadExecutionState`;
- samples memory, swap, disk, load and processes through `runner-sample.ps1`, and attributes processes to lanes from
  the lane shell pid recorded at launch (adopted lanes aren't attributed);
- types lane launch lines as `-EncodedCommand` into pwsh or PowerShell 5.1 panes. `cmd.exe` panes are refused. On 5.1,
  an argv with a double quote is refused with `RUNNER_LANE_ARGV_UNSAFE`;
- only watches herdr (through CIM); it never installs or starts a herdr service.

WSL and UNC runner dirs aren't supported. A Windows machine without a runner isn't guarded at all.

## Guard

A worker's runner (one started with `--listen`) samples its host every 30 seconds with the same readings the
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

On the supervisor, the machine-guard sweep judges each runner machine from that runner's latest sample when it is at
most 90 seconds old; it never samples over ssh. The sample gives `HOST_GUARD ALERT`, `CLEAR` and
`LAUNCH_READY machine=<label>`, while `OFFLINE` and `ONLINE` come from runner liveness. The critical stage reports the runner's kills (`HOST_GUARD CRITICAL
machine=<label> ...; killed ...`), tells the lanes, and pauses the newest lane on entering critical with nothing
killed, but it kills nothing over ssh. A machine whose runner sent no fresh sample is skipped that round, and a machine
without a runner isn't guarded.

When it starts, a runner deletes the old guard agent files on its host (`~/.dori/guard-agent.sh`,
`guard-agent.ps1`, `guard-agent.version`) and logs `RUNNER_GUARD_AGENT_REMOVED <files>`.

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

## Cleanup sweep

Every runner (local, remote, Windows) sweeps its own host once a day (`src/runner/cleanup.ts`); there is no per-machine
cron or tmpfiles rule and no dry-run mode. The first check runs 10 minutes after start and then hourly; a sweep runs when
the last one recorded in `~/.dori/runner/logs/cleanup.json` is at least 24 hours old, so restarts neither skip nor repeat
a day.

| Target | Root (Linux/macOS; Windows) | Action |
|---|---|---|
| lane sandbox TMPDIRs | `~/.cache/omo-tmp/lane-sandbox/<key>`; `%USERPROFILE%\.cache\omo-tmp\lane-sandbox` | files older than 3 days, then empty dirs |
| lane build temp | `~/.cache/omo-tmp`; `%USERPROFILE%\.cache\omo-tmp` | same, 3 days |
| system temp | `/tmp` (macOS also `$TMPDIR`); `%TEMP%` (else `%TMP%`, `%LOCALAPPDATA%\Temp`) | the user's own files older than 2 days |
| `/var/tmp` | Linux only | the user's own files older than 30 days |
| browser profiles | `.<id>.bun-chrome` directly in a temp root | removed when untouched for 2 hours |
| omo sessions | `~/.omo/agent/sessions/<cwd>/*.jsonl` | untouched 14 days: moved with their `-artifacts` dir to `~/.omo/agent/sessions-archive/<cwd>/` |
| empty artifact dirs | empty `*-artifacts` session dirs, empty dirs under `~/.dori/runner/evidence` | removed after a day |
| memory agents | `~/.omo/memory/agents/<slug>-<hash>` | removed when untouched for 30 days |
| worktree records | every workspace repo the runner reports | `git worktree prune` |

Age is the newest of mtime, ctime and atime, as systemd-tmpfiles counts it. The sweep never removes: an open lane's
sandbox dir, cwd, session dir or memory agent; the lead's memory agent; any git checkout (a directory holding `.git`);
`~/.dori/secrets` and `~/.secrets`; anything a process holds open or runs in (Linux `/proc`, macOS `lsof`; Windows
refuses to delete an open file); sockets, FIFOs, symlinks, lock files and other users' files; temp entries of live
sessions (`tmux-*`, `herdr*`, `senpi-*`, `.X11-unix`, `*.sock`, `*.lock` and the rest of `TEMP_EXCLUDES`); and any root
that is the home dir, above it, or a secret store. When the in-use listing fails, that day's sweep skips the deleting
targets and reports `inUse=failed`.

Each sweep logs one line and rewrites the status file with the full report:

```text
RUNNER_CLEANUP at=<iso> sandbox=<n> omoTmp=<n> bunChrome=<n> temp=<n> varTmp=<n> sessionsArchived=<n> emptyArtifactDirs=<n> memoryAgents=<n> worktreePrune=<ok>/<repos> freedBytes=<n> kept=<n> inUse=ok errors=<n> ms=<n>
```

To check a host, read `~/.dori/runner/logs/cleanup.json` there (`at` is the last sweep) or find the `RUNNER_CLEANUP`
line in the runner's log.

## Shadow mode (removed)

Shadow mode is gone. The supervisor always opens the hub, `dori supervise` always spawns the local runner as its
child (label `local`), and every lane is runner-owned. A leftover `runners` section in the config is ignored and named in the
one `CONFIG_KEYS_IGNORED` warning per process. `dori runner shadow-report` was removed with it, nothing is
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

The current protocol is 6, so a supervisor accepts runners at 6 and 5. Protocol 6 adds the four secret control frames
(see [Secrets over the link](#secrets-over-the-link)); `secretsSupported(proto)` (`proto >= SECRET_PROTO`) is the gate.
**Upgrade the supervisor before its runners**: a proto 5 runner still connects to a proto 6 supervisor, but a proto 6
runner is refused by a proto 5 supervisor (`RUNNER_PROTO_MISMATCH`, newer than the supervisor). The runner's `state.sqlite` gained the
nullable `commands.result_json` column in protocol 3; an older file gets it on open and its rows read with no result.

## Liveness and restarts

The supervisor judges each runner by when its heartbeats arrive, on its own monotonic clock; a runner's wall clock is
never used. A supervisor start counts as the last time it saw each runner it knows.

| Silent for | What happens |
|---|---|
| 60 s | `RUNNER_STALE machine=<label>` (digest), once |
| 180 s | `RUNNER_OFFLINE machine=<label> runner heartbeat missing ...` (digest), and restart decisions start; `HOST_GUARD OFFLINE machine=<label> ...` (urgent) instead when the runner owns open lanes |
| 10 min offline, or the probe finds it dead | `HOST_GUARD OFFLINE machine=<label> ...` (urgent), once per disconnect |
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

The restart circuit allows 3 restarts per runner per hour. A heartbeat or hello ends a disconnect, with
`HOST_GUARD ONLINE machine=<label>` when it had woken the lead with `HOST_GUARD OFFLINE`.

Outages have hysteresis per machine: an outage ends only once the runner has stayed connected for 10 minutes. A
disconnect before then folds into the same outage: no new `RUNNER_STALE` or `RUNNER_OFFLINE`, and owned lanes do not
wake the lead a second time (staying down 10 minutes or a dead probe still does). The end of the outage is said once as
`RUNNER_ONLINE machine=<label>` (digest), with the number of disconnects folded into it. The runner's unit is separate from herdr's (it only
`Wants=` and is `After=` the herdr unit), so a restart never touches a lane's pane.

`dori status` shows the restarts of the last hour on the runner's machine line (`restarts1h` in `--json`). `dori doctor` checks the recorded runner endpoints, the local
runner directory, and each runner's protocol, outbox backlog and restart circuit.

`dori update` restarts the supervisor first. Only once it is active again does it move the runners, one at a time.
The local runner's unit is restarted; every other runner gets the new bundle the way `dori runner install` sends it.
The update then waits up to 2 minutes for a hello with a higher gen before it goes to the next runner. A runner
that fails logs `RUNNER_UPGRADE_FAILED runner=<label> ...` (urgent) and keeps its version; the rollout goes on with
the next runner.

The urgent runner events are `LANE_RUNNER_LOST`, `LANE_ORPHAN`, `RUNNER_LAUNCH_FAILED`, `RUNNER_FORGED_EVENT`, `RUNNER_AUTH_FAILED`,
`RUNNER_OUTBOX_LARGE` and `RUNNER_UPGRADE_FAILED`. `RUNNER_STALE`, `RUNNER_OFFLINE`, `RUNNER_ONLINE`, `RUNNER_UNREACHABLE`, `RUNNER_RESTARTED`,
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

The supervisor records each `lane.start` it sends in `runner_attempts` of `runners.sqlite` (with its body and the
supervisor epoch) and drops the record when the command's `cmd.result` arrives. At each hello it reads back the
records an earlier supervisor run left for that runner, for lanes still open, owned by that runner and without a
pane; any other record is dropped unasked. A lane in the hello inventory counts as present, `lane.observe` answering
`RUNNER_LANE_UNKNOWN` as absent. A proven absence sends the same `lane.start` again under its cmdId; a command the
runner still runs (`intent` or `running`) is read back at the next hello. Each record logs
`RUNNER_READBACK runner=<label> cmdId=<id> verified|retry|ambiguous|pending|settled`.

Command records are kept 30 days.

## Runner-owned lanes

Every lane is runner-owned. `dori launch` starts a local lane through the local runner, the supervisor's child, and
`dori launch --machine <label>` starts it through that machine's runner. There's no direct herdr path and no mode
that picks one: a `runners` config section is ignored (`CONFIG_KEYS_IGNORED`). A lane whose runner is down waits for it,
and losing a runner never hands the lane back to the supervisor.

**Launch.** `dori launch` registers the lane at once with `runner: <label>` and appends the runner footer to the
brief. It then queues `lane.start` for the supervisor (`runner_admin` in `runners.sqlite`), which sends it once the
runner is connected; a request waits at most 2 minutes. A runner launch needs `--cwd` and takes no `--pane` or
`--workspace`. On the worker, the runner:

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
other command exits 2 with `DORI_CLI_UNSUPPORTED_ON_RUNNER <cmd>`. A report goes over `~/.dori/runner/sock/lane.d/lane`
with the lane's token. The socket has a directory of its own so the Linux lane sandbox can bind the directory rather
than the socket file: a restarted runner binds a new socket at the same path, and a lane started before the restart
reaches it. The runner also serves the older `~/.dori/runner/sock/lane`, and a lane's CLI falls back to it when the
`lane.d` connect fails (a sandbox set up before the move). The runner refuses a token that is not that key's own (`RUNNER_LANE_AUTH_FAILED`) and puts an
accepted report in its outbox as `lane.report`. `heavy` takes the host's `~/.dori/heavy/slot.N`, the same slots
the supervisor's scheduled heavy jobs use, so there's one heavy count per machine.

**Secrets.** The lane socket also takes `secret`: `{"kind": "secret", "key": "<key>", "token": "<token>", "names": ["NPM_TOKEN"]}`,
sent by the lane's `dori secret exec NAME... -- <cmd>`. `names` holds 1 to 32 unique secret names (else
`RUNNER_LANE_BAD_REQUEST`), and the token is checked first. A grant replies `{"ok": true, "values": {"NPM_TOKEN": "..."}}`;
a refusal replies `{"ok": false, "code": "RUNNER_SECRET_DENIED", "detail": "..."}` (or `RUNNER_SECRET_MISSING`,
`RUNNER_SECRET_FAILED`). The local runner grants from its own store. A remote runner at protocol 6 asks the supervisor over the link (below);
a protocol 5 runner answers `RUNNER_SECRET_UNSUPPORTED` and never receives a value. The lane reply is never journaled,
logged or put in the outbox. See [secrets.md](secrets.md).

### Secrets over the link

Protocol 6. A remote runner sends `secret.get {rid, key, names, repo?}` (`rid`: 32 random hex chars; `repo`: the lane's
`owner/repo` read from its worktree) and the supervisor answers `secret.value {rid, ok, code?, detail?, sealed?}`.
`secret.run {rid, key, op, repo?}` asks the supervisor host to run the configured command `op`; the answer is
`secret.run.result`, shaped like `secret.value`. A refusal carries `ok: false` and a `RUNNER_SECRET_*` code
(`DENIED`, `MISSING`, `FAILED`, `UNSUPPORTED`, `OUTDATED` when either side speaks protocol < 6, `TIMEOUT` when the runner
got no answer); `detail` names secret names and lanes, never a value.

Values never cross the link in clear. `sealed {n, c}` is an AEAD box: AES-256-GCM, a fresh 12-byte nonce `n` and the
ciphertext with its 16-byte tag `c` (both base64), under a key derived per direction from the handshake session key
(`s2r` supervisor to runner, `r2s` runner to supervisor), with the frame's `{runner, gen, epoch, type, rid}` as
associated data, so a box moved to another frame, rid, runner or direction fails to open. The frame also carries the
normal `mac`. Both sides send secret frames only on an authenticated link whose peer announced protocol >= 6; the
supervisor must therefore be upgraded before runners, and an older runner is never sent a value.

**Ownership.** The supervisor takes a lane event only from the runner that `Lane.runner` names, over that runner's
authenticated connection. Anything else (another runner's lane, a lane no runner owns, a key the registry does not
have) is dropped as `RUNNER_FORGED_EVENT runner=<label> key=<key>` (urgent). A `lane.report` becomes a row of the lane
report store whose `source` is the event's journal id (`runner:<label>:<seq>`), so the same event never makes two
rows. From there it is routed exactly as a local `dori report`: a done report becomes the claim through `claimDone`
(the same evidence again is `LANE_DONE_ALREADY_CLAIMED`); the rest is journaled or posted to the thread. The
supervisor reads lane events back from the hub's own journal on every runners pass, from the start after a restart,
so an event acked just before a crash is still stored.

**Inventory.** On each hello the supervisor compares the runner's inventory with the registry:

- a lane the runner owns that the inventory lacks is marked `recoveryPending` and sent `lane.recover`;
- a key with no open lane in the registry is `LANE_ORPHAN <key>` and gets no registry entry, unless the archive holds
  that key closed, owned by the same runner, in the same pane (a closed lane the runner still lists is no unknown agent);
- a lane in both whose pane, tab or session differs takes the runner's values for those three only.

**Sweeps without a runner.** The supervisor's watch, dead-panes and freshness sweeps read a machine only through an
admitted connection. While a runner has none (after a supervisor restart, before its hello, or while it is gone) its
lanes are skipped without a line per lane, and the sweeps say `RUNNER_UNAVAILABLE runner=<label>` (digest) once per
outage; the archive's worktree cleanup runs right after the local runner's hello.

**Evacuate.** `dori runner evacuate <label>` is the forced rollback for a runner that cannot be used. In order:

1. It fetches the runner's unacked events over ssh (`runner export-outbox`) and takes them as if they had arrived,
   so a report already received is not stored twice.
2. It tells each lane the runner owns, through that runner while it still runs, that its reports fail until the runner
   is back. `Lane.runner` is kept: the runner is the only path to its lanes.
3. It stops the runner's service: the systemd unit on Linux, or on macOS the launchd agent (disabled and booted out).

The lanes keep running. A step that fails is reported, and the later steps still run.
