#!/bin/bash
# dori-secret (macOS): hand secrets the owner stored in their login keychain to one command, as environment variables.
# Usage:
#   dori-secret run [ENV=]dori.<name> [...] -- <cmd> [args...]   run <cmd> with each secret in its environment variable
#   dori-secret has dori.<name>                                   exit 0 when the item exists, 1 when it does not
#   dori-secret list                                              the dori.* item names in the login keychain
#   dori-secret help
# The owner registers an item once, in a terminal on this Mac; security asks for the value, so it is never on a command
# line or in shell history:
#   security add-generic-password -U -a "$USER" -s dori.<name> -w
# (-w last with no value makes security prompt for it; never add -A, which lets every app read the item without asking.)
#
# Only generic-password items whose service name is dori.<name> are read, and only from the user's login keychain. No
# subcommand prints a value: `run` puts it in the environment of the command it execs, and nothing else. Without ENV=,
# the variable is the name upper-cased with . and - as _ (dori.gh-token -> DORI_GH_TOKEN). A value with bytes security
# cannot print as text arrives hex-encoded, as `security find-generic-password -w` gives it.
# Exit codes: 0 ok (run: the command's own), 1 has: missing, 2 usage, 3 item missing, 4 keychain refused.
# DORI_SECRET_SECURITY replaces /usr/bin/security (tests only).
# macOS ships bash 3.2: no ${x^^}, no empty "${array[@]}" under set -u.
set -eu

SEC=${DORI_SECRET_SECURITY:-/usr/bin/security}
KC="$HOME/Library/Keychains/login.keychain-db"
NAME_RE='^dori\.[a-z0-9][a-z0-9._-]{0,62}$'
ENV_RE='^[A-Za-z_][A-Za-z0-9_]*$'

usage() {
  sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

check_name() {
  if ! [[ $1 =~ $NAME_RE ]]; then
    echo "dori-secret: refused '$1': only dori.<name> items (lower-case letters, digits, . _ -) are read" >&2
    exit 2
  fi
}

# A lookup that prints the item's attributes, never its value (no -w, no -g).
exists() { "$SEC" find-generic-password -s "$1" "$KC" >/dev/null 2>&1; }

cmd=${1:-help}
[ $# -gt 0 ] && shift

case "$cmd" in
  run)
    pairs=()
    while [ $# -gt 0 ] && [ "$1" != -- ]; do
      spec=$1
      shift
      case "$spec" in
        *=*) env=${spec%%=*} name=${spec#*=} ;;
        *) name=$spec env=$(printf '%s' "$spec" | tr 'a-z.-' 'A-Z__') ;;
      esac
      check_name "$name"
      if ! [[ $env =~ $ENV_RE ]]; then
        echo "dori-secret: refused variable name '$env' for $name" >&2
        exit 2
      fi
      pairs+=("$env=$name")
    done
    if [ $# -eq 0 ]; then
      echo "dori-secret: run needs -- and a command: dori-secret run dori.<name> -- <cmd> [args...]" >&2
      exit 2
    fi
    shift
    if [ ${#pairs[@]} -eq 0 ] || [ $# -eq 0 ]; then
      echo "dori-secret: run needs at least one dori.<name> before -- and a command after it" >&2
      exit 2
    fi
    for pair in "${pairs[@]}"; do
      env=${pair%%=*}
      name=${pair#*=}
      rc=0
      value=$("$SEC" find-generic-password -s "$name" -w "$KC" 2>/dev/null) || rc=$?
      if [ "$rc" -ne 0 ]; then
        unset value
        if exists "$name"; then
          echo "dori-secret: the keychain refused to give $name (security exit $rc); unlock the login keychain or allow /usr/bin/security for this item" >&2
          exit 4
        fi
        echo "dori-secret: no $name in the login keychain; the owner registers it with: security add-generic-password -U -a \"\$USER\" -s $name -w" >&2
        exit 3
      fi
      export "$env=$value"
      unset value
    done
    exec "$@"
    ;;
  has)
    [ $# -eq 1 ] || usage
    check_name "$1"
    if exists "$1"; then
      echo "$1 present"
    else
      echo "$1 missing"
      exit 1
    fi
    ;;
  list)
    [ $# -eq 0 ] || usage
    # dump-keychain without -d prints attributes only, never secret data. A service name is printed as "svce"<blob>="...".
    "$SEC" dump-keychain "$KC" 2>/dev/null | sed -n 's/^ *"svce"<blob>="\(dori\.[^"]*\)"$/\1/p' | while IFS= read -r name; do
      if [[ $name =~ $NAME_RE ]]; then printf '%s\n' "$name"; fi
    done | sort -u
    ;;
  help | -h | --help)
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    usage
    ;;
esac
