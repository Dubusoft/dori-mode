# Secrets

The secret store is a plain sharing channel from the supervisor host to every lane. It lives on the supervisor host at `~/.dori/secrets`, and every lane gets every stored value in its environment when it starts. There's no allowlist and nobody is asked.

## Storage

Each secret is one file in `~/.dori/secrets` (mode 0700). Writes always produce `<NAME>.plain`, the raw value with mode 0600.

A legacy `<NAME>.cred` (ciphertext from `systemd-creds --user encrypt`, written by older versions) is still read, decrypted with `systemd-creds --user`, so existing entries keep working without a migration. Updating a `.cred` name writes `<NAME>.plain` and removes the `.cred`; when both files exist (an update stopped before the removal), the `.plain` value is the one read and listed.

If the directory has any group or other permission bit set, every store command refuses with `SECRET_DIR_UNSAFE` and changes nothing. Fix it with `chmod 700 ~/.dori/secrets`.

A name matches `^[A-Z][A-Z0-9_]{0,63}$` (uppercase, digits, underscore, starting with a letter); anything else is `SECRET_NAME_INVALID`.

## Host commands

| Command | What it does |
|---|---|
| `dori secret add NAME` | Stores a new secret. Fails with `SECRET_EXISTS` if the name is taken. |
| `dori secret update NAME` | Replaces a stored secret. Fails with `SECRET_MISSING` if it isn't there. |
| `dori secret list [--json]` | Prints names and backends (`plain` or `cred`). Never values. |
| `dori secret delete NAME` | Removes the secret's file. |

`add` and `update` read the value from stdin only, never from argv. On a terminal you get a hidden prompt; otherwise all of stdin is taken, minus one trailing newline. An empty value is `SECRET_VALUE_EMPTY`. A value shorter than 8 characters is stored but not masked in outbound text, and they warn `SECRET_NOT_MASKED NAME` on stderr. They print `SECRET_ADDED NAME backend=plain` or `SECRET_UPDATED NAME backend=plain`; `delete` prints `SECRET_DELETED NAME`.

```sh
printf %s "$TOKEN" | dori secret add NPM_TOKEN
```

There's no `get` or `show`, and no host command prints a value.

## How lanes get values

A lane's pane command exports its `DORI_LANE_*` variables, then runs `eval "$(<dori> secret env)"`, then the agent. `<dori>` is the lane CLI the footer points at: `dori` from PATH on the supervisor host, `~/.dori/runner/bin/dori` on a remote runner. The agent and every shell it spawns inherit every stored value under its name.

`dori secret env` works only inside a lane. It asks the runner over the lane socket with the lane's token, and prints one line per value:

```sh
export NPM_TOKEN='...'
```

Single quotes in a value are written as `'\''`, so multi-line values survive. On a refusal or failure it prints `<code> <detail>` to stderr, nothing on stdout, and exits 1. The lane still starts, just without values, and the error shows in the pane. It is only for `eval "$(...)"`: with stdout on a terminal it asks the runner nothing, prints `SECRET_ENV_TTY_REFUSED <detail>` to stderr and exits 2, so a hand-typed `dori secret env` never puts values in pane scrollback or logs.

- **Local runner:** reads its own store.
- **Remote runner** (`dori runner serve --listen`): holds no store. It sends a sealed `secret.get` control frame with an empty names list, and the supervisor answers with every store value in a sealed `secret.value`. The supervisor refuses a link that isn't authenticated, a lane that isn't open or isn't owned by that runner (logged as `RUNNER_FORGED_SECRET runner=<label> key=<key>`, a sign the runner host is compromised), and every lane of a runner with `runners.<label>.allowUnsandboxed`. An older runner that still sends names gets just those names.

Control frames are never journaled or queued in the outbox, so a request made while the link is down fails instead of waiting. Values never land on a command line, in a brief, journal, outbox or any file.

The PowerShell (Windows) launch path gets no secrets.

## GitHub access in lanes

Store a token as `GH_TOKEN` (`dori secret add GH_TOKEN`). Both `gh` and gh's git credential helper read it from the environment, so a lane just runs:

```sh
gh pr view 12
git push https://github.com/<owner>/<repo>.git HEAD:refs/heads/<branch>
```

The push names the https URL: an ssh remote doesn't use `GH_TOKEN`. gh's `~/.config/gh/hosts.yml` and `~/.npmrc` stay hidden from lanes; a registry token goes in the store as `NPM_TOKEN` instead.

## Proxy execution

Config `secretCommands` names operations the supervisor host runs for a lane. Production deploys and host work go only through these:

```json
"secretCommands": {
  "deploy-prod": { "argv": ["/usr/local/bin/deploy", "prod"], "secrets": ["PROD_DEPLOY_TOKEN"], "lanes": ["release-*"], "repos": [], "timeoutSec": 600, "cwd": "/srv/deploy" }
}
```

- The op name matches `^[a-z][a-z0-9-]{0,63}$`.
- `argv` is the command, non-empty strings, run without a shell.
- `secrets` lists store names put in the command's environment. It may be empty or left out.
- `lanes` and `repos` decide which lanes may run it: a lane key, a `prefix-*` pattern, or the `owner/repo` of the lane's origin (which the lane can rewrite, so prefer `lanes`).
- `timeoutSec` is 1 to 3600, default 300. `cwd` is an absolute path; without it the command runs in the host user's home.

A lane runs `dori secret run <op>`, or its alias `dori host <op>`. The command runs on the supervisor host, outside every sandbox, also for a remote lane (sent as a sealed `secret.run` frame). Its environment is only `PATH`, `HOME`, `LANG`, `TMPDIR`, `XDG_RUNTIME_DIR`, `DORI_LANE_KEY` and its secrets, and stdin is closed.

The lane sees the exit code and the output: the first 64 KiB of each stream, with `dori: <op> output was truncated at 64 KiB per stream` when cut. Every secret value in the output becomes `[REDACTED:<NAME>]`. A command still running after `timeoutSec` is killed and exits 124. The runner log gets `RUNNER_SECRET_RUN lane=<key> op=<op> exit=<n>`, or `RUNNER_SECRET_DENIED` with a detail ending `ops this lane may run: <op, ...>`. A missing, extra or malformed op prints `usage: dori secret run <op>` and exits 2.

An op with no `secrets` is a host command: work the sandbox blocks, such as a sandbox probe or `systemctl --user daemon-reload`.

```json
"secretCommands": {
  "probe-sandbox": { "argv": ["/home/me/.dori/ops/probe-sandbox.sh"], "lanes": ["*"], "timeoutSec": 120 }
}
```

It still runs unsandboxed as the host user. Never register one that runs a file a lane can write; keep scripts under a path like `~/.dori/ops`.

### Worker host commands

Work that has to happen on the worker a lane runs on (a Mac's keychain, a TestFlight upload) goes in that worker's `~/.dori/runner/runner-config.json` `hostCommands`, which the owner edits and lanes cannot write:

```json
"hostCommands": {
  "probe-sandbox": { "argv": ["/Users/me/.dori/ops/probe-sandbox.sh"], "lanes": ["*"], "timeoutSec": 120 }
}
```

The shape is `secretCommands` without `secrets`: a worker op gets no store value. `dori host <op>` (or `dori secret run <op>`) in a lane on that worker runs a listed op on the worker itself, outside the lane sandbox, with the same environment, output cap, redaction, timeout and lane/repo check as above; a refusal names `runner-config hostCommands`. Any other op goes to the supervisor's `secretCommands` as before, and when the supervisor refuses it the detail's `ops this lane may run` list includes the worker's ops too. A name in both tables runs on the worker. The local runner ignores `hostCommands`: `secretCommands` already run on its host. Production deploy credentials stay in `secretCommands`.

## Masking

Stored values are registered with dori's output masking. The supervisor loads all of them at start and reloads when `~/.dori/secrets` changes (`SECRET_STORE_WATCH_FAILED` if that fails); runners load them at start and add each value they hand out. Values shorter than 8 characters aren't masked. Masking is a safety net: a transformed value (encoded, split) won't match.

## Lane sandbox hiding

Both lane sandbox scripts hide `~/.dori/secrets` (and `~/.dori/env`, `~/.dori/state`, other lanes' runner entries, `~/.ssh` keys, gh's `hosts.yml`, `~/.npmrc` and the shared credential list `CREDENTIAL_DENY` in `scripts/src/lane-sandbox-install.ts`). A lane gets values only through its environment. `~/.dori/lane-sandbox-hide` lists extra host paths to hide, one per line, globs allowed. `lane-sandbox --explain` prints the exact table.

## Error codes

| Code | Meaning |
|---|---|
| `SECRET_NAME_INVALID` | The name doesn't match the name rule. |
| `SECRET_EXISTS` | `add` of a name that's already stored. |
| `SECRET_MISSING` | `update`, `delete` or a read of a name that isn't stored. |
| `SECRET_VALUE_EMPTY` | Empty value on `add` or `update`. |
| `SECRET_DECRYPT_FAILED` | `systemd-creds --user` couldn't decrypt a legacy `.cred`. |
| `SECRET_DIR_UNSAFE` | `~/.dori/secrets` has group or other permission bits. |
| `RUNNER_SECRET_UNSUPPORTED` | The runner doesn't hand out secrets, or the link to the supervisor isn't authenticated. |
| `RUNNER_SECRET_OUTDATED` | The runner or the supervisor speaks a protocol older than 6. |
| `RUNNER_SECRET_TIMEOUT` | No answer from the supervisor within 30 seconds (3660 for `dori secret run`). |
| `RUNNER_SECRET_DENIED` | The supervisor refused the lane, or `dori secret run` named an op that isn't configured or doesn't allow this lane. |
| `RUNNER_SECRET_MISSING` | A `secretCommands` op names a secret that isn't in the store. |
| `RUNNER_SECRET_FAILED` | Reading the store failed, a secret command couldn't start, or the link dropped or a reply wouldn't open. |
| `RUNNER_LANE_BAD_REQUEST` | Malformed request or op name. |
| `RUNNER_LANE_AUTH_FAILED` | The token isn't that lane's own. |

## Protection scope

- Every lane receives every stored value. Store only what you're fine with every lane holding.
- `.plain` files are only as safe as their 0600 mode. Anything running as the host user outside the sandbox can read them.
- A lane can print or send a value anywhere. Treat stored values as disclosed to every lane.
- Values stay out of journals, `state.sqlite`, `outbox.sqlite`, briefs, command lines and files lanes can see, and cross the runner link only sealed.
- An op's `secrets` are store names, so lanes hold those values too. What `secretCommands` adds is a fixed command on the host: keep it narrow and its output free of anything you wouldn't show a lane.
