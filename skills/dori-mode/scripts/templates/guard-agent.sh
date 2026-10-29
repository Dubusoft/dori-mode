#!/bin/sh
# dori guard agent: prints one host-metrics line; invoked over ssh, no daemon.
# usage: guard-agent.sh sample [DISK_PATH] | version

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
  load1=-1 mem=-1 swap=-1 disk=-1
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
      ;;
    Linux)
      os=linux
      load1=$(awk '{ print $1 }' /proc/loadavg 2>/dev/null)
      mem=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 }
        END { if (t > 0 && a != "") printf "%d", a / t * 100 + 0.5 }' /proc/meminfo 2>/dev/null)
      swap=$(awk '/^SwapFree:/ { printf "%.4f", $2 / 1048576 }' /proc/meminfo 2>/dev/null)
      ;;
    *) os=other ;;
  esac
  disk=$(df -k "$disk_path" 2>/dev/null | awk 'END { if (NR > 1) print $4 / 1048576 }')
  load1=$(num2 "$load1")
  swap=$(num2 "$swap")
  disk=$(num2 "$disk")
  case $mem in
    '' | *[!0-9]*) mem=-1 ;;
  esac
  printf 'DORI_GUARD_SAMPLE version=%s os=%s load1=%s mem_free_pct=%s swap_free_gb=%s disk_free_gb=%s\n' \
    "$(version)" "$os" "$load1" "$mem" "$swap" "$disk"
}

case ${1:-} in
  sample) sample "${2:-}" ;;
  version) version ;;
  *)
    echo "usage: $0 sample [DISK_PATH] | version" >&2
    exit 2
    ;;
esac
