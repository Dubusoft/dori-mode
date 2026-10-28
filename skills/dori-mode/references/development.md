# Development

For working on the `dori` package itself. Using the CLI needs none of this; see [scripts.md](scripts.md).

## Install and test

```sh
cd skills/dori-mode/scripts
bun install          # runtime dependencies plus types and tsc
bun link             # puts `dori` on your PATH
bun test             # behavior tests with fake herdr/git/gh; nothing real is touched
bunx tsc --noEmit    # typecheck
```

Needs: bun 1.3+, herdr, git, and the GitHub CLI (`gh`) for `merged`/`closed` signals (npm for `published`). The `command`, `file` and `url` signals need nothing extra. The full list of signal kinds is in [sessions.md](sessions.md). The host guard reads `sysctl`, `memory_pressure` and `df` on macOS; on Linux it reads the load average, `/proc/meminfo` (memory and swap) and `df`.

## Library modules

The CLI is a thin layer over typed modules you can import in your own scripts:

| Module | What it gives you |
|---|---|
| `src/messenger/slack.ts` | `Slack`: post, edit, thread replies, file upload (upload URL + complete), presence; 429 backoff |
| `src/messenger/telegram.ts` | `Telegram`: send, edit, typing, `sendMessageDraft` streaming with a `Thinking…` start, forum topics (create, rename, close, reopen), HTML tables |
| `src/messenger/discord.ts` | `Discord`: send without pings, edit, typing, threads (start, rename, archive); gateway presence |
| `src/messenger/discord-commands.ts` | `DiscordCommands`: register guild `/quota` and `/status`, defer private replies, enforce owner access and format bounded results |
| `src/messenger/discord-inbound.ts` | Discord inbound polling over REST |
| `src/messenger/discord-supervisor.ts` | the supervisor's Discord gateway connection |
| `src/messenger/discord-lock.ts` | the token-scoped lock that keeps one gateway per user and machine |
| `src/messenger/typing.ts` | `Timers`: the interval timers seam (`realTimers` in production) |
| `src/messenger/voice.ts` | `transcribe`: voice note to text through your hook |
| `src/messenger/thread-ledger.ts` | `ThreadLedger`: every thread the Dori posts in, persisted; given to `Slack`, it records each `chat.postMessage` (also raw `call`s) |
| `src/messenger/slack-inbound.ts` | `pollSlackInbound`: threads view, ledger threads and unread counts, deduplicated, own messages filtered |
| `src/messenger/slack-presence.ts` | `slackPresence`: hold a user account active |
| `src/messenger/toodo.ts`, `toodo-mirror.ts`, `toodo-supervisor.ts` | the Toodo task mirror |
| `src/doctor.ts` | `runDoctor`: read-only checks (units, herdr, paths, config, Discord, gateway, tools, disk) as OK/WARN/FAIL with the fix; `doctorMain` prints it and returns the exit code |
| `src/status.ts` | `collectStatus` / `renderStatus`: the no-LLM one-screen summary behind `dori status` and `/status` |
| `src/gateway-status.ts` | the supervisor's `gateway-status.json` heartbeat in stateDir (written every loop, about 5 s); doctor and status read it |
| `src/claude-quota.ts` | `lookupQuotaResults(agentDir?)`: pi-quota through senpi's native auth storage (defaults to `~/.omo/agent`); `claudeUsage` and the usage report behind `dori quota` and `/quota`: Claude 5h/7d usage and reset times for every account |
| `src/routing.ts` | `canLaunch`, `idleLaneFor`: the routing checks |
| `src/repos.ts` | `Repos(stateDir)`: synchronous `list`, `add`, `remove`, `replace`; atomic machine-local GitHub watched list |
| `src/registry.ts`, `src/store.ts` | the lane registry and its store |
| `src/launch.ts`, `src/done-flow.ts` | launching lanes and the done flow |
| `src/lane-finish.ts` | `postOwnerLine`, which posts the supervisor's lead-status announcements |
| `src/freshness.ts`, `src/host-guard.ts`, `src/dead-panes.ts` | the sweeps behind `freshness`, `guard` and `dead-panes` |
| `src/pause.ts` | `pause` and `resume` |
| `src/inbox.ts` | the lead's event inbox (`dori inbox take`) |
| `src/supervise.ts` and `src/supervise-*.ts` | `dori supervise` and its loop, delivery and lead lifecycle |
| `src/cli.ts` | the `dori` command itself |

Every module takes its HTTP, clock and timers as arguments. That's how the tests run without the network.

## SKILL.md is a release artifact

Every Dori loads SKILL.md, so treat each change to it as a release. Batch wording edits into one commit rather than a trickle of small ones. Keep deployment-specific values (hostnames, pane ids, tokens, owner names) out of it; they belong in `~/.dori/config.json` or memory.
