#!/usr/bin/env bash
# WP-2423 P4 preparation: online daily backup and restore drill for the single-host pilot database.
#
#   pilot-backup.sh backup --container <postgres container> --port <port> --database <db> \
#     --user <role> --password-file <file> --dir <backup dir> [--keep <n>]
#   pilot-backup.sh drill  --container <postgres container> --port <port> --database <db> \
#     --user <role> --password-file <file> --dir <backup dir> [--backup <file>] [--keep-drill]
#
# backup: a consistent online pg_dump (custom format) taken while services keep running, written to
# a private directory, with a manifest of its SHA-256 and the row count of every table it contains
# (counted from the dump itself). Older backups beyond --keep (default 14) are removed.
#
# drill: verifies the chosen (default newest) backup against its manifest, restores it into a new
# isolated database <db>_drill_<UTC time> in the same server, compares every table's row count with
# the manifest, writes a drill record and drops the drill database (unless --keep-drill).
#
# Needs only docker on the host. Never prints credentials, connection strings or row contents.
# Off-host copies must be encrypted by their storage (P4); the local copy has the same trust
# boundary as the database volume on this host.
set -euo pipefail
umask 077

fail() {
  echo "PILOT_BACKUP_UNAVAILABLE: $1" >&2
  exit 1
}
command=${1:-}
[[ $command == backup || $command == drill ]] || fail "usage"
shift
container="" port="" database="" user="" password_file="" dir="" keep=14 backup="" keep_drill=0
while [[ $# -gt 0 ]]; do
  case $1 in
  --container) container=${2:-} ;;
  --port) port=${2:-} ;;
  --database) database=${2:-} ;;
  --user) user=${2:-} ;;
  --password-file) password_file=${2:-} ;;
  --dir) dir=${2:-} ;;
  --keep) keep=${2:-} ;;
  --backup) backup=${2:-} ;;
  --keep-drill)
    keep_drill=1
    shift
    continue
    ;;
  *) fail "usage" ;;
  esac
  shift 2 || fail "usage"
done
identifier='^[a-z][a-z0-9_]{0,40}$'
[[ $container =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || fail "container"
[[ $port =~ ^[1-9][0-9]{0,4}$ ]] || fail "port"
[[ $database =~ $identifier ]] || fail "database"
[[ $user =~ $identifier ]] || fail "user"
[[ $keep =~ ^[1-9][0-9]{0,2}$ ]] || fail "keep"
[[ -f $password_file && ! -L $password_file ]] || fail "password file"
[[ -n $dir ]] || fail "dir"
mkdir -p "$dir"
chmod 700 "$dir"
[[ -d $dir && ! -L $dir && -O $dir ]] || fail "dir"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
# Runs a client program in the database container; the password travels on stdin, never argv/env.
in_container() {
  local program=$1
  shift
  { cat "$password_file"; printf '\n'; cat; } | docker exec -i "$container" sh -c \
    'IFS= read -r p; export PGPASSWORD="$p"; exec "$@"' sh "$program" -h 127.0.0.1 -p "$port" -U "$user" "$@"
}
# Per-table row counts of a dump, from its COPY blocks (schema.table<TAB>rows), sorted.
dump_counts() {
  docker exec -i "$container" pg_restore --data-only --file=- <"$1" | awk '
    /^COPY / { table = $2; rows[table] = 0; inside = 1; next }
    inside && $0 == "\\." { inside = 0; next }
    inside { rows[table]++ }
    END { for (t in rows) printf "%s\t%d\n", t, rows[t] }' | LC_ALL=C sort
}

if [[ $command == backup ]]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$dir/$database-$stamp.dump"
  partial="$file.partial"
  [[ ! -e $file && ! -e $partial ]] || fail "backup exists"
  # pg_dump takes one consistent snapshot; services keep running.
  in_container pg_dump --dbname="$database" --format=custom --compress=6 </dev/null >"$partial" ||
    { rm -f "$partial"; fail "pg_dump"; }
  counts=$(dump_counts "$partial") || { rm -f "$partial"; fail "dump read"; }
  [[ -n $counts ]] || { rm -f "$partial"; fail "empty dump"; }
  sync
  mv "$partial" "$file"
  digest=$(sha256 "$file")
  bytes=$(wc -c <"$file" | tr -d ' ')
  tables=$(printf '%s\n' "$counts" | wc -l | tr -d ' ')
  rows=$(printf '%s\n' "$counts" | awk -F '\t' '{s += $2} END {print s}')
  server=$(in_container psql --dbname="$database" -AtX -c 'SHOW server_version' </dev/null)
  {
    printf '{"schemaVersion":1,"database":"%s","createdAt":"%s","file":"%s",' \
      "$database" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$file")"
    printf '"bytes":%s,"sha256":"%s","serverVersion":"%s","tableCount":%s,"rowCount":%s,"tables":{' \
      "$bytes" "$digest" "$server" "$tables" "$rows"
    printf '%s\n' "$counts" | awk -F '\t' 'NR > 1 { printf "," } { printf "\"%s\":%d", $1, $2 }'
    printf '}}\n'
  } >"$file.manifest.json"
  # Retention: newest $keep backups (by name, which sorts by UTC time) are kept.
  ls -1 "$dir" | grep -E "^$database-[0-9]{8}T[0-9]{6}Z\.dump$" | LC_ALL=C sort -r |
    tail -n +"$((keep + 1))" | while read -r old; do
    rm -f "$dir/$old" "$dir/$old.manifest.json"
  done
  echo "PILOT_BACKUP_CREATED $(basename "$file") tables=$tables rows=$rows bytes=$bytes"
  exit 0
fi

# drill
if [[ -z $backup ]]; then
  backup=$(ls -1 "$dir" | grep -E "^$database-[0-9]{8}T[0-9]{6}Z\.dump$" | LC_ALL=C sort -r | head -n 1)
  [[ -n $backup ]] || fail "no backup"
  backup="$dir/$backup"
fi
manifest="$backup.manifest.json"
[[ -f $backup && -f $manifest ]] || fail "backup or manifest missing"
expected=$(sed -E 's/.*"sha256":"([0-9a-f]{64})".*/\1/' "$manifest")
[[ $(sha256 "$backup") == "$expected" ]] || fail "checksum mismatch"
manifest_counts=$(sed -E 's/.*"tables":\{(.*)\}\}/\1/' "$manifest" | tr ',' '\n' |
  sed -E 's/^"([^"]+)":([0-9]+)$/\1\t\2/' | LC_ALL=C sort)
[[ $(dump_counts "$backup") == "$manifest_counts" ]] || fail "dump differs from manifest"
drill="${database}_drill_$(date -u +%Y%m%d%H%M%S)"
[[ $drill =~ ^[a-z][a-z0-9_]{0,62}$ ]] || fail "drill name"
exists=$(in_container psql --dbname=postgres -AtX -c \
  "SELECT count(*) FROM pg_database WHERE datname = '$drill'" </dev/null)
[[ $exists == 0 ]] || fail "drill database exists"
cleanup() {
  if [[ $keep_drill == 0 ]]; then
    in_container psql --dbname=postgres -qAtX -c "DROP DATABASE IF EXISTS \"$drill\"" </dev/null >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
in_container psql --dbname=postgres -qAtX -c "CREATE DATABASE \"$drill\"" </dev/null >/dev/null ||
  fail "create drill database"
started=$(date -u +%s)
{ cat "$password_file"; printf '\n'; cat "$backup"; } | docker exec -i "$container" sh -c \
  'IFS= read -r p; export PGPASSWORD="$p"; exec pg_restore -h 127.0.0.1 -p "$1" -U "$2" --dbname="$3" --exit-on-error --single-transaction' \
  sh "$port" "$user" "$drill" || fail "restore"
query=""
while IFS=$'\t' read -r table _; do
  [[ $table =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] || fail "table name"
  query+="${query:+ UNION ALL }SELECT '$table'||chr(9)||count(*) FROM ONLY $table"
done <<<"$manifest_counts"
restored=$(in_container psql --dbname="$drill" -AtX -c "SET row_security = off" -c "$query" </dev/null |
  grep -v '^SET$' | LC_ALL=C sort)
[[ $restored == "$manifest_counts" ]] || fail "restored rows differ from backup"
seconds=$(($(date -u +%s) - started))
tables=$(printf '%s\n' "$manifest_counts" | wc -l | tr -d ' ')
rows=$(printf '%s\n' "$manifest_counts" | awk -F '\t' '{s += $2} END {print s}')
record="$dir/drill-$(date -u +%Y%m%dT%H%M%SZ).json"
printf '{"schemaVersion":1,"backup":"%s","sha256":"%s","drillDatabase":"%s","tables":%s,"rows":%s,"restoreSeconds":%s,"result":"Matched","drillDatabaseKept":%s}\n' \
  "$(basename "$backup")" "$expected" "$drill" "$tables" "$rows" "$seconds" \
  "$([[ $keep_drill == 1 ]] && echo true || echo false)" >"$record"
echo "PILOT_RESTORE_DRILL_MATCHED $(basename "$backup") tables=$tables rows=$rows restoreSeconds=$seconds"
