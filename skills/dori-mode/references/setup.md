# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 0. Your name

Before anything else, ask the owner what to call you. Plain "Dori" is fine, and so is a name ending in Dori (ShipDori, WorkDori), so several Doris can run side by side. Use that name everywhere: the bot's display name, your sign-off, and the mode itself, which you remember as "<name> mode" so the owner can switch it on again in one line.

## 1. herdr

Run inside herdr. It is how you open, read and message sessions, and they survive restarts. herdr is the terminal multiplexer the Dori runs in. Every lane is a herdr tab, and herdr lets you read a pane, type into it and see which process runs there.

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi        # or the integration for the agent you run in
herdr --skill                       # load its skill unless it is already in your context
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
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dev-bokdong/dori-mode/main/install.sh)"
```

The installer clones the repo, links the skill, runs `bun link` (puts `dori` on PATH) and then `dori setup` when it has a terminal. Otherwise run `dori setup` yourself, or from a checkout: `cd skills/dori-mode/scripts && bun install && bun link && dori setup`.

`dori setup` is interactive and safe to rerun: each question shows the current value and Enter keeps it. It does, in order:

1. **Bot token**: saved as `DORI_DISCORD_TOKEN` in `~/.dori/env` (mode 600, other lines kept). Input is hidden and the token is never printed.
2. **Main channel ids**: `discordChannels`. Each id is checked with the token (`GET /channels/{id}`); a 401 means a bad token, a 403 means the bot is not in the server or cannot view the channel.
   With a token and at least one channel, setup reads `GET /oauth2/applications/@me` and the first channel's `guild_id`, then asks for the Discord owner user id (defaults to the application owner). It writes `discord.applicationId`, `discord.guildId`, and `discord.ownerId` for slash commands, preserving existing values on reruns.
3. **`defaultModel`, `leadModel`, `defaultCwd`, `stateDir`**: defaults are the subscription model, empty (the lead uses `defaultModel`), `~` and `~/.dori/state`. `defaultModel` is for lanes; `leadModel` only changes the lead. `laneThinking` (default `medium`) sets the lanes' `--thinking`; `launch --mode mass-ulw` uses `massLaunchKeywords`. `leadModel` is one model; a legacy array uses its first entry with a warning.
   It also asks for optional GitHub repos to watch on this machine and saves them in the state directory; `dori repos add/remove/list` changes the list without a supervisor restart.
   Then it asks which GitHub accounts' new issues start work automatically (`githubIssueAuthors`, optional, comma separated; `--issue-author LOGIN` non-interactively). Issues from anyone else never wake the lead.
4. **herdr**: keeps `leadPane` and `laneWorkspace` when they still exist, otherwise creates a `dori-lead` tab in a `Dori` workspace and a `lanes` workspace, and writes `leadPane`, `laneWorkspace`, `workspaces` and `ignorePanes` (the shell pane a new workspace starts with). The herdr server must be running.
5. **Autostart (optional, Linux)**: renders only `herdr-server.service` and `dori-supervisor.service` from `scripts/templates` (there is no runner unit on the lead host: the supervisor spawns the local runner as its child) into `~/.config/systemd/user`, plus `~/.dori/dori-boot-prep.sh` (the supervisor's ExecStartPre: it recreates the lead pane and lanes workspace after a reboot; needs `jq`). Then, asking before each: `loginctl enable-linger`, `systemctl --user daemon-reload`, and `systemctl --user enable herdr-server.service dori-supervisor.service`. Before enabling, setup checks systemd for an existing `dori-presence.service` and asks to run `systemctl --user disable --now dori-presence.service`. Accepting stops and disables it without deleting its file; declining leaves it untouched. Stop the legacy presence process before starting the supervisor. Start the new units with `systemctl --user start herdr-server.service dori-supervisor.service`; if herdr already runs by hand, setup instead prints a supervisor-only start command to avoid a socket conflict.
   The supervisor unit uses the systemd watchdog (`Type=notify`, `WatchdogSec=300`) and both units stop after 5 starts in 600 s, then run `dori-failure-notify@.service`, which posts one Discord line with the fix (`systemctl --user reset-failed <unit> && systemctl --user start <unit>`). Rerun autostart and `daemon-reload` on older installs to get them.

The config is written atomically (mode 600) and every key setup does not manage, such as `hooks`, stays as it is. Add the hooks and anything else by hand; `references/scripts.md` explains every field and `config.example.json` shows them all.

Figma MCP: set the figma server to `"exposure": "search"` in the global `~/.omo/agent/mcp.json`. Its tools then cost no prompt tokens until a lane activates them with `tool_search`. `dori launch` writes no `.omo/mcp.json` into lane folders and removes one that is exactly the old figma-off file.

Non-interactive, for scripts and CI: `dori setup --yes --token-file FILE --channel ID [--model M] [--cwd DIR] [--state-dir DIR] [--no-herdr] [--autostart]`. Flags win, then stored values, then defaults. A channel the bot cannot read stops the run before anything is written. `--autostart` with `--yes` accepts every system step, including disabling and stopping a detected legacy presence unit. Failed system steps are reported and return exit code 2; a failed legacy-unit check stops autostart before enabling the new units.

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

The done-flow filter keeps every `LANE_` line except the ready line. `LANE_WATCH_WARN` matters most there: it's the only sign that `dori watch` is failing and lanes aren't being closed. Freshness acts on its own (it nudges the lane and posts the report to the thread), so only `WORKING-WHILE-PAUSED` needs you. The other freshness lines (`NUDGED`, `POSTED`, `NO-REPORT`, `PENDING-REPORT`, `STALE-REPORT`) go only to `~/.dori/freshness.log`. Run `tail ~/.dori/freshness.log` when you want recent nudges and posts.

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

After editing `leadModel` or `leadThinking`, run `dori lead-restart` to request a fresh lead at its next idle moment; `--model ID` and `--thinking LEVEL` override those settings for the request. `dori status` and `dori doctor` show pending requests. If herdr lost the lead pane, `doctor` names it and gives `dori lead-restart` as the repair command; keep the supervisor running to recreate it.

The supervisor recovers missing working-lane panes automatically, and replaces a restored `omo` whose live model is absent or differs from its registry model. `dori recover [key]` runs this immediately. Paused and closed lanes stay untouched and attempts are capped. Each recovery posts one thread line.

#### Cutting over a running Dori

Switching an existing Dori over is an outside job, done on the lead only. Stop the old monitors and pollers first, then start the supervisor from outside the lead's session. Never edit a live lead's prompt or config in place.

The cutover touches the lead only. Lanes keep running as they are.

1. From outside the lead's session, stop the lead's old monitors and pollers: inbound, `watch`, `dead-panes`, `guard`, `freshness`. Two copies of a sweep would double every nudge and close.
2. Stop any standalone `dori presence discord`. If the legacy unit is installed, migrate it through `dori setup` with autostart or run `systemctl --user disable --now dori-presence.service`. Only `herdr-server.service` and `dori-supervisor.service` should remain enabled for supervised mode.
3. Enable **Message Content Intent** in the Developer Portal's **Bot** tab. Keep `discord.applicationId`, `discord.guildId`, `discord.ownerId` and `discordChannels`; `dori setup` discovers the ids if needed. `discordSafetyPollSeconds` is optional and defaults to 300.
4. Export `DORI_DISCORD_TOKEN` with the bot token, then start `dori supervise` from outside the lead, in its own pane or service. Keep the existing per-channel `discord-inbound.json` in the configured state directory when migrating the standalone poller so its cursor is preserved.
5. Let the supervisor start or restart the lead with its startup prompt.

Don't edit a live lead's prompt, config or monitors in place. Stop, then start.

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.

Once the bot is live and the first look around is done, run onboarding (`references/onboarding.md`), unless it has been done before.
