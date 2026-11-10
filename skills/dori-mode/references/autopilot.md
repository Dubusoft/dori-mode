# Autopilot

Autopilot decides which ready toodo tasks may run as lanes without a fresh word from the owner. It acts only on tasks marked for autopilot in toodo (the task's `autopilot` field, set in the web app or through MCP `create_task` / `update_task`). Config `autopilot.mode` decides how far it goes: `off` (the supervisor does not judge), `shadow` (the default: judged and recorded, nothing launches) or `on` (the supervisor wakes the lead with `AUTOPILOT_READY` and the lead launches). dori code itself never calls `dori launch`, never changes toodo and never merges. `dori autopilot launch` is the lead's reservation step for a launch it runs itself: it records the attempt in the ledger and launches nothing, and it refuses unless the mode is `on` and autopilot is not paused (`dori autopilot pause`). Shadow stays the default: switching to `on` is the owner's call.

## Flag contract

- A task is a candidate when it is `planned` and marked for autopilot, in any workspace. There is no workspace allow list and no approval list kept by dori: the mark is the owner's approval, and clearing it withdraws it.
- Toodo does not record who set the mark, so the lead sets it only when the owner asked for autopilot on that task, and adds the owner's message as a task ref `owner:<ref>` (e.g. `owner:discord:<channel>/<message>`). A marked task without such a ref refuses `owner-ref-missing`.
- A marked task needs at least one criterion, so the lane has something to verify (`criteria-missing` otherwise).
- Editing a marked task does not withdraw the mark; there is no content hash. When the lead changes a marked task's scope (title, criteria), it records the change as a `decision` progress note.
- A follow-up task is never marked by inheritance; the owner asks for it on that task.

Toodo's web RPC `list_tasks` filter has no `autopilot` key, so dori reads every planned task (`{ statuses: ["planned"] }`, all workspaces) and keeps the marked ones.

## Ledger

Launch attempts are operation rows: lane `toodo:<taskId>`, action `autopilot-launch`, target `<attempt number>` (1, 2, ...), data `{ "laneKey" }` with the lane key `ap-<taskId>-<attempt>`. Only `dori autopilot launch` writes them (see Commands): `planned` when reserved, then `verified` (launched), `failed` or `ambiguous` when settled. The predicate reads them:

- Autopilot never retries by itself: any earlier attempt that is not running refuses `already-attempted`, for the owner to decide.
- A row in `ambiguous` sends the task to the owner (REFUSE `ledger-ambiguous`); it is never retried.
- A row that is open (`planned`, `attempted`), or `verified` with its `laneKey` an open registry lane, means the task is running (HOLD `lane-live`).

When the lane a row names closes, the close settles the row once and adds `outcome` to its data (every close path: `dori close`, a settled done claim, a merge, a recovery close, a close the supervisor resumes after a crash):

- A close with `--cancelled` (the lane never started, e.g. after `RUNNER_LAUNCH_FAILED`, was given up, or its Done can never hold) settles the row `failed` with `outcome: "failed"` and gives the lead `AUTOPILOT_LANE_FAILED #<id> lane=<key> attempt=<n> cancelled: <reason>: tell the owner; autopilot does not launch it again`.
- Any other close (every Done signal held, or its PR merged) keeps the row `verified` with `outcome: "done"` and gives `AUTOPILOT_LANE_DONE #<id> lane=<key> attempt=<n>: complete toodo task #<id>`.

`dori close` prints the line; a close the supervisor runs journals it as an urgent event under the id `autopilot-outcome:<key>`, so it is told once. A row the launch itself settled `failed` or `ambiguous` is left as it is.

Shadow records are rows too: lane `autopilot`, action `autopilot-shadow`, target `<taskId>@<slot ISO>` (slot is the current hour floored, UTC), state `verified`, detail `<VERDICT> <reasons joined by ", ">`. Only `--record` writes them, one per task per hour.

## Configuration

Key `autopilot` in `config.json`; every field is optional. An invalid value or an unknown key throws a TypeError at load naming the key. The bundle design's keys (`workspaces`, `bundleExpiryDays`, `wip`, `wipCap`, `attemptCap`, `onRevoke`) are ignored with one `CONFIG_AUTOPILOT_KEYS_IGNORED` line.

| Key | Default | Meaning |
| --- | --- | --- |
| `quotaMaxUsedPct` | `80` | Any Claude account's 5h or 7d window at or above it holds (`quota-over-threshold`). |
| `quotaUnreadable` | `"hold"` | Only value in v1: unreadable quota holds (`quota-unreadable`). |
| `mergeBase` | `"dev"` | Autopilot lanes merge into this branch only. |
| `crossWorkspacePrereqs` | `"block"` | Only value in v1: a prerequisite in another workspace refuses (`cross-workspace-prerequisite`). |
| `mode` | `"shadow"` | `"off"`: the supervisor's tick does not judge and writes nothing. `"shadow"`: the tick judges and writes shadow rows, never wakes the lead, and `launch` refuses. `"on"`: the tick also wakes the lead with `AUTOPILOT_READY`, and `launch` may reserve. |
| `tickSec` | `300` | Seconds between the supervisor's ticks, an integer from 30 to 3600. |

Both apply live when `config.json` is edited (no supervisor restart). There is no workspace allow list (every workspace's marked tasks are candidates), no autopilot WIP cap and no daily cap: the host guard alone limits how many lanes run (see Slots).

## Selection predicate

`judge(input)` returns `{ taskId, verdict, reasons }`. Every failing reason is collected, not just the first. The verdict is REFUSE when any reason refuses, else HOLD when any reason holds, else LAUNCH. A dependency is satisfied only when it is `done` with resolution `merged` or `completed`.

REFUSE means the task needs the owner or the lead, or is not eligible yet:

| Reason | When |
| --- | --- |
| `not-flagged` | The task is not marked for autopilot (a `--tasks` id, e.g. a ready task nobody marked). |
| `owner-ref-missing` | No task ref `owner:<ref>`. |
| `criteria-missing` | The task has no criterion. |
| `task-missing` | Toodo no longer returns the task (archived or deleted). |
| `not-planned` | Status is not `planned` and the task has no wait. |
| `prerequisite-missing` | A dependency is no longer returned by toodo (archived or bulk-deleted). |
| `prerequisite-open` | A dependency is not done yet. The next tick after it is done judges again. |
| `prerequisite-not-adopted` | A dependency is done with resolution `not_adopted`. |
| `cross-workspace-prerequisite` | A dependency lives in another workspace. |
| `already-attempted` | A launch attempt exists for the task and none is running. |
| `ledger-ambiguous` | A ledger row for the task is `ambiguous`. |

HOLD is temporary; the next tick judges again:

| Reason | When |
| --- | --- |
| `waiting` | The task has a wait. A waiting in-progress task reads `planned` plus a wait, so it lands here too. |
| `lane-live` | An open ledger row, a verified row whose lane is open, or a task ref `lane:<key>` naming an open lane. |
| `quota-unreadable` | Claude quota could not be read. |
| `quota-over-threshold` | A Claude account's 5h or 7d window is at or above `quotaMaxUsedPct`. |
| `host-hold` | `dori can-launch` holds the default machine. |
| `no-slot` | The task would launch, but the host's free slots went to tasks ahead of it. |

## Slots

The default machine's free slots are `guard.panesMax` minus its panes (the runner's thresholds for a remote machine). After every task is judged, only that many LAUNCH tasks keep LAUNCH: those with a due date first (earliest first), then by ascending id. The rest HOLD `no-slot`. With the pane limit off (`panesMax` 0) nothing caps the count. A held host gives every task `host-hold` and reports `slots=0`.

## Commands

Lead-only; inside a lane each one exits with `LANE_PERMISSION_DENIED`.

```
dori autopilot candidates [--tasks 12,13] [--json] [--record]
dori autopilot launch <taskId> [--launched <laneKey> | --failed | --ambiguous] [--note TEXT]
dori autopilot pause [--reason TEXT]
dori autopilot resume
```

- `candidates` judges every planned task marked for autopilot, plus the `--tasks` ids. It's read-only unless `--record` is given, which writes shadow rows only. Text output:

  ```
  AUTOPILOT mode=shadow record-only: nothing launches slots=<n|unlimited> candidates=<n>
  AUTOPILOT_CANDIDATE #12 LAUNCH would-launch
  AUTOPILOT_CANDIDATE #13 HOLD no-slot
  AUTOPILOT_CANDIDATE #14 REFUSE owner-ref-missing, criteria-missing
  ```

  The header reads `AUTOPILOT mode=on slots=<n> candidates=<n>` only in mode `on` without a pause; otherwise it says `record-only: nothing launches`, with `paused` after the mode while a pause is in force. With no candidate it prints `AUTOPILOT_NO_CANDIDATES`. `--json` prints `{ mode, paused, slots, candidates: [{taskId, verdict, reasons}] }` (`slots` is null without a pane limit). Exit 0 whenever it judged (all HOLD included), 1 with `AUTOPILOT_TOODO_UNREADABLE <why>` when toodo-server cannot be read (token file missing or empty, network error, non-200), 2 on usage errors.
- `launch <taskId>` reserves the task's next launch attempt. Unless the mode is `on` it prints `AUTOPILOT_LAUNCH_REFUSED #<id> mode=<mode>: nothing launches unless autopilot.mode is "on"`, and while paused `AUTOPILOT_LAUNCH_REFUSED #<id> paused since <ISO>[: <reason>] (dori autopilot resume lifts it)`; both exit 1 before reading anything. Otherwise it holds a state lock (`<stateDir>/autopilot-launch.lock.sqlite`) while it reads toodo, the ledger, open lanes, quota and the host again, and judges the task among every marked task as `candidates` does. Another task's reservation that is not running as a lane yet takes one of the host's free slots, since its pane does not exist yet. Only on LAUNCH it writes the `planned` row and prints `AUTOPILOT_RESERVED #<id> lane=ap-<id>-<n> attempt=<n>` (exit 0). Otherwise it prints `AUTOPILOT_LAUNCH_REFUSED #<id> <HOLD|REFUSE> <reasons>` and writes nothing (exit 1). A second reserve of the same task holds `lane-live`, so handling one event twice launches once.
- `launch <taskId> --launched <laneKey>` settles the open reservation as `verified` (the key must be the reserved one, else `AUTOPILOT_LANE_MISMATCH`, exit 1). `--failed` settles it `failed` when the launch surely did not happen, and `--ambiguous` settles it `ambiguous` when that cannot be told; `--note` adds why to the row. Each prints `AUTOPILOT_SETTLED #<id> attempt=<n> <state> lane=<key>`; with no open reservation, `AUTOPILOT_NO_RESERVATION #<id>` (exit 1). A settled attempt is never retried by itself: `failed` and a closed lane refuse `already-attempted`, `ambiguous` also refuses `ledger-ambiguous`. Settling works in any mode and while paused, so a launch already under way can still be recorded.
- `pause [--reason TEXT]` writes `<stateDir>/autopilot-pause.json` and prints `AUTOPILOT_PAUSED since <ISO>[: <reason>]` (` (already paused)` when one was in force; the first is kept). While it is in force, `launch` refuses new reservations and the tick wakes no one; lanes already running go on to their claim. A pause file that cannot be read still counts as paused. `resume` removes it (`AUTOPILOT_RESUMED`, or `AUTOPILOT_NOT_PAUSED`). Both exit 0. Use pause to stop autopilot at once without editing the config.

## Supervisor tick

The supervisor judges the same candidates itself every `autopilot.tickSec` (5 minutes by default; sooner after a toodo task event, `tasks-changed` included, at most once per 15 s) and writes the hour's shadow rows. In mode `off` it judges nothing. In mode `shadow`, or while paused, it stops there. In mode `on` it wakes the lead with urgent `AUTOPILOT_READY #12,#15 slots=<n|unlimited>` only when the set of LAUNCH tasks or the free slots change, and once more as `AUTOPILOT_READY ... again` every 30 minutes while the same set waits; a tick with nothing to launch (or in shadow, or paused) forgets the set, so it is news again when it comes back or the pause lifts. A tick that cannot read toodo logs `AUTOPILOT_TICK_ERROR <why>` once and tries again at the next tick. The tick runs only while the `toodo` event source is enabled, and it replaced the hourly `autopilot-reconcile` schedule job, which the supervisor removes at startup (`AUTOPILOT_RECONCILE_JOB_REMOVED`).

## Rules for the lead

- A `TOODO_TASK_READY` event never launches by itself: the supervisor's tick judges it (`dori autopilot candidates --tasks <id>` shows why an unmarked ready task would not run). Only a marked task that judges LAUNCH may run, and only in mode `on`; in `shadow` LAUNCH only records "would launch #<n>". Any other ready task is recorded, not launched.
- `AUTOPILOT_READY` comes only in mode `on`. Take the named tasks through the order below: `dori autopilot launch <id>` judges each again under its lock, so a task that changed since the tick is refused there. The supervisor's tick replaces any periodic reconcile of your own; there is no `autopilot-reconcile` schedule job any more.
- Never set `autopilot.mode` to `on` yourself: that needs the owner's explicit word. When the owner says to stop autopilot, run `dori autopilot pause --reason TEXT` (and `resume` when they say to go on); `mode: "off"` is for turning it off for good.
- Autopilot lanes merge into `dev` only (`autopilot.mergeBase`). Merging to main or releasing always needs the owner's explicit word for that merge or release.
- Order: `dori autopilot launch <id>` (reserve; use the lane key it prints), `start_task` with a `lane:<key>` ref, `dori launch <key>`, then settle with `dori autopilot launch <id> --launched <key>`, or `--failed` / `--ambiguous` when the launch did not happen or its outcome is unclear (either goes to the owner). After a restart, an in-progress task with no live lane is reported, never relaunched.
- A started autopilot lane that fails (`RUNNER_LAUNCH_FAILED`, the work is given up, its Done can never hold) is closed with `dori close <key> --cancelled --reason TEXT`, never launched again. On `AUTOPILOT_LANE_FAILED` tell the owner what failed and leave the task for them (`report_blocker` on it). On `AUTOPILOT_LANE_DONE` complete the task (`complete_task` with the PR as a ref), which lets its dependents become ready.
- While any task is marked for autopilot, never archive a task that has dependents, and never run `delete_done_tasks` or any bulk delete in a workspace that holds marked tasks.
- Clearing the mark (`update_task` with `autopilot: false`) stops new launches. Running lanes go on to claim, and their merges wait until the owner speaks.

## Leaving shadow mode

This is the owner's call, not code: it is the `autopilot.mode` edit from `shadow` to `on`. Shadow ends after 7 days and 20 judgments, whichever comes later, with zero wrong would-launch verdicts and a passed restart and resync drill.
