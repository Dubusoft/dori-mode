# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab. You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --from-message <channel> <messageId> --note "worktree from origin/dev; leave the session store alone" --done "merged acme/app#412; closed acme/app#398" \
  --thread "discord:<channel>/<thread>" --mode ulw
```

Every lane runs on `defaultModel` with `laneThinking` (opus-5-5, effort medium by default); pick the mode, not the model. `--mode ulw` (the default, opened with `launchKeywords`) is for clear, contained work whose instructions say exactly what to change. `--mode mass-ulw` (opened with `massLaunchKeywords`) is for work that touches many places or whose instructions are vague enough that it has to investigate before it can decide what to change. `--model` stays only for the relaunch after a `STARTUP_ERROR`.

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in `laneWorkspace`, starts the agent, and after 20 seconds checks the start: `STARTUP_ERROR` on a known failure (missing module, no API key, rate limit, quota), `STARTUP_OK` when herdr reports the agent working, or idle with no such failure on its screen, `STARTUP_UNCONFIRMED` otherwise. On `STARTUP_ERROR`, relaunch on another model; on `STARTUP_UNCONFIRMED`, look at the pane before doing anything else.

To run the lane in an existing worktree session (for example a shell pane another tool left in a new worktree), add `--pane <ID>` (or `--workspace <ID>`): the same lane command runs in that pane, with the same footer, registry entry and startup check, and `--cwd` defaults to the pane's cwd. The pane must be an idle shell not owned by another lane; otherwise `launch` refuses and writes nothing.

For a Toodo task, start it from your own session with the Toodo `start_task` tool (without `agent_command`; a task never starts itself, so a lane never calls it), save the response JSON, and launch with `--toodo-start <file>` instead of `--cwd`/`--pane`. The lane then runs in the worktree and the idle shell pane Toodo opened for the task, never in a second worktree or tab. Launch the same turn: pane ids go stale when the herdr workspace closes or herdr restarts, so a missing pane is looked up again in the task's `herdrWorkspaceId` (`LAUNCH_PANE_REFOUND`). With no usable pane (runner plain, tmux or none, herdr down: `panes` empty or `paneError`) the lane gets a new tab in the task's worktree and `launch` prints `LAUNCH_FALLBACK <key> new tab: <why>`. For a task on a remote workspace add `--machine <its herdr machine>`: the pane ids belong to that machine's herdr.

To run a lane on another machine, add `--machine <label-or-id>` naming a saved herdr machine, either on its own (a new tab there) or with `--pane`/`--workspace`. The brief is read locally and written on the machine to its temp directory (`/tmp/dori-brief-<key>.md` for a POSIX shell, `<temp>\dori-brief-<key>.md` for PowerShell, sent as base64 so no quoting can break it); a `cmd.exe` pane is refused. `--cwd` names the directory on that machine and is kept as `remoteCwd`, apart from the local directory where `command` Done signals run (`defaultCwd`). A remote lane prints its `[REPORT]` lines in its own pane and does not run `dori claim-done`; the watcher turns its new `done` report into a claim with the usual 5-minute window, and its blocker or question into an urgent `LANE_REPORT`. Register a lane already running remotely with `dori adopt --machine`. The machine is saved in the registry entry, and every reader and sender uses it; older entries without one stay local. Remote lanes skip the local MCP optimization, and their worktree git checks and cleanup are skipped with an explicit detail rather than run against a local path that only looks the same.

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
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

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
