#!/usr/bin/env bash
# lane-sandbox: run a dori lane agent command inside a bubblewrap sandbox.
# Usage: lane-sandbox <cmd> [args...] | lane-sandbox --check
# Passthrough (no sandbox) only when DORI_LANE_KEY is empty/unset: the lead runs outside the sandbox.
# Host paths come from the environment, colon-separated:
#   LANE_SANDBOX_RW      extra read-write directories (e.g. your worktree root, a verify/scratch dir)
#   LANE_SANDBOX_NO_CWD  directories too broad to bind read-write as the cwd (e.g. the parents of the worktree root)
#   LANE_SANDBOX_VERIFY  the lead workspace's verify directory, bound read-write (the local runner passes <leadCwd>/state/verify)
set -eu

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

if [ "$#" -eq 0 ]; then
  echo "usage: lane-sandbox <cmd> [args...]" >&2
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
  --bind /tmp /tmp
  --setenv LANE_SANDBOX_ACTIVE 1
)

# ~/.dori gets its own tmpfs that is made read-only after the ro binds, so
# rm/creates directly in it fail with EROFS (not EBUSY); ~/.dori/env stays hidden.
# Every rw mount point under it is created here: bwrap cannot mkdir one once it is read-only.
opts+=(--tmpfs "$H/.dori" --dir "$H/.dori/state" --dir "$H/.dori/heavy")

# Read-only re-binds (skipped when missing)
for p in .local/bin .bun .npm-global .pyenv .cargo .rustup .fzf .oh-my-zsh \
  .zshrc .bashrc .profile .gitconfig .ssh/known_hosts .ssh/config .config \
  .npmrc .dori/config.json .dori/src .dori/bin; do
  opts+=(--ro-bind-try "$H/$p" "$H/$p")
done
opts+=(--ro-bind-try "$H/.dori/runner/sock" "$H/.dori/runner/sock")
# A worker runner host's dori (the lane's `dori report`) lives here; read-only so a lane cannot rewrite what the runner runs.
opts+=(--ro-bind-try "$H/.dori/runner/bin" "$H/.dori/runner/bin")
opts+=(--ro-bind-try "$H/.dori/runner/briefs/$key.md" "$H/.dori/runner/briefs/$key.md")
opts+=(--dir "$H/.dori/runner/briefs/$key.out")
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

# Read-write re-binds (after ro ones so nested rw paths win)
opts+=(--bind "$H/.dori/runner/briefs/$key.out" "$H/.dori/runner/briefs/$key.out")
for p in "$H/.omo" "$H/.dori/state" "$H/.cache" "$H/.npm" "$H/.bun/install/cache" \
  "$H/.cargo/registry" "$H/.cargo/git"; do
  opts+=(--bind-try "$p" "$p")
done
mkdir -p "$H/.dori/heavy"
opts+=(--bind-try "$H/.dori/heavy" "$H/.dori/heavy")

if [ -n "${LANE_SANDBOX_RW:-}" ]; then
  IFS=: read -r -a extra <<<"$LANE_SANDBOX_RW"
  for p in "${extra[@]}"; do
    [ -n "$p" ] && opts+=(--bind-try "$p" "$p")
  done
fi
# Only the verify directory itself: the rest of its parent stays read-only.
if [ -n "${LANE_SANDBOX_VERIFY:-}" ]; then
  opts+=(--bind-try "$LANE_SANDBOX_VERIFY" "$LANE_SANDBOX_VERIFY")
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

# Private TMPDIR last, so the broad ~/.cache rw bind cannot shadow it
opts+=(--bind "$LT" "$H/.lane-tmp" --setenv TMPDIR "$H/.lane-tmp")
# Keep the root tmpfs read-only like the old --ro-bind / / (after all mountpoints exist)
opts+=(--remount-ro /)

exec bwrap "${opts[@]}" -- "$@"
