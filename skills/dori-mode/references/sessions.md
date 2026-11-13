# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab. You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --from-message <channel> <messageId> --note "worktree from origin/dev; leave the session store alone" --done "merged acme/app#412; closed acme/app#398" \
  --thread "discord:<channel>/<thread>" --mode ulw
```

Every lane runs on `defaultModel` at thinking medium (opus-5-5, effort medium by default); pick the mode, not the model. `--mode ulw` (the default, opened with `launchKeywords`) is for clear, contained work whose instructions say exactly what to change. `--mode mass-ulw` (opened with `massLaunchKeywords`) is for work that touches many places or whose instructions are vague enough that it has to investigate before it can decide what to change. `--model` stays only for the relaunch after a `STARTUP_ERROR`.

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in the supervisor-managed lanes workspace (found again or created when herdr lost it; a local launch never opens in herdr's focused workspace), starts the agent, and after 20 seconds checks the start: `STARTUP_ERROR` on a known failure (missing module, no API key, rate limit, quota), `STARTUP_OK` when herdr reports the agent working, or idle with no such failure on its screen, `STARTUP_UNCONFIRMED` otherwise. On `STARTUP_ERROR`, relaunch on another model; on `STARTUP_UNCONFIRMED`, look at the pane before doing anything else.

To run the lane in an existing worktree session (for example a shell pane another tool left in a new worktree), add `--pane <ID>` (or `--workspace <ID>`): the same lane command runs in that pane, with the same footer, registry entry and startup check, and `--cwd` defaults to the pane's cwd. The pane must be an idle shell not owned by another lane; otherwise `launch` refuses and writes nothing.

A Toodo task is tracked by you, not by the lane. Toodo holds the task graph (tasks, dependencies, related links) and the working memory (progress and decision notes, blockers, status history); Dori does all the running. Launch the lane exactly as for any other work, in its own worktree through `--cwd`, and name the task with `--task <id>` (dori only records the link, Toodo is not asked; step 5 needs it). Then record the work on the task over MCP, in this order:

1. Before planning, `search_tasks` with a few distinctive words and read the hits with `get_task`: an earlier task may already have decided the approach or rejected one. New work goes in with `create_task` (`## Purpose`, `## Background`, criteria), a real prerequisite with `add_dependency`, context worth reading together with `add_related`.
2. Right after `LAUNCHED`, `start_task` the task and `add_progress_note` with the lane key, its thread and why it starts now (an owner go, an urgent fix). `start_task` only moves the task to `in_progress` and records the reason and refs; it opens no worktree or pane.
3. While the lane works, record each decision worth remembering (the choice and the reason) with `add_progress_note` when it is made, and a blocker the lane cannot clear with `report_blocker`.
4. When the lane opens its PR, add a note with the PR URL.
5. After the PR merges and `LANE_CLOSED`, the task is finished. For a lane launched with `--task <id>` the supervisor does it when it closes the lane after a merged claim: it reads each PR the claim bound or the supervisor merged back as merged with its merge SHA, checks the task's open manual criteria with that as evidence (URL criteria are toodo's own), completes it with a note naming the PR and merge SHA, and reads it back (`ToodoWriter`); then it appends the merge to the lane's last report by editing it (a closed thread is left alone: nothing is posted into it or redirected to its parent channel). The close then carries `toodo=done`, and after a claim you already took (`LANE_CLOSED <key> closed seen-claim toodo=done`) it is digest, beside digest `TOODO_TASK_COMPLETED <key> #<id> <pr> merge=<sha>; report appended|not appended: <why>`. Every other close stays urgent and the task is yours: `toodo=no-task` (no `--task`), or `toodo=unmerged` / `toodo=failed` with urgent `TOODO_TASK_NOT_COMPLETED <key> #<id> <why>` (`toodo=append-failed`: completed, append the merge yourself). The close also wakes you at once when you already took the claim, so you need no wait of your own for it. Finish the task with `complete_task` and a note linking the PR (a task whose criteria Toodo already saw met may be done on its own), or `conclude_task` with the reason when the work did not ship. Toodo accepts `conclude_task` only from `in_progress` or `in_review`, so a task still `planned` (for example work dropped before its lane started) is started first: `start_task`, then `conclude_task` with the reason. A refused call has not finished anything; read the task back with `get_task` and finish it only once the status reads `done`. Tell the owner about the merge and the finished task with `dori reported <key> --append TEXT`, which edits the lane's last report instead of posting: the owner may already have closed the thread with the button on that report, and a new post would reopen it (a thread the owner closed gets one line in its parent channel linking it instead).

A lane never calls Toodo and its brief never asks it to; you relay what it reports into the task.

The scripts carry a writer for these calls, `ToodoWriter` in `scripts/src/toodo-client.ts`: `startTask`, `addProgressNote`, `reportBlocker`, `checkCriterion` and `completeTask` over toodo's `/mcp` endpoint with the server's `mcp-token`. Each one reads the task first and sends nothing when the task already shows the change, and reads it back after the call, so a write whose reply was lost still counts once the task shows it. The supervisor uses it for step 5 (`toodoWriter` in its built-in tunables: the server at `http://127.0.0.1:47616` with the token in `~/.local/share/toodo-server/mcp-token`); every other call is still yours, made as above.

To run a lane on another machine, add `--machine <label-or-id>` naming a saved herdr machine, either on its own (a new tab there) or with `--pane`/`--workspace`. The brief is read locally and written on the machine to its temp directory (`/tmp/dori-brief-<key>.md` for a POSIX shell, `<temp>\dori-brief-<key>.md` for PowerShell, sent as base64 so no quoting can break it); a `cmd.exe` pane is refused. `--cwd` names the directory on that machine and is kept as `remoteCwd`, apart from the local directory where `command` Done signals run (`leadCwd`). A remote lane reports with its runner's `~/.dori/runner/bin/dori report`: its `done` report becomes a claim with the usual 5-minute window, and its blocker or question an urgent `LANE_REPORT`. Register a lane already running remotely with `dori adopt --machine`. The machine is saved in the registry entry, and every reader and sender uses it; older entries without one stay local. Remote lanes skip the local MCP optimization, and their worktree git checks and cleanup are skipped with an explicit detail rather than run against a local path that only looks the same.

When the work comes from the owner's messages, build the brief from them with `--from-message <channel> <messageId>` (repeatable) and add `--note` for what only you know: earlier decisions from memory, boundaries with other lanes, what not to touch, which repo or worktree. Don't restate the request. Write a `--brief FILE` by hand only for work that has no owner message:

- leave the opening keywords out: `launch` puts the mode's keywords (`ulw ...` or `/mass-ulw ...`) in front of the prompt;
- where the code is and what has been learned so far;
- the ideal end state, from the point of view of whoever uses the result;
- what not to touch;
- any exception to the config's `laneRules` this lane needs (for example a lane that merges its own PR).

Leave out what the footer already says to every lane: how to report and claim done, how to ask the owner (`dori report <key> question`, never only an on-screen prompt), that PR bodies, issues, commits and repo docs carry no owner quotes, chat message ids, or quota, usage or cost numbers, that decisions and conversations stay out of the repo, the owner's language (`ownerLanguage`), and the owner's standing policy lines (`laneRules`, such as stopping at a green PR or keeping CI to the typecheck).

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `pr <owner/repo> <branch>` | the newest PR from that branch is merged, or is open, not a draft, and has at least one check with every check green (success, skipped or neutral) |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

Worked examples: `Done = merged acme/app#12` for a lane that lands a PR, and `Done = merged acme/app#12; closed acme/app#7` when it also closes an issue. When the PR number is not known at launch, or the lane stops at a green PR, use `Done = pr acme/app feat/add-x-12`. Either way the lane claims at its green PR and stops; it never waits for the merge, which the supervisor makes after the claim (a `pr` lane's close waits for that merge when its PR targets `dev`). Quote a branch that holds `;` or spaces (`pr acme/app "a;b"`). Only the newest PR from the branch counts, so give every lane its own branch name. A PR from a fork is reported as an error: `pr` covers branches in the repo itself only. A `command [...] stdout~` signal that can only hold after the work is done is never live for a cancel, so a cancelled lane never passes it: cancel with `dori close <key> --cancelled --reason TEXT`.

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. `lanes/` holds open lanes only: a lane is moved to `<stateDir>/lanes-archive/` (one atomic rename) when it closes, so the sweeps never read the closed history. A closed key is still found there (`dori launch` refuses to reuse it). Closed files left in `lanes/` by older versions are archived on the next read, and files hand-moved to the old `<stateDir>/lanes-closed/` are kept verbatim under `lanes-archive/legacy/`. Each lane records:

| Field | Meaning |
|---|---|
| `thread` | where its updates go, as `platform:thread` (or `none`) |
| `pane`, `tab` | its herdr location |
| `session` | the agent's own session id, so a closed job can be reopened later |
| `status` | `working`, `done-claimed`, `verified-done`, `not-done`, `closed` |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change |

`dori sync` compares the registry with live panes and prints drift (a pane that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a pane, in order:

1. the agent process's `--session <id>` argument;
2. `PI_SESSION_ID` in the environment of one of its child processes;
3. the session file whose timestamp falls within three minutes after the agent process started.

The id from step 1 is the session the agent was launched with. If someone switches sessions inside the agent, only steps 2 and 3 notice.

When the owner writes in a closed lane's thread, reopen its recorded session in a new tab, set its monitors again, and keep replying there.

## Messaging a session

Before you type into a pane, run the pre-send check in [messaging.md](messaging.md).

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `dori dead-panes` reports agent panes that stopped; restart the session in place (`<agent> --session <id>`) unless its work is finished.

## Under supervision

With `dori supervise` running, the sweeps above run inside the supervisor and reach you as lines in `<stateDir>/lead-events.log`, read through the single monitor your startup prompt names (`tail -c +N -F <path>`, used exactly as given). The lane protocol doesn't change: launch, claim, object, close and pause work the same way. What changes is your own memory. The supervisor can restart you on a new session, so before any turn ends, put open questions, promises to the owner and lane notes into memory or the lane's registry record. Treat your context as gone after every turn.

With `autopilot.executor` on, the supervisor also launches marked autopilot tasks itself, so `ap-<id>-<n>` lanes appear in the registry with threads you did not open. Follow them like any lane (claims, questions, blockers, close), but never launch, hold-drop or settle them yourself: `references/autopilot.md` Switch-over lists what stays yours.
