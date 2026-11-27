# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 0. Your name

Before anything else, ask the owner what to call you. Plain "Dori" is fine, and so is a name ending in Dori (ShipDori, WorkDori), so several Doris can run side by side. Use that name everywhere: the bot's display name, your sign-off, and the mode itself, which you remember as "<name> mode" so the owner can switch it on again in one line.

## 1. hc

Install hc (herdr-core, the project's headless terminal runtime). The lead and every lane run in hc terminals, and hc is how the Dori opens, reads and types into them. There is no other terminal runtime.

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
```

## 2. Messenger

Dori runs on Discord only. Install agent-messenger (github.com/agent-messenger/agent-messenger) for the Discord bot.

agent-messenger wraps part of Discord. Read Discord's current bot API changelog and call the API directly for the rest:

- Discord: edit your own messages to grow them, and use threads.

## 3. Bot

Finish every login in the browser. Create the bot with agent-messenger and finish its setup. Then give it its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon. On the **Bot** tab, enable the privileged **Message Content Intent** setting for supervised inbound messages.

Greet the owner through the bot before doing anything else.

## 4. Scripts and `dori setup`

```sh
gh auth login   # the repo is private; skip when gh is signed in or GH_TOKEN is set
bash -c "$(gh api -H 'Accept: application/vnd.github.raw' repos/Dubusoft/dori-mode/contents/install.sh)"
```

The repo is private, so the installer needs gh signed in (or GH_TOKEN); it clones the repo with that login (the checkout keeps using gh for its credentials, so `dori update` authenticates too), links the skill, runs `bun link` (puts `dori` on PATH) and then `dori setup` when it has a terminal. Otherwise run `dori setup` yourself, or from a checkout: `cd skills/dori-mode/scripts && bun install && bun link && dori setup`.

`dori setup` is interactive and safe to rerun: each question shows the current value in brackets, or `(default: ...)` with the value that applies when the key is unset; Enter keeps it and `-` clears an optional key. It asks five questions: the bot token, the channel ids, the owner id, whether new GitHub issues start work, and autostart. Everything else keeps its stored value or default (change it with `--set key=value`). `dori setup --advanced` also asks the steps marked *advanced* below. It does, in order:

1. **Bot token**: saved as `DORI_DISCORD_TOKEN` in `~/.dori/env` (mode 600, other lines kept). Input is hidden and the token is never printed.
2. **Main channel ids**: `discordChannels`. Each id is checked with the token (`GET /channels/{id}`); a 401 means a bad token, a 403 means the bot is not in the server or cannot view the channel.
   A channel that fails its check is asked again (*advanced*: setup offers to keep it anyway).
   With a token and at least one channel, setup reads `GET /oauth2/applications/@me` and the first channel's `guild_id`, then asks for the Discord owner user id (defaults to the application owner). It writes `discord.applicationId`, `discord.guildId`, and `discord.ownerId` for slash commands, preserving existing values on reruns.
3. **`defaultModel`, `leadModel`, `leadCwd`, `stateDir`** (*advanced*; otherwise flags `--model`, `--cwd`, `--state-dir`, then stored values, then defaults): defaults are the subscription model, empty (the lead uses `defaultModel`), `~/.dori/lead` and `~/.dori/state`; setup creates both directories. `defaultModel` is for lanes; `leadModel` only changes the lead. `leadCwd` is the lead session's working directory; local lanes started without `--cwd` start there too. A config that still names it `defaultCwd` keeps its value: setup renames the key to `leadCwd` (`SETUP_KEY_RENAMED defaultCwd -> leadCwd`), and an existing config with neither key gets `"leadCwd": "~"`, the home directory it ran the lead in. Lanes run at `--thinking medium`; change it in `agentCommand` or a runner's `runner-config.json` `agents`; `launch --mode mass-ulw` uses `massLaunchKeywords`. `leadModel` is one model; a legacy array uses its first entry with a warning.
   Then it asks whether new GitHub issues start work automatically. Yes asks which GitHub accounts' new issues do (`githubIssueAuthors`, comma separated; `--issue-author LOGIN` answers it without asking) and the GitHub repos to watch on this machine, saved in the state directory (*advanced* asks the repos either way); no clears `githubIssueAuthors`. Issues from anyone else never wake the lead. `dori repos add/remove/list` changes the repo list without a supervisor restart.
   *Advanced* then asks the other config keys (see below); the default flow records them as seen, so `dori setup --migrate` later asks only keys added after this run.
4. **Autostart (optional, Linux)**: renders only `hc-core.service` and `dori-supervisor.service` from `scripts/templates` (there is no runner unit on the lead host: the supervisor spawns the local runner as its child) into `~/.config/systemd/user`, plus `~/.dori/dori-boot-prep.sh` (the supervisor's ExecStartPre; hc starts its core on demand, so it waits for nothing and the supervisor then finds or recreates the lead pane). hc must be on PATH, otherwise setup stops with `hc is not on PATH; install it (curl -fsSL https://releases.herdr.dev/core/install.sh | sh) before turning on autostart`. Then, asking before each: `loginctl enable-linger`, `systemctl --user daemon-reload`, `systemctl --user enable hc-core.service dori-supervisor.service` and `systemctl --user start hc-core.service` (without *advanced*, answering yes to autostart runs every step without asking). Before enabling, setup checks systemd for an existing `dori-presence.service` and asks to run `systemctl --user disable --now dori-presence.service`. Accepting stops and disables it without deleting its file; declining leaves it untouched. Stop the legacy presence process before starting the supervisor. Start the supervisor with `systemctl --user start dori-supervisor.service`.
   The supervisor unit uses the systemd watchdog (`Type=notify`, `WatchdogSec=300`) and both units stop after 5 starts in 600 s, then run `dori-failure-notify@.service`, which posts one Discord line with the fix (`systemctl --user reset-failed <unit> && systemctl --user start <unit>`). Rerun autostart and `daemon-reload` on older installs to get them.

The config is written atomically (mode 600). `references/scripts.md` explains every field and `config.example.json` shows them all.

### Config keys: by argument or interactively

`dori setup` and `dori runner setup` (a runner's `runner-config.json`) work the same way:

- **By argument.** `--set key=value` and `--unset key` (both repeatable) are applied exactly as given and never asked. An empty value unsets. A list takes `a,b` or a JSON array, a JSON key takes JSON. An unknown key or a bad value stops the run before anything is written (`SETUP_FAILED` / exit 1, listing the valid keys).
- **Interactively.** Every other key is asked with its `[required]` or `[optional]` label and its current value; Enter keeps it and `-` clears an optional key. Required keys without a value and keys never shown before come first, then setup offers the other keys; a required key that already has a value is not asked again. `dori setup` asks these only with `--advanced`. Without a terminal or with `--yes` nothing is asked.
- **Seen keys.** Each key shown or given is recorded in `<stateDir>/setup-keys.json` (runners: `<stateDir>/runner-setup-keys/<label|local>.json`). A later run in "new" mode (`dori setup --migrate`, `dori runner setup --new`) asks only keys never shown before, such as keys a `dori update` added, plus required keys that are empty.
- **Automatic removal.** Keys the file no longer reads are deleted: unknown top-level keys, `hooks.*` other than `threadReply`/`transcribe`, `laneSandbox.default`, the old `runners` keys (`listen`, `mode`, `restartCircuit`, or a `runners` array), and in `runner-config.json` unknown keys and `guard.*` subkeys. Legacy pane keys are moved into `<stateDir>` first. In `config.json` every other removal is warned about once first: the run that first finds the key keeps it and logs `SETUP_KEY_REMOVAL_PENDING <key> (<reason>)`, and the next run removes it (`SETUP_KEY_REMOVED <key>`). Before any write the previous file is copied to `config.json.<UTC time>.bak` (each run keeps its own copy) / `runner-config.json.bak`, and runner removals are logged as `RUNNER_SETUP_KEY_REMOVED <key>`.
- **Schema version.** `config.json` holds `schemaVersion`. Setup applies the migration table (`scripts/src/config-schema.ts`: renames move a value, removals carry their reason, fills write a changed built-in default into a file that lacks the key, so an existing install keeps the value it ran with) for every version the file has not had, then writes the current version. A file written by a newer dori is refused and left untouched; update dori first.
- **Missing required keys** log `SETUP_KEY_MISSING <key> [required]` (`RUNNER_SETUP_KEY_MISSING`) and exit 2.

`config.json` keys:

| Key | Label |
|---|---|
| `discord`, `stateDir`, `leadCwd`, `defaultModel`, `discordChannels` | [required] |
| `worktreeRoot`, `agentCommand`, `leadModel`, `leadThinking`, `leadArgs`, `alertsChannel`, `decisionsChannel`, `githubIssueAuthors`, `ownerLanguage`, `displayTimeZone`, `laneRules`, `laneSandbox`, `guardMachines`, `runners`, `placement`, `buttonHooks`, `hooks`, `ciMergeBase`, `ignorePanes`, `autoReport`, `reportQuietLanes` | [optional] |

`decisionsChannel` holds the owner decision (`[결정]`) and input request (`[요청]`) threads (the owner's #inbox; it is wired by id, so renaming the channel needs no change): `dori setup --set decisionsChannel=<channel id>`, or `--unset decisionsChannel`. Use a new, empty channel. Unset, each decision goes to the channel that asked for it.

`runner-config.json` keys:

| Key | Label |
|---|---|
| `agents` | [required] |
| `allowedRoots`, `sandbox` (`required`\|`optional`), `jobs` (`allow`\|`deny`), `guard`, `heavyKill`, `sandboxCheck`, `workspaces`, `reposRoot`, `worktreeRoot` | [optional] |
| `detectWorkspaces` | [optional], never asked: set it with `--set detectWorkspaces=false` |
| `grants`, `hostCommands` | [optional], never asked: the owner edits them (`--set` takes them too) |

Every lane opens on hc. The first hc lane installs hc into `~/.local/bin` when it is missing and runs `hc update` when it is older than 0.1.22 (`RUNNER_HC_UNAVAILABLE` names the fix when neither works). An hc lane is one terminal named after the lane key (label `dori.lane=<key>`), opened with no parent and no notes; the runner types the launch line into its shell, so `hc get`, `hc ls` and `ps` show only the shell, and the lane's stored secrets reach it inside that shell through `dori secret env`, never on a command line. hc has no TUI: on that host `hc ls` lists the lanes, `hc read <key> --lines 200` prints one, and `hc attach <key>` shows it live (Ctrl+\ detaches; typing there types into the lane). A lane itself never reaches hc, whose control socket runs any command on the host: the lane sandbox hides hc's runtime dir (`$XDG_RUNTIME_DIR/herdr-core`, or `/run/user/<uid>/herdr-core`), its state dir (`~/.local/state/herdr-core`) and any socket `HC_SOCKET` or hc's config names, keeps `~/.config/herdr-core` read-only and unsets the `HC_*` variables an hc terminal sets. omo in an hc lane still shows working or blocked through OSC 7501 on its terminal. `dori doctor`'s `lane hc socket` check connects to each hc socket on the host from a probe lane and fails when one answers or an `HC_*` variable gets through.

**Retired runtime keys.** hc is the only terminal runtime. A `config.json` that still holds `leadRuntime` loads as usual (the key is named in `CONFIG_KEYS_IGNORED`), and `dori setup --migrate` removes it (`SETUP_KEY_REMOVED leadRuntime ...`). The same run removes a leftover `laneRuntime` from the local runner's `~/.dori/runner/runner-config.json`, keeping `runner-config.json.bak` (`SETUP_RUNNER_KEY_REMOVED laneRuntime ... from <path>`). A worker's runner ignores `laneRuntime` with `RUNNER_CONFIG_KEY_IGNORED`, and `dori runner setup` removes it.

**hc core autostart.** On Linux the hc client starts its core in transient `systemd-run --user` units, and those don't come back after a reboot until some hc command runs. `hc-core.service` (from `templates/hc-core.service`) is a oneshot `hc server start` at login/boot. It's safe while a core already runs, and stopping the unit never stops the core. macOS has no user systemd, so launchd owns the core there: `~/Library/LaunchAgents/com.dori.hc.plist` (from `templates/dori-hc-launchd.plist`) runs `hc serve` with `KeepAlive` and logs to `~/.dori/runner/hc.log`. `dori runner install` writes the unit or agent on every worker and stops when `hc` isn't on its login PATH. On the lead host, `dori setup --autostart` always writes and starts `hc-core.service` (Linux only: setup doesn't install the launchd agent yet).

The lead's pane is always one hc terminal named `dori-lead` (label `dori.lead=1`; `hc attach dori-lead` shows it). The supervisor starts, types `[dori]` lines and `/resume` into, reads, stops and restarts the lead there. The lead is never sandboxed, so the lane sandbox's hc socket hiding does not touch it.

The runner-config `defaultCwd` key is retired: a lane started without `--cwd` starts in `~/.dori/runner/lanes/<key>` on its runner. A file that still holds it loads with one `RUNNER_CONFIG_KEY_IGNORED defaultCwd` line and the key has no effect; `dori runner setup` removes it (with `RUNNER_SETUP_KEY_REMOVED defaultCwd` and a `.bak`).

A `runner-config.json` that would not pass the runner's policy check is never written (`RUNNER_SETUP_FAILED invalid runner-config: ...`). The running runner reloads the file itself; no restart.

What runs it for you:

- `dori runner install` runs `dori runner setup --new` on the new runner afterwards (it takes `--set`, `--unset` and `--yes`).
- `dori update` runs `dori setup --migrate`: migrate to the current `schemaVersion`, warn about or prune obsolete keys (timestamped `.bak` before each write) and ask only new keys. With no `config.json` it prints `SETUP_MIGRATE_SKIPPED` and creates nothing.
- `dori runner upgrade` (and so `dori update`'s rollout) runs `dori runner setup --new` for every runner, upgraded or already on the current version, and reports a worker without `runner-config.json` or with a required key missing (`RUNNER_POLICY_MISSING`, exit 1).

Figma MCP: set the figma server to `"exposure": "search"` in the global `~/.omo/agent/mcp.json`. Its tools then cost no prompt tokens until a lane activates them with `tool_search`. `dori launch` writes no `.omo/mcp.json` into lane folders and removes one that is exactly the old figma-off file.

Non-interactive, for scripts and CI: `dori setup --yes --token-file FILE --channel ID [--model M] [--cwd DIR] [--state-dir DIR] [--set key=value ...] [--unset key ...] [--autostart]`. Flags win, then stored values, then defaults. A channel the bot cannot read stops the run before anything is written. `--autostart` with `--yes` accepts every system step, including disabling and stopping a detected legacy presence unit. Failed system steps are reported and return exit code 2; a failed legacy-unit check stops autostart before enabling the new units.

## 5. Monitors

Subscribe to new messages with your monitor tool. Transcribe voice messages (`dori transcribe`) and treat the transcript as the owner's message.

Arm these as persistent monitors in your own session. Each filter matches only lines that need the lead, so `*_READY` start-up lines never wake you:

| Monitor | Command | Filter |
|---|---|---|
| inbound messages | your messenger's watch command | new owner messages |
| done flow | `dori watch` | `^LANE_(?!WATCH_READY)` |
| dead panes | `dori dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE)` |
| host guard | `dori guard --loop 1` | `^HOST_GUARD (ALERT\|CLEAR)` |
| freshness | `dori freshness --loop 5 \| tee -a ~/.dori/freshness.log` | `^WORKING-WHILE-PAUSED` |
| presence (optional) | `dori presence discord` | `^PRESENCE_READY` |

The done-flow filter keeps every `LANE_` line except the ready line. `LANE_WATCH_WARN` matters most there: it's the only sign that `dori watch` is failing and lanes aren't being closed. Freshness acts on its own (it nudges the lane), so only `WORKING-WHILE-PAUSED` needs you. The other freshness lines (`NUDGED`) go only to `~/.dori/freshness.log`. Run `tail ~/.dori/freshness.log` when you want recent nudges.

### Supervised mode instead

If you run `dori supervise`, skip the table above. The supervisor owns one Discord gateway connection for online presence, slash commands (`/quota`) and inbound messages, plus `watch`, `guard`, `dead-panes` and `freshness`, so the lead arms exactly one monitor: the tail on `<stateDir>/lead-events.log`. Take the command from the startup prompt, which reads `tail -c +N -F <path>` with the handoff byte offset filled in, and run it exactly. Don't swap in `tail -n 0 -F`. That form starts at the end of the file as it stands when the monitor registers, so events written in the gap are dropped.

`dori presence discord` is still available for non-supervised installs only. A token-scoped lock shared by the same OS user on the same machine prevents it and the supervisor from opening concurrent gateways, even with separate state directories. Stop the existing owner before starting the other command; this lock does not coordinate different machines or OS users.

REST catches up on startup and reconnect. With a healthy gateway, `discordSafetyPollSeconds` controls the safety interval (default 300 seconds); when the gateway cannot connect, inbound automatically falls back to REST every 5 seconds. If Discord rejects the privileged intent with close code 4014, the supervisor logs one instruction to enable **Message Content Intent** in the Developer Portal's **Bot** tab, reconnects without it, and retains presence and slash interactions while using the 5-second REST fallback. REST cannot bypass Discord's content restrictions: in this degraded mode, message text may be empty unless Discord grants an exemption, such as a bot mention.

On a supervised start the lead:

1. runs `dori inbox take` and handles everything it prints, straight away (the prompt itself lists no events);
2. registers the one monitor from the prompt;
3. starts no sweeps and no inbound pollers;
4. before each turn ends, writes open questions, promises and any other state it needs into memory or the registry, since the next turn may be a fresh session.

Set `discordChannels` (the channel ids to watch, as strings), and `cacheTtlMin` in the config. The lead runs on `leadModel` if set, else `defaultModel`; `leadThinking` sets its `--thinking` level without touching lanes. `references/scripts.md` has the fields.

After editing `leadModel` or `leadThinking`, run `dori lead-restart` to request a fresh lead at its next idle moment; `--model ID` and `--thinking LEVEL` override those settings for the request. `dori status` and `dori doctor` show pending requests. If hc no longer lists the lead pane, `doctor` names it and gives `dori lead-restart` as the repair command; keep the supervisor running to recreate it.

The supervisor recovers missing working-lane panes automatically, and replaces a restored `omo` whose live model is absent or differs from its registry model. `dori recover [key]` runs this immediately. Paused and closed lanes stay untouched and attempts are capped. Each recovery posts one thread line.

#### Cutting over a running Dori

Switching an existing Dori over is an outside job, done on the lead only. Stop the old monitors and pollers first, then start the supervisor from outside the lead's session. Never edit a live lead's prompt or config in place.

The cutover touches the lead only. Lanes keep running as they are.

1. From outside the lead's session, stop the lead's old monitors and pollers: inbound, `watch`, `dead-panes`, `guard`, `freshness`. Two copies of a sweep would double every nudge and close.
2. Stop any standalone `dori presence discord`. If the legacy unit is installed, migrate it through `dori setup` with autostart or run `systemctl --user disable --now dori-presence.service`. Only `hc-core.service` and `dori-supervisor.service` should remain enabled for supervised mode.
3. Enable **Message Content Intent** in the Developer Portal's **Bot** tab. Keep `discord.applicationId`, `discord.guildId`, `discord.ownerId` and `discordChannels`; `dori setup` discovers the ids if needed. `discordSafetyPollSeconds` is optional and defaults to 300.
4. Export `DORI_DISCORD_TOKEN` with the bot token, then start `dori supervise` from outside the lead, in its own pane or service. Keep the existing per-channel `discord-inbound.json` in the configured state directory when migrating the standalone poller so its cursor is preserved.
5. Let the supervisor start or restart the lead with its startup prompt.

Don't edit a live lead's prompt, config or monitors in place. Stop, then start.

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.

Once the bot is live and the first look around is done, run onboarding (`references/onboarding.md`), unless it has been done before.
