#!/bin/sh
# WP-2423 P1: per-container state a new container start removes, for the installation directory
# given. Each container start has a new PID namespace, so service PID files and the supervisor
# lease left by an earlier container can never name a live pilot process here. Their numbers can,
# however, collide with unrelated processes or threads in this namespace, which the identity checks
# correctly refuse to adopt. Remove only those files. Maintenance and restart locks are kept, so the
# supervisor still refuses to start while maintenance is in progress.
# DEC-BRAND-MULTI-STORE (v15 2026-10-31): the same for every served Store's directory
# (`stores/<name>/*.pid`); a Store has no supervisor lease of its own.
set -eu
directory="${1:?}"
for file in "$directory"/*.pid "$directory"/supervisor.lock; do
  [ -f "$file" ] || continue
  echo "pilot-container-start: removing stale $(basename "$file")"
  rm -f "$file"
done
for file in "$directory"/stores/*/*.pid; do
  [ -f "$file" ] || continue
  echo "pilot-container-start: removing stale ${file#"$directory"/}"
  rm -f "$file"
done
