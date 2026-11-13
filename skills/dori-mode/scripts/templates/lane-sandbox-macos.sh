#!/usr/bin/env bash
# lane-sandbox (macOS): run a dori lane agent command inside a Seatbelt sandbox (sandbox-exec).
# Usage: lane-sandbox <cmd> [args...] | lane-sandbox --check
# Same inputs as the Linux (bubblewrap) lane-sandbox. Passthrough (no sandbox) only when DORI_LANE_KEY is empty/unset:
# the lead runs outside the sandbox. Host paths come from the environment, colon-separated:
#   LANE_SANDBOX_RW      extra writable directories (e.g. your worktree root, a scratch dir)
#   LANE_SANDBOX_NO_CWD  directories too broad to make writable as the cwd (e.g. the parents of the worktree root)
#   DORI_LANE_TOKEN_FILE the lane's own token file, readable
#   LANE_SANDBOX_WORKTREES the runner's lane worktree root, made writable (the runner sets it from its policy)
#   LANE_SANDBOX_REPOS   the runner's repos root: the .git directory of each repo directly under it is made writable
#                        (hooks excluded), so a lane can fetch there and `git worktree add` into the worktree root
#
# Seatbelt cannot hide or remap paths the way bubblewrap does; it only refuses access (EPERM). So the profile allows
# reads almost everywhere and refuses writes by default, with a whitelist: the cwd (worktree) and its git common dir,
# the runner's worktree root and the .git directories of the repos under its repos root,
# the lane's own TMPDIR, ~/.omo, ~/.cache, ~/.dori/state, ~/.dori/heavy, package caches, Xcode's per-user dirs, /tmp,
# Claude Code's lock dir, the user's login keychain file (and its atomic-write temp copies) and the terminal and null
# devices. Reads of ~/.dori are refused except what a lane needs (config, dori itself, the runner's lane socket and bin,
# its own brief and token), and ~/.dori/env, ~/.dori/secrets and ~/.ssh private keys are refused outright. Of ~/.config only gh and git
# are readable. A unix socket connect is not a file read to Seatbelt, so sockets get their own rules: none under ~/.dori
# but the lane socket (sock/lane.d/lane) and the lane's own herdr report socket (sock/herdr.d/<key>/herdr, which
# HERDR_SOCKET_PATH names), none under ~/.config but the ssh agent's when SSH_AUTH_SOCK lives there.
# Host paths outside ~/.dori listed one per line in ~/.dori/lane-sandbox-hide ('#' starts a comment; the lead owns that file) are
# refused outright, reads, writes and socket connects alike, over every rule above. Every path is resolved first
# (macOS /var and /tmp are symlinks into /private) and reaches the profile as a -D parameter, never as profile text.
# macOS ships bash 3.2: no ${x,,}, no {fd} redirections, and no empty "${array[@]}" under set -u.
set -eu

SBX=/usr/bin/sandbox-exec
# macOS's own OpenSSL-format root bundle (what curl and git use by default).
CERTS=/etc/ssl/cert.pem

# The real path of $1, which need not exist (a missing tail is appended to its nearest existing parent).
canon() {
  local p=$1 d b t
  if [ -d "$p" ]; then
    (cd "$p" && pwd -P)
    return
  fi
  d=$(dirname "$p")
  b=$(basename "$p")
  if [ -L "$p" ]; then
    t=$(readlink "$p")
    case "$t" in /*) canon "$t" ;; *) canon "$d/$t" ;; esac
    return
  fi
  d=$(canon "$d") || return 1
  if [ "$d" = / ]; then printf '/%s\n' "$b"; else printf '%s/%s\n' "$d" "$b"; fi
}

# $1's parent resolved, its last component kept: the path a symlink is reached by.
canon_parent() { printf '%s/%s\n' "$(canon "$(dirname "$1")")" "$(basename "$1")"; }

# $1 with every regex metacharacter escaped.
re_escape() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }

# Splits $1 on ':' into SPLIT, without globbing.
split_paths() { local IFS=:; set -f; SPLIT=($1); set +f; }

H="${HOME:?}"
H=$(canon "$H")
key=${DORI_LANE_KEY:-}
key=${key//[^A-Za-z0-9._-]/_}
case "$key" in . | ..) key="_$key" ;; esac

# The profile and its -D parameters for the lane in $key with working directory $C and TMPDIR $LT (set by the caller).
# Fills the globals PROFILE and PARAMS.
build_profile() {
  local n=0 p w_rules="" r_rules="" d_rules="" g_rules="" h_rules="" a_rules="" k_rules="" gcd broad kc rr
  PARAMS=()
  # param NAME PATH: adds -D NAME=<real path of PATH>.
  param() { PARAMS+=(-D "$1=$(canon "$2")"); }
  param_raw() { PARAMS+=(-D "$1=$2"); }
  w() { param "W$n" "$1"; w_rules="$w_rules (subpath (param \"W$n\"))"; n=$((n + 1)); }
  r() { param "R$n" "$1"; r_rules="$r_rules (subpath (param \"R$n\"))"; n=$((n + 1)); }

  w "$LT"
  for p in "$H/.omo" "$H/.dori/state" "$H/.dori/heavy" "$H/.cache" "$H/.npm" "$H/.bun/install/cache" \
    "$H/.cargo/registry" "$H/.cargo/git" "$H/Library/Caches" "$H/Library/Developer" /tmp; do
    w "$p"
  done
  # Claude Code's lock files: its processes take them so only one refreshes an account's OAuth token at a time.
  w "$H/.local/state/claude"
  # The login keychain, where Claude Code (through /usr/bin/security) stores a refreshed OAuth token; without it the
  # rotated token is lost. securityd rewrites the file atomically: a full copy as login.keychain-db.sb-<random> in the
  # same directory, then a rename over the original, so both names need writes. It is not SQLite (no -journal, -wal or
  # -shm), and nothing else in Keychains, nor another user's keychain, is opened.
  kc=$(canon "$H/Library/Keychains/login.keychain-db")
  param_raw KEYCHAIN "$kc"
  param_raw KEYCHAIN_TMP "^$(re_escape "$kc")[.]sb-[^/]+\$"
  # Per-user temp and cache dirs under /var/folders (Xcode, clang module cache and other Apple tools use these, not TMPDIR).
  for p in "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || :)" "$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || :)"; do
    if [ -n "$p" ]; then w "$p"; fi
  done
  split_paths "${LANE_SANDBOX_RW:-}"
  for p in ${SPLIT[@]+"${SPLIT[@]}"}; do
    if [ -n "$p" ]; then w "$p"; fi
  done
  # A lane started without --cwd makes its worktree from a repo under reposRoot into the worktree root: the new
  # worktree, and the repo's .git (refs, objects, FETCH_HEAD, worktrees/<name>), but not the repo's working tree.
  if [ -n "${LANE_SANDBOX_WORKTREES:-}" ]; then w "$LANE_SANDBOX_WORKTREES"; fi
  if [ -n "${LANE_SANDBOX_REPOS:-}" ]; then
    rr=$(re_escape "$(canon "$LANE_SANDBOX_REPOS")")
    param_raw REPOS_GIT "^$rr/[^/]+/[.]git(/|\$)"
    param_raw REPOS_HOOKS "^$rr/[^/]+/[.]git/hooks(/|\$)"
    g_rules="(allow file-write* (regex (param \"REPOS_GIT\")))"
    d_rules="(deny file-write* (regex (param \"REPOS_HOOKS\")))"
  fi

  broad=0
  case "$C" in / | /Users | "$H") broad=1 ;; esac
  split_paths "${LANE_SANDBOX_NO_CWD:-}"
  for p in ${SPLIT[@]+"${SPLIT[@]}"}; do
    if [ -n "$p" ] && [ "$C" = "$(canon "$p")" ]; then broad=1; fi
  done
  if [ "$broad" = 1 ]; then
    if [ -n "$key" ]; then echo "lane-sandbox: warning: cwd $C is too broad; not making it writable" >&2; fi
  else
    w "$C"
    if gcd=$(git -C "$C" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$gcd" ]; then
      w "$gcd"
      # A hook written by a lane would run outside the sandbox at the next git command on the host.
      param HOOKS "$gcd/hooks"
      d_rules="$d_rules (deny file-write* (subpath (param \"HOOKS\")))"
    fi
  fi

  for p in .dori/config.json .dori/src .dori/bin .dori/state .dori/heavy .dori/runner/sock/lane.d .dori/runner/bin "runner-brief"; do
    case "$p" in runner-brief) r "$H/.dori/runner/briefs/$key.md" ;; *) r "$H/$p" ;; esac
  done
  if [ -n "${DORI_LANE_TOKEN_FILE:-}" ]; then r "$DORI_LANE_TOKEN_FILE"; fi
  r "$H/.dori/runner/briefs/$key.files"
  r "$H/.dori/runner/briefs/$key.out"
  w "$H/.dori/runner/briefs/$key.out"
  # A lane started without --cwd works in ~/.dori/runner/lanes/<key>: readable here, writable as the cwd above.
  if [ -n "$key" ]; then r "$H/.dori/runner/lanes/$key"; fi

  param DORI "$H/.dori"
  param DORI_RUNNER "$H/.dori/runner"
  param DORI_BRIEFS "$H/.dori/runner/briefs"
  param DORI_LANES "$H/.dori/runner/lanes"
  param DORI_ENV "$H/.dori/env"
  param DORI_SECRETS "$H/.dori/secrets"
  param DOCKER_HOME "$H/.docker/run/docker.sock"
  param DOCKER_VAR /var/run/docker.sock
  param_raw DOCKER_VAR_LINK "$(canon_parent /var/run/docker.sock)"
  param LANE_SOCK "$H/.dori/runner/sock/lane.d/lane"
  if [ -n "$key" ]; then
    param HERDR_SOCK "$H/.dori/runner/sock/herdr.d/$key/herdr"
    k_rules="(allow network-outbound (remote unix-socket (path-literal (param \"HERDR_SOCK\"))))"
  fi
  param CONFIG "$H/.config"
  param CONFIG_GH "$H/.config/gh"
  param CONFIG_GIT "$H/.config/git"
  # herdr points SSH_AUTH_SOCK at ~/.config/herdr/herdr.sock.agent, a symlink to the agent's socket: both names stay usable.
  case "${SSH_AUTH_SOCK:-}" in
    "$H"/.config/*)
      param AGENT_SOCK "$SSH_AUTH_SOCK"
      param_raw AGENT_LINK "$(canon_parent "$SSH_AUTH_SOCK")"
      a_rules="(allow file-read* (literal (param \"AGENT_SOCK\")) (literal (param \"AGENT_LINK\")))
(allow network-outbound (remote unix-socket (path-literal (param \"AGENT_SOCK\"))) (remote unix-socket (path-literal (param \"AGENT_LINK\"))))"
      ;;
  esac
  if [ -f "$H/.dori/lane-sandbox-hide" ]; then
    while IFS= read -r p || [ -n "$p" ]; do
      p=${p%%#*}
      p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
      if [ -n "$p" ]; then
        param "HIDE$n" "$p"
        h_rules="$h_rules
(deny file-read* (subpath (param \"HIDE$n\")))
(deny file-write* (subpath (param \"HIDE$n\")))
(deny network-outbound (remote unix-socket (subpath (param \"HIDE$n\"))))"
        n=$((n + 1))
      fi
    done <"$H/.dori/lane-sandbox-hide"
  fi

  # Later rules win over earlier ones in SBPL.
  # realpath() of a directory opens it, and omo resolves every parent of its cwd: a cwd-less lane's parents are
  # ~/.dori/runner/lanes, ~/.dori/runner and ~/.dori. Each gets file-read-data on the directory itself (the names of its
  # entries), never on anything under it: ~/.dori/env and the other lanes' files stay refused. /bin/ps is setuid root, and a
  # sandboxed process cannot exec a setuid binary, so ps alone runs outside the profile; it writes nothing.
  PROFILE="(version 1)
(allow default)
(deny file-write*)
(allow file-write*$w_rules)
$g_rules
(allow file-write* (literal (param \"KEYCHAIN\")) (regex (param \"KEYCHAIN_TMP\")))
(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") (literal \"/dev/ptmx\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/ttys[0-9]+\$\") (regex #\"^/dev/fd/[0-9]+\$\"))
$d_rules
(deny file-read* (subpath (param \"DORI\")))
(allow file-read*$r_rules)
(allow file-read-metadata (literal (param \"DORI\")) (literal (param \"DORI_RUNNER\")) (literal (param \"DORI_BRIEFS\")) (literal (param \"DORI_LANES\")))
(allow file-read-data (literal (param \"DORI\")) (literal (param \"DORI_RUNNER\")) (literal (param \"DORI_LANES\")))
(allow process-exec (literal \"/bin/ps\") (with no-sandbox))
(deny file-read* (literal (param \"DORI_ENV\")) (regex #\"/\\.ssh/id_[^/.]+\$\"))
(deny file-read* (subpath (param \"CONFIG\")))
(allow file-read* (subpath (param \"CONFIG_GH\")) (subpath (param \"CONFIG_GIT\")))
(deny network-outbound (remote unix-socket (subpath (param \"DORI\"))) (remote unix-socket (subpath (param \"CONFIG\"))))
(allow network-outbound (remote unix-socket (path-literal (param \"LANE_SOCK\"))))
$k_rules
$a_rules
(deny network-outbound (remote unix-socket (path-literal (param \"DOCKER_HOME\"))) (remote unix-socket (path-literal (param \"DOCKER_VAR\"))) (remote unix-socket (path-literal (param \"DOCKER_VAR_LINK\"))))
$h_rules
(deny file-read* (subpath (param \"DORI_SECRETS\")))
(deny file-write* (subpath (param \"DORI_SECRETS\")))
(deny network-outbound (remote unix-socket (subpath (param \"DORI_SECRETS\"))))
"
}

# --check: preflight for `dori doctor` and the runner. Runs before the usage and DORI_LANE_KEY passthrough below so it
# also answers on the lead; exit 3 (not 2) keeps "no sandbox here" apart from a usage error. It runs `true` under the
# same profile a lane gets, so a profile this macOS refuses is caught before a lane's pane opens.
if [ "${1:-}" = "--check" ]; then
  if [ ! -x "$SBX" ]; then
    echo "lane-sandbox: $SBX not found" >&2
    exit 3
  fi
  C=/
  key=
  LT="$H/.cache/omo-tmp/lane-sandbox/_check"
  build_profile
  if ! err=$("$SBX" -p "$PROFILE" "${PARAMS[@]}" /usr/bin/true 2>&1); then
    echo "lane-sandbox: sandbox-exec cannot create a sandbox: ${err//$'\n'/ }" >&2
    exit 3
  fi
  echo "DORI_LANE_FILES=1"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: lane-sandbox <cmd> [args...]" >&2
  exit 2
fi

if [ -z "${DORI_LANE_KEY:-}" ]; then
  exec "$@"
fi

LT="$H/.cache/omo-tmp/lane-sandbox/${key:?}"
mkdir -p "$LT" "$H/.dori/heavy"
chmod 700 "$LT"
LT=$(canon "$LT")
C=$(pwd -P)
build_profile

export LANE_SANDBOX_ACTIVE=1 TMPDIR="$LT" HERDR_SOCKET_PATH="$H/.dori/runner/sock/herdr.d/$key/herdr"
# omo starts its engine with an empty OpenSSL bundle (SSL_CERT_FILE/SSL_CERT_DIR under ~/.omo/engine-trust/defaults)
# and its agent shell inherits it, so curl, git and gh there fail every TLS verification. With SSL_CERT_FILE already
# set omo keeps it and only adds its own roots for itself; the system bundle is what these tools read by default.
if [ -z "${SSL_CERT_FILE:-}" ] && [ -f "$CERTS" ]; then export SSL_CERT_FILE="$CERTS"; fi
# omo wraps its memory reflection child in a sandbox-exec of its own, and macOS refuses to apply a sandbox inside this
# one ("sandbox_apply: Operation not permitted"). The omo profile dori-lane, which `dori runner install` adds to
# ~/.omo/omo.jsonc, turns that inner sandbox off: the reflection child still runs inside this profile. An OMO_PROFILE
# already set is kept.
if [ -z "${OMO_PROFILE:-}" ]; then export OMO_PROFILE=dori-lane; fi
exec "$SBX" -p "$PROFILE" "${PARAMS[@]}" -- "$@"
