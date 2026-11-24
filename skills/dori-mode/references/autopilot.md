# Autopilot

Autopilot decides which ready toodo tasks may run as lanes without a fresh word from the owner. It acts only on tasks marked for autopilot in toodo (the task's `autopilot` field, set in the web app or through MCP `create_task` / `update_task`). Autopilot is always on: the supervisor judges the marked tasks, wakes the lead with `AUTOPILOT_READY`, and the lead launches; the task's mark alone decides whether it may run, and `dori autopilot pause` is the emergency stop. dori code itself never calls `dori launch`, never changes toodo and never merges. `dori autopilot launch` is the lead's reservation step for a launch it runs itself: it records the attempt in the ledger and launches nothing, and it refuses while autopilot is paused (`dori autopilot pause`). With `autopilot.executor` on, the supervisor runs that launch instead and `dori autopilot launch` refuses to reserve (see Switch-over).

## Flag contract

- A task is a candidate when it is `planned` and marked for autopilot, in any workspace. There is no workspace allow list and no approval list kept by dori: the mark is the owner's approval, and clearing it withdraws it.
- Toodo does not record who set the mark, so the lead sets it only when the owner asked for autopilot on that task, and adds the owner's message as a task ref `owner:<ref>` (e.g. `owner:discord:<channel>/<message>`). A marked task without such a ref refuses `owner-ref-missing`.
- A marked task needs at least one criterion, so the lane has something to verify (`criteria-missing` otherwise).
- Editing a marked task does not withdraw the mark; there is no content hash. When the lead changes a marked task's scope (title, criteria), it records the change as a `decision` progress note.
- A follow-up task is never marked by inheritance; the owner asks for it on that task.

Toodo's web RPC `list_tasks` filter has no `autopilot` key, so dori reads every planned task (`{ statuses: ["planned"] }`, all workspaces) and keeps the marked ones.

## Execution contract

A marked task states how it runs through task refs, which toodo stores without interpreting them. `planTask` (`scripts/src/autopilot-plan.ts`) reads them, with the task, its dependencies, the workspace guidelines (`ToodoClient.guidelines`, toodo's `list_guidelines`) and the workspace's `repository` (`ToodoClient.workspaceRepository`, toodo's `get_workspace`), and returns either a ready contract with its template brief or the reasons the task needs the lead's review. It is pure: nothing in it reads toodo, writes a file or launches.

| Ref | Default | Meaning |
| --- | --- | --- |
| `repo:<owner>/<name>` | the workspace's repository, else none | The one repository the lane works in (case-insensitive). |
| `base:<branch>` | `autopilot.mergeBase` | The branch the lane starts from and opens its PR into. It must be `autopilot.mergeBase`. |
| `branch:<name>` | `autopilot/<taskId>` | The lane's branch, a valid git branch name other than the base. The lane's Done is `pr <repo> <branch>`. |
| `mode:<ulw\|mass-ulw>` | `ulw` | The lane's mode. Nothing guesses it from the text. |
| `model:<id>` | `defaultModel` | The lane's model. |
| `approved:<version>` | none | The lead reviewed the task at that contract version. |

Without a `repo:` ref the task takes its workspace's `repository` when that free text names a GitHub repository (`owner/name`, or a github.com URL or remote); anything else there (empty, `discord:<channel>`, a path) means no repo. A task with no repo at all runs repo-less:

- It makes no branch, commit or PR (`repo` and `branch` are null). Its brief says so, declares `deliverable: report` (the runner refuses a done claim without report files) and asks for the result, criterion by criterion, in `DORI_LANE_OUT/report.md`.
- Its Done is `file "<research>/<laneKey>/report.md"`: the lead-host path where the claim installs that file (`lane-files.ts` `laneReportFile`, next to the state dir). Done checks of local and remote lanes both run on the lead host, so the signal is live once the claim is collected.
- It is placed like any launch with no repo: `placement.defaultMachine`, then the fallbacks. A local lane works in `<worktree root>/<laneKey>`.
- When it closes, the supervisor completes its task with the report as evidence (see Ledger).

The contract also carries:

- `version`: a 12-digit sha256 over the title, description, criteria, dependencies and contract refs; for a task without a `repo:` ref, also the repo its workspace gives it (or none), so changing the workspace's repository moves the version of those tasks only. Status, notes and other refs (`owner:`, `lane:`, `approved:`) are left out, so starting or approving the task keeps it, while a scope change moves it.
- `guidelines`: a snapshot of the workspace's guidelines (rules and memories, by id) with its own hash, so a later run can tell whether they changed since the brief was built.
- `approvedVersion`: the version an `approved:` ref names when it matches.

The task goes to review instead (`kind: "review"`, reasons in this order) on `repo-missing` (no repo and no report path to run repo-less with; the executor always passes one), `repo-ambiguous` (two repos), `ref-invalid` (a malformed repo, base, branch, mode or model, or a branch equal to the base), `ref-conflict` (two different values for one key), `base-not-allowed` (a base other than `autopilot.mergeBase`) and `approval-stale` (an `approved:` ref none of which names the current version). Whether a criterion can be judged by a script is not guessed: a lead who reviews such a task records `approved:<version>`, and any later scope change sends it back to review.

The template brief is the task's title (`# <title> (Toodo #<id>)`), its description as written, its criteria with kind and target, its dependencies with status, its other refs, the workspace guidelines (rules, then memories) and the contract (repo, base, branch, Done, mode, version, snapshot hash). `dori launch` appends the common lane footer, so the brief does not repeat it. Storing the snapshot outside the repo and launching from the contract belong to the executor.

## Ledger

Launch attempts are operation rows: lane `toodo:<taskId>`, action `autopilot-launch`, target `<attempt number>` (1, 2, ...), data `{ "laneKey" }` with the lane key `ap-<taskId>-<attempt>`. Only `dori autopilot launch` writes them (see Commands): `planned` when reserved, then `verified` (launched), `failed` or `ambiguous` when settled. The predicate reads them:

- Autopilot never retries by itself: any earlier attempt that is not running refuses `already-attempted`, for the owner to decide, until the owner covers it: by pausing the task and then setting a wait, or by a re-arm (both below).
- The owner's word on the task itself: when the task's latest pause (Toodo `milestones.pausedAt`: a pause, a wait that paused it, or a reopen back to `planned`) is later than the latest attempt no re-arm covers, the predicate reads it instead of refusing. With no wait set since that pause (the `Waiting until ...` / `Wait changed: ...` progress note `wait_task` records) the task holds `paused` and never launches. While a wait set after the pause runs it holds `waiting`; once that wait ends, the attempt counts as covered and the task launches as attempt `n+1`, with no re-arm. An attempt with no pause after it keeps refusing `already-attempted`.
- A row in `ambiguous` sends the task to the owner (REFUSE `ledger-ambiguous`); it is never retried by itself.
- A re-arm row (lane `toodo:<taskId>`, action `autopilot-rearm`, target `<n>`, state `verified`, data `{ "note"? }`) is the owner's word to run the task again: attempts numbered up to `n` no longer count toward `already-attempted` or `ledger-ambiguous`, and the next launch is attempt `n+1` (lane `ap-<taskId>-<n+1>`). Only `dori autopilot rearm` writes it (see Commands). The rest of the predicate still applies, so a re-armed task that waits holds `waiting` and launches when its wait ends. A failed attempt nobody re-armed keeps refusing.
- A row that is open (`planned`, `attempted`), or `verified` with its `laneKey` an open registry lane, means the task is running (HOLD `lane-live`).

When the lane a row names closes, the close settles the row once and adds `outcome` to its data (every close path: `dori close`, a settled done claim, a merge, a recovery close, a close the supervisor resumes after a crash):

- A close with `--cancelled` (the lane never started, e.g. after `RUNNER_LAUNCH_FAILED`, was given up, or its Done can never hold) settles the row `failed` with `outcome: "failed"` and gives the lead `AUTOPILOT_LANE_FAILED #<id> lane=<key> attempt=<n> cancelled: <reason>: tell the owner; autopilot does not launch it again`.
- Any other close (every Done signal held, or its PR merged) keeps the row `verified` with `outcome: "done"` and gives `AUTOPILOT_LANE_DONE #<id> lane=<key> attempt=<n>: complete toodo task #<id>`.
- Not adopted: a lane whose investigation finds nothing to change writes its conclusion and evidence to `DORI_LANE_OUT/not-adopted.md`, opens no PR and claims done (its brief says so). When that file is installed and every Done signal that does not hold is a `pr` signal with no PR from its branch at all, the settle closes the lane instead of objecting (`LANE_NOT_DONE`): the close's receipt records `notAdopted: { conclusion }`, it reads `CLOSED <key> not-adopted`, and the row is `outcome: "done"` as above, never `failed`. A lane that opened a PR settles on that PR whatever else it wrote, and any other failing signal still objects.
- Completed with no PR: a repo lane whose work has no PR to make (a report, research) writes its result, criterion by criterion, to `DORI_LANE_OUT/report.md` (never `not-adopted.md`), opens no PR and claims done (its brief says so). Under the same conditions as not adopted, with `report.md` installed and no `not-adopted.md` (that file wins when both are there), the settle closes the lane on its report: the receipt records `reported: { report }`, it reads `CLOSED <key> reported`, and the row is `outcome: "done"`.

After the close the supervisor writes the outcome to the task (task-finish.ts, every write read back with `get_task`) and marks the row's data `toodo` once (`done`, `blocked` or `failed`), so a resumed or repeated close never writes to the task or tells the lead again; nothing is relaunched:

- Repo-less (its Done names no repo), or closed on its report (above), `report.md` installed: each pending manual criterion is checked with the report path as evidence and the task is completed with a note naming the report; its report gets `Toodo #<id> done` (in the owner's language) appended, and the line is `TOODO_TASK_COMPLETED <key> #<id> report=<path>; ...`. With no report there, the task is left open with a blocker as below.
- Done, PR read back merged: each pending manual criterion is checked with the merge as evidence and the task is completed with the PR as a ref and a note naming its merge SHA. The line becomes `AUTOPILOT_LANE_DONE ... attempt=<n> toodo=done: toodo task #<id> completed and read back by the supervisor`, which is digest.
- Done, but the task could not be completed (no merge read back, toodo refused or did not confirm): the task gets a blocker note and the one failure line, `TOODO_TASK_NOT_COMPLETED`, ends with `blocker recorded on toodo task #<id>` (or why it was not).
- Not adopted (above): the task is concluded `not_adopted` (`conclude_task`) with the conclusion as its note and no blocker; its report gets `Toodo #<id> not adopted` (in the owner's language) appended, the lines are `TOODO_TASK_NOT_ADOPTED <key> #<id> conclusion=<path>; ...` and `AUTOPILOT_LANE_DONE ... attempt=<n> toodo=not-adopted: ...`, and the close is `toodo=not-adopted`, all digest. A task already done (the lead finished it first) is left as it is (`toodo=done`). Its dependents stay blocked (`prerequisite-not-adopted`).
- Cancelled: `dori close` (or the supervisor resuming it) records the blocker note and the failure line reads `AUTOPILOT_LANE_FAILED ... cancelled: <reason> toodo=blocked: blocker recorded on toodo task #<id>; tell the owner; ...`.

`dori close` prints the line; a close the supervisor runs journals it as an urgent event under the id `autopilot-outcome:<key>`, so it is told once. A row the launch itself settled `failed` or `ambiguous` is left as it is.

Rows with lane `autopilot` and action `autopilot-shadow` are judgment records an older dori wrote (shadow mode, now removed); nothing reads or writes them any more.

## Configuration

Key `autopilot` in `config.json`; every field is optional. An invalid value or an unknown key throws a TypeError at load naming the key. The bundle design's keys (`workspaces`, `bundleExpiryDays`, `wip`, `wipCap`, `attemptCap`, `onRevoke`) the removed `mode` (any value; autopilot is always on) and the removed `quotaMaxUsedPct` (an account now counts as spent only at 100%) are ignored with one `CONFIG_AUTOPILOT_KEYS_IGNORED` line. `dori setup` (`--migrate` included) removes `autopilot.mode` from `config.json` once, at schema version 7, logging `SETUP_KEY_REMOVED autopilot.mode (...)`.

| Key | Default | Meaning |
| --- | --- | --- |
| `mergeBase` | `"dev"` | Autopilot lanes merge into this branch only. |
| `tickSec` | `300` | Seconds between the supervisor's ticks, an integer from 30 to 3600. |
| `quotaCacheSec` | `90` | Seconds a quota read is reused before the usage endpoints are read again, an integer from 30 to 900. It applies to every quota caller (the judge, `dori quota`, Discord `/quota`); see Quota reads. |
| `executor` | `false` | A boolean (anything else is rejected). `true` lets the supervisor launch LAUNCH tasks itself; see Supervisor executor. |
| `threadChannel` | `""` | The Discord channel id the executor opens lane threads under (trimmed; anything but a string is rejected). Empty: the first `discordChannels` entry. Set it when `discordChannels[0]` is not where lane threads belong (e.g. a reports channel); closed-thread redirects and owner lines keep using `discordChannels[0]`. `dori doctor` shows the channel in use as `config.autopilot.threadChannel`. |

All apply live when `config.json` is edited (no supervisor restart). There is no workspace allow list (every workspace's marked tasks are candidates), no autopilot WIP cap and no daily cap: the host guard alone limits how many lanes run (see Slots).

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
| `already-attempted` | A launch attempt the owner did not cover (a re-arm, or a pause and then a wait that ended) exists for the task, none is running, and the task was not paused since. |
| `ledger-ambiguous` | A launch attempt the owner did not cover is `ambiguous`. |

HOLD is temporary; the next tick judges again:

| Reason | When |
| --- | --- |
| `waiting` | The task has a wait. A waiting in-progress task reads `planned` plus a wait, so it lands here too. A task paused after its latest attempt and then put on a wait holds here, and launches as attempt `n+1` when the wait ends. |
| `paused` | The task was paused (or reopened) after its latest attempt and no wait was set since: the owner holds it. A wait set later and ended releases it. |
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

Slots are counted per machine. A task is placed the way `dori launch` places a launch with no repo or checkout: `placement.defaultMachine` first, then the `placement.fallback` machines (the shared launch service in `scripts/src/launch-service.ts`, which `dori launch` uses too). Each of those machines' free slots are `guard.panesMax` (the runner's thresholds for a remote machine) minus its panes, minus launches admitted there whose pane hasn't appeared yet (`scripts.md`, launch); review lanes use the same slots. After every task is judged, the LAUNCH tasks take slots in launch order (a due date first, earliest first, then ascending id): each takes one on its first machine that is not held and has a slot left, and keeps LAUNCH naming that machine. The rest HOLD `no-slot`. So a full local machine does not stop a task whose fallback has room. The tick and launch count slots the same way: other tasks' reservations that aren't running yet are subtracted first from the machine each was reserved on (the default machine for a reservation that names none), so `slots=` already counts them. With the pane limit off (`panesMax` 0) nothing caps authors on that machine. `slots=` is the free slots of every machine not held, summed; when the tasks may go to two or more machines the header adds `machines=<label>:<n|unlimited|hold>,...` and each LAUNCH line `machine=<label>`. A task all of whose machines are held gets `host-hold`, and with every machine held `slots=0`.

## Commands

Lead-only; inside a lane each one exits with `LANE_PERMISSION_DENIED`.

```
dori autopilot candidates [--tasks 12,13] [--json]
dori autopilot launch <taskId> [--launched <laneKey> | --failed | --ambiguous] [--note TEXT]
dori autopilot rearm <taskId> [--note TEXT]
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
- With `autopilot.executor` on, `launch <taskId>` prints `AUTOPILOT_LAUNCH_REFUSED #<id> executor-on: ...` and exits 1 before reading anything or writing a row, and a settle flag on a reservation an executor sequence owns (`toodo:<id>/autopilot-execute/<n>` exists) prints `AUTOPILOT_LAUNCH_REFUSED #<id> executor-owned: ...` and exits 1 without touching the row. A reservation the lead opened before the switch has no sequence row and still settles.
- `launch <taskId> --launched <laneKey>` settles the open reservation as `verified` (the key must be the reserved one, else `AUTOPILOT_LANE_MISMATCH`, exit 1). `--failed` settles it `failed` when the launch surely did not happen, and `--ambiguous` settles it `ambiguous` when that cannot be told; `--note` adds why to the row. Each prints `AUTOPILOT_SETTLED #<id> attempt=<n> <state> lane=<key>`; with no open reservation, `AUTOPILOT_NO_RESERVATION #<id>` (exit 1). A settled attempt is never retried by itself: `failed` and a closed lane refuse `already-attempted`, `ambiguous` also refuses `ledger-ambiguous`, until `rearm`. Settling works while paused too, so a launch already under way can still be recorded.
- `rearm <taskId> [--note TEXT]` is for the owner's word to run a task again when Toodo does not carry it, e.g. "run it again now" with no pause and wait (a pause and then a wait that ends release the attempt by themselves, see Ledger). Under the launch lock it writes one re-arm row covering the task's highest attempt number (launch attempts and executor sequences alike) and prints `AUTOPILOT_REARMED #<id> through=<n> next=ap-<id>-<n+1>` (exit 0); the task then judges like a fresh one, so it launches as attempt `n+1` once the rest of the predicate passes (a wait still holds `waiting`). Re-arming again with no attempt since changes nothing and adds ` (already)`. While an attempt still runs (an open reservation or executor sequence, or a verified attempt whose lane is open) it prints `AUTOPILOT_REARM_REFUSED #<id> lane-live: ...`, and with no attempt at all `AUTOPILOT_REARM_NOTHING #<id>: ...` (exit 1 for both). It launches nothing, works while paused and with the executor on, and is run only on the owner's word: re-arming an `ambiguous` attempt states that the owner checked no lane of it still runs.
- `pause [--reason TEXT]` writes `<stateDir>/autopilot-pause.json` and prints `AUTOPILOT_PAUSED since <ISO>[: <reason>]` (` (already paused)` when one was in force; the first is kept). While it is in force, `launch` refuses new reservations and the tick wakes no one; lanes already running go on to their claim. A pause file that cannot be read still counts as paused. `resume` removes it (`AUTOPILOT_RESUMED`, or `AUTOPILOT_NOT_PAUSED`). Both exit 0. Use pause to stop autopilot at once without editing the config.

## Supervisor tick

The supervisor judges the same candidates itself every `autopilot.tickSec` (5 minutes by default). A toodo task event (`tasks-changed` included) or a local change (a reservation, its settle, a lane opening or closing) brings the next judging forward: it runs once things are quiet for 10 s, and at most 60 s after the first change. While paused it stops there. Otherwise it wakes the lead with urgent `AUTOPILOT_READY #12,#15 slots=<n|unlimited>` only when a task id joins the LAUNCH set; a set that only shrinks, or whose slots change, is remembered silently. Every 30 minutes after the last wake, while a LAUNCH set still waits, it sends `AUTOPILOT_READY ... again` naming the current set; a tick with nothing to launch (or paused) forgets the set, so it is news again when it comes back or the pause lifts. A tick that cannot read toodo logs `AUTOPILOT_TICK_ERROR <why>` once and tries again at the next tick. The tick runs only while the `toodo` event source is enabled, and it replaced the hourly `autopilot-reconcile` schedule job, which the supervisor removes at startup (`AUTOPILOT_RECONCILE_JOB_REMOVED`).

## Rules for the lead

- A `TOODO_TASK_READY` event never launches by itself: the supervisor's tick judges it (`dori autopilot candidates --tasks <id>` shows why an unmarked ready task would not run). Only a marked task that judges LAUNCH may run, and not while paused. Any other ready task is not launched.
- `AUTOPILOT_READY` never comes while paused. Take the named tasks through the order below: `dori autopilot launch <id>` judges each again under its lock, so a task that changed since the tick is refused there. The supervisor's tick replaces any periodic reconcile of your own; there is no `autopilot-reconcile` schedule job any more.
- Autopilot has no mode to set. When the owner says to stop autopilot, run `dori autopilot pause --reason TEXT` (and `resume` when they say to go on).
- Autopilot lanes merge into `dev` only (`autopilot.mergeBase`). Merging to main or releasing always needs the owner's explicit word for that merge or release.
- Order: `dori autopilot launch <id>` (reserve; use the lane key it prints), `start_task` with a `lane:<key>` ref, `dori launch <key>`, then settle with `dori autopilot launch <id> --launched <key>`, or `--failed` / `--ambiguous` when the launch did not happen or its outcome is unclear (either goes to the owner). After a restart, an in-progress task with no live lane is reported, never relaunched. With `autopilot.executor` on, the supervisor runs this order itself and the lead does none of it (see Switch-over).
- A started autopilot lane that fails (`RUNNER_LAUNCH_FAILED`, the work is given up, its Done can never hold) is closed with `dori close <key> --cancelled --reason TEXT`, never launched again by itself.
- When the owner sends an attempted task back to run at a later time, pause it (or reopen it) and put it on a Toodo wait until then: it holds `waiting` and launches as attempt `n+1` when the wait ends. When the owner only says to hold it, pause it with no wait: it holds `paused`. Only for "run it again" with no wait, run `dori autopilot rearm <id> --note TEXT` on that word. Never re-arm, or pause and wait to relaunch, on your own judgment. On `AUTOPILOT_LANE_FAILED` tell the owner what failed and leave the task for them; the close already recorded its blocker (`toodo=blocked`), so add one only when the line says it was not recorded. `AUTOPILOT_LANE_DONE ... toodo=done` needs nothing: the supervisor completed the task with its PR, which lets its dependents become ready. On a plain `AUTOPILOT_LANE_DONE` (its `TOODO_TASK_NOT_COMPLETED` says why) complete the task yourself (`complete_task` with the PR as a ref).
- While any task is marked for autopilot, never archive a task that has dependents, and never run `delete_done_tasks` or any bulk delete in a workspace that holds marked tasks.
- Clearing the mark (`update_task` with `autopilot: false`) stops new launches. Running lanes go on to claim, and their merges wait until the owner speaks.

## Supervisor executor

`src/autopilot-executor.ts` can take the lead's launch order over. It's off by default (`autopilot.executor: false`), and while it's off `runExecutor` and `reconcileExecutions` return `disabled` and touch nothing, so the lead keeps launching by hand as above. It stays off until the owner approves turning it on; see Switch-over.

When on, each supervisor tick first runs `reconcileExecutions`, then `runExecutor` on the tick's LAUNCH ids, one task at a time under the same `autopilot-launch.lock.sqlite` lock as `dori autopilot launch`. A task goes through these steps:

1. prepare: read the task and its contract again; a reason to stop goes to review before anything is reserved or started. Nobody reads an executor brief before its launch, so a path it names under an attachment root (`~/.dori/research/...` included) that does not exist on the lead is review `lane-file-missing:<path>` rather than a lane that starts without it; the lane's own `research/<key>` collection directory is exempt.
2. reserve: open the task's `autopilot-launch` ledger attempt, exactly as the CLI does. A reservation the CLI opened is never adopted.
3. start-task: `start_task` with the `lane:<key>` ref.
4. thread: create the lane's Discord thread under `autopilot.threadChannel` (else the first `discordChannels` entry) and add `discord.ownerId`.
5. launch: write the brief, then place, validate and admit through the real launch service (never `launchLane` directly). A HOLD from admission queues the lane.
6. settle: settle the ledger attempt `verified`, `failed` or `ambiguous`, and notify with `AUTOPILOT_EXECUTOR_LAUNCHED`, `_REVIEW`, `_FAILED` or `_AMBIGUOUS`.

Every step is journaled in the operation store: one sequence row `toodo:<taskId>/autopilot-execute/<n>` (attempt `n`: 1, or one past the attempts a re-arm covers) and step rows with actions `autopilot-prepare`, `autopilot-reserve`, `autopilot-start-task`, `autopilot-thread`, `autopilot-brief`, `autopilot-hold`, `autopilot-admit`, `autopilot-settle`, `autopilot-drop-held`, `autopilot-blocker`, `autopilot-notice` and `autopilot-orphan`. The thread id and its member result are kept, so a member-add error doesn't create a second thread. The `autopilot-launch` ledger row stays authoritative.

- Crash reconcile: at startup and on every tick, `reconcileExecutions` resumes open sequences from their last journaled step. It never relaunches. An admission whose start can't be proved (a startup receipt or the runner's journaled startup result; a registered pane alone isn't proof) settles `ambiguous` and goes to the lead, as does a lost thread-create reply. Positive proof that a launch never started settles `failed` with one blocker, without retry.
- Orphaned start: an ambiguous `start_task` (`AUTOPILOT_EXECUTOR_AMBIGUOUS ... at start-task, before any lane launched`) that has no `autopilot-hold` or `autopilot-admit` row is read again on each tick until Toodo answers. If the task is `in_progress` with its `lane:<key>` ref while the registry has no lane for the key (a paused reservation counts as one) and nothing is queued for it, the supervisor journals one `AUTOPILOT_EXECUTOR_ORPHAN #<id> lane=<key> ...` per attempt and records `autopilot-orphan`, so later ticks and restarts stay quiet. An unreadable task is unknown and waits for a later tick. It never pauses, edits or relaunches the task.
- HOLD resume: a held lane drains under its original key. A pause or a changed contract keeps it queued, and a scope change sends it to review. If the key left the queue outside the executor, a registry lane for it is `ambiguous` (a manual `dori launch` is never repeated) and no lane is review `hold-dropped` (`dori hold drop` was the lead's call). Neither path admits again.
- Base enforcement: `autopilot.mergeBase` must equal the CI merge base, and the contract's base and version are recorded before launch.
- Worktree isolation: a local launch runs in `<worktree root>/<repo name>-<laneKey>` (a repo-less one in `<worktree root>/<laneKey>`), created empty right before validation. The root is the local runner's reported worktree root, else `config.worktreeRoot`; with neither the task goes to review `worktree-root-missing`, and a directory that can't be made is review `local-cwd-unusable`. It's never under the state dir and never left out. Remote placement drops the cwd so the runner makes its own lane directory.

## Switch-over

The switch is `autopilot.executor` in `config.json` (it applies live). The lead sets it to `true` only after the owner approves the switch-over, and sets it back to `false` when the owner says so; nothing else turns it on.

One task has exactly one launcher. Both launchers take the same `autopilot-launch.lock.sqlite` lock and write the same `autopilot-launch` ledger, and each refuses the other's work:

- With the switch on, `dori autopilot launch <id>` refuses to reserve (`executor-on`) and refuses to settle a reservation an executor sequence owns (`executor-owned`).
- The executor never adopts a ledger row it did not open: a task with any earlier `autopilot-launch` row the owner did not cover comes back `refused`, and the tick wakes the lead for it as before.

With the switch on, the lead does not:

- reserve, `start_task`, `dori launch` or settle a marked task, nor run `dori launch` / `dori hold drop` on an `ap-<id>-<n>` key the executor holds;
- settle a launch the executor settled, or complete a task the supervisor completed (`AUTOPILOT_LANE_DONE ... toodo=done`).

The lead still:

- reviews a task the executor sent to review (`AUTOPILOT_EXECUTOR_REVIEW`, or an `AUTOPILOT_READY` naming it): fill in the missing or conflicting contract refs, or judge criteria a script cannot and record `approved:<version>`; the next tick runs it again. A task that should not run loses its mark.
- decides on `AUTOPILOT_EXECUTOR_FAILED`, `AUTOPILOT_EXECUTOR_AMBIGUOUS` and `AUTOPILOT_EXECUTOR_ORPHAN`: read the task, its thread and the registry, tell the owner, and leave a new attempt to the owner; a failed or ambiguous attempt is never retried by itself. When the owner wants it run again, a pause and a wait that ends (or `dori autopilot rearm <id>`) let the executor run attempt `n+1`. An orphaned task is still `in_progress` in Toodo: check nobody works it, then pause it in Toodo so it no longer looks started.
- finishes a reservation it opened before the switch (the executor refuses that task): `dori launch` and settle it as before, or settle it `--failed` / `--ambiguous`.
- handles lane outcomes as before: `AUTOPILOT_LANE_FAILED`, and a plain `AUTOPILOT_LANE_DONE` whose task the supervisor could not complete.

Turning the switch off stops new and resumed executions; an open executor sequence stays where it stopped. Its reservation then has no owner, so the lead settles it (`--launched <key>` when its lane runs, else `--failed` or `--ambiguous`) and handles the task by hand.
