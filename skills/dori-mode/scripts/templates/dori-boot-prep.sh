#!/usr/bin/env bash
# Runs before `dori supervise` (systemd ExecStartPre). Rendered by `dori setup`.
# Waits for the herdr server. The supervisor itself finds or creates the lead
# pane and the lanes workspace and records them in dori state, so nothing here
# reads or rewrites the config. Idempotent.
set -euo pipefail

for _ in $(seq 1 60); do
  herdr workspace list >/dev/null 2>&1 && break
  sleep 2
done
herdr workspace list >/dev/null 2>&1 || { echo "BOOT_PREP herdr server not reachable" >&2; exit 1; }
echo "BOOT_PREP herdr server ready"
