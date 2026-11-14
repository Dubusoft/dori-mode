#!/usr/bin/env bash
# lane-sandbox: run a dori lane agent command inside a bubblewrap sandbox.
# Usage: lane-sandbox <cmd> [args...] | lane-sandbox --check | lane-sandbox --explain
# --explain prints the mount table a lane in the current directory would get (same environment, DORI_LANE_KEY defaulting
# to "explain") instead of running anything: one "<mode> <path>" line per mount, in mount order, where a later line wins at
# and below its path. Modes: rw, ro, hide (an empty read-only tmpfs or /dev/null over the path) and empty (a fresh tmpfs:
# none of the host's entries there show). A -try bind whose source is missing is left out, as bwrap skips it.
# Passthrough (no sandbox) only when DORI_LANE_KEY is empty/unset: the lead runs outside the sandbox.
# Host paths come from the environment, colon-separated:
#   LANE_SANDBOX_RW      extra read-write directories (e.g. your worktree root, a scratch dir; the runner's grants)
#   LANE_SANDBOX_RO      extra read-only directories (the runner's grants); $HOME itself is read-only already
#   LANE_SANDBOX_NO_CWD  directories too broad to bind read-write as the cwd (e.g. the parents of the worktree root)
#   LANE_SANDBOX_WORKTREES the runner's lane worktree root, bound read-write (the runner sets it from its policy)
#   LANE_SANDBOX_REPOS   the runner's repos root: the .git directory of each repo directly under it is bound read-write
#                        (hooks excluded), so a lane can fetch there and `git worktree add` into the worktree root
#   LANE_SANDBOX_PROFILE empty (the default above) or "review"; any other value exits 2. A review lane reads a locked
#                        snapshot worktree and writes only its findings: the cwd, its git common dir, the worktree root
#                        and each repo's .git are bound read-only, LANE_SANDBOX_RW is ignored (LANE_SANDBOX_RO kept), and
#                        the only writable host paths are briefs/<key>.out, the private TMPDIR, ~/.omo and ~/.cache (/tmp
#                        is a private tmpfs). No git or gh credentials reach it: ~/.gitconfig, ~/.config/gh, ~/.config/git
#                        and an ssh agent socket under $HOME are hidden, GH_TOKEN/GITHUB_TOKEN (and the enterprise ones) are
#                        unset, git ignores global and system config and never prompts. Nothing under the cwd is
#                        writable, so omo cannot back up <cwd>/.omo/omo.jsonc there; omo tolerates that failure.
# $HOME and ~/.dori are bound read-only; what no lane may read is hidden after every read-write bind, so neither the cwd
# nor a grant can re-expose it: ~/.dori/runner, ~/.ssh and ~/.config (each an empty read-only tmpfs with only the
# lane's own runner entries, ssh known_hosts and config, and gh, git and the ssh agent socket bound back), the
# credential stores below (~/.dori/env, secrets and state among them) and every other host path listed one per line in
# ~/.dori/lane-sandbox-hide ('#' starts a comment); the lead owns that file, and a lane can neither read nor change it.
set -eu

# Credential stores and secrets under $HOME no lane reads, files and directories alike (a lane gets a credential only
# through the secret broker); the macOS template and `dori doctor` use the same list. Each one that exists is hidden
# after every bind, like the hide list below.
# BEGIN CREDENTIALS (rendered from CREDENTIAL_DENY in src/lane-sandbox-install.ts; edit the list there)
CREDENTIALS=".dori/env .dori/secrets .dori/state .dori/lane-sandbox-hide .dori/gateway-locks .secrets .aws .azure
  .oci .kube .config/gcloud .config/doctl .config/hcloud .config/flyctl .config/helm
  .terraform.d/credentials.tfrc.json .vault-token .docker/config.json .config/containers/auth.json .gnupg
  .password-store .local/share/keyrings .local/share/gnome-keyring .local/share/kwalletd .config/age .age
  .config/sops .config/Bitwarden .config/keepassxc .config/1Password .git-credentials .netrc .pypirc
  .cargo/credentials .cargo/credentials.toml .gem/credentials .m2/settings.xml .gradle/gradle.properties
  .config/composer/auth.json .yarnrc .yarnrc.yml .pnpmrc .config/pnpm/auth.ini .config/glab-cli .nuget/NuGet
  .local/share/toodo-server .mozilla .config/google-chrome .config/chromium .config/BraveSoftware
  .config/microsoft-edge .config/discord .config/Slack .config/Signal .local/share/TelegramDesktop
  .config/Code/User/globalStorage .vscode .vscode-server .bash_history .zsh_history .python_history .psql_history
  .mysql_history .lesshst"
# END CREDENTIALS

# --check: preflight for `dori doctor` and the runner. Runs before the usage and DORI_LANE_KEY passthrough
# below so it also answers on the lead; exit 3 (not 2) keeps "no sandbox here" apart from a usage error.
if [ "${1:-}" = "--check" ]; then
  if ! command -v bwrap >/dev/null 2>&1; then
    echo "lane-sandbox: bwrap not found on PATH" >&2
    exit 3
  fi
  if ! err=$(bwrap --ro-bind / / true 2>&1); then
    echo "lane-sandbox: bwrap cannot create a sandbox: ${err//$'\n'/ }" >&2
    exit 3
  fi
  echo "DORI_LANE_FILES=1"
  exit 0
fi

explain=0
if [ "${1:-}" = "--explain" ]; then
  explain=1
  shift
  : "${DORI_LANE_KEY:=explain}"
fi

if [ "$#" -eq 0 ] && [ "$explain" = 0 ]; then
  echo "usage: lane-sandbox <cmd> [args...] | --check | --explain" >&2
  exit 2
fi

# Fail closed: an unknown profile, or a review lane with no lane key (which would pass through unsandboxed), runs nothing.
profile=${LANE_SANDBOX_PROFILE:-}
case "$profile" in
  "") review=0 ;;
  review) review=1 ;;
  *)
    echo "lane-sandbox: unknown LANE_SANDBOX_PROFILE '$profile' (expected empty or review)" >&2
    exit 2
    ;;
esac
if [ "$review" = 1 ] && [ -z "${DORI_LANE_KEY:-}" ]; then
  echo "lane-sandbox: LANE_SANDBOX_PROFILE=review needs DORI_LANE_KEY; refusing to run unsandboxed" >&2
  exit 2
fi

if [ -z "${DORI_LANE_KEY:-}" ]; then
  exec "$@"
fi

H="${HOME:?}"

# Per-lane private TMPDIR. The host dir lives under ~/.cache (which may be
# group-writable), so it is mounted inside at $H/.lane-tmp, whose ancestors are
# all namespace-owned 0755 dirs (omo's trust-ancestor check needs that).
key=${DORI_LANE_KEY//[^A-Za-z0-9._-]/_}
case "$key" in . | ..) key="_$key" ;; esac
LT="$H/.cache/omo-tmp/lane-sandbox/${key:?}"
mkdir -p "$LT"
chmod 700 "$LT"

# Root is a namespace-owned tmpfs (uid = us, 0755) instead of --ro-bind / /, so
# / and the parent of $HOME do not show up as nobody-owned. Host top-level
# entries are re-bound read-only and top-level symlinks recreated.
top=${H#/}
top=/${top%%/*}
# $HOME is bound read-only from the host, where bwrap cannot create a mount point: make the ones it needs there now.
mkdir -p "$H/.dori/heavy" "$H/.dori/runner" "$H/.lane-tmp"
opts=(--perms 0755 --tmpfs /)
shopt -s nullglob dotglob
for e in /*; do
  case "$e" in "$top" | /tmp | /proc | /dev) continue ;; esac
  if [ -L "$e" ]; then
    opts+=(--symlink "$(readlink "$e")" "$e")
  else
    opts+=(--ro-bind "$e" "$e")
  fi
done
shopt -u nullglob dotglob

opts+=(
  --dev /dev
  --proc /proc
  --unshare-pid
  --die-with-parent
  --perms 0755 --dir "$(dirname "$H")"
  --ro-bind "$H" "$H"
  --ro-bind "$H/.dori" "$H/.dori"
)
# A review lane gets a private /tmp: the host's is shared with every other process.
if [ "$review" = 1 ]; then opts+=(--tmpfs /tmp); else opts+=(--bind /tmp /tmp); fi
opts+=(--setenv LANE_SANDBOX_ACTIVE 1)
# A review lane carries no git or gh credentials: no global/system git config, no prompt, no token.
if [ "$review" = 1 ]; then
  opts+=(--setenv GIT_TERMINAL_PROMPT 0 --setenv GIT_CONFIG_GLOBAL /dev/null --setenv GIT_CONFIG_NOSYSTEM 1)
  opts+=(--unsetenv GH_TOKEN --unsetenv GITHUB_TOKEN --unsetenv GH_ENTERPRISE_TOKEN --unsetenv GITHUB_ENTERPRISE_TOKEN)
  opts+=(--unsetenv SSH_AUTH_SOCK)
fi

# The real BrowserSkill home (daemon.json and its daemon.sock), read-only: a lane drives bsk directly. A unix socket
# connect needs no write mount; a lane cannot rewrite daemon.json or bsk's state.
bsk_home=${BSK_HOME:-$H/.bsk}
opts+=(--ro-bind-try "$bsk_home" "$bsk_home")
opts+=(--setenv HERDR_SOCKET_PATH "$H/.dori/runner/sock/herdr.d/$key/herdr")

# ssh rejects root-owned include files inside the user namespace (root shows as
# nobody): re-provide each /etc/ssh/ssh_config.d file as a user-owned ro copy.
for f in /etc/ssh/ssh_config.d/*; do
  [ -f "$f" ] || continue
  r=$(readlink -f "$f")
  exec {fd}<"$r"
  opts+=(--ro-bind-data "$fd" "$r")
done

# Granted read-only paths, before every read-write bind so a cwd or rw path under one stays writable.
if [ -n "${LANE_SANDBOX_RO:-}" ]; then
  IFS=: read -r -a extra_ro <<<"$LANE_SANDBOX_RO"
  for p in "${extra_ro[@]}"; do
    [ -n "$p" ] && opts+=(--ro-bind-try "$p" "$p")
  done
fi

# Read-write re-binds (after ro ones so nested rw paths win); briefs/<key>.out is bound with the runner dir below.
if [ "$review" = 1 ]; then
  # A review lane keeps only omo's own state and caches writable: no package caches, no heavy dir, no grants.
  for p in "$H/.omo" "$H/.cache"; do
    opts+=(--bind-try "$p" "$p")
  done
else
  for p in "$H/.omo" "$H/.cache" "$H/.npm" "$H/.bun/install/cache" \
    "$H/.cargo/registry" "$H/.cargo/git"; do
    opts+=(--bind-try "$p" "$p")
  done
  opts+=(--bind-try "$H/.dori/heavy" "$H/.dori/heavy")
fi

if [ "$review" = 0 ] && [ -n "${LANE_SANDBOX_RW:-}" ]; then
  IFS=: read -r -a extra <<<"$LANE_SANDBOX_RW"
  for p in "${extra[@]}"; do
    [ -n "$p" ] && opts+=(--bind-try "$p" "$p")
  done
fi

# No ssh private key is ever bound, even when the agent holds no identities: a lane gets a key only for one command,
# through the secret broker (dori secret exec <ssh-key secret> -- git push).

# Hide docker sockets (resolve symlinks such as /var/run -> /run, bind each real path once)
seen=""
for s in /run/docker.sock /var/run/docker.sock; do
  [ -e "$s" ] || continue
  r=$(readlink -f "$s")
  case " $seen " in *" $r "*) continue ;; esac
  seen="$seen $r"
  opts+=(--ro-bind /dev/null "$r")
done

# Hide the user's D-Bus session bus and systemd user manager sockets: through either a lane could ask the user manager
# to start a transient unit (systemd-run --user), which runs outside the sandbox.
U=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
for s in "$U/bus" "$U/at-spi/bus"; do
  if [ -S "$s" ]; then opts+=(--ro-bind /dev/null "$s"); fi
done
if [ -d "$U/systemd" ]; then opts+=(--tmpfs "$U/systemd" --remount-ro "$U/systemd"); fi
opts+=(--unsetenv DBUS_SESSION_BUS_ADDRESS)

# Working directory
C=$(pwd -P)
broad=0
gits=()
case "$C" in / | /home | "$H") broad=1 ;; esac
# A cwd under the runner dir (a lane started without --cwd: ~/.dori/runner/lanes/<key>) is bound with that dir below.
runner_cwd=0
if [ -n "${LANE_SANDBOX_NO_CWD:-}" ]; then
  IFS=: read -r -a nocwd <<<"$LANE_SANDBOX_NO_CWD"
  for p in "${nocwd[@]}"; do
    [ -n "$p" ] && [ "$C" = "$p" ] && broad=1
  done
fi
case "$broad" in
  1)
    echo "lane-sandbox: warning: cwd $C is too broad; not binding it rw" >&2
    ;;
  *)
    case "$C" in "$H/.dori/runner" | "$H/.dori/runner"/*) runner_cwd=1 ;; esac
    if [ "$review" = 1 ]; then
      # The review snapshot and its git common dir, read-only: git log/diff/show work, nothing can be written there.
      [ "$runner_cwd" = 1 ] || opts+=(--ro-bind "$C" "$C")
      if gcd=$(git -C "$C" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$gcd" ]; then
        opts+=(--ro-bind "$gcd" "$gcd")
      fi
    else
      [ "$runner_cwd" = 1 ] || opts+=(--bind "$C" "$C")
      if gcd=$(git -C "$C" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$gcd" ]; then
        opts+=(--bind "$gcd" "$gcd")
        gits+=("$gcd")
      fi
    fi
    ;;
esac
opts+=(--chdir "$C")

# A lane started without --cwd makes its worktree from a repo under the repos root into the worktree root: the worktree
# root and each repo's .git (refs, objects, FETCH_HEAD, worktrees/<name>) are writable; the repos root itself and each
# repo's working tree stay read-only.
# A review lane gets both read-only (it may read neighbor code, never write another worktree or a repo's refs).
if [ -n "${LANE_SANDBOX_WORKTREES:-}" ]; then
  if [ "$review" = 1 ]; then
    opts+=(--ro-bind-try "$LANE_SANDBOX_WORKTREES" "$LANE_SANDBOX_WORKTREES")
  else
    opts+=(--bind-try "$LANE_SANDBOX_WORKTREES" "$LANE_SANDBOX_WORKTREES")
  fi
fi
if [ -n "${LANE_SANDBOX_REPOS:-}" ]; then
  shopt -s nullglob
  for g in "${LANE_SANDBOX_REPOS%/}"/*/.git; do
    if [ -d "$g" ] && [ "$review" = 1 ]; then
      opts+=(--ro-bind "$g" "$g")
    elif [ -d "$g" ]; then
      opts+=(--bind "$g" "$g")
      gits+=("$g")
    fi
  done
  shopt -u nullglob
fi
# A hook written by a lane would run outside the sandbox at the next git command on the host: each writable .git's
# hooks stay read-only, bound after every read-write .git so none of them re-exposes one.
for g in ${gits[@]+"${gits[@]}"}; do
  opts+=(--ro-bind-try "$g/hooks" "$g/hooks")
done

# Hidden host paths last among the binds, so neither the cwd nor LANE_SANDBOX_RW can re-expose one. First the hidden
# subtrees: each an empty tmpfs, made read-only once the entries a lane keeps are bound back into it.
trees=()
kept=()
# keep <bind option> <path>: binds <path> back at itself and records it (unless bwrap skips it), for hide_path below.
keep() {
  opts+=("$1" "$2" "$2")
  case "$1" in *-try) [ -e "$2" ] || return 0 ;; esac
  kept+=("$(readlink -m "$2")")
}
# The ssh agent socket may live in a hidden subtree (herdr points SSH_AUTH_SOCK at ~/.config/herdr/herdr.sock.agent).
keep_agent() {
  [ "$review" = 0 ] || return 0
  case "${SSH_AUTH_SOCK:-}" in "$1"/*) keep --ro-bind-try "$SSH_AUTH_SOCK" ;; esac
}
# The runner dir: only this lane's entries. The control and cli sockets (sock/control, sock/cli), the runner's keys and
# state, and other lanes' briefs and tokens are not a lane's to read. The lane socket's own directory is bound, not the
# socket file: a restarted runner unlinks the socket and binds a new one at the same path, which a bind of the old file
# would never show (the lane would dial the dead inode). The lane's own herdr report socket (sock/herdr.d/<key>) is
# bound the same way: omo's herdr extension reports the agent state through it, and the runner forwards only reports
# for this lane's own pane to herdr. A worker runner host's dori (the lane's `dori report`) lives in bin.
R="$H/.dori/runner"
opts+=(--tmpfs "$R" --dir "$R/sock")
keep --ro-bind-try "$R/sock/lane.d"
keep --ro-bind-try "$R/sock/herdr.d/$key"
keep --ro-bind-try "$R/bin"
keep --ro-bind-try "$R/briefs/$key.md"
keep --ro-bind "$R/briefs/$key.files"
if [ -n "${DORI_LANE_TOKEN_FILE:-}" ]; then keep --ro-bind-try "$DORI_LANE_TOKEN_FILE"; fi
# Mount points for the read-write binds below (bwrap cannot mkdir one once the tmpfs is read-only), among them a
# cwd-less lane's ~/.dori/runner/lanes/<key>.
opts+=(--dir "$R/briefs/$key.out" --dir "$R/lanes/$key")
if [ "$runner_cwd" = 1 ]; then opts+=(--dir "$C"); fi
opts+=(--remount-ro "$R")
keep --bind "$R/briefs/$key.out"
if [ "$runner_cwd" = 1 ]; then
  if [ "$review" = 1 ]; then keep --ro-bind "$C"; else keep --bind "$C"; fi
fi
trees+=("$(readlink -f "$R")")
if [ -d "$H/.ssh" ]; then
  # No ssh private key is ever readable: a lane gets a key only for one command, through the secret broker.
  opts+=(--tmpfs "$H/.ssh")
  keep --ro-bind-try "$H/.ssh/known_hosts"
  keep --ro-bind-try "$H/.ssh/config"
  keep_agent "$H/.ssh"
  opts+=(--remount-ro "$H/.ssh")
  trees+=("$(readlink -f "$H/.ssh")")
fi
if [ -d "$H/.config" ]; then
  # Other tools' credentials and herdr's control socket stay out; a review lane keeps neither gh nor git.
  opts+=(--tmpfs "$H/.config")
  if [ "$review" = 0 ]; then
    keep --ro-bind-try "$H/.config/gh"
    keep --ro-bind-try "$H/.config/git"
  fi
  keep_agent "$H/.config"
  opts+=(--remount-ro "$H/.config")
  trees+=("$(readlink -f "$H/.config")")
fi

# Then each credential store, the hide list and, in a review lane, the git config and an ssh agent socket under $HOME.
hide_path() {
  [ -n "$1" ] && [ -e "$1" ] || return 0
  local r t o covered=0
  r=$(readlink -f "$1")
  # In a hidden subtree only a path at, below or above an entry bound back has a mount point, and only such a path
  # shows; the rest is hidden with the subtree.
  for t in ${trees[@]+"${trees[@]}"}; do
    case "$r" in "$t"/*) covered=1 ;; esac
  done
  if [ "$covered" = 1 ]; then
    for o in ${kept[@]+"${kept[@]}"}; do
      case "$r/" in "$o"/*) covered=0 ;; esac
      case "$o" in "$r"/*) covered=0 ;; esac
    done
  fi
  [ "$covered" = 0 ] || return 0
  if [ -d "$r" ]; then
    opts+=(--tmpfs "$r" --remount-ro "$r")
  else
    opts+=(--ro-bind /dev/null "$r")
  fi
}
for p in $CREDENTIALS; do hide_path "$H/$p"; done
if [ -f "$H/.dori/lane-sandbox-hide" ]; then
  while IFS= read -r p || [ -n "$p" ]; do
    p=${p%%#*}
    p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    hide_path "$p"
  done <"$H/.dori/lane-sandbox-hide"
fi
if [ "$review" = 1 ]; then
  hide_path "$H/.gitconfig"
  case "${SSH_AUTH_SOCK:-}" in "$H"/*) hide_path "$SSH_AUTH_SOCK" ;; esac
fi

# Private TMPDIR last, so the broad ~/.cache rw bind cannot shadow it
opts+=(--bind "$LT" "$H/.lane-tmp" --setenv TMPDIR "$H/.lane-tmp")
# Keep the root tmpfs read-only like the old --ro-bind / / (after all mountpoints exist)
opts+=(--remount-ro /)

# --explain: the table is read off the very argv bwrap would get, so it cannot drift from the mounts.
if [ "$explain" = 1 ]; then
  echo "# lane-sandbox --explain (bwrap) for lane $key in $C${profile:+ (profile $profile)}: a later line wins at and below its path"
  i=0
  while [ "$i" -lt "${#opts[@]}" ]; do
    o=${opts[$i]}
    case "$o" in
      --bind | --bind-try | --ro-bind | --ro-bind-try | --ro-bind-data | --symlink | --setenv)
        a=${opts[$((i + 1))]}
        b=${opts[$((i + 2))]}
        i=$((i + 3))
        case "$o" in --bind-try | --ro-bind-try) [ -e "$a" ] || continue ;; esac
        case "$o" in
          --bind | --bind-try) echo "rw $b" ;;
          --ro-bind | --ro-bind-try) if [ "$a" = /dev/null ]; then echo "hide $b"; else echo "ro $b"; fi ;;
          --ro-bind-data) echo "ro $b" ;;
        esac
        ;;
      --tmpfs)
        a=${opts[$((i + 1))]}
        i=$((i + 2))
        # A tmpfs made read-only later (other than the root) hides its path; the entries bound back show on later lines.
        ro=0
        if [ "$a" != / ]; then
          for ((j = i; j + 1 < ${#opts[@]}; j++)); do
            if [ "${opts[$j]}" = --remount-ro ] && [ "${opts[$((j + 1))]}" = "$a" ]; then ro=1 && break; fi
          done
        fi
        if [ "$ro" = 1 ]; then echo "hide $a"; else echo "empty $a"; fi
        ;;
      --unshare-pid | --die-with-parent) i=$((i + 1)) ;;
      *) i=$((i + 2)) ;;
    esac
  done
  exit 0
fi

exec bwrap "${opts[@]}" -- "$@"
