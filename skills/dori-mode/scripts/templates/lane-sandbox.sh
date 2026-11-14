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
#   LANE_SANDBOX_RO      extra read-only directories under $HOME, which is otherwise empty (the runner's grants)
#   LANE_SANDBOX_NO_CWD  directories too broad to bind read-write as the cwd (e.g. the parents of the worktree root)
#   LANE_SANDBOX_WORKTREES the runner's lane worktree root, bound read-write (the runner sets it from its policy)
#   LANE_SANDBOX_REPOS   the runner's repos root: the .git directory of each repo directly under it is bound read-write
#                        (hooks excluded), so a lane can fetch there and `git worktree add` into the worktree root
#   LANE_SANDBOX_PROFILE empty (the default above) or "review"; any other value exits 2. A review lane reads a locked
#                        snapshot worktree and writes only its findings: the cwd, its git common dir, the worktree root
#                        and each repo's .git are bound read-only, LANE_SANDBOX_RW is ignored (LANE_SANDBOX_RO kept), and
#                        the only writable host paths are briefs/<key>.out, the private TMPDIR, ~/.omo and ~/.cache (/tmp
#                        is a private tmpfs). No git or gh credentials reach it: ~/.gitconfig, ~/.config/gh, ~/.config/git
#                        and the ssh agent socket are not bound, GH_TOKEN/GITHUB_TOKEN (and the enterprise ones) are
#                        unset, git ignores global and system config and never prompts. Nothing under the cwd is
#                        writable, so omo cannot back up <cwd>/.omo/omo.jsonc there; omo tolerates that failure.
# Host paths outside ~/.dori hidden from every lane (e.g. ~/.secrets) are listed one per line in ~/.dori/lane-sandbox-hide
# ('#' starts a comment); the lead owns that file, and a lane can neither read nor change it. ~/.dori/env and
# ~/.dori/secrets are hidden without that file: ~/.dori is a fresh tmpfs, so neither is ever bound.
set -eu

# Credential stores and secrets under $HOME no lane reads, files and directories alike (a lane gets a credential only
# through the secret broker); the macOS template and `dori doctor` use the same list. Each one that exists outside
# ~/.dori is hidden after every bind, like the hide list below; the rest of $HOME is a fresh tmpfs already.
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
  --tmpfs "$H"
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

# ~/.dori gets its own tmpfs that is made read-only after the ro binds, so
# rm/creates directly in it fail with EROFS (not EBUSY); ~/.dori/env, ~/.dori/secrets and ~/.dori/state stay hidden,
# since nothing under ~/.dori is bound from the host and no bind below names them. A lane's dori reaches the
# supervisor only through the runner's lane socket and never opens the state dir.
# Every rw mount point under it is created here: bwrap cannot mkdir one once it is read-only.
opts+=(--tmpfs "$H/.dori" --dir "$H/.dori/heavy")

# Read-only re-binds (skipped when missing)
for p in .local/bin .bun .npm-global .pyenv .cargo .rustup .fzf .oh-my-zsh \
  .zshrc .bashrc .profile .gitconfig .ssh/known_hosts .ssh/config .config/gh .config/git \
  .npmrc .dori/config.json .dori/src .dori/bin; do
  if [ "$review" = 1 ]; then
    case "$p" in .gitconfig | .config/gh | .config/git) continue ;; esac
  fi
  opts+=(--ro-bind-try "$H/$p" "$H/$p")
done
# The real BrowserSkill home (daemon.json and its daemon.sock), read-only: a lane drives bsk directly. A unix socket
# connect needs no write mount; a lane cannot rewrite daemon.json or bsk's state.
bsk_home=${BSK_HOME:-$H/.bsk}
opts+=(--ro-bind-try "$bsk_home" "$bsk_home")
# The rest of ~/.config (other tools' credentials, herdr's control socket) stays out. The ssh agent socket may live
# there (herdr points SSH_AUTH_SOCK at ~/.config/herdr/herdr.sock.agent): that one path is bound on its own.
if [ "$review" = 0 ]; then
  case "${SSH_AUTH_SOCK:-}" in "$H"/*) opts+=(--ro-bind-try "$SSH_AUTH_SOCK" "$SSH_AUTH_SOCK") ;; esac
fi
# Only the lane socket: the runner's control and cli sockets (sock/control, sock/cli) are not a lane's to dial.
# The lane socket's own directory is bound, not the socket file: a restarted runner unlinks the socket and binds a
# new one at the same path, which a bind of the old file would never show (the lane would dial the dead inode).
opts+=(--dir "$H/.dori/runner/sock" --ro-bind-try "$H/.dori/runner/sock/lane.d" "$H/.dori/runner/sock/lane.d")
# The lane's own herdr report socket (the runner's sock/herdr.d/<key>, bound as a directory like lane.d): omo's herdr
# extension reports the agent state through it, and the runner forwards only reports for this lane's own pane to herdr.
opts+=(--ro-bind-try "$H/.dori/runner/sock/herdr.d/$key" "$H/.dori/runner/sock/herdr.d/$key")
opts+=(--setenv HERDR_SOCKET_PATH "$H/.dori/runner/sock/herdr.d/$key/herdr")
# A worker runner host's dori (the lane's `dori report`) lives here; read-only so a lane cannot rewrite what the runner runs.
opts+=(--ro-bind-try "$H/.dori/runner/bin" "$H/.dori/runner/bin")
opts+=(--ro-bind-try "$H/.dori/runner/briefs/$key.md" "$H/.dori/runner/briefs/$key.md")
opts+=(--dir "$H/.dori/runner/briefs/$key.out")
# The mount point of a lane started without --cwd, whose cwd is ~/.dori/runner/lanes/<key> (bound rw below as the cwd).
opts+=(--dir "$H/.dori/runner/lanes/$key")
opts+=(--ro-bind "$H/.dori/runner/briefs/$key.files" "$H/.dori/runner/briefs/$key.files")
if [ -n "${DORI_LANE_TOKEN_FILE:-}" ]; then
  opts+=(--ro-bind-try "$DORI_LANE_TOKEN_FILE" "$DORI_LANE_TOKEN_FILE")
fi
opts+=(--remount-ro "$H/.dori")

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

# Read-write re-binds (after ro ones so nested rw paths win)
opts+=(--bind "$H/.dori/runner/briefs/$key.out" "$H/.dori/runner/briefs/$key.out")
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
  mkdir -p "$H/.dori/heavy"
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
    if [ "$review" = 1 ]; then
      # The review snapshot and its git common dir, read-only: git log/diff/show work, nothing can be written there.
      opts+=(--ro-bind "$C" "$C")
      if gcd=$(git -C "$C" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$gcd" ]; then
        opts+=(--ro-bind "$gcd" "$gcd")
      fi
    else
      opts+=(--bind "$C" "$C")
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

# Hidden host paths last among the binds, so neither the cwd nor LANE_SANDBOX_RW can re-expose one: the credential
# stores above, then the hide list.
hide_path() {
  [ -n "$1" ] && [ -e "$1" ] || return 0
  local r
  r=$(readlink -f "$1")
  # ~/.dori is hidden already, and its read-only tmpfs takes no new mount point.
  case "$r" in "$H/.dori" | "$H/.dori"/*) return 0 ;; esac
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
        if [ "${opts[$i]:-}" = --remount-ro ] && [ "${opts[$((i + 1))]:-}" = "$a" ]; then
          echo "hide $a"
          i=$((i + 2))
        else
          echo "empty $a"
        fi
        ;;
      --unshare-pid | --die-with-parent) i=$((i + 1)) ;;
      *) i=$((i + 2)) ;;
    esac
  done
  exit 0
fi

exec bwrap "${opts[@]}" -- "$@"
