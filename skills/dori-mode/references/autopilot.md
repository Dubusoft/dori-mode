# Autopilot

Autopilot decides which ready toodo tasks may run as lanes without a fresh word from the owner. It acts only on tasks the owner approved ahead of time, in a closed list called a bundle. v1 is shadow only: `dori autopilot candidates` judges and records, and nothing launches, nothing calls `dori launch`, nothing changes toodo and nothing merges.

## Approval contract (bundle)

A bundle is the owner's approval of a closed list of toodo task ids. It is one operation row: lane `autopilot`, action `autopilot-bundle`, target `<bundleId>` (slug `[a-z0-9-]+`), with `data`:

```
{ "v": 1, "bundleId": "b1", "ownerRef": "discord:<channel>/<message>", "approvedAt": <ms>, "expiresAt": <ms>,
  "attemptBudget": <int>, "members": { "<taskId>": { "hash": "<sha256 hex>", "dependsOn": [ids], "workspaceId": n, "revokedAt"?: <ms> } },
  "revokedAt"?: <ms> }
```

- The row stays `planned` while the bundle is in force, so `prune` (which deletes only `verified` rows) never drops it. A bundle revoked as a whole is settled `verified` with detail `revoked ...`.
- Expiry is computed from `expiresAt`, never stored as a state.
- A member's hash is the sha256 hex of canonical JSON (stable key order) of `{ workspaceId, title, description, criteria: criteria.map(c => ({text, kind, target: c.target ?? null})), dependsOn: sorted ascending }`. Criterion check state, notes, labels, refs, timeline and status are not hashed, so editing the content or adding or removing a dependency breaks the approval; progress does not.

## Ledger

Launch attempts are operation rows: lane `toodo:<taskId>`, action `autopilot-launch`, target `<attempt number>` (1, 2, ...), data `{ "bundleId", "bundleVersion": <approvedAt>, "laneKey" }`. v1 never writes them; the predicate reads them:

- Attempts used is the number of such rows for the task.
- A row in `ambiguous` sends the task to the owner (REFUSE `ledger-ambiguous`); it is never retried.
- A row that is open (`planned`, `attempted`), or `verified` with its `laneKey` an open registry lane, means the task is running (HOLD `lane-live`).
- WIP in use counts, over all tasks, the rows that are open or verified with a live `laneKey`.

Shadow records are rows too: lane `autopilot`, action `autopilot-shadow`, target `<taskId>@<slot ISO>` (slot is the current hour floored, UTC), state `verified`, detail `<VERDICT> <reasons joined by ", ">`. Only `--record` writes them, one per task per hour.

## Configuration

Key `autopilot` in `config.json`; every field is optional. An invalid value throws a TypeError at load naming the key.

| Key | Default | Meaning |
| --- | --- | --- |
| `workspaces` | `[]` | Toodo workspace ids autopilot may act in. Empty means every task is REFUSE `workspace-not-allowed`. |
| `bundleExpiryDays` | `7` | Default expiry of a new bundle. |
| `wip` | `1` | Concurrent autopilot lanes. |
| `wipCap` | `2` | Hard ceiling; a larger `wip` is clamped to it with a load warning. |
| `attemptCap` | `2` | Launch attempts per task; at the cap the task is REFUSE `attempt-cap`, a blocker for the owner. |
| `quotaMaxUsedPct` | `80` | Any Claude account's 5h or 7d window at or above it holds (`quota-over-threshold`). |
| `quotaUnreadable` | `"hold"` | Only value in v1: unreadable quota holds (`quota-unreadable`). |
| `mergeBase` | `"dev"` | Autopilot lanes merge into this branch only. |
| `onRevoke` | `"stop-new"` | Only value in v1: revoke stops new launches; running lanes go on to claim and their merges wait for the owner. |
| `crossWorkspacePrereqs` | `"block"` | Only value in v1: a prerequisite in another workspace refuses (`cross-workspace-prerequisite`). |
| `mode` | `"shadow"` | Only value in v1: record only, nothing launches. |

## Selection predicate

`judge(input)` returns `{ taskId, verdict, reasons }`. Every failing reason is collected, not just the first. The verdict is REFUSE when any reason refuses, else HOLD when any reason holds, else LAUNCH. A dependency is satisfied only when it is `done` with resolution `merged` or `completed`.

REFUSE means the task needs the owner, or is never eligible:

| Reason | When |
| --- | --- |
| `not-a-bundle-member` | No in-force bundle lists the task, including a task created ready with no dependency that nobody approved. |
| `bundle-expired` | Now is at or past `expiresAt`. |
| `bundle-revoked` | The bundle was revoked. |
| `member-revoked` | This member was revoked; the other members are judged as usual. |
| `hash-changed` | The current member hash differs from the approved one: content edited, or a dependency added or removed. |
| `task-missing` | Toodo no longer returns the task (archived or deleted). |
| `not-planned` | Status is not `planned` and the task has no wait. |
| `workspace-not-allowed` | The task's workspace is not in `autopilot.workspaces`. |
| `prerequisite-missing` | An approved dependency is no longer returned by toodo (archived or bulk-deleted). |
| `prerequisite-not-adopted` | A dependency is done with resolution `not_adopted`. |
| `cross-workspace-prerequisite` | A dependency lives in another workspace. |
| `attempt-cap` | Attempts used are at least `min(attemptCap, attemptBudget)`. |
| `ledger-ambiguous` | A ledger row for the task is `ambiguous`. |

HOLD is temporary; the next reconcile judges again:

| Reason | When |
| --- | --- |
| `waiting` | The task has a wait. A waiting in-progress task reads `planned` plus a wait, so it lands here too. |
| `prerequisite-open` | A dependency is not done. |
| `lane-live` | An open ledger row, a verified row whose lane is open, or a task ref `lane:<key>` naming an open lane. |
| `wip-full` | WIP in use is at least `min(wip, wipCap)`. |
| `quota-unreadable` | Claude quota could not be read. |
| `quota-over-threshold` | A Claude account's 5h or 7d window is at or above `quotaMaxUsedPct`. |
| `host-hold` | `dori can-launch` holds the default machine. |
| `toodo-unreadable` | Toodo-server could not be read (token file missing or empty, network error, non-200). Every member is then HOLD with only this reason. |

## Commands

Lead-only; inside a lane each one exits with `LANE_PERMISSION_DENIED`.

```
dori autopilot candidates [--json] [--record]
dori autopilot approve <bundleId> --tasks 12,13 --owner-ref <ref> [--expires-days N] [--attempts N]
dori autopilot revoke <bundleId> [--task N] [--reason TEXT]
dori autopilot bundles [--json]
dori autopilot schedule
```

- `candidates` judges every member of every in-force bundle. It's read-only unless `--record` is given, which writes shadow rows only. Text output:

  ```
  AUTOPILOT mode=shadow record-only: nothing launches wip=<inUse>/<limit> bundles=<n>
  AUTOPILOT_CANDIDATE #12 LAUNCH bundle=b1 would-launch
  AUTOPILOT_CANDIDATE #13 HOLD bundle=b1 waiting, prerequisite-open
  AUTOPILOT_CANDIDATE #14 REFUSE bundle=b1 hash-changed
  ```

  With no bundle it prints `AUTOPILOT_NO_BUNDLES`. `--json` prints `{ mode, wip: {inUse, limit}, candidates: [{taskId, bundleId, verdict, reasons}] }`. Exit 0 whenever it judged (all HOLD included), 2 on usage errors.
- `approve` reads the tasks from toodo now and stores their hashes. It refuses with exit 1 and `AUTOPILOT_APPROVE_REFUSED <why>` when toodo is unreadable, a task is missing, or a task's workspace is not in `autopilot.workspaces`.
- `revoke` revokes the whole bundle, or one member with `--task`.
- `bundles` lists the bundles and their state.
- `schedule` adds, idempotently, the job `autopilot-reconcile`: cron `0 * * * *` (`Asia/Seoul`), kind `AUTOPILOT_RECONCILE`, catch-up `once`, running this same CLI as `autopilot candidates --record`. Its kind is digest under the default event policy, so it never wakes the lead by itself.

## Rules for the lead

- A `TOODO_TASK_READY` event never launches by itself. Run `dori autopilot candidates --record`. Only a member of an in-force, owner-approved bundle that judges LAUNCH may run; in v1 even LAUNCH only records "would launch #<n>" in the bundle thread. Any other ready task is recorded, not launched.
- Reconcile at lead startup, on every `TOODO_TASK_READY` and `TOODO_TASK_RESYNC`, and hourly through `autopilot-reconcile`. Batch several ready lines into one reconcile.
- Autopilot lanes merge into `dev` only (`autopilot.mergeBase`). Merging to main or releasing always needs the owner's explicit word for that merge or release.
- Order: `start_task` with a `lane:<key>` ref first, then `dori launch`. After a restart, an in-progress task with no live lane is reported, never relaunched.
- While any bundle is in force, never archive a task that has dependents, and never run `delete_done_tasks` or any bulk delete in a workspace that holds bundle tasks.
- `dori autopilot revoke` stops new launches. Running lanes go on to claim, and their merges wait until the owner speaks.

## Leaving shadow mode

This is the owner's call, not code. Shadow ends after 7 days and 20 judgments, whichever comes later, with zero wrong would-launch verdicts and a passed restart and resync drill.
