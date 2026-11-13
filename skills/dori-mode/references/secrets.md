# Secrets

The secret store keeps tokens a lane needs (a registry token, a deploy key) on the supervisor host, at `~/.dori/secrets`. Lanes never see the files. A lane asks its runner for names it's allowed to have, and the values go only into the environment of the one command it runs.

The local runner reads the store itself. A remote runner (`dori runner serve --listen`) holds no store; it asks the supervisor, as described in [Remote runners](#remote-runners).

## Lead commands

| Command | What it does |
|---|---|
| `dori secret add NAME` | Stores a new secret. Fails with `SECRET_EXISTS` if the name is taken. |
| `dori secret update NAME` | Replaces a stored secret. Fails with `SECRET_MISSING` if it isn't there. |
| `dori secret list [--json]` | Prints names and backends (`systemd-creds` or `plain`), one per line or as JSON. Never values. |
| `dori secret delete NAME` | Removes the secret's file. |

`add` and `update` read the value from stdin only, never from argv. On a terminal you get a hidden prompt; otherwise all of stdin is taken, minus one trailing newline. An empty value is `SECRET_VALUE_EMPTY`. They print `SECRET_ADDED NAME backend=...` or `SECRET_UPDATED NAME backend=...`; `delete` prints `SECRET_DELETED NAME`.

```sh
printf %s "$TOKEN" | dori secret add NPM_TOKEN
```

There's no `get` or `show`, and no command prints a value. Running `dori secret exec` outside a lane exits 2 with `SECRET_EXEC_LANE_ONLY`.

A name matches `^[A-Z][A-Z0-9_]{0,63}$` (uppercase, digits, underscore, starting with a letter); anything else is `SECRET_NAME_INVALID`.

## Storage and encryption

Each secret is one file in `~/.dori/secrets` (mode 0700):

- `<NAME>.cred`: ciphertext from `systemd-creds --user encrypt`, mode 0600. The key is the host's user credential key, so the file can't be read on another machine or from a backup.
- `<NAME>.plain`: the raw value, mode 0600. Used only when `systemd-creds --user` isn't available. `add`/`update` then print `SECRET_PLAINTEXT_FALLBACK` to stderr, and `dori doctor` keeps a WARN on its `secret store` check until the entry is re-added with `dori secret update NAME` on a host where encryption works.

The backend is picked on every write, so `update` moves an entry from `.plain` to `.cred` once encryption works. If the directory exists with any group or other permission bit set, every store command refuses with `SECRET_DIR_UNSAFE` and changes nothing; fix it with `chmod 700 ~/.dori/secrets`. The doctor check also warns about files that aren't 0600 and about names in config `secrets` that aren't stored.

## Allowlist

Config `secrets` says which lanes may receive which name. A name missing from it is denied to every lane.

```json
"secrets": {
  "NPM_TOKEN": { "lanes": ["release-npm", "pub-*"], "repos": ["Dubusoft/dori-mode"] }
}
```

A lane may receive a name when any of these holds:

- its key equals an entry in `lanes`;
- an entry ends in `*` and the key starts with the part before it (`pub-*` matches `pub-docs`);
- `repos` lists the lane's repo. That's the `owner/repo` of the `origin` remote of the lane's worktree, compared case-insensitively. The lane can rewrite its own `origin` (`git remote set-url`), so a repo entry is weaker than a lane entry: use `lanes` for anything a lane of another repo must not get.

A rule may also carry `as` (`"env"`, the default, or `"ssh-key"`, see [Deploy keys](#deploy-keys)) or `mint` (see [Minted GitHub tokens](#minted-github-tokens)). The two can't be combined.

A request names one or more secrets, and it's all or nothing: if any one name is denied, the whole request is refused with `RUNNER_SECRET_DENIED` and no value is sent. The config is re-read on every request, so an edit takes effect without a restart.

## Lane usage

```sh
dori secret exec NPM_TOKEN -- npm publish
dori secret exec NPM_TOKEN GH_TOKEN -- ./release.sh
```

The lane CLI sends the names to the runner over the lane socket with the lane's token. On a grant it runs the command with the values added to its environment, under the secret names, and exits with the command's exit code. Values are never printed and never put in argv. A refusal prints `<code> <detail>` to stderr and exits 1; a usage error exits 2. Any other `dori secret` subcommand in a lane is `DORI_CLI_LANE_ONLY`.

A lane should pass the variable to the tool that needs it, not echo it, write it to a file or put it in a report. Keep the value itself off command lines too (for example `test "$NAME" = <value>`): argv shows in `ps`, shell history and the pane.

Every lane footer `dori launch` writes says this: credentials come only through `secret exec` and `secret run` (the runner's `~/.dori/runner/bin/dori` on a remote lane), production deploys only through `secret run`, the lane never reads or copies credential files or CLI logins, and a refusal is reported as `blocked` with the name or op so the lead can add the secret or its rule.

An `ssh-key` secret arrives as a file path instead of the key (see [Deploy keys](#deploy-keys)). A minted name looks like any other env secret to the lane.

For an operation the lane should never hold the credential for, it asks the host to run it instead:

```sh
dori secret run deploy-prod
```

See [Proxy execution](#proxy-execution). The lane gets the command's output and exit code; a refusal prints `<code> <detail>` to stderr and exits 1, and a missing, extra or malformed op prints `usage: dori secret run <op>` and exits 2.

## Minted GitHub tokens

A rule with `mint` doesn't hand out a stored value. The granting side mints a GitHub App installation token for the lane on every request:

```json
"secrets": {
  "GH_TOKEN": {
    "lanes": ["pub-*"],
    "mint": { "kind": "github-app", "appId": "123456", "installationId": "7890123", "keySecret": "GH_APP_KEY", "permissions": { "contents": "write", "pull_requests": "write" } }
  }
}
```

- `kind` is `"github-app"`, the only kind.
- `appId` and `installationId` are the App's ids, as non-empty strings.
- `keySecret` names a store secret holding the App's private key (PEM). Add it with `dori secret add GH_APP_KEY`. The key is read on the granting host to sign the request and is never sent to a lane; leave it out of every rule's reach so no lane can ask for it by name.
- `permissions` maps GitHub permission names (lowercase letters and `_`) to `"read"` or `"write"`. It can't be empty.

The token is restricted to the lane's repo, the `owner/repo` of its worktree's origin, and to those permissions. GitHub gives it a lifetime of about an hour, and nothing renews it: a lane that runs longer asks again. A lane with no repo is refused with `RUNNER_SECRET_DENIED`. A missing `keySecret` is `RUNNER_SECRET_MISSING`. When GitHub refuses or can't be reached the lane gets `RUNNER_SECRET_FAILED` with a detail starting `GITHUB_MINT_FAILED`; the detail never carries the private key, the signed JWT or a token.

The allowlist still decides first, as for any other name. The lane's repo is read from its origin, which the lane can rewrite, so a minted rule granted by `lanes` can still be pointed at another repo the App's installation covers. Install the App only on the repos its lanes should reach.

## Deploy keys

A rule with `"as": "ssh-key"` hands out an SSH private key as a file:

```json
"secrets": {
  "DEPLOY_KEY": { "lanes": ["pub-docs"], "as": "ssh-key" }
}
```

For `dori secret exec DEPLOY_KEY -- git push`, the lane CLI writes the key to a 0600 file in a fresh 0700 temp dir and sets `DEPLOY_KEY` to that file's path, not the key. When exactly one `ssh-key` name is in the request it also sets `GIT_SSH_COMMAND` to `ssh -i '<path>' -o IdentitiesOnly=yes -o IdentityAgent=none`, so git uses that key and nothing from the agent. With two or more, the lane passes the paths to ssh itself. The temp dir is removed when the command exits.

For git-only access, prefer a per-repo deploy key over a personal token: it reaches one repo, it can be read-only, and it can't call the GitHub API.

This works the same on remote runners: the sealed `secret.value` carries the `ssh-key` kind, and the remote runner passes it on to its lane.

## Proxy execution

Config `secretCommands` names operations the supervisor host runs for a lane, with secrets the lane never receives:

```json
"secretCommands": {
  "deploy-prod": { "argv": ["/usr/local/bin/deploy", "prod"], "secrets": ["PROD_DEPLOY_TOKEN"], "lanes": ["release-*"], "repos": [], "timeoutSec": 600, "cwd": "/srv/deploy" }
}
```

- The op name matches `^[a-z][a-z0-9-]{0,63}$`.
- `argv` is the command, non-empty strings, run without a shell.
- `secrets` lists store names (or minted names, see below) put in the command's environment.
- `lanes` and `repos` decide which lanes may run it, with the same matching as config `secrets`. The secrets themselves need no `secrets` rule of their own: the op's rule is the only check.
- `timeoutSec` is 1 to 3600, default 300.
- `cwd` is an absolute path; without it the command runs in the host user's home.

A lane runs `dori secret run <op>`. The command runs on the supervisor host, outside every lane and sandbox, also for a lane on a remote runner (its request goes to the supervisor as a sealed `secret.run` control frame). Its environment is only `PATH`, `HOME`, `LANG` and `TMPDIR` (those set on the host) plus its secrets, and stdin is closed. A secret whose `secrets` rule has `mint` is minted for the lane's repo, as in [Minted GitHub tokens](#minted-github-tokens).

The lane sees only the exit code and the output. Each of stdout and stderr keeps its first 64 KiB, and the lane CLI adds `dori: <op> output was truncated at 64 KiB per stream` when either was cut. Every secret value in the output becomes `[REDACTED:<NAME>]`, including a value cut off at the end of truncated output, and then the usual masking runs. A command still running after `timeoutSec` is killed and exits 124, with `dori: <op> killed after <n>s (timeoutSec)` on stderr.

The runner log (the supervisor's for a remote runner, tagged `runner=<label>`) gets `RUNNER_SECRET_RUN lane=<key> op=<op> exit=<n>`, or `RUNNER_SECRET_DENIED lane=<key> op=<op> code=<code>` for a refusal. An unknown op or a lane the op doesn't allow is `RUNNER_SECRET_DENIED`, and a command that can't start is `RUNNER_SECRET_FAILED`.

Use this for the most sensitive operational credentials: production deploys, cloud admin keys, anything a lane shouldn't hold even for one command. The lane can still choose when to run the op, so keep the op narrow (a fixed argv, not a shell that takes input) and its output free of anything you wouldn't show the lane.

## Remote runners

A remote runner sends the lane's request to the supervisor as a `secret.get` control frame: the lane key, the names, and the lane's repo read from the origin of its worktree. The supervisor answers with a `secret.value` control frame. Control frames are never journaled and never queued in the outbox, so a request made while the link is down fails instead of waiting.

On a grant the values travel only inside a sealed box. Each direction gets its own key, derived with HKDF-SHA256 from the session key of the authenticated link, and the box is AES-256-GCM. It's bound to the runner, gen, epoch, frame type and request id, so it won't open if it's moved to another frame. The runner opens it, checks it carries exactly the names it asked for, registers the values for masking and hands them to the lane.

Each side checks different things:

- The runner checks the lane's token on the lane socket, as the local runner does.
- The supervisor decides with its own registry, config and store. It refuses a link that isn't authenticated, refuses a lane that isn't open or isn't owned by the asking runner, and refuses every lane of a runner with `runners.<label>.allowUnsandboxed` set. It then applies the allowlist and writes the audit line to its own `<stateDir>/secret-audit.jsonl`, with the runner's label in `runner`.

A request for a lane the runner doesn't own also logs `RUNNER_FORGED_SECRET runner=<label> key=<key>` in the supervisor log. An honest runner never sends one, so treat it as a sign the runner host is compromised.

Remote secrets need protocol 6 on both sides. Upgrade the supervisor first: it still accepts protocol 5 runners. An old runner keeps answering its lanes `RUNNER_SECRET_UNSUPPORTED` and never receives a value. When either side speaks a protocol older than 6, the lane gets `RUNNER_SECRET_OUTDATED`. With no answer in 30 seconds the lane gets `RUNNER_SECRET_TIMEOUT`. `dori secret run` waits longer: the op runs on the supervisor host until its `timeoutSec` (at most 3600 seconds), so the runner waits 3660 seconds before it gives up.

## Audit log

The granting side appends one JSON line per request to `<stateDir>/secret-audit.jsonl` (mode 0600). That's the local runner's state dir, or the supervisor's for a remote runner:

```json
{"at":"2026-11-11T07:00:00.000Z","runner":"local","lane":"release-npm","names":["NPM_TOKEN"],"allowed":true}
```

Fields: `at`, `runner`, `lane`, `names`, `allowed`, `minted` (names whose value was a minted token, only when there are any), and on a refusal `reason` (`not allowed: A,B`, `missing: A`, `read failed: A`, `no repo: A` or `mint failed: A`). A `dori secret run` line has `op` instead of `reason`, `names` is the op's secrets (empty for an unknown op), and `exitCode` is set when the command ran. No value or hash of one is ever written. A failed write logs `RUNNER_SECRET_AUDIT_FAILED <path>: ...` and doesn't block the grant. The runner log also gets `RUNNER_SECRET_GRANTED lane=<key> names=<A,B>`, or `RUNNER_SECRET_DENIED` for any refusal.

## Masking

Stored values are registered with dori's output masking, so a value that turns up in text dori posts, logs or journals is masked. The supervisor loads all store values at start and reloads them when `~/.dori/secrets` changes (`SECRET_STORE_WATCH_FAILED` if that fails). The local runner loads them at start and adds each value it grants. Values shorter than 8 characters aren't masked. Masking is a safety net for accidents, not a guarantee: a value that's been transformed (encoded, split) won't match.

## Error codes

| Code | Meaning |
|---|---|
| `SECRET_NAME_INVALID` | The name doesn't match the name rule. |
| `SECRET_EXISTS` | `add` of a name that's already stored. |
| `SECRET_MISSING` | `update`, `delete` or a read of a name that isn't stored. |
| `SECRET_VALUE_EMPTY` | Empty value on `add` or `update`. |
| `SECRET_ENCRYPT_FAILED` / `SECRET_DECRYPT_FAILED` | `systemd-creds --user` failed. |
| `SECRET_DIR_UNSAFE` | `~/.dori/secrets` has group or other permission bits. |
| `SECRET_EXEC_LANE_ONLY` | `dori secret exec` run outside a lane. |
| `RUNNER_SECRET_UNSUPPORTED` | The lane's runner doesn't hand out secrets (a remote runner older than protocol 6), or the link to the supervisor isn't authenticated. |
| `RUNNER_SECRET_OUTDATED` | The runner or the supervisor speaks a protocol older than 6. |
| `RUNNER_SECRET_TIMEOUT` | A remote runner got no answer from the supervisor within 30 seconds (3660 seconds for `dori secret run`). |
| `RUNNER_SECRET_DENIED` | At least one name isn't allowed for this lane by config `secrets`, a minted name was asked for by a lane with no repo, or `dori secret run` named an op that isn't configured or doesn't allow this lane. |
| `RUNNER_SECRET_MISSING` | A name is allowed but not in the store, or a mint rule's `keySecret` isn't. |
| `RUNNER_SECRET_FAILED` | Reading the store or the config failed, a mint failed (detail `GITHUB_MINT_FAILED ...`), a secret command couldn't start, or a remote runner lost its connection or got a reply it couldn't open. |
| `RUNNER_LANE_BAD_REQUEST` | The request had no names, more than 32, duplicates or an invalid name, or an op that doesn't match the op rule. |
| `RUNNER_LANE_AUTH_FAILED` | The token isn't that lane's own. |

## Lane sandbox hiding

Both lane sandbox scripts hide dori's own sensitive paths, `~/.dori/env` and `~/.dori/secrets`, by default. No file or setting is needed. On Linux `~/.dori` is a fresh tmpfs inside the sandbox with nothing bound from the host below it; on macOS the profile denies reads, writes and socket connects under both paths.

`~/.dori/lane-sandbox-hide` is an optional per-machine list for paths unrelated to dori, such as `~/.secrets`: one host path per line, `#` starts a comment. Don't list `~/.dori/env` or `~/.dori/secrets` there; they're already covered.

## Protection scope

What the store does:

- Keeps values out of journals, the runner's `state.sqlite` and `outbox.sqlite`, lane start bodies (briefs) and every file a lane can see. The `secret` reply goes straight from the runner to the asking lane, and on a remote runner the supervisor's `secret.value` is a sealed control frame. Neither is ever journaled or queued in the outbox.
- Keeps disk and backup copies of `.cred` files useless without the host's credential key.
- With `mint`, hands a lane a token that reaches one repo with the listed permissions and expires in about an hour, while the App key stays on the granting host.
- With `secretCommands`, keeps a credential out of every lane: the lane gets redacted, capped output and an exit code.

What it doesn't do:

- It doesn't protect against processes running as the same user outside the lane sandbox. The lead shell, an unsandboxed lane (Windows runners, for example) or anything else running as that user can read `~/.dori/secrets` or run `systemd-creds decrypt --user` itself.
- It can't stop a lane that received a value from printing it or sending it somewhere. Treat a granted value as disclosed to that lane, and grant it only to lanes you'd trust with it.
- `.plain` entries are only as safe as their 0600 mode.
- A minted token is as good as a stored one for its hour. Revoking it early is up to GitHub.
- A deploy key file sits in the temp dir for as long as the command runs, readable by that user.
- A proxy command does whatever its argv does whenever an allowed lane asks. Output redaction catches the values verbatim only; a command that prints a transformed value leaks it.
