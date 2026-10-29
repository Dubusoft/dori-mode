#!/bin/sh
# dori guard agent: prints one host-metrics line; invoked over ssh, no daemon.
# usage: guard-agent.sh sample [DISK_PATH] | version | kill PATTERN... | heavy LABEL -- CMD...

dir=$(dirname "$0")

version() {
  v=
  if [ -r "$dir/guard-agent.version" ]; then
    v=$(head -n 1 "$dir/guard-agent.version" 2>/dev/null | tr -d '[:space:]')
  fi
  [ -n "$v" ] || v=unknown
  printf '%s\n' "$v"
}

# float with 2 decimals, or -1 when the input is not a number
num2() {
  awk -v v="$1" 'BEGIN { if (v ~ /^[0-9]+(\.[0-9]+)?$/) printf "%.2f", v; else printf "-1" }'
}

sample() {
  disk_path=${1:-$HOME}
  load1=-1 mem=-1 swap=-1 swaptotal=-1 disk=-1
  case $(uname -s 2>/dev/null) in
    Darwin)
      os=darwin
      load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{ gsub(/[{}]/, ""); print $1 }')
      mem=$(memory_pressure -Q 2>/dev/null | awk '/free percentage/ { gsub(/[^0-9]/, "", $NF); print $NF }')
      swap=$(sysctl -n vm.swapusage 2>/dev/null | awk '{
        for (i = 1; i <= NF; i++) if ($i == "free" && $(i + 1) == "=") {
          s = $(i + 2); u = substr(s, length(s)); sub(/[A-Za-z]$/, "", s)
          if (u == "M") printf "%.4f", s / 1024
          else if (u == "G") printf "%.4f", s
          else if (u == "K") printf "%.4f", s / 1048576
        } }')
      swaptotal=$(sysctl -n vm.swapusage 2>/dev/null | awk '{
        for (i = 1; i <= NF; i++) if ($i == "total" && $(i + 1) == "=") {
          s = $(i + 2); u = substr(s, length(s)); sub(/[A-Za-z]$/, "", s)
          if (u == "M") printf "%.4f", s / 1024
          else if (u == "G") printf "%.4f", s
          else if (u == "K") printf "%.4f", s / 1048576
        } }')
      ;;
    Linux)
      os=linux
      load1=$(awk '{ print $1 }' /proc/loadavg 2>/dev/null)
      mem=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 }
        END { if (t > 0 && a != "") printf "%d", a / t * 100 + 0.5 }' /proc/meminfo 2>/dev/null)
      swap=$(awk '/^SwapFree:/ { printf "%.4f", $2 / 1048576 }' /proc/meminfo 2>/dev/null)
      swaptotal=$(awk '/^SwapTotal:/ { printf "%.4f", $2 / 1048576 }' /proc/meminfo 2>/dev/null)
      ;;
    *) os=other ;;
  esac
  disk=$(df -k "$disk_path" 2>/dev/null | awk 'END { if (NR > 1) print $4 / 1048576 }')
  load1=$(num2 "$load1")
  swap=$(num2 "$swap")
  swaptotal=$(num2 "$swaptotal")
  disk=$(num2 "$disk")
  case $mem in
    '' | *[!0-9]*) mem=-1 ;;
  esac
  printf 'DORI_GUARD_SAMPLE version=%s os=%s load1=%s mem_free_pct=%s swap_free_gb=%s swap_total_gb=%s disk_free_gb=%s\n' \
    "$(version)" "$os" "$load1" "$mem" "$swap" "$swaptotal" "$disk"
}

# true when pid $1 is running (a zombie counts as gone)
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null) in
    '' | Z*) return 1 ;;
  esac
  return 0
}

# kill PATTERN...: end this user's processes whose full command line contains any PATTERN (fixed string),
# never this script or its ancestors. TERM, wait up to 5 s, then KILL.
kill_procs() {
  if [ $# -eq 0 ]; then
    echo "usage: $0 kill PATTERN..." >&2
    exit 2
  fi
  skip=" $$ "
  p=$$
  while :; do
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d '[:space:]')
    case $p in '' | 0) break ;; esac
    case $skip in *" $p "*) break ;; esac
    skip="$skip$p "
  done
  pats=$(printf '%s\n' "$@")
  # list first, then filter: a forked copy of this script must not be caught mid-pipeline
  psout=$(ps -u "$(id -un)" -o pid= -o rss= -o args= 2>/dev/null)
  found=$(printf '%s\n' "$psout" | PATS=$pats SKIP=$skip awk '
    BEGIN { n = split(ENVIRON["PATS"], pats, "\n"); skip = ENVIRON["SKIP"] }
    {
      pid = $1; rss = $2
      if (index(skip, " " pid " ") > 0) next
      args = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "", args)
      hit = 0
      for (i = 1; i <= n; i++) if (pats[i] != "" && index(args, pats[i]) > 0) hit = 1
      if (!hit) next
      cmd = args; sub(/[ \t].*/, "", cmd); sub(/.*\//, "", cmd)
      gsub(/[^A-Za-z0-9._:+-]/, "_", cmd)
      if (cmd == "") cmd = "_"
      print pid, rss, cmd
    }')
  [ -n "$found" ] || { echo "DORI_GUARD_KILL_DONE count=0"; return 0; }
  pids=$(printf '%s\n' "$found" | awk '{ print $1 }')
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null; done
  i=0
  while [ $i -lt 25 ]; do
    any=
    for pid in $pids; do alive "$pid" && any=1; done
    [ -n "$any" ] || break
    sleep 0.2
    i=$((i + 1))
  done
  for pid in $pids; do alive "$pid" && kill -KILL "$pid" 2>/dev/null; done
  printf '%s\n' "$found" | awk '{ printf "DORI_GUARD_KILLED pid=%s rss_kb=%s cmd=%s\n", $1, $2, $3 }'
  printf 'DORI_GUARD_KILL_DONE count=%s\n' "$(printf '%s\n' "$found" | wc -l | tr -d '[:space:]')"
}

heavy_release() {
  [ -n "$heavy_slot" ] || return 0
  rm -rf "$heavy_slot"
  heavy_slot=
}

heavy_abort() {
  [ -z "$heavy_child" ] || kill -TERM "$heavy_child" 2>/dev/null
  heavy_release
  trap - EXIT
  exit "$1"
}

# heavy LABEL -- CMD...: run CMD while holding one of DORI_HEAVY_SLOTS (default 1) per-machine slots.
heavy_run() {
  if [ $# -lt 1 ]; then
    echo "usage: $0 heavy LABEL -- CMD..." >&2
    exit 2
  fi
  label=$1
  shift
  [ "${1:-}" = -- ] && shift
  if [ $# -eq 0 ]; then
    echo "usage: $0 heavy LABEL -- CMD..." >&2
    exit 2
  fi
  root=$HOME/.dori/heavy
  mkdir -p "$root" || exit 1
  slots=${DORI_HEAVY_SLOTS:-1}
  poll=${DORI_HEAVY_POLL_SEC:-15}
  heavy_slot= heavy_child= warned=
  while [ -z "$heavy_slot" ]; do
    n=1
    holder=
    while [ "$n" -le "$slots" ]; do
      d=$root/slot.$n
      if mkdir "$d" 2>/dev/null; then
        heavy_slot=$d
        break
      fi
      holder=$(cat "$d/owner" 2>/dev/null)
      opid=${holder%% *}
      if [ -n "$opid" ] && ! alive "$opid"; then
        rm -rf "$d" # owner died without releasing
        continue
      fi
      n=$((n + 1))
    done
    [ -z "$heavy_slot" ] || break
    if [ -z "$warned" ]; then
      echo "DORI_HEAVY_WAITING $label slot held by $holder" >&2
      warned=1
    fi
    sleep "$poll"
  done
  printf '%s %s %s\n' "$$" "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$heavy_slot/owner"
  trap 'heavy_abort 130' INT
  trap 'heavy_abort 143' TERM
  trap 'heavy_abort 1' EXIT
  "$@" <&0 &
  heavy_child=$!
  wait "$heavy_child"
  rc=$?
  heavy_child=
  heavy_release
  trap - EXIT
  exit "$rc"
}

case ${1:-} in
  sample) sample "${2:-}" ;;
  version) version ;;
  kill) shift; kill_procs "$@" ;;
  heavy) shift; heavy_run "$@" ;;
  *)
    echo "usage: $0 sample [DISK_PATH] | version | kill PATTERN... | heavy LABEL -- CMD..." >&2
    exit 2
    ;;
esac
