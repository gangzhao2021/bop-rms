#!/bin/sh
# WP-2423 Q13: container entrypoint for the operations monitor (compose service `ops`).
# A new container has a new PID namespace, so a monitor lock left by an earlier container can
# never name a live monitor; only this service runs the monitor for the mounted runtime directory.
set -eu
lock="/app/${PILOT_RUNTIME_DIRECTORY:?}/ops/monitor.lock"
if [ -f "$lock" ]; then
  echo "pilot-ops-container-start: removing stale monitor.lock"
  rm -f "$lock"
fi
exec node --import ./tooling/environment/register-workspace-typescript.mjs \
  tooling/environment/pilot-ops.mjs run "$PILOT_RUNTIME_DIRECTORY"
