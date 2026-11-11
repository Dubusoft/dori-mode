# Browser fill

A lane can log into a web page without ever seeing the password. It asks for an opaque one-time secret handle, passes that handle to the browser skill's fill, and the runner's per-lane browser proxy swaps it for the real value on the way to the daemon. The value goes from the granting side to the proxy and then into the page. The lane never sees it.

The granting side is the one that holds the secret store: the local runner for local lanes, or the supervisor for a remote runner's lanes (see [secrets.md](secrets.md#remote-runners)).

## Lane usage

```sh
h=$(dori secret handle SITE_PASSWORD)
```

Then fill the password field with the handle through the browser skill, exactly as you'd fill any field:

```js
fill("#password", h)
```

There's nothing to configure in the lane. The runner launches every lane with `BSK_HOME` pointing at that lane's proxy, so the browser client talks to the proxy without knowing it.

`dori secret handle NAME` prints the handle and a newline on stdout and exits 0. A refusal prints `<code> <detail>` on stderr and exits 1, and bad usage prints `usage: dori secret handle NAME` and exits 2. A runner without browser proxies (Windows, or a host with no `~/.bsk`) answers `RUNNER_SECRET_UNSUPPORTED`.

The fill's value must be the handle and nothing else. Use a CSS selector as the target. The proxy refuses `tab_id` and `ref` targets for a secret fill.

## Config

A secret becomes browser-fillable when its rule lists `origins`:

```json
"secrets": {
  "SITE_PASSWORD": { "lanes": ["qa-*"], "origins": ["https://login.example.com"] }
}
```

- `lanes` and `repos` decide which lanes may get a handle, with the same matching as every other rule.
- `origins` is a non-empty list of page origins, each exactly `new URL(entry).origin` with `http` or `https`: scheme, host and a port only when it isn't the default, no path and no trailing slash.
- It can't be combined with `"as": "ssh-key"` or `mint`.

A rule with `origins` is browser-proxy-only. `dori secret exec` and `dori secret run` refuse it with `RUNNER_SECRET_BROWSER_ONLY`, so the lane can't get the value as an environment variable. Rules without `origins` behave exactly as before.

## Handle lifetime

A handle is `dsh_` followed by 43 base64url characters, from 32 random bytes (`SECRET_HANDLE_PATTERN`). The granting side keeps it in memory only, bound to:

- the lane that asked for it;
- the secret name;
- the rule's `origins` at issue time;
- an expiry 5 minutes after issue (`SECRET_HANDLE_TTL_MS`);
- a used flag.

A handle is single use. The first exchange attempt consumes it, whatever the outcome: a refused fill burns the handle too, so ask for a new one. A lane can hold at most 16 unused, unexpired handles (`SECRET_HANDLE_CAP`). A restart of the granting side forgets every handle.

At issue the granting side checks the lane against `lanes`/`repos` and refuses a rule with no `origins`. It reads no value then. At exchange it reads the config again, so a rule removed or narrowed since issue wins.

A lane token can never exchange a handle. The lane socket has no exchange verb, and an unknown verb is refused with `RUNNER_LANE_BAD_REQUEST`. Only the proxy, which runs in the runner process outside the sandbox, asks for an exchange, and it always names its own lane.

## What the proxy checks

For each `tool.fill` whose value matches the handle pattern, the proxy:

1. checks the target is a non-empty CSS `selector` without `tab_id` or `ref`;
2. syncs with the daemon (`tool.cooperate` sync) and runs its own `tool.evaluate` to read the page origin, whether it's the top frame, and whether the selector names an `input` whose `type` is `password`;
3. asks the granting side to exchange the handle, sending its own lane key, the handle and the page origin;
4. on a grant, syncs again and forwards the fill with the value in place of the handle.

The exchange succeeds only when the handle exists, isn't expired, isn't used, was issued to the proxy's lane, the rule still allows that lane, and the origin is in both the bound origins and the current rule's origins.

Any other request is forwarded unchanged, after one check: a handle anywhere else in a request (in another method, inside a longer value, in a selector, behind JSON escapes) is refused.

### Refusals

A refusal is `{"id", "error": {"code": "permission_denied", "message", "data": {"reason", "effect_state": "none"}}}`. The reasons:

| Reason | When |
|---|---|
| `secret_handle_misuse` | A handle appears anywhere but as the whole value of a fill. |
| `secret_target_unsupported` | A secret fill with no CSS selector, or with `tab_id` or `ref`. |
| `secret_target_not_password` | The target isn't a top-frame password input, or the page check gave no answer. The handle isn't exchanged, so it stays usable. |
| `secret_origin_not_allowed` | The granting side refused with `RUNNER_SECRET_DENIED`: unknown, expired, used, wrong lane, rule gone or origin not allowed. |
| `secret_unavailable` | Any other refusal (a missing secret, a failed read) or a failed exchange call. |
| `secret_tainted_session` | `tool.evaluate` after a secret fill, until `session.stop`. |
| `bad_request` | The request line isn't a JSON object. |

The granting side's audit says which case it was. The lane only gets the proxy's reason.

A daemon that's missing or unreachable gives `error.code` `daemon_unavailable`.

## Redaction and the tainted session

Once a fill has put a value in the page, the proxy redacts it from every reply line it sends the lane, for the rest of the proxy's life. It replaces each of these forms with `[REDACTED]`: the literal value, its JSON-escaped form, base64 (unpadded), base64url, lower and upper hex, and `encodeURIComponent`.

After a secret fill the session is tainted: `tool.evaluate` is refused with `secret_tainted_session`, because a script could read the field. A successful `session.stop` clears the taint.

## Logs and audit

The proxy writes one line per request to the runner log, and never a selector, value, handle, param or reply:

```
RUNNER_BROWSER lane=<key> method=<method> decision=<forward|allow|refuse:<reason>>[ origin=<origin>]
```

A proxy that fails to start logs `RUNNER_BROWSER_PROXY_FAILED lane=<key> <message>`, and the lane launches anyway without it.

The granting side writes one audit line per issue and per exchange to `<stateDir>/secret-audit.jsonl`, with `kind` set to `handle.issue` or `handle.exchange`, `handleId` (the first 12 hex chars of the handle's sha256, to match an issue with its exchange), and on an exchange the page `origin`. Refusal reasons are `unknown`, `expired`, `used`, `wrong lane`, `rule gone` and `origin not allowed` for an exchange, and `not allowed: NAME`, `no origins: NAME` and `too many handles` for an issue. See [Audit log](secrets.md#audit-log). No line ever carries a value or a full handle.

## Where the sockets live

| Path | Mode | What |
|---|---|---|
| `~/.dori/runner/browser/` | 0700 | one directory per lane |
| `~/.dori/runner/browser/<key>/` | 0700 | the lane's `BSK_HOME` |
| `~/.dori/runner/browser/<key>/daemon.sock` | 0600 | the proxy's socket |
| `~/.dori/runner/browser/<key>/daemon.json` | 0600 | `{"pid":<runner pid>,"sock_path":"<that socket>","ws_port":0,"version":"dori-browser-proxy"}` |
| `~/.bsk/` (or the host's `BSK_HOME`) | | the real BrowserSkill daemon, which the proxy dials per call |

The runner launches the lane with `BSK_HOME=<runnerDir>/browser/<key>` and `LANE_SANDBOX_BSK_HOME=<real bsk home>`. The proxy starts before the lane's pane command and stops (removing its directory) when the lane closes. PowerShell lanes get neither.

## Sandbox

On macOS, the Seatbelt profile:

- denies reads, writes and unix-socket connects under the real daemon's home (`LANE_SANDBOX_BSK_HOME`, else `~/.bsk`);
- denies TCP connects to `localhost:<ws_port>` when that home's `daemon.json` has a valid `ws_port`;
- allows reads of the lane's own `~/.dori/runner/browser/<key>` and connects to its `daemon.sock`, and no other lane's.

On Linux, bubblewrap gives the lane a fresh tmpfs `$HOME`, so `~/.bsk` and its socket don't exist inside the sandbox. Only the lane's own proxy directory is bound, read-only.

## Residual risks

- **Check-then-fill race.** The proxy checks the origin and the field type, then fills. A page that navigates or swaps the field between the two can receive the value on another origin or in another field.
- **Page scripts.** Once the value is in the page, the page's own scripts can read, copy or transform it. Redaction only catches the encodings listed above, so a value the page hashes, splits or re-encodes and shows the lane gets through.
- **The ws_port is read once.** The macOS sandbox reads the daemon's `ws_port` when the lane starts. A daemon restarted on a new port is reachable until the lane restarts.
- **Linux can't refuse the ws_port.** Without a network namespace the daemon's TCP port on 127.0.0.1 stays reachable from a Linux lane, so a lane that knows the port can drive the daemon directly and skip the proxy.
- **A handle in the transcript.** A handle the lane prints sits in its transcript. Only that lane's proxy can use it, within its 5 minutes, on the allowed origins, and only once.
- **Browser storage.** The browser may offer to save the password, autofill it later or keep it in its profile. Keep password saving off in the profile the daemon uses.
