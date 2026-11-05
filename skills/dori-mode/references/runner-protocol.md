# Runner protocol

The runner is a small per-machine process (`dori runner serve`) that talks to the supervisor over one line-based
connection. In this release it runs in shadow mode only: it reports what it sees on its machine and changes nothing.
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
| `mac` | optional string; accepted but not checked yet |

Validation is strict. An unknown envelope or body field, an unknown type, a type sent by the wrong side, `seq` on a
non-event, `cmdSeq` on a non-command, a missing or zero sequence, a wrong field shape or a bad label is rejected
with `RUNNER_FRAME_INVALID <rule> <detail>`. Integers must be non-negative safe integers. On the hub an invalid
frame closes the connection without an ack.

## Types

Control frames, used in this release:

- Runner to supervisor: `hello {proto, gen, label, hostId, cmdAck, version?, inventory?}`,
  `heartbeat {outbox?: {unacked, oldestAgeMs}}`, `cmd.status.result {cmdId, state, detail?}`.
- Supervisor to runner: `hello.ok {proto, epoch, eventAck}`, `hello.reject {code, detail}`, `ack {eventAck}`,
  `cmd.status {cmdId}`.

`hello` must be the first frame on a connection. The hub rejects it with `RUNNER_PROTO_MISMATCH` when the protocol
version isn't accepted, and with `RUNNER_CONFLICT` when the label is already pinned to another `hostId` or the
`gen` is lower than the highest one it has seen for that label. A newer connection for a label replaces an older one.

Runner events are defined for `lane.started`, `lane.state`, `lane.report`, `lane.asking`, `lane.progress`,
`wait.result`, `job.result`, `guard.sample`, `guard.alert`, `guard.critical`, `heavy.state` and `cmd.result`. The
shadow runner publishes only `lane.state` today. Supervisor commands (`lane.start`, `lane.stop`, `lane.pause`,
`lane.resume`, `lane.recover`, `lane.send`, `lane.close`, `lane.observe`, `wait.check`, `job.run`, `guard.kill`,
`runner.rotate`) are part of the schema but never sent; a shadow runner drops any command it receives.

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
| `sock/control` | the unix socket the supervisor listens on and the runner connects to |

The hub's table is `<stateDir>/runners.sqlite` on the supervisor side.

Directories must be 0700 and files 0600, owned by the runner's uid, with no symlinks anywhere. `dori runner serve`
checks this with lstat before opening anything; on the first bad entry it prints `RUNNER_DIR_UNSAFE <path> <reason>`
to stderr and exits 1. It never repairs permissions. The supervisor creates `~/.dori/runner` and `sock/` as 0700
when they're missing, and the socket itself is 0600.

There's no peer credential check on the socket. Bun's unix sockets don't expose the peer's uid (no `SO_PEERCRED`),
so the 0700 `sock/` directory inside the 0700 runner directory is the only access boundary for now.

## Shadow mode

A runner is in shadow mode when the config's `runners.mode` maps its label to `"shadow"`; unnamed labels are
`"off"`. Without a `runners` section the supervisor opens no hub and nothing changes. In shadow mode the runner reads
the registry's open local lanes and herdr's pane list every 30 seconds, publishes `lane.state` when a status changes,
and sends the latest list as the hello inventory. It never starts, stops or edits a lane.

On the supervisor, the `runners` task (every 5 seconds, under the usual watchdog) compares what the runner reported
with what the legacy path sees. A new difference waits one cycle. If it's still there next cycle it's logged with
its class; if it went away it's logged as `timing`:

```
RUNNER_SHADOW_DIFF runner=<label> class=<c> kind=<k> lane=<key> gen=<n> field=<f> runnerHash=<h|-> legacyHash=<h|->
```

| Class | Meaning |
|---|---|
| `missing-in-runner` | the legacy path has the value, the runner doesn't |
| `missing-in-legacy` | the runner has the value, the legacy path doesn't |
| `value-differs` | both have it, with different values |
| `timing` | a difference that settled within one cycle; not a failure |

Values are compared as short sha256 hashes. Guard verdicts compare level and reasons, never raw figures. If the
hub can't open (an unsafe directory, a bad socket file) the supervisor logs `RUNNER_HUB_DISABLED` and keeps running.

## Compatibility

Because validation rejects unknown fields, a new field, optional or not, is a protocol change. Add it as optional
in the schema and bump `PROTO`. The hub accepts runners at its own protocol version and one below (N and N-1),
so a supervisor can be upgraded before its runners. An older runner never sends the new field, and code reading it
must handle its absence. On disk, new hub columns are added with `ALTER TABLE` and read back as optional.

## Not yet

Later phases add:

- authentication: enrollment, keys and `mac` checking (`RUNNER_AUTH_FAILED`, `RUNNER_REVOKED`)
- remote install of runners on worker machines
- lane control: supervisor commands, `cmd.result` and `cmdAck` actually moving, `authoritative` mode
- guard samples and alerts from the runner
- full liveness: `lost` and `revoked` states, restart counts and the restart circuit
