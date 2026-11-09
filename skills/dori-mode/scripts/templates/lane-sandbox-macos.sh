#!/usr/bin/env bash
# lane-sandbox (macOS): run a dori lane agent command inside a Seatbelt sandbox (sandbox-exec).
# Usage: lane-sandbox <cmd> [args...] | lane-sandbox --check
# Same inputs as the Linux (bubblewrap) lane-sandbox. Passthrough (no sandbox) only when DORI_LANE_KEY is empty/unset:
# the lead runs outside the sandbox. Host paths come from the environment, colon-separated:
#   LANE_SANDBOX_RW      extra writable directories (e.g. your worktree root, a verify/scratch dir)
#   LANE_SANDBOX_NO_CWD  directories too broad to make writable as the cwd (e.g. the parents of the worktree root)
#   LANE_SANDBOX_VERIFY  the lead workspace's verify directory, made writable
#   DORI_LANE_TOKEN_FILE the lane's own token file, readable
#
# Seatbelt cannot hide or remap paths the way bubblewrap does; it only refuses access (EPERM). So the profile allows
# reads almost everywhere and refuses writes by default, with a whitelist: the cwd (worktree) and its git common dir,
# the lane's own TMPDIR, ~/.omo, ~/.cache, ~/.dori/state, ~/.dori/heavy, package caches, Xcode's per-user dirs, /tmp
# and the terminal and null devices. Reads of ~/.dori are refused except what a lane needs (config, dori itself, the runner socket and bin, its
# own brief and token), and ~/.dori/env and ~/.ssh private keys are refused outright. Every path is resolved first
# (macOS /var and /tmp are symlinks into /private) and reaches the profile as a -D parameter, never as profile text.
# macOS ships bash 3.2: no ${x,,}, no {fd} redirections, and no empty "${array[@]}" under set -u.
set -eu

SBX=/usr/bin/sandbox-exec

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
  local n=0 p w_rules="" r_rules="" d_rules="" gcd broad
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
  # Per-user temp and cache dirs under /var/folders (Xcode, clang module cache and other Apple tools use these, not TMPDIR).
  for p in "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || :)" "$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || :)"; do
    if [ -n "$p" ]; then w "$p"; fi
  done
  split_paths "${LANE_SANDBOX_RW:-}"
  for p in ${SPLIT[@]+"${SPLIT[@]}"}; do
    if [ -n "$p" ]; then w "$p"; fi
  done
  # Only the verify directory itself: the rest of its parent stays read-only.
  if [ -n "${LANE_SANDBOX_VERIFY:-}" ]; then w "$LANE_SANDBOX_VERIFY"; fi

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
      d_rules="(deny file-write* (subpath (param \"HOOKS\")))"
    fi
  fi

  for p in .dori/config.json .dori/src .dori/bin .dori/state .dori/heavy .dori/runner/sock .dori/runner/bin "runner-brief"; do
    case "$p" in runner-brief) r "$H/.dori/runner/briefs/$key.md" ;; *) r "$H/$p" ;; esac
  done
  if [ -n "${DORI_LANE_TOKEN_FILE:-}" ]; then r "$DORI_LANE_TOKEN_FILE"; fi

  param DORI "$H/.dori"
  param DORI_RUNNER "$H/.dori/runner"
  param DORI_BRIEFS "$H/.dori/runner/briefs"
  param DORI_ENV "$H/.dori/env"
  param DOCKER_HOME "$H/.docker/run/docker.sock"
  param DOCKER_VAR /var/run/docker.sock
  param_raw DOCKER_VAR_LINK "$(canon_parent /var/run/docker.sock)"

  # Later rules win over earlier ones in SBPL.
  PROFILE="(version 1)
(allow default)
(deny file-write*)
(allow file-write*$w_rules)
(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") (literal \"/dev/ptmx\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/ttys[0-9]+\$\") (regex #\"^/dev/fd/[0-9]+\$\"))
$d_rules
(deny file-read* (subpath (param \"DORI\")))
(allow file-read*$r_rules)
(allow file-read-metadata (literal (param \"DORI\")) (literal (param \"DORI_RUNNER\")) (literal (param \"DORI_BRIEFS\")))
(deny file-read* (literal (param \"DORI_ENV\")) (regex #\"/\\.ssh/id_[^/.]+\$\"))
(deny network-outbound (remote unix-socket (path-literal (param \"DOCKER_HOME\"))) (remote unix-socket (path-literal (param \"DOCKER_VAR\"))) (remote unix-socket (path-literal (param \"DOCKER_VAR_LINK\"))))
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

export LANE_SANDBOX_ACTIVE=1 TMPDIR="$LT"
exec "$SBX" -p "$PROFILE" "${PARAMS[@]}" -- "$@"
