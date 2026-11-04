#!/usr/bin/env bash
# lane-sandbox: run a dori lane agent command inside a bubblewrap sandbox.
# Usage: lane-sandbox <cmd> [args...]
# Passthrough (no sandbox) when DORI_LANE_KEY is empty/unset or LANE_SANDBOX=off.
# Host paths come from the environment, colon-separated:
#   LANE_SANDBOX_RW      extra read-write directories (e.g. your worktree root, a verify/scratch dir)
#   LANE_SANDBOX_NO_CWD  directories too broad to bind read-write as the cwd (e.g. the parents of the worktree root)
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: lane-sandbox <cmd> [args...]" >&2
  exit 2
fi

if [ -z "${DORI_LANE_KEY:-}" ] || [ "${LANE_SANDBOX:-}" = "off" ]; then
  exec "$@"
fi

H="${HOME:?}"

opts=(
  --ro-bind / /
  --dev /dev
  --proc /proc
  --unshare-pid
  --die-with-parent
  --tmpfs "$H"
  --bind /tmp /tmp
  --setenv LANE_SANDBOX_ACTIVE 1
)

# ~/.dori gets its own tmpfs that is made read-only after the ro binds, so
# rm/creates directly in it fail with EROFS (not EBUSY); ~/.dori/env stays hidden.
opts+=(--tmpfs "$H/.dori" --dir "$H/.dori/state")

# Read-only re-binds (skipped when missing)
for p in .local/bin .bun .npm-global .pyenv .cargo .rustup .fzf .oh-my-zsh \
  .zshrc .bashrc .profile .gitconfig .ssh/known_hosts .ssh/config .config \
  .npmrc .dori/config.json .dori/src .dori/bin; do
  opts+=(--ro-bind-try "$H/$p" "$H/$p")
done
opts+=(--remount-ro "$H/.dori")

# ssh rejects root-owned include files inside the user namespace (root shows as
# nobody): re-provide each /etc/ssh/ssh_config.d file as a user-owned ro copy.
for f in /etc/ssh/ssh_config.d/*; do
  [ -f "$f" ] || continue
  r=$(readlink -f "$f")
  exec {fd}<"$r"
  opts+=(--ro-bind-data "$fd" "$r")
done

# Read-write re-binds (after ro ones so nested rw paths win)
for p in "$H/.omo" "$H/.dori/state" "$H/.cache" "$H/.npm" "$H/.bun/install/cache" \
  "$H/.cargo/registry" "$H/.cargo/git"; do
  opts+=(--bind-try "$p" "$p")
done

if [ -n "${LANE_SANDBOX_RW:-}" ]; then
  IFS=: read -r -a extra <<<"$LANE_SANDBOX_RW"
  for p in "${extra[@]}"; do
    [ -n "$p" ] && opts+=(--bind-try "$p" "$p")
  done
fi

# Private key only when the ssh agent has no identities
if ! ssh-add -l >/dev/null 2>&1; then
  opts+=(--ro-bind-try "$H/.ssh/id_rsa" "$H/.ssh/id_rsa")
fi

# Hide docker sockets (resolve symlinks such as /var/run -> /run, bind each real path once)
seen=""
for s in /run/docker.sock /var/run/docker.sock; do
  [ -e "$s" ] || continue
  r=$(readlink -f "$s")
  case " $seen " in *" $r "*) continue ;; esac
  seen="$seen $r"
  opts+=(--ro-bind /dev/null "$r")
done

# Working directory
C=$(pwd -P)
broad=0
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
    opts+=(--bind "$C" "$C")
    if gcd=$(git -C "$C" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$gcd" ]; then
      opts+=(--bind "$gcd" "$gcd")
    fi
    ;;
esac
opts+=(--chdir "$C")

exec bwrap "${opts[@]}" -- "$@"
