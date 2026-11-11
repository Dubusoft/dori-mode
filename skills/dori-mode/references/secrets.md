# Secrets

The secret store keeps tokens a lane needs (a registry token, a deploy key) on the supervisor host, at `~/.dori/secrets`. Lanes never see the files. A lane asks its runner for names it's allowed to have, and the values go only into the environment of the one command it runs.

In this phase only the local runner hands out secrets. A remote runner (`dori runner serve --listen`) answers every `secret` request with `RUNNER_SECRET_UNSUPPORTED`.

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

A request names one or more secrets, and it's all or nothing: if any one name is denied, the whole request is refused with `RUNNER_SECRET_DENIED` and no value is sent. The config is re-read on every request, so an edit takes effect without a restart.

## Lane usage

```sh
dori secret exec NPM_TOKEN -- npm publish
dori secret exec NPM_TOKEN GH_TOKEN -- ./release.sh
```

The lane CLI sends the names to the runner over the lane socket with the lane's token. On a grant it runs the command with the values added to its environment, under the secret names, and exits with the command's exit code. Values are never printed and never put in argv. A refusal prints `<code> <detail>` to stderr and exits 1; a usage error exits 2. Any other `dori secret` subcommand in a lane is `DORI_CLI_LANE_ONLY`.

A lane should pass the variable to the tool that needs it, not echo it, write it to a file or put it in a report. Keep the value itself off command lines too (for example `test "$NAME" = <value>`): argv shows in `ps`, shell history and the pane.

## Audit log

The runner appends one JSON line per request to `<stateDir>/secret-audit.jsonl` (mode 0600):

```json
{"at":"2026-11-11T07:00:00.000Z","runner":"local","lane":"release-npm","names":["NPM_TOKEN"],"allowed":true}
```

Fields: `at`, `runner`, `lane`, `names`, `allowed`, and on a refusal `reason` (`not allowed: A,B`, `missing: A` or `read failed: A`). No value or hash of one is ever written. A failed write logs `RUNNER_SECRET_AUDIT_FAILED <path>: ...` and doesn't block the grant. The runner log also gets `RUNNER_SECRET_GRANTED lane=<key> names=<A,B>`, or `RUNNER_SECRET_DENIED` for any refusal.

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
| `RUNNER_SECRET_UNSUPPORTED` | The lane's runner doesn't hand out secrets (every remote runner, for now). |
| `RUNNER_SECRET_DENIED` | At least one name isn't allowed for this lane by config `secrets`. |
| `RUNNER_SECRET_MISSING` | A name is allowed but not in the store. |
| `RUNNER_SECRET_FAILED` | Reading the store or the config failed. |
| `RUNNER_LANE_BAD_REQUEST` | The request had no names, more than 32, duplicates or an invalid name. |
| `RUNNER_LANE_AUTH_FAILED` | The token isn't that lane's own. |

## Lane sandbox hiding

Both lane sandbox scripts hide dori's own sensitive paths, `~/.dori/env` and `~/.dori/secrets`, by default. No file or setting is needed. On Linux `~/.dori` is a fresh tmpfs inside the sandbox with nothing bound from the host below it; on macOS the profile denies reads, writes and socket connects under both paths.

`~/.dori/lane-sandbox-hide` is an optional per-machine list for paths unrelated to dori, such as `~/.secrets`: one host path per line, `#` starts a comment. Don't list `~/.dori/env` or `~/.dori/secrets` there; they're already covered.

## Protection scope

What the store does:

- Keeps values out of journals, the runner's `state.sqlite` and `outbox.sqlite`, lane start bodies (briefs) and every file a lane can see. The `secret` reply goes straight from the runner to the asking lane and is never journaled or queued in the outbox.
- Keeps disk and backup copies of `.cred` files useless without the host's credential key.

What it doesn't do:

- It doesn't protect against processes running as the same user outside the lane sandbox. The lead shell, an unsandboxed lane (Windows runners, for example) or anything else running as that user can read `~/.dori/secrets` or run `systemd-creds decrypt --user` itself.
- It can't stop a lane that received a value from printing it or sending it somewhere. Treat a granted value as disclosed to that lane, and grant it only to lanes you'd trust with it.
- `.plain` entries are only as safe as their 0600 mode.
