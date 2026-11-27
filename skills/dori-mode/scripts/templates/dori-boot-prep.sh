#!/usr/bin/env bash
# Runs before `dori supervise` (systemd ExecStartPre). Rendered by `dori setup`.
# Nothing to wait for: hc-core.service brings hc's core up at boot and the hc client starts it on demand. The
# supervisor itself finds or creates the lead's hc terminal and records it in dori state, so nothing here reads or
# rewrites the config. Idempotent.
set -euo pipefail

echo "BOOT_PREP hc starts its core on demand; nothing to wait for"
