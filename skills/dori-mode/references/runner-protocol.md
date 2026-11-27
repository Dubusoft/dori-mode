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
  `secret.get {rid, key, names, repo?}` and `secret.run {rid, key, op, repo?}` (protocol 6, see [Secrets](#secrets-over-the-link)),
  `toodo.read {rid, key, op, id?, query?}` (protocol 10, see [Toodo reads](#toodo-reads-over-the-link)).
- Supervisor to runner: `enroll.ok`, `hello.challenge {nonce, dh, sig, keyFp}`, `hello.ok {proto, epoch, eventAck}`,
  `hello.reject {code, detail}`, `rotate.ok`, `ack {eventAck}`, `cmd.status {cmdId}`, and the queries `q.panes`,
  `q.screen`, `q.process`, `q.stat`, `q.lane.inspect`, `q.machine.observe` (protocol 3), and `secret.value` and
  `secret.run.result {rid, ok, code?, detail?, sealed?: {n, c}}` (protocol 6), and `toodo.read.result` shaped like them
  (protocol 10). The secret frames are control frames: no
  `seq`/`cmdSeq`, never queued, journaled or logged.

`hello` must be the first frame on a connection (after an `enroll` connection has closed). After the handshake
(below) the hub applies its hello rules: `RUNNER_PROTO_MISMATCH` when the protocol version isn't accepted, then the
fencing rules in [Fencing](#fencing).

Runner events are defined for `lane.started`, `lane.state`, `lane.report`, `lane.asking`, `lane.progress`,
`lane.ack`, `wait.result`, `job.result`, `guard.sample`, `guard.alert`, `guard.critical`, `heavy.state` and `cmd.result`. Today
a runner publishes `lane.state`, `lane.progress`, `cmd.result`, `wait.result` and `job.result` and, on a worker, `lane.started`, `lane.report` and
the three `guard.*` events. Supervisor commands (`lane.start`, `lane.stop`, `lane.pause`, `lane.resume`,
`lane.recover`, `lane.send`, `lane.close`, `lane.observe`, `wait.check`, `job.run`, `guard.kill`, `runner.rotate`)
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
| `lane.state` | `reason` (`pane-missing` or `agent-gone`) for a `dead` lane; an `agent-gone` dead is published only by the runner's observe loop, after 90 s of dead reads with no alive one between (a lane agent process still running in the pane counts as alive), and the hub raises one `RUNNER_LANE_DEAD` per lane and pane |
| `lane.ack {key, id}` | new event: the lane confirmed the supervisor's lane message `id` |
| `guard.sample` | `panes` (hc's pane count, -1 when the runner could not read hc) and `lanes [{key, rssKb, top [{comm, rssKb, count}]}]` |
| `cmd.result` | `result`: the effect's structured result (any JSON value; below) |
| `lane.start` | `keywords`, `session`, `heavySlots`, `heavyMaxLoad` |
| `lane.adopt {key, pane, cwd?, mode, model}` | new command: take an existing pane as lane `key` |
| `lane.pause` | `step` (`goal`, `stop` or `both`, default `both`) |
| `lane.recover` | `session` (resume that agent session when relaunching) |
| `lane.send` | `mode` (`verified` or `guarded`), `refuseWhileAsking` |
| `lane.notify {key, status, objection?: {at, reasons}, claim?: {at, evidence}}` | new command: the lane's status as the supervisor holds it |
| `lane.git {key, op, root, path?, branch?, remote?}` | new command: `worktree-remove`, `branch-delete` or `remote-branch-delete` in `root` |

Protocol 7 adds the command `lane.attach {key, tree}` (`dori attach`): the runner validates `tree` like a `lane.start`
input tree, writes it into the running lane's existing `briefs/<key>.files` directory under the next free `a<NNNN>`
group (in place, so a sandbox that bound that directory at start sees it; the combined directory keeps the launch caps),
and answers `{dir}`, that group's path. A lane without a file run (adopted, or started before lane files) refuses it
with `LANE_ATTACH_UNMANAGED`.

A verified `cmd.result` carries `result` per command type: `lane.start` and `lane.recover` `{pane, tab, startup?:
{verdict, detail}}` (plus `relaunched`, `resumed` for recover), `lane.adopt` `{pane, tab, tokenFile}`, `lane.stop` and
`lane.close` `{closed: pane|none, gone}`, `lane.pause` `{goal?, working?, stopped?}`, `lane.resume` `{goal, execution?}` (`/goal resume`, then `/resume` when the pane shows omo's Esc-paused footer, then the turn read back: `running` or `held`),
`lane.send` `{delivery, refusal?}`, `lane.notify` `{}`, `lane.attach` `{dir}`, `lane.git` `{code, out, err}` (each capped at 4 KiB),
`lane.observe` `{status}`, `guard.kill` `{killed [{pid, lane?, comm, rssKb}]}`. A runner effect that only returns a
detail sends no `result`.

## Queries

Reads (screens, pane lists, process info, path existence, lane and machine facts) are control frames, not commands:
they carry no `seq` or `cmdSeq`, go through no outbox and no journal, get no intent or result row, and are not
epoch-fenced (they change nothing). Each `q.*` body has a `qid`; the runner answers it with one `q.result {qid, ok,
detail, result?}` on the same connection, sealed like every frame. A query sent while the link is down is not sent at
all, and an answer whose connection has closed is dropped: the caller times out and asks again on its next pass.

| Query | Body | `result` when `ok` |
|---|---|---|
| `q.panes` | `{qid}` | `{panes}`: hc's pane list of the runner's host |
| `q.screen` | `{qid, pane, lines, source: visible\|recent}` | `{text}` (at most 400 lines; `lines` ignored for `visible`) |
| `q.process` | `{qid, pane}` | `{info?, error?}`: hc's process info |
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
time; a frame with a missing or wrong `mac` is dropped. Each end logs its drops once per connection, as
`RUNNER_AUTH_FAILED ... bad mac count=<n> ...`: after `BAD_MAC_CLOSE_AFTER` (8) of them it closes the connection with
`RUNNER_AUTH_FAILED` so the runner handshakes again and gets a fresh session key, and a connection that closes sooner
logs its count on close. Authentication is
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
connection while one is open is refused. Both ends bound the handshake to 10 s: the runner closes a connection that
has not answered its `hello` with `hello.ok` or `hello.reject` by then (`RUNNER_HELLO_TIMEOUT`) and reconnects after
the backoff, and the supervisor closes a connection it has not admitted, refused or answered `enroll.ok` within 10 s
of accepting it. A peer that takes the runner's slot and stays silent therefore holds it for at most 10 s. The supervisor reads `<stateDir>/runner-endpoints.json`, an object mapping
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
| `grants` | named path grants a sandboxed lane gets only when its launch asks for them by name (`dori launch --grant NAME`, `lane.start.grants`): `{"<name>": {"write": [dirs], "read": [dirs]}}`, absolute or `~/...`; see [Path grants](#path-grants) | none |

A `lane.start` without `cwd` (`dori launch --machine M` with no `--cwd`) starts in its own directory `<runnerDir>/lanes/<key>`
(`~/.dori/runner/lanes/<key>`, `%USERPROFILE%\.dori\runner\lanes\<key>` on Windows). The runner fills it before the
`allowedRoots` check, creates it (0700) when the start runs, and the `lane.start` result reports it as `cwd`. The
runner creates `<runnerDir>/lanes` at start and always admits it as an allowed root (unless a listed root already holds
it); the runner-directory safety check audits each `lanes/<key>` directory itself but not what the lane puts in it.
A key that cannot name a directory is refused `cwd-missing`. The lane sandbox (Linux and macOS) lets such a lane read
and write its own directory; update the wrapper (`dori runner update`) on a host that still has an older one.

### Review lane profile

A `lane.start` with `agentProfile: "review"` (the runner policy's `agents.review`, the same argv as `agents.sandboxed`; every runner-config that takes review lanes needs it)
always runs sandboxed: the runner runs `sandboxCheck` first even without `sandbox: true`, refuses it on a PowerShell pane
(`RUNNER_LANE_REVIEW_UNSANDBOXED`), and launches it with `LANE_SANDBOX_PROFILE=review` and without `LANE_SANDBOX_REPOS`,
`LANE_SANDBOX_WORKTREES` and `LANE_SANDBOX_RW`. The Linux wrapper then binds the cwd (the review snapshot worktree), its
git common dir, the worktree root and the repos' `.git` read-only, ignores write grants, gives `/tmp` a private tmpfs
and leaves only `briefs/<key>.out`, the lane TMPDIR, `~/.omo` and `~/.cache` writable; `~/.gitconfig`, `~/.config/gh` (its `hosts.yml` included),
`~/.config/git` and the ssh agent socket are not bound, GitHub tokens are unset and git reads no global or system
config. Any other non-empty `LANE_SANDBOX_PROFILE` exits 2, and the macOS wrapper refuses every profile (review lanes run
on Linux only). `lane-sandbox --explain` names the profile in its header.

### Path grants

The owner keeps a named table of narrow paths in runner-config.json `grants`; the lead picks names from it per lane
(`dori launch --grant NAME`, repeatable) and never edits the table. A grant's `write` directories reach the lane
sandbox as `LANE_SANDBOX_RW` (read-write) and its `read` directories as `LANE_SANDBOX_RO` (read-only, bound before every
read-write path, so a cwd under one stays writable); the wrapper takes only these two lists. Both wrappers apply
`~/.dori/lane-sandbox-hide` after every grant, so a hidden path stays hidden whatever a grant names. A lane without
`--grant` gets neither list, as before.

The table may not name, and parsing refuses (`RUNNER_CONFIG_INVALID`): a relative path or one holding `:`; `/`, the home
directory or anything above it; anything that holds or lies under `~/.dori`, `~/.config` or the user runtime directory
(`/run/user`, `XDG_RUNTIME_DIR`: the D-Bus session bus and the systemd user manager). At each start and relaunch the
runner resolves every granted path (`realpath`) and checks the real form again, and refuses a write grant that is a git
checkout (it holds `.git`): the host runs that checkout's scripts, so grant a data directory inside it instead (for
example `/data/dori/blog-writer/runs`, never `/data/dori/blog-writer`). A refused or unknown name starts nothing
(`RUNNER_CMD_REJECTED grant-path|grant-unknown ...`), and the lane record keeps the names, so a relaunch resolves them
against the table as it is then. On the local runner a runner-config.json holding only placement keys and `grants`
layers them onto the policy derived from config.json.

`lane.start.grants` is sent only when non-empty and needs no protocol bump: a runner older than it refuses that start
`RUNNER_CMD_REJECTED unknown-field` (the lead reports `LAUNCH_GRANT_UNSUPPORTED`; `dori runner update` there), and
every other start is unchanged.

### Host commands

A worker's runner-config.json `hostCommands` (`{ "<op>": { argv, lanes, repos, timeoutSec?, cwd? } }`, config
`secretCommands` without `secrets`) lists the ops its own lanes may run on that worker, outside the lane sandbox, with
`dori host <op>`. The worker runner answers a lane socket `secret-run` for a listed op itself (secretCommandRunner) and
sends any other op to the supervisor as `secret.run`, as before; a supervisor `RUNNER_SECRET_DENIED` gets the worker's
matching ops added to its list. Nothing crosses the link for a worker op, so it needs no protocol bump. The local runner
ignores the key. See [secrets.md](secrets.md#worker-host-commands).

The former `defaultCwd` key is retired. A runner-config.json that still holds it loads as before, the key is ignored
and each load logs one `RUNNER_CONFIG_KEY_IGNORED defaultCwd: ...` line; `dori runner setup` removes it.

A refusal is `RUNNER_CMD_REJECTED <rule>` with one of these rules: a schema rule from frame validation (such as
`unknown-field` or `unknown-type`), `agent-profile`, `cwd-missing` (the path does not resolve), `cwd-outside-roots`
(compared by path segment after resolving symlinks on both sides, so `/data/repos-evil` is not under `/data/repos`),
`sandbox-required`, `sandbox-unavailable` (the `sandboxCheck` failed; it arrives inside a `RUNNER_CMD_FAILED` detail), `command-not-argv` (a `job.run` command that is not an array of strings), `jobs-denied`,
`grant-unknown` (a `grants` name the table lacks), `grant-unsandboxed` (grants on a start with `sandbox: false`) or `grant-path` (a granted path refused at start, see [Path grants](#path-grants)).
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
came with protocol 5, so every admitted runner carries them; there is no protocol bump. A runner without the handler
answers `cmd.result failed RUNNER_CMD_UNSUPPORTED <type>`. Under `jobs: deny` both are refused (`jobs-denied`), and
`cwd` must be absolute, existing and under `allowedRoots`.

| Command | Body | `cmd.result` result |
| --- | --- | --- |
| `wait.check` | `{cmdId, waitId, signal, cwd}` | `{met, error?}` |
| `job.run` | `{cmdId, opKey, name, command: string[], cwd, timeoutSec, heavy}` | `{exitCode, timedOut, output, err}` |

- `wait.check` runs the `Done =` signal once in `cwd`, bounded by 10 s. A met check also publishes
  `wait.result {waitId, outcome: WAIT_DONE, detail}` (detail at most 500 characters), which the supervisor settles as
  the same success line a local check gives (`WAIT_DONE`, or the wait's `--on-success` line); an unmet or failed check publishes nothing. A check that throws answers
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
`eventAck` from `hello.ok`, in order, before sending anything new. It reads the outbox 64 rows at a time and, when
the socket reports backpressure, waits for it to drain before the next row, so a large backlog is neither loaded
nor queued at once; `hello.ok` ends the handshake deadline, so a slow replay is not cut by it. A message the socket
drops closes the link with `RUNNER_SEND_DROPPED`: the peer sees the close at once instead of waiting out a lost
control frame, and a lost event replays after the reconnect. A lower ack than the runner already holds is ignored.

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
machines (`runner-machines.json` plus `guardMachines`); a positional target is used as given and, once installed, is
saved in `<stateDir>/runner-machines.json` so the guard knows it too. The listen address comes from the target (see
[Network link](#network-link)) and is recorded in `runner-endpoints.json` only after enrollment and the service
install succeed. The supervisor issues the enrollment code in its own process and runs
`ssh <target> sh -s`. That command line never changes: everything else goes on ssh's stdin as one sh script.
`dori runner remove <label>` undoes an install: it removes the runner service and `~/.dori/runner` (keys included) on
the worker, leaves hc's core running, and only then revokes the runner and drops it from both state files.

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
  `templates/dori-runner-launchd.plist`, `KeepAlive`) runs the same command, also without credentials. A reinstall or
  upgrade rewrites the plist from the template but keeps the string entries an operator added to its
  `EnvironmentVariables` (such as `DORI_CLEANUP_TARGETS`); the template's own `PATH` and `LANG` always take the new
  values. When the old plist cannot be read, the install prints `RUNNER_PLIST_ENV_LOST <plist>`. While it
  serves, the runner holds `caffeinate -i -s -w <its pid>` so an idle Mac does not sleep: asleep, it runs the runner
  only in short DarkWake windows, heartbeats stop and the supervisor closes the link after 120 s without a frame
  (`RUNNER_SILENT`, see Liveness and restarts), so it redials each time the Mac wakes. `-s` is what
  keeps a DarkWake from going back to sleep, and macOS honors it only on AC power; on battery, and with the lid closed,
  the Mac still sleeps. When `caffeinate` cannot start or exits, the runner logs `RUNNER_AWAKE_FAILED` and keeps serving.
  Before each `lane.start` a macOS runner also checks BrowserSkill once, outside the lane sandbox and without holding
  the start up (`runner/browser-window.ts`): the extension connects bsk only while a Chrome window is open, so when
  `bsk browsers` shows none it runs `open -b com.google.Chrome` (no URL) and rechecks for 10 s. It logs one line:
  `RUNNER_BSK_OK`, `RUNNER_BSK_WINDOW_OPENED`, `RUNNER_BSK_UNAVAILABLE` (bsk did not answer; nothing opened),
  `RUNNER_BSK_OPEN_FAILED`, `RUNNER_BSK_STILL_NONE`, or `RUNNER_BSK_PROFILE_PROBLEM` (still none and no Chrome
  `--extension-process`: Chrome's sign-in or the extension needs the owner). Starts that overlap share one check, and
  Chrome is never killed or scripted.
- Then, on Linux, linger is turned on and the unit is enabled and restarted. On macOS the agent is loaded into
  `gui/<uid>` (`user/<uid>` when there is no GUI session or it refuses the agent), enabled first and kickstarted, and the domain is recorded in
  `~/.dori/runner/launchd-domain`. Either way a new bundle takes effect.

**hc.** hc is required, and its core gets an autostart unit or agent so it is up after a reboot:

- `hc` is looked up on the PATH of the user's login shell (`$SHELL -lc`) before anything is written; without it the
  install stops with `RUNNER_INSTALL_NO_HC` (exit 7).
- On Linux it writes `~/.config/systemd/user/hc-core.service` (from `templates/hc-core.service`, a oneshot
  `hc server start`), runs `systemctl --user enable hc-core.service dori-runner.service`, `start hc-core.service` and
  `restart dori-runner.service`; a failure exits 6. The runner unit has `Wants=hc-core.service` and
  `After=hc-core.service`. On macOS it writes `~/Library/LaunchAgents/com.dori.hc.plist` (from
  `templates/dori-hc-launchd.plist`, `hc serve`, `KeepAlive`, output to `~/.dori/runner/hc.log`) and enables and
  bootstraps it only when `launchctl print` doesn't find `com.dori.hc` in the runner's domain. It never boots it out,
  since that would end every lane.
- The script prints `DORI_HC enabled`.

It prints `RUNNER_INSTALLED runner=<label> version=<first 12 hex of the bundle's sha256> hc=enabled (its core starts at boot)`
(`hc=unknown` on Windows), or exits 1 with
`RUNNER_INSTALL_UNREACHABLE` (ssh failed or timed out), `RUNNER_INSTALL_UNSUPPORTED` (neither Linux nor macOS, or no POSIX shell),
`RUNNER_INSTALL_NO_BUN` (on macOS: none found and the download failed), `RUNNER_INSTALL_NO_HC` (no `hc` on the
login PATH), `RUNNER_INSTALL_ENROLL_FAILED` or `RUNNER_INSTALL_FAILED` (with the systemd, linger or launchd step
named when that failed).


### Windows workers

The install first asks the machine what it is. A PowerShell host, or Git Bash/MSYS/Cygwin (`uname -s` gives
`MINGW*`, `MSYS*` or `CYGWIN*`), counts as Windows; a POSIX script that hits one of those exits 8 and the Windows path
runs instead. A machine with no usable shell fails as unsupported before any enrollment code is issued.

Prerequisites:

- Windows 10 1809 or Server 2019 (build 17763) or later, x64. Otherwise the script exits 4. ARM64 isn't supported.
- OpenSSH server, reachable the same way as for the guard.
- No hc: hc has no Windows support, so the install never exits 7 and the note says `hc=unknown`.
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

Lane records store `hcInstance` (`hc:<core id>`), the hc core that opened the lane, and keep `tab` empty. With no
known core a new launch or adoption is refused (`RUNNER_HC_INSTANCE_UNKNOWN`).

Observe, recover, send, pause, resume, close, asking-screen reads and lane inspection compare the saved identity
before touching the recorded pane. A mismatch means missing (`RUNNER_LANE_ABSENT` for steering); close forgets
the lane without closing a reused pane. Recover opens the lane in a new hc terminal, on its saved session when it
has one.

## Health and probe

The runner rewrites `~/.dori/runner/health` (`{pid, gen, monotonicMs, wallAt}`, 0600) at start and then every
15 seconds, on a timer of its own. `dori runner probe [--json]` runs on the runner's host and reads it. The age comes
from the file's mtime, so it is measured on the host's own clock.

| Verdict | When | Exit |
|---|---|---|
| `healthy` | the pid is alive and the file is at most 60 s old | 0 |
| `stalled` | the pid is alive and the file is 60 to 120 s old | 1 |
| `dead` | no file, no such process, or the file is older than 120 s | 1 |

## Cleanup sweep

Every runner (local, remote, Windows) sweeps its own host once a day (`src/runner/cleanup.ts`); there is no per-machine
cron or tmpfiles rule. The first check runs 10 minutes after start and then hourly; a sweep runs when
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
| closed lanes' `node_modules` | `<worktree>/node_modules` of each worktree (cwd and recorded worktrees) of a lane the registry records as closed | removed once the lane's last activity (its close, the worktree's `HEAD`, index and `HEAD` log) is 3 days old and nothing in the worktree, its `.git` or its `node_modules` changed for 6 hours; `report` by default |
| closed lanes' build output | in the same worktrees and their direct subdirectories: `android/build`, `android/<module>/build` and `android/.gradle` (closedAndroidBuild), `.expo` (closedExpo), `ios/Pods` (closedPods), a `target` holding cargo's `CACHEDIR.TAG` (closedCargoTarget) | removed once the lane's last activity is 7 days old (14 for `.expo`; for `target` also its newest file), with the same keeps as `node_modules`, never when git tracks anything in it (`tracked`), and not that day while Gradle, Metro/Expo, Xcode/xcodebuild/Simulator/pod or cargo/rustc/rust-analyzer runs on the host (`skip:toolRunning`); `report` by default |
| Metro caches | `metro-*` directly in a temp root (`metro-cache`, `metro-file-map-*`) | removed when nothing in them changed for 3 days and no Metro or Expo dev server runs (metroCache); the system temp sweep leaves them to this target; `report` by default |
| Xcode DerivedData (`xcodeDerivedData`) | macOS only: `~/Library/Developer/Xcode/DerivedData/<folder>` | a folder in which nothing changed (mtime or ctime) for 14 days is removed; `report` by default |
| iOS DeviceSupport (`xcodeDeviceSupport`) | macOS only: `~/Library/Developer/Xcode/iOS DeviceSupport/<version>` | same, 60 days; `report` by default |
| unavailable simulators (`simulatorsUnavailable`) | macOS only | `xcrun simctl delete unavailable` when `xcrun simctl list --json devices unavailable` lists any; `report` by default |
| bun cache (`bunCache`) | the dir `bun pm cache` prints | `bun pm cache rm` (it empties the cache), at most every 30 days; `report` by default |
| npm cache (`npmCache`) | `<npm config get cache>/_cacache` | `npm cache verify`; `report` by default |
| pnpm store (`pnpmStore`) | the dir `pnpm store path` prints | `pnpm store prune`, after the `node_modules` target so it frees what nothing links to any more; `report` by default |

Age is the newest of mtime, ctime and atime, as systemd-tmpfiles counts it. The sweep never removes: an open lane's
sandbox dir, cwd, session dir or memory agent; the lead's memory agent; any git checkout (a directory holding `.git`);
`~/.dori/secrets` and `~/.secrets`; anything a process holds open or runs in (Linux `/proc`, macOS `lsof`; Windows
refuses to delete an open file); sockets, FIFOs, symlinks, lock files and other users' files; temp entries of live
sessions (`tmux-*`, `senpi-*`, `.X11-unix`, `*.sock`, `*.lock` and the rest of `TEMP_EXCLUDES`); and any root
that is the home dir, above it, or a secret store. When the in-use listing fails, that day's sweep skips the deleting
targets and reports `inUse=failed`.

The closed lanes' `node_modules` target only looks at worktrees of lanes the registry records as closed; a worktree the
registry does not know (a lane being opened may not be registered yet) is never touched. It also keeps a worktree that
an open lane uses as its cwd, one whose directory name carries an open or observed lane's key (the key itself,
`<key>-...` or `<repo>-<key>`), and one under which a process holds a file open or runs (only paths inside the worktree
count, not a shell whose cwd is a directory above it). The registry is read again right before removing, and a lane
that is no longer closed by then keeps its worktree (`reopened`). The registry lives with the supervisor, so the runner asks it over
the link at each sweep: the runner control frame `lanes.closed {rid}` (proto 9) is answered with `lanes.closed.result
{rid, ok, detail?, lanes?}`, each lane `{key, closedAt, worktrees}` (closedAt in ms; worktrees are its cwd and recorded
worktrees), only the asking runner's lanes (local lanes for `local`, a remote runner's by its label). Nothing in it is
secret, so it is not sealed. Without a registry to ask the target is skipped (`noRegistry`); when the supervisor
refuses, is older than proto 9 or does not answer within 60 seconds, it is skipped (`registryFailed`).

The developer-cache targets (`src/runner/cleanup-dev-caches.ts`) never remove files of the global package caches
themselves: only the tools' own commands above run, in a scratch directory (bun's need a `package.json`). Xcode Archives
(dSYMs cannot be rebuilt), `~/.expo` (login state) and CoreSimulator `Devices` (only simctl removes a simulator) are no
target. Each target first reads the host's process list (`ps -A -o pid=,args=`) and is skipped (`busy`) while a process
that uses its cache runs: Xcode, Simulator or xcodebuild for the three Xcode targets; `bunx` or bun's package commands
(`install`, `add`, `remove`, `update`, `pm`, `x`, ...) for bun; any npm/npx or pnpm/pnpx. When the list cannot be read
they are all skipped (`processesFailed`). An Xcode folder a process holds a file open in or runs in is kept (`shielded`;
only paths inside the folder count), symlinks and other users' folders too, and the two folder targets are skipped
when the in-use listing fails. The Xcode targets are skipped on Linux and Windows (`platform`), the package caches on
Windows; a tool that is not installed is skipped (`notInstalled`). In `report` the folders and unavailable simulators
count with their size, bun's cache with its whole size, npm's and pnpm's with 0 bytes (what they collect is known only
once they run). When a tool target runs its command, the report records the time under `lastRuns.<target>`; the next
sweep reads it from `cleanup.json`, and `bunCache` is skipped (`notDue`) until 30 days after its last run.

Each target runs in one of three modes: `on` removes (sessions are moved), `report` only counts what it would remove
and changes nothing (a dry run; `git worktree prune --dry-run --verbose` for the worktree records), `off` skips it.
Every target defaults to `on` except `closedNodeModules`, the build-output targets, `metroCache` and the developer-cache targets, which start at `report`; a target added later starts at
`report` until its reports have been read. The runner's
environment sets them, read at each sweep (on a macOS worker, in the agent plist's `EnvironmentVariables`, which a
reinstall or upgrade keeps):

| Variable | Effect |
|---|---|
| `DORI_CLEANUP_DRY_RUN=1` | every target that is not `off` runs in `report` (empty, `0`, `false`, `no` and `off` leave it unset) |
| `DORI_CLEANUP_TARGETS=temp=off,memoryAgents=report` | `<target>=<on\|report\|off>` entries, split by commas or spaces; targets `sandbox`, `omoTmp`, `bunChrome`, `temp`, `varTmp`, `sessionsArchived`, `emptyArtifactDirs`, `memoryAgents`, `worktreePrune`, `closedNodeModules`, `closedAndroidBuild`, `closedExpo`, `closedPods`, `closedCargoTarget`, `metroCache`, `xcodeDerivedData`, `xcodeDeviceSupport`, `simulatorsUnavailable`, `bunCache`, `npmCache`, `pnpmStore` |

An entry that is not understood is ignored and logged as a `RUNNER_CLEANUP_ERROR`.

Each sweep logs one line and rewrites the status file with the full report:

```text
RUNNER_CLEANUP at=<iso> [dryRun=1] sandbox=<n> omoTmp=<n> bunChrome=<n> temp=<n> varTmp=<n> sessionsArchived=<n> emptyArtifactDirs=<n> memoryAgents=<n> closedNodeModules=<n> closedAndroidBuild=<n> closedExpo=<n> closedPods=<n> closedCargoTarget=<n> metroCache=<n> worktreePrune=<ok>/<repos> freedBytes=<n> [wouldFreeBytes=<n>] kept=<n> inUse=ok errors=<n> [skipped=<target>.<reason>:<n>,...] ms=<n>
```

A target's value is the number removed in `on`, `report:<candidates>/<bytes>B` in `report` (`worktreePrune=report:<records>`),
`off`, `skip:inUseFailed` when the in-use listing failed, (closed-lane targets) `skip:noRegistry` / `skip:registryFailed`,
(build output and Metro) `skip:procsFailed` when the process listing (Linux `/proc/*/cmdline`, macOS `ps`; none on Windows)
failed and `skip:toolRunning` when a process of the target's tool runs, or (developer caches) `skip:platform` / `skip:busy` /
`skip:processesFailed` / `skip:notInstalled` / `skip:notDue`. `wouldFreeBytes` sums the `report` targets' bytes. `skipped`
counts the entries left and why: `shielded` (an open lane's, in use, or a secret store), `checkout`, `lock`, `otherUser`,
`excluded` (a live-session temp name), `archived` (already in the archive), `unsafeRoot`, `recent` (a closed lane's worktree
active within 3 days or changed within 6 hours, build output within its age, or an Xcode folder changed within its age),
`reopened` (the lane is open again) and `tracked` (build output git tracks). In `cleanup.json` each
target carries `mode`, `removed`, `bytes`, `candidates`, `candidateBytes`, `kept`, `errors`, `skipped` and, when it did
not run, `skip`; the report has `dryRun` and `worktreePrune.{mode,ok,failed,candidates}`. Bytes of a removed browser
profile or memory agent are its files' total size.

To check a host, read `~/.dori/runner/logs/cleanup.json` there (`at` is the last sweep) or find the `RUNNER_CLEANUP`
line in the runner's log.

## Closed-lane worktree cleanup

Lane worktrees are not the daily sweep's: the supervisor removes them in two stages, through the lane's runner
(`lane.git`), the same way for local and remote lanes.

1. **Close (queue).** A lane's close removes nothing. A local close still refuses uncommitted, untracked or unpushed
   work (unless `--force`), then writes the worktrees it may drop into the closed lane's receipt (`receipt.queue`):
   each worktree's path and the checkout its `git worktree remove` runs in, and each SHA-bound branch target
   (repository, PR number, base, branch, merged head SHA, the checkout and remote to delete it from). A remote close
   queues its worktrees under the runner's reported root, each removed from inside itself (it skips the unpushed check,
   D10).
2. **Watcher (remove).** The watcher's closed-lane pass reads each queued worktree again and removes it only when it is
   clean and has no commit that no remote has (a worktree whose unpushed commits cannot be read stays, with a
   warning). Then it deletes each queued branch, remote first with a lease on the merged head, then local with a
   compare-and-delete, both only while the branch is still at that SHA, and also when the worktree was already gone.
   A branch still checked out in a queued worktree that stays waits for it.

Outside the root: a local lane's queued worktree is removed wherever it is, because its close found it as the lane's
(named by its key, or recorded) and checked it. Everything else is removed only under the lane's runner's reported
worktree root (a local lane uses `worktreeRoot` while its runner has reported none): a remote lane's queued
worktrees, a worktree an older close listed as kept, and the lane's own directory (`cwd`; for a remote lane
`remoteCwd`) and recorded worktrees that the close never found. A path an open lane uses (`cwd`, `remoteCwd`,
`worktrees`), the lead's cwd and a worktree the close held with its branch are never removed.

Every removal and delete is an operation row with a read-back, so a supervisor killed anywhere between the queue write
and the last branch delete finishes on a later pass without repeating an effect. What is done is marked in the queue,
so it is never repeated after its operation row is pruned. The pass prints `WORKTREE_CLEANED <key> <paths>` and
`BRANCH_CLEANED <key> <receipt lines>`; a branch that can never be deleted on its binding (protected, or moved off
the merged head) is one `LANE_WATCH_WARN` and is settled, and one that only has to wait (another open lane names its
PR, a ref that cannot be read) is one `LANE_WATCH_WARN` for each new reason and is tried again on every pass.

## Shadow mode (removed)

Shadow mode is gone. The supervisor always opens the hub, `dori supervise` always spawns the local runner as its
child (label `local`), and every lane is runner-owned. A leftover `runners` section in the config is ignored and named in the
one `CONFIG_KEYS_IGNORED` warning per process. `dori runner shadow-report` was removed with it, nothing is
compared against a legacy path any more, and a `shadow_diffs` table left in `runners.sqlite` is ignored.

## Liveness rule

A lane's agent is alive when its pane is in hc's pane list and its `agent_status` is `idle`, `working`, `blocked`
or `done` (`paneAlive` in `panes.ts`). Both sides use that rule: the runner reports no pane as `missing`, a pane
whose agent is not alive as `dead`, and an alive one as `working` or `idle`; the supervisor applies it to its own
pane list for the runner's machine. A paused lane whose pane is gone is therefore not alive on either side.

## Compatibility

Because validation rejects unknown fields, a new field, optional or not, is a protocol change. Add it as optional
in the schema and bump `PROTO`. The hub accepts runners at its own protocol version and one below (N and N-1),
so a supervisor can be upgraded before its runners. An older runner never sends the new field, and code reading it
must handle its absence. On disk, new hub columns are added with `ALTER TABLE` and read back as optional.

The current protocol is 10, so a supervisor accepts runners at 10 and 9 (`checkProto`). Any other runner is refused at
hello with `RUNNER_PROTO_MISMATCH`: one at 8 or below as too old (`dori runner update` upgrades it), one at 11 or
above as newer than the supervisor. Protocol 10 adds `toodo.read` / `toodo.read.result`; a proto 9 runner still
runs lanes and secrets while `dori doctor` warns that its lanes get no `dori toodo` reads. Protocol 9 added
`lanes.closed` / `lanes.closed.result` (the cleanup sweep's closed lanes). Protocol 8 added `secret.put` (since
removed; the protocol number stays).

**Upgrade the supervisor before its runners**: a proto 9 runner still connects to a proto 10 supervisor, but a proto 10
runner is refused by a proto 9 supervisor (`RUNNER_PROTO_MISMATCH`, newer than the supervisor). Bring every runner
to the supervisor's version before the next bump: a supervisor at protocol 11 would accept 11 and 10 and refuse a
runner still at 9.

Historical note (runners below protocol 8 can no longer connect): protocol 3 added the queries, the `cmd.result`
`result` and the other protocol 3 fields above, and the runner's `state.sqlite` gained the nullable
`commands.result_json` column; protocol 4 added runtime state reports (since removed); protocol 5 added the runner file
operations, `wait.check` and `job.run`; protocol 6 added the four secret control frames (see
[Secrets over the link](#secrets-over-the-link)); protocol 7 added `lane.attach`. The supervisor keeps no per-command
proto table: a connected runner speaks at least `MIN_PROTO` (`PROTO - 1`), which carries every command and query, and
only lane file operations fail closed while a connected runner's proto is not known yet. The remaining per-feature
checks (`secretsSupported`) date from those versions and never refuse a
runner the current window accepts.

## Liveness and restarts

The supervisor judges each runner by when its heartbeats arrive, on its own monotonic clock; a runner's wall clock is
never used. A supervisor start counts as the last time it saw each runner it knows.

The link itself has its own, shorter watch. A connection that carries no frame for 120 s (`RUNNER_SILENT_CLOSE_MS`;
heartbeats come every 15 s) is closed by the supervisor with `RUNNER_SILENT runner=<label> ...` and, once admitted,
`RUNNER_DISCONNECTED runner=<label>`. A TCP link that died without a FIN (sleep, a network change, a reboot) would
otherwise look open: the supervisor would not redial the worker, and the runner's next hello at the same gen would be
refused as `RUNNER_CONFLICT`. Once it is closed the supervisor redials and the same-gen hello is admitted. On the
worker side the listening socket pings a link that has been idle for 120 s and closes it when the ping goes unanswered
(a few minutes in all), so a worker does not keep refusing the redial as `runner already connected` behind a dead
link.

| Silent for | What happens |
|---|---|
| 60 s | `RUNNER_STALE machine=<label>` (engine-only), once |
| 180 s | `RUNNER_OFFLINE machine=<label> runner heartbeat missing ...` (engine-only), and restart decisions start; `HOST_GUARD OFFLINE machine=<label> ...` (urgent) instead when the runner owns open lanes and has sent a heartbeat or hello since the supervisor started (one still reconnecting after a supervisor restart waits for the next row) |
| 10 min offline, or the probe finds it dead | `HOST_GUARD OFFLINE machine=<label> ...` (urgent), once per disconnect |
| 30 min offline, or the restart circuit open | the runner is lost: `LANE_RUNNER_LOST <key> runner=<label>` (urgent) once for each open lane it owns; nothing is moved |

Each decision runs `dori runner probe --json` on the runner's host: over ssh for a worker, using
`~/.dori/runner/bin/dori.js`, and directly for the local runner. It ends one of three ways:

- **Unreachable** (ssh fails or times out after 20 s, the machine is unknown, or there is no probe answer): no
  restart; the next decision waits 2 min, doubling to 30 min.
- **Alive** (`healthy` or `stalled`): the runner is fine and only its connection is down, so it is not restarted.
  `RUNNER_UNREACHABLE machine=<label>` (engine-only) is said once per outage.
- **Dead**: a restart is planned as operations row `runner:<label>/restart/<epoch>-<n>`, and then
  the runner's service is restarted on that host (`systemctl --user restart dori-runner.service`, or
  `launchctl kickstart -k` on the recorded launchd domain on macOS). A hello with a higher gen within 2 minutes
  verifies it: `RUNNER_RESTARTED`. Without one the row fails, `RUNNER_RESTART_FAILED` is said, and the next decision
  follows the backoff.

The restart circuit allows 3 restarts per runner per hour. A heartbeat or hello ends a disconnect, with
`HOST_GUARD ONLINE machine=<label>` when it had woken the lead with `HOST_GUARD OFFLINE`. Each such
`HOST_GUARD OFFLINE` and `HOST_GUARD ONLINE` is also posted as a system notice to the alerts channel (config
`alertsChannel`, else the first `discordChannels` entry).

Outages have hysteresis per machine: an outage ends only once the runner has stayed connected for 10 minutes. A
disconnect before then folds into the same outage: no new `RUNNER_STALE` or `RUNNER_OFFLINE`, and owned lanes do not
wake the lead a second time (staying down 10 minutes or a dead probe still does). The end of the outage is said once as
`RUNNER_ONLINE machine=<label>` (digest), with the number of disconnects folded into it. The runner's unit is separate from hc's (it only
`Wants=` and is `After=` `hc-core.service`), so a restart never touches a lane's pane.

`dori status` shows the restarts of the last hour on the runner's machine line (`restarts1h` in `--json`). `dori doctor` checks the recorded runner endpoints, the local
runner directory, and each runner's protocol, outbox backlog and restart circuit.

`dori update` restarts the supervisor first. Only once it is active again does it move the runners, one at a time.
The local runner's unit is restarted; every other runner gets the new bundle the way `dori runner install` sends it.
The update then waits up to 2 minutes for a hello with a higher gen before it goes to the next runner. A runner
that fails logs `RUNNER_UPGRADE_FAILED runner=<label> ...` (urgent) and keeps its version; the rollout goes on with
the next runner.

The urgent runner events are `LANE_RUNNER_LOST`, `LANE_ORPHAN`, `RUNNER_LAUNCH_FAILED`, `RUNNER_FORGED_EVENT`, `RUNNER_AUTH_FAILED`,
`RUNNER_OUTBOX_LARGE` and `RUNNER_UPGRADE_FAILED`. `RUNNER_ONLINE`, `RUNNER_RESTARTED`, `RUNNER_RESTART_FAILED`, `RUNNER_PROTO_MISMATCH` and `RUNNER_CONFLICT` are digest;
`RUNNER_STALE`, `RUNNER_OFFLINE`, `RUNNER_UNREACHABLE` and `RUNNER_UNAVAILABLE` are engine-only (journaled, never delivered).

## Command durability

The runner commits a command's intent before the effect and its result after it. A runner that stops between the two
never runs the command again on restart. It settles it from what hc shows:

- **`lane.start`:** a pane whose process carries `DORI_LANE_KEY=<key>` makes it `verified`, no such pane makes it
  `failed`, and hc not answering leaves it `ambiguous`.
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
`dori launch --machine <label>` starts it through that machine's runner. There's no direct hc path and no mode
that picks one: a `runners` config section is ignored (`CONFIG_KEYS_IGNORED`). A lane whose runner is down waits for it,
and losing a runner never hands the lane back to the supervisor.

**Launch.** `dori launch` registers the lane at once with `runner: <label>` and appends the runner footer to the
brief. It then queues `lane.start` for the supervisor (`runner_admin` in `runners.sqlite`), which sends it once the
runner is connected; a request waits at most 2 minutes. A runner launch needs `--cwd` and takes no target pane. On the worker, the runner:

- checks the command against `runner-config.json` (the `cwd` must be under `allowedRoots`);
- opens an hc terminal named after the key, writes the brief to `~/.dori/runner/briefs/<key>.md` and issues the lane a
  fresh 32-byte token;
- runs the agent of its own profile `default` (`agents.default`, with `{prompt}`, `{model}` and `{brief}` filled in),
  with `DORI_LANE_KEY` and `DORI_LANE_TOKEN` in front of it. The lead never sends an argv.

The runner keeps only the token's sha256, with the lane's pane, tab and cwd, in `~/.dori/runner/lanes.json`; that is
its hello inventory. Its `lane.started` gives the supervisor the pane. `lane.close` and `lane.stop` close the
pane, delete the brief and forget the token. `lane.recover` starts the lane again from its brief when its pane or agent
is gone, and leaves a live one alone. The agent runs in the hc pane, not under the runner, so a runner restart
does not end a lane.

**Reporting.** A runner lane's footer has it report with `~/.dori/runner/bin/dori` (a wrapper the installer puts there
for the bundle). In a lane that CLI takes only `report`, `claim-done` and `heavy`, and only for the lane's own key; any
other command exits 2 with `DORI_CLI_UNSUPPORTED_ON_RUNNER <cmd>`. A report goes over `~/.dori/runner/sock/lane.d/lane`
with the lane's token. The socket has a directory of its own so the Linux lane sandbox can bind the directory rather
than the socket file: a restarted runner binds a new socket at the same path, and a lane started before the restart
reaches it. The runner refuses a token that is not that key's own (`RUNNER_LANE_AUTH_FAILED`) and puts an
accepted report in its outbox as `lane.report`. `heavy` takes the host's `~/.dori/heavy/slot.N`, the same slots
the supervisor's scheduled heavy jobs use, so there's one heavy count per machine.

**Secrets.** The lane socket also takes `secret`: `{"kind": "secret", "key": "<key>", "token": "<token>"}`,
sent by the lane's `dori secret env` at launch. It carries no names and means every store value; the token is checked
first. A grant replies `{"ok": true, "values": {"NPM_TOKEN": "...", ...}}`;
a refusal replies `{"ok": false, "code": "RUNNER_SECRET_DENIED", "detail": "..."}` (or `RUNNER_SECRET_FAILED`). The
local runner answers from its own store. A remote runner asks the supervisor over the link (below). The lane reply is never journaled,
logged or put in the outbox. See [secrets.md](secrets.md).

### Secrets over the link

Protocol 6. A remote runner sends `secret.get {rid, key, names, repo?}` (`rid`: 32 random hex chars; `repo`: the lane's
`owner/repo` read from its worktree) and the supervisor answers `secret.value {rid, ok, code?, detail?, sealed?}`.
Current runners send an empty `names` and get every store value; a non-empty list from an older runner gets just those
names. There's no allowlist: the supervisor checks only the link, lane ownership and `allowUnsandboxed`.
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

### Toodo reads over the link

Protocol 10. A lane reads Toodo read-only with `dori toodo get [<id>] | search <query> | guidelines` (lane socket
verb `toodo {key, token, op, id?, query?}`). Toodo's token lives only on the supervisor host, so the local runner
reads there itself and a remote runner sends `toodo.read {rid, key, op, id?, query?}`; the supervisor checks the link
and lane ownership (not `allowUnsandboxed`: no secret is handed out) and answers `toodo.read.result`, shaped like
`secret.value`, whose sealed box opens to `{text, truncated}`. Both sides check `op` again: only `get`, `search` and
`guidelines` exist, each mapped to toodo-server's read commands (`get_task`, `list_tasks`, `list_task_relations`,
`list_guidelines`), so no lane request can reach a Toodo write. The scope is the lane's task (autopilot key
`ap-<task>-<n>`): that task, the tasks it depends on or is related to, the tasks of its workspace and that workspace's
guidelines. Anything else is refused with `TOODO_LANE_OUT_OF_SCOPE`; a lane without a task gets `TOODO_LANE_NO_TASK`.
The text goes through `redactSecrets` and is cut at 256 KiB. A runner whose supervisor is below protocol 10 answers
`RUNNER_SECRET_OUTDATED`.

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
lanes are skipped without a line per lane, and the sweeps say `RUNNER_UNAVAILABLE runner=<label>` (engine-only) once per
outage; the archive's worktree cleanup runs right after the local runner's hello.

**Evacuate.** `dori runner evacuate <label>` is the forced rollback for a runner that cannot be used. In order:

1. It fetches the runner's unacked events over ssh (`runner export-outbox`) and takes them as if they had arrived,
   so a report already received is not stored twice.
2. It tells each lane the runner owns, through that runner while it still runs, that its reports fail until the runner
   is back. `Lane.runner` is kept: the runner is the only path to its lanes.
3. It stops the runner's service: the systemd unit on Linux, or on macOS the launchd agent (disabled and booted out).

The lanes keep running. A step that fails is reported, and the later steps still run.
