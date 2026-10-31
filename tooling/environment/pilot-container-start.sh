#!/bin/sh
# WP-2423 P1: container entrypoint for the pilot supervisor.
# Stale PID files and the supervisor lease of the installation and of every served Store are
# removed first (pilot-container-clean.sh); maintenance and restart locks are kept. Only this
# service may run pilot services for the mounted runtime directory.
set -eu
sh tooling/environment/pilot-container-clean.sh "/app/${PILOT_RUNTIME_DIRECTORY:?}"
exec node --import ./tooling/environment/register-workspace-typescript.mjs \
  tooling/environment/pilot-supervisor.mjs "$PILOT_RUNTIME_DIRECTORY"
