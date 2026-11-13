# Autopilot

Autopilot decides which ready toodo tasks may run as lanes without a fresh word from the owner. It acts only on tasks marked for autopilot in toodo (the task's `autopilot` field, set in the web app or through MCP `create_task` / `update_task`). Autopilot is always on: the supervisor judges the marked tasks, wakes the lead with `AUTOPILOT_READY`, and the lead launches; the task's mark alone decides whether it may run, and `dori autopilot pause` is the emergency stop. dori code itself never calls `dori launch`, never changes toodo and never merges. `dori autopilot launch` is the lead's reservation step for a launch it runs itself: it records the attempt in the ledger and launches nothing, and it refuses while autopilot is paused (`dori autopilot pause`).

## Flag contract

- A task is a candidate when it is `planned` and marked for autopilot, in any workspace. There is no workspace allow list and no approval list kept by dori: the mark is the owner's approval, and clearing it withdraws it.
- Toodo does not record who set the mark, so the lead sets it only when the owner asked for autopilot on that task, and adds the owner's message as a task ref `owner:<ref>` (e.g. `owner:discord:<channel>/<message>`). A marked task without such a ref refuses `owner-ref-missing`.
- A marked task needs at least one criterion, so the lane has something to verify (`criteria-missing` otherwise).
- Editing a marked task does not withdraw the mark; there is no content hash. When the lead changes a marked task's scope (title, criteria), it records the change as a `decision` progress note.
- A follow-up task is never marked by inheritance; the owner asks for it on that task.

Toodo's web RPC `list_tasks` filter has no `autopilot` key, so dori reads every planned task (`{ statuses: ["planned"] }`, all workspaces) and keeps the marked ones.

## Execution contract

A marked task states how it runs through task refs, which toodo stores without interpreting them. `planTask` (`scripts/src/autopilot-plan.ts`) reads them, with the task, its dependencies and the workspace guidelines (`ToodoClient.guidelines`, toodo's `list_guidelines`), and returns either a ready contract with its template brief or the reasons the task needs the lead's review. It is pure: nothing in it reads toodo, writes a file or launches.

| Ref | Default | Meaning |
| --- | --- | --- |
| `repo:<owner>/<name>` | required | The one repository the lane works in (case-insensitive). |
| `base:<branch>` | `autopilot.mergeBase` | The branch the lane starts from and opens its PR into. It must be `autopilot.mergeBase`. |
| `branch:<name>` | `autopilot/<taskId>` | The lane's branch, a valid git branch name other than the base. The lane's Done is `pr <repo> <branch>`. |
| `mode:<ulw\|mass-ulw>` | `ulw` | The lane's mode. Nothing guesses it from the text. |
| `model:<id>` | `defaultModel` | The lane's model. |
| `approved:<version>` | none | The lead reviewed the task at that contract version. |

The contract also carries:

- `version`: a 12-digit sha256 over the title, description, criteria, dependencies and contract refs. Status, notes and other refs (`owner:`, `lane:`, `approved:`) are left out, so starting or approving the task keeps it, while a scope change moves it.
- `guidelines`: a snapshot of the workspace's guidelines (rules and memories, by id) with its own hash, so a later run can tell whether they changed since the brief was built.
- `approvedVersion`: the version an `approved:` ref names when it matches.

The task goes to review instead (`kind: "review"`, reasons in this order) on `repo-missing`, `repo-ambiguous` (two repos), `ref-invalid` (a malformed repo, base, branch, mode or model, or a branch equal to the base), `ref-conflict` (two different values for one key), `base-not-allowed` (a base other than `autopilot.mergeBase`) and `approval-stale` (an `approved:` ref none of which names the current version). Whether a criterion can be judged by a script is not guessed: a lead who reviews such a task records `approved:<version>`, and any later scope change sends it back to review.

The template brief is the task's title (`# <title> (Toodo #<id>)`), its description as written, its criteria with kind and target, its dependencies with status, its other refs, the workspace guidelines (rules, then memories) and the contract (repo, base, branch, Done, mode, version, snapshot hash). `dori launch` appends the common lane footer, so the brief does not repeat it. Storing the snapshot outside the repo and launching from the contract belong to the executor.

## Ledger

Launch attempts are operation rows: lane `toodo:<taskId>`, action `autopilot-launch`, target `<attempt number>` (1, 2, ...), data `{ "laneKey" }` with the lane key `ap-<taskId>-<attempt>`. Only `dori autopilot launch` writes them (see Commands): `planned` when reserved, then `verified` (launched), `failed` or `ambiguous` when settled. The predicate reads them:

- Autopilot never retries by itself: any earlier attempt that is not running refuses `already-attempted`, for the owner to decide.
- A row in `ambiguous` sends the task to the owner (REFUSE `ledger-ambiguous`); it is never retried.
- A row that is open (`planned`, `attempted`), or `verified` with its `laneKey` an open registry lane, means the task is running (HOLD `lane-live`).

When the lane a row names closes, the close settles the row once and adds `outcome` to its data (every close path: `dori close`, a settled done claim, a merge, a recovery close, a close the supervisor resumes after a crash):

- A close with `--cancelled` (the lane never started, e.g. after `RUNNER_LAUNCH_FAILED`, was given up, or its Done can never hold) settles the row `failed` with `outcome: "failed"` and gives the lead `AUTOPILOT_LANE_FAILED #<id> lane=<key> attempt=<n> cancelled: <reason>: tell the owner; autopilot does not launch it again`.
- Any other close (every Done signal held, or its PR merged) keeps the row `verified` with `outcome: "done"` and gives `AUTOPILOT_LANE_DONE #<id> lane=<key> attempt=<n>: complete toodo task #<id>`.

After the close the supervisor writes the outcome to the task (task-finish.ts, every write read back with `get_task`) and marks the row's data `toodo` once (`done`, `blocked` or `failed`), so a resumed or repeated close never writes to the task or tells the lead again; nothing is relaunched:

- Done, PR read back merged: each pending manual criterion is checked with the merge as evidence and the task is completed with the PR as a ref and a note naming its merge SHA. The line becomes `AUTOPILOT_LANE_DONE ... attempt=<n> toodo=done: toodo task #<id> completed and read back by the supervisor`, which is digest.
- Done, but the task could not be completed (no merge read back, toodo refused or did not confirm): the task gets a blocker note and the one failure line, `TOODO_TASK_NOT_COMPLETED`, ends with `blocker recorded on toodo task #<id>` (or why it was not).
- Cancelled: `dori close` (or the supervisor resuming it) records the blocker note and the failure line reads `AUTOPILOT_LANE_FAILED ... cancelled: <reason> toodo=blocked: blocker recorded on toodo task #<id>; tell the owner; ...`.

`dori close` prints the line; a close the supervisor runs journals it as an urgent event under the id `autopilot-outcome:<key>`, so it is told once. A row the launch itself settled `failed` or `ambiguous` is left as it is.

Rows with lane `autopilot` and action `autopilot-shadow` are judgment records an older dori wrote (shadow mode, now removed); nothing reads or writes them any more.

## Configuration

Key `autopilot` in `config.json`; every field is optional. An invalid value or an unknown key throws a TypeError at load naming the key. The bundle design's keys (`workspaces`, `bundleExpiryDays`, `wip`, `wipCap`, `attemptCap`, `onRevoke`) the removed `mode` (any value; autopilot is always on) and the removed `quotaMaxUsedPct` (an account now counts as spent only at 100%) are ignored with one `CONFIG_AUTOPILOT_KEYS_IGNORED` line. `dori setup` (`--migrate` included) removes `autopilot.mode` from `config.json` once, at schema version 7, logging `SETUP_KEY_REMOVED autopilot.mode (...)`.

| Key | Default | Meaning |
| --- | --- | --- |
| `quotaUnreadable` | `"hold"` | Only value in v1: unreadable quota holds (`quota-unreadable`). |
| `mergeBase` | `"dev"` | Autopilot lanes merge into this branch only. |
| `crossWorkspacePrereqs` | `"block"` | Only value in v1: a prerequisite in another workspace refuses (`cross-workspace-prerequisite`). |
| `tickSec` | `300` | Seconds between the supervisor's ticks, an integer from 30 to 3600. |
| `quotaCacheSec` | `90` | Seconds a quota read is reused before the usage endpoints are read again, an integer from 30 to 900. It applies to every quota caller (the judge, `dori quota`, Discord `/quota`); see Quota reads. |

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
| `quota-unreadable` | No account of the provider serving `defaultModel` (for `anthropic-subscription/...`, every Claude subscription account) has a usable read. An unreadable account (expired token, failed request, a last good read older than 30 minutes: `stale-read`) is skipped while another is readable, and named in the candidates header (`quota-skipped: ...`) and JSON (`quotaSkipped`). An account judged on a cached read older than `quotaCacheSec` (rate-limited, or no lookup during a backoff) still counts, and is named with its age (`quota-stale: default (12m)`, JSON `quotaStale`). |
| `quota-over-threshold` | Every readable account of that provider is spent: its 5h or 7d window is at 100%. One account with room is enough, since omo moves a lane off an account that hits its limit. When an account is spent, the candidates header names it and the ones with room (`quota-over: default (100%) quota-room: account-2 (40%)`, JSON `quotaOver` / `quotaRoom`). |
| `host-hold` | `dori can-launch` holds every machine the task may launch on. |
| `no-slot` | The task would launch, but the free slots of the machines it may launch on went to tasks ahead of it. |

## Quota reads

Every quota caller (the judge, `dori quota`, Discord `/quota`) reads through one cache file, `<stateDir>/quota-cache.json`, so the supervisor and CLI invocations together call the usage endpoints at most once per `quotaCacheSec`:

- A read younger than `quotaCacheSec` is served from the file without calling the endpoints.
- An expired read is refreshed by one caller under a state lock (`quota-cache.json.lock`); concurrent callers wait for it and reuse its answer, or serve the old file when the lock is still held after 10 s.
- An account that answers HTTP 429 backs off for its `Retry-After` (5 minutes when absent). pi-quota reads every account in one lookup, so no lookup runs until every backoff has passed; meanwhile each account is served from its last answer, and the rate-limited one from its last good read.
- A last good read is used for at most 30 minutes; after that the account is skipped as `stale-read`, and with no other readable account the judge holds `quota-unreadable`.

## Slots

Slots are counted per machine. A task is placed the way `dori launch` places a launch with no repo or checkout: `placement.defaultMachine` first, then the `placement.fallback` machines (the shared launch service in `scripts/src/launch-service.ts`, which `dori launch` uses too). Each of those machines' free slots are `guard.panesMax` minus its panes (the runner's thresholds for a remote machine). After every task is judged, the LAUNCH tasks take slots in launch order (a due date first, earliest first, then ascending id): each takes one on its first machine that is not held and has a slot left, and keeps LAUNCH naming that machine. The rest HOLD `no-slot`. So a full local machine does not stop a task whose fallback has room. The tick and launch count slots the same way: other tasks' reservations that aren't running yet are subtracted first from the machine each was reserved on (the default machine for a reservation that names none), so `slots=` already counts them. With the pane limit off (`panesMax` 0) nothing caps that machine. `slots=` is the free slots of every machine not held, summed; when the tasks may go to two or more machines the header adds `machines=<label>:<n|unlimited|hold>,...` and each LAUNCH line `machine=<label>`. A task all of whose machines are held gets `host-hold`, and with every machine held `slots=0`.

## Commands

Lead-only; inside a lane each one exits with `LANE_PERMISSION_DENIED`.

```
dori autopilot candidates [--tasks 12,13] [--json]
dori autopilot launch <taskId> [--launched <laneKey> | --failed | --ambiguous] [--note TEXT]
dori autopilot pause [--reason TEXT]
dori autopilot resume
```

- `candidates` judges every planned task marked for autopilot, plus the `--tasks` ids. It is read-only. Text output:

  ```
  AUTOPILOT slots=<n|unlimited> candidates=<n>
  AUTOPILOT_CANDIDATE #12 LAUNCH would-launch
  AUTOPILOT_CANDIDATE #13 HOLD no-slot
  AUTOPILOT_CANDIDATE #14 REFUSE owner-ref-missing, criteria-missing
  ```

  While a pause is in force the header reads `AUTOPILOT paused: nothing launches slots=<n> candidates=<n>`. With no candidate it prints `AUTOPILOT_NO_CANDIDATES`. `--json` prints `{ paused, slots, candidates: [{taskId, verdict, reasons}] }` (`slots` is null without a pane limit), plus `machines: [{machine, slots}]` and each LAUNCH candidate's `machine` when the tasks may go to two or more machines. Exit 0 whenever it judged (all HOLD included), 1 with `AUTOPILOT_TOODO_UNREADABLE <why>` when toodo-server cannot be read (token file missing or empty, network error, non-200), 2 on usage errors.
- `launch <taskId>` reserves the task's next launch attempt. While paused it prints `AUTOPILOT_LAUNCH_REFUSED #<id> paused since <ISO>[: <reason>] (dori autopilot resume lifts it)` and exits 1 before reading anything. Otherwise it holds a state lock (`<stateDir>/autopilot-launch.lock.sqlite`) while it reads toodo, the ledger, open lanes, quota and the host again, and judges the task among every marked task as `candidates` does. Another task's reservation that is not running as a lane yet takes one of the free slots of the machine it was reserved on, since its pane does not exist yet. Only on LAUNCH it writes the `planned` row and prints `AUTOPILOT_RESERVED #<id> lane=ap-<id>-<n> attempt=<n>` (exit 0); a slot taken on a machine other than the default one is recorded in the row's data (`machine`) and printed as ` machine=<label>`. Otherwise it prints `AUTOPILOT_LAUNCH_REFUSED #<id> <HOLD|REFUSE> <reasons>` and writes nothing (exit 1). A second reserve of the same task holds `lane-live`, so handling one event twice launches once.
- `launch <taskId> --launched <laneKey>` settles the open reservation as `verified` (the key must be the reserved one, else `AUTOPILOT_LANE_MISMATCH`, exit 1). `--failed` settles it `failed` when the launch surely did not happen, and `--ambiguous` settles it `ambiguous` when that cannot be told; `--note` adds why to the row. Each prints `AUTOPILOT_SETTLED #<id> attempt=<n> <state> lane=<key>`; with no open reservation, `AUTOPILOT_NO_RESERVATION #<id>` (exit 1). A settled attempt is never retried by itself: `failed` and a closed lane refuse `already-attempted`, `ambiguous` also refuses `ledger-ambiguous`. Settling works while paused too, so a launch already under way can still be recorded.
- `pause [--reason TEXT]` writes `<stateDir>/autopilot-pause.json` and prints `AUTOPILOT_PAUSED since <ISO>[: <reason>]` (` (already paused)` when one was in force; the first is kept). While it is in force, `launch` refuses new reservations and the tick wakes no one; lanes already running go on to their claim. A pause file that cannot be read still counts as paused. `resume` removes it (`AUTOPILOT_RESUMED`, or `AUTOPILOT_NOT_PAUSED`). Both exit 0. Use pause to stop autopilot at once without editing the config.

## Supervisor tick

The supervisor judges the same candidates itself every `autopilot.tickSec` (5 minutes by default). A toodo task event (`tasks-changed` included) or a local change (a reservation, its settle, a lane opening or closing) brings the next judging forward: it runs once things are quiet for 10 s, and at most 60 s after the first change. While paused it stops there. Otherwise it wakes the lead with urgent `AUTOPILOT_READY #12,#15 slots=<n|unlimited>` only when a task id joins the LAUNCH set; a set that only shrinks, or whose slots change, is remembered silently. Every 30 minutes after the last wake, while a LAUNCH set still waits, it sends `AUTOPILOT_READY ... again` naming the current set; a tick with nothing to launch (or paused) forgets the set, so it is news again when it comes back or the pause lifts. A tick that cannot read toodo logs `AUTOPILOT_TICK_ERROR <why>` once and tries again at the next tick. The tick runs only while the `toodo` event source is enabled, and it replaced the hourly `autopilot-reconcile` schedule job, which the supervisor removes at startup (`AUTOPILOT_RECONCILE_JOB_REMOVED`).

## Rules for the lead

- A `TOODO_TASK_READY` event never launches by itself: the supervisor's tick judges it (`dori autopilot candidates --tasks <id>` shows why an unmarked ready task would not run). Only a marked task that judges LAUNCH may run, and not while paused. Any other ready task is not launched.
- `AUTOPILOT_READY` never comes while paused. Take the named tasks through the order below: `dori autopilot launch <id>` judges each again under its lock, so a task that changed since the tick is refused there. The supervisor's tick replaces any periodic reconcile of your own; there is no `autopilot-reconcile` schedule job any more.
- Autopilot has no mode to set. When the owner says to stop autopilot, run `dori autopilot pause --reason TEXT` (and `resume` when they say to go on).
- Autopilot lanes merge into `dev` only (`autopilot.mergeBase`). Merging to main or releasing always needs the owner's explicit word for that merge or release.
- Order: `dori autopilot launch <id>` (reserve; use the lane key it prints), `start_task` with a `lane:<key>` ref, `dori launch <key>`, then settle with `dori autopilot launch <id> --launched <key>`, or `--failed` / `--ambiguous` when the launch did not happen or its outcome is unclear (either goes to the owner). After a restart, an in-progress task with no live lane is reported, never relaunched.
- A started autopilot lane that fails (`RUNNER_LAUNCH_FAILED`, the work is given up, its Done can never hold) is closed with `dori close <key> --cancelled --reason TEXT`, never launched again. On `AUTOPILOT_LANE_FAILED` tell the owner what failed and leave the task for them; the close already recorded its blocker (`toodo=blocked`), so add one only when the line says it was not recorded. `AUTOPILOT_LANE_DONE ... toodo=done` needs nothing: the supervisor completed the task with its PR, which lets its dependents become ready. On a plain `AUTOPILOT_LANE_DONE` (its `TOODO_TASK_NOT_COMPLETED` says why) complete the task yourself (`complete_task` with the PR as a ref).
- While any task is marked for autopilot, never archive a task that has dependents, and never run `delete_done_tasks` or any bulk delete in a workspace that holds marked tasks.
- Clearing the mark (`update_task` with `autopilot: false`) stops new launches. Running lanes go on to claim, and their merges wait until the owner speaks.

