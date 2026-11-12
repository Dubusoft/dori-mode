# Lane done protocol

The `dori launch` footer already carries these rules to every lane, so the Dori does not paste them. This file is the full version.

When your lane's `Done =` signals are live and every change is pushed, claim done from your own session. The signals might be a PR merged, a branch's PR merged or green (`pr <owner/repo> <branch>`), an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). Run them yourself first: the watcher re-runs every one and never takes your word for it.

A lane ends at its green PR. Once the PR is pushed, its CI is green and the `Done =` signals are live, claim and stop: never wait for the merge yourself, with no monitor, wait, sleep, polling loop or `gh pr checks --watch` on the PR or its merge. The supervisor merges a claimed PR into `dev` at the head your claim recorded, and the watcher closes the lane after that merge; the Dori follows it up, not you.

A `merged <repo>#N` signal is the exception: the supervisor merges your PR only after your claim, so it cannot be live before you claim. Push everything, open the PR, and claim as soon as its CI is running or green; do not wait for the merge. The claim records the PR's head, and the supervisor merges exactly that head once its checks are green and GitHub calls it clean.

If your footer says to report with `dori report`, claim done the same way:

```sh
dori report <your-lane-key> done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version, links>"
```

The supervisor turns that row into the same claim within a few seconds. `dori claim-done` (below) still works and records the same claim at once.

```sh
dori claim-done <your-lane-key> --evidence "<PR link and head SHA, closed issue, version, links>"
```

The key is in your brief's lane footer. With `claim-done`, if you leave it out, the lane registered for your pane is used. Running `claim-done` (or `report done`) again with the same evidence while the claim stands prints `LANE_DONE_ALREADY_CLAIMED <key> <at> <evidence>` and doesn't wake the Dori again; new evidence, or a claim after an objection, is a new claim. A session that recovery replaced gets `LANE_STALE_SESSION` from `claim-done` and `report`: only the session in the lane's registered pane may report.

## Reporting before done

Follow your footer. A footer that names `dori report` means: report only with `dori report <key> <milestone|progress|question|blocked> --text "..."`, and never type into the Dori's pane. `question` and `blocked` wake the Dori, `milestone` reaches it with its next update, and `progress` (1-2 sentences: done since last, and next) updates your work thread's status message. A `milestone` is a state change the owner would care about: what now works or landed, where you stand against your Done condition, and whether scope changed. No pane is read for a report: text printed in your pane or typed into the Dori's pane reaches no one. Thread posts the supervisor makes for you (`dori report progress`) read `[System] relayed from lane <key>: ...`. A lane on a footer an older dori wrote is moved onto `dori report` (footer rewritten) when recovery relaunches it.

A lane on another machine (`dori launch --machine`) reports the same way with its runner's `~/.dori/runner/bin/dori report <key> ...`, so everything below applies unchanged (remote worktree checks are skipped and say so in the close receipt).

## What happens next

1. The supervisor records the claim (`LANE_DONE_CLAIMED` wakes the Dori, who checks your evidence and reports the lane to the owner at that point, not at the close), and you get a `[LEAD]` line saying when the lane closes.
2. Stop: stay idle, start no new work, and do not watch or wait for the merge. While the claim stands, the freshness sweep neither nudges you nor raises `NO-PROGRESS` or `IDLE-ESCALATE` for your silence.
3. If nobody objects within 5 minutes, the watcher re-checks everything live and closes the lane. When the only signals not yet live are `merged` PRs your claim recorded, still at that head with checks pending or green and no conflict, the claim keeps waiting for the supervisor's merge, up to `mergeWaitMaxMin` (60) minutes after the window started; a failed check, a conflict, a draft, a push after the claim, or a wait past that bound becomes the objection, with that reason. Likewise, when every signal reads live but a PR the claim recorded into `dev` is still open at that head with no failed check and no conflict (a `pr` signal is live at a green open PR), the close waits for the supervisor's merge, up to the same bound, so the PR is never left unmerged; a PR into another base, or one the supervisor cannot merge as it stands, does not hold the close. A lane whose PR is confirmed merged (the supervisor merged it, or GitHub reports a PR merged into `dev` from your worktree branch at its HEAD) closes on the next pass instead, and its merged branch is deleted locally and on the remote. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted changes, untracked files (gitignored ones don't count), or commits that are on no remote.
4. Closing removes your worktrees first, then marks your thread done (when a thread hook is configured, and only if no other open lane shares it), then closes your tab. A worktree that cannot be removed then (for example untracked files) is listed as kept in the close receipt; the watcher removes it later once it is clean, only under `worktreeRoot`, and reports `WORKTREE_CLEANED`. omo's own `.omo/omo.jsonc` migration (`_migrations`) and `.omo/omo.jsonc.bak.*` backups do not make a worktree dirty. A lane that has not closed never loses a worktree to that sweep, even after its PR merged. A worktree that is already gone when the close runs (for example removed by hand) does not stop the close: the Done signals run in `leadCwd` and the receipt lists it as already removed.

## If the Dori objects, or a check fails

You get `[LEAD] not done: the Done check of <key> did not pass. Read the reasons with dori lane status <key>, ...` in your pane, and the lane goes back to not-done. Run `dori lane status <key>`: its `objection.reasons` lists what failed. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.

## Messages from the supervisor

A `[LEAD]` line that ends with `dori report ack <id>` (for example failing CI on your PR) needs that confirmation: run `dori report ack <id>` once you have read it, then act on it. Keep your own CI wait until the PR is green; the message does not replace it. Never wait for the merge. Without the ack the lead is told after 20 minutes. When your PR is green and mergeable into `dev`, the supervisor merges it for you, but only at the head SHA your done claim recorded: push everything before you claim, and claim again after any later push; a conflict with `dev` may get its own merge lane.

## When the window starts

The window starts when the Dori actually receives your claim, not when you make it: a claim that waits behind a restarting lead still gets the full 5 minutes after it arrives, and your `[LEAD]` line says so instead of naming a time. A brief that declares `autoClose: machine` on a line of its own (its `Done =` signals settle it alone) closes 5 minutes after the claim without waking the Dori; the footer says so. An objection or a failing signal still reaches the Dori as usual.

## What you may touch

`dori launch` sets `DORI_LANE_KEY` in your lane. From inside it, `claim-done`, `object-done`, `close`, `pause` and `resume` work only on your own key, and you may not run `dori send` at all: ask the owner with `dori report <key> question --text ...` and the Dori relays the answer. You may not run `ack`, `handled`, `launch`, `adopt`, `hold` or `lead-restart` at all. Anything else exits 1 with `LANE_PERMISSION_DENIED`. Ask the Dori instead. A manual `dori close` runs the same worktree checks as the watcher and refuses with `REFUSED <key>: ...`; only the Dori uses `--force`. A lane the owner cancelled, or whose Done can never hold, is closed by the Dori with `dori close <key> --cancelled --reason TEXT`: no Done check, recorded as cancelled; a lane cannot run it.
