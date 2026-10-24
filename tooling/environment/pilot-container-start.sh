#!/bin/sh
# WP-2423 P1: container entrypoint for the pilot supervisor.
# Each container start has a new PID namespace, so service PID files and the supervisor
# lease left by an earlier container can never name a live pilot process here. Their
# numbers can, however, collide with unrelated processes or threads in this namespace,
# which the identity checks correctly refuse to adopt. Remove only those files.
# Maintenance and restart locks are kept, so the supervisor still refuses to start
# while maintenance is in progress. Only this service may run pilot services for the
# mounted runtime directory.
set -eu
directory="/app/${PILOT_RUNTIME_DIRECTORY:?}"
for file in "$directory"/*.pid "$directory"/supervisor.lock; do
  [ -f "$file" ] || continue
  echo "pilot-container-start: removing stale $(basename "$file")"
  rm -f "$file"
done
exec node --import ./tooling/environment/register-workspace-typescript.mjs \
  tooling/environment/pilot-supervisor.mjs "$PILOT_RUNTIME_DIRECTORY"
