#!/usr/bin/env bash
# WP-2423 P4 preparation: online daily backup and restore drill for the single-host pilot database.
#
#   pilot-backup.sh backup --container <postgres container> --port <port> --database <db> \
#     --user <role> --password-file <file> --dir <backup dir> [--keep <n>] [--media <photo dir>]
#   pilot-backup.sh drill  --container <postgres container> --port <port> --database <db> \
#     --user <role> --password-file <file> --dir <backup dir> [--backup <file>] [--keep-drill]
#
# --client local (WP-2423 Q13) runs the PostgreSQL client programs on PATH instead of
# `docker exec` into --container (which is then not needed): the pilot ops container ships the
# exact client version of the server and shares its network namespace (127.0.0.1:<port>).
#
# backup: a consistent online pg_dump (custom format) taken while services keep running, written to
# a private directory, with a manifest of its SHA-256 and the row count of every table it contains
# (counted from the dump itself). Older backups beyond --keep (default 14) are removed.
#
# --media <photo dir> (WP-2423 menu photos): the pilot storage adapter's product photo directory
# (<runtime>/media/product-images). Published menus reference these customer-visible files, so a
# database restore without them breaks menus. The backup also writes <dump>.media.tar with every
# photo file (content-addressed <sha256>.jpg|webp) and records its SHA-256, the file count and how
# many files the dump's bop_media.product_image rows reference that the directory lacks. The files
# are listed after the dump: the adapter writes a photo's files before its row is inserted, so every
# row in the dump already has its files. A missing directory is a store without photos yet (the
# adapter creates it on the first upload) and gives an empty archive. Files the dump references but
# the directory lacks do not stop the backup (orders and payments must keep being backed up); they
# are recorded as mediaMissing and the drill fails with "media missing" so the restore check alerts.
#
# drill: verifies the chosen (default newest) backup against its manifest, restores it into a new
# isolated database <db>_drill_<UTC time> in the same server, compares every table's row count with
# the manifest, writes a drill record and drops the drill database (unless --keep-drill). When the
# manifest names a photo archive, the drill also verifies its SHA-256, extracts it into a scratch
# directory, requires every file's SHA-256 to equal its name and the count to match the manifest,
# and requires every photo the dump references to be present (backups made before photos were
# included have no photo archive and are checked as before).
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
container="" port="" database="" user="" password_file="" dir="" keep=14 backup="" keep_drill=0 client=docker
media=""
while [[ $# -gt 0 ]]; do
  case $1 in
  --container) container=${2:-} ;;
  --client) client=${2:-} ;;
  --port) port=${2:-} ;;
  --database) database=${2:-} ;;
  --user) user=${2:-} ;;
  --password-file) password_file=${2:-} ;;
  --dir) dir=${2:-} ;;
  --keep) keep=${2:-} ;;
  --backup) backup=${2:-} ;;
  --media) media=${2:-} ;;
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
[[ $client == docker || $client == local ]] || fail "client"
[[ $client == local || $container =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || fail "container"
[[ $port =~ ^[1-9][0-9]{0,4}$ ]] || fail "port"
[[ $database =~ $identifier ]] || fail "database"
[[ $user =~ $identifier ]] || fail "user"
[[ $keep =~ ^[1-9][0-9]{0,2}$ ]] || fail "keep"
[[ -f $password_file && ! -L $password_file ]] || fail "password file"
[[ -n $dir ]] || fail "dir"
mkdir -p "$dir"
chmod 700 "$dir"
[[ -d $dir && ! -L $dir && -O $dir ]] || fail "dir"
# A photo directory that exists must be a real directory; a missing one means no photos yet.
[[ -z $media || ( ! -L $media && ( -d $media || ! -e $media ) ) ]] || fail "media dir"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
# A client program in the database container (docker) or on PATH here (local).
tool() {
  if [[ $client == local ]]; then "$@"; else docker exec -i "$container" "$@"; fi
}
# Runs a client program; the password travels on stdin, never argv or the caller's environment.
in_container() {
  local program=$1
  shift
  { tr -d '\r\n' <"$password_file"; printf '\n'; cat; } | tool sh -c \
    'IFS= read -r p; export PGPASSWORD="$p"; exec "$@"' sh "$program" -h 127.0.0.1 -p "$port" -U "$user" "$@"
}
# Per-table row counts of a dump, from its COPY blocks (schema.table<TAB>rows), sorted.
dump_counts() {
  tool pg_restore --data-only --file=- <"$1" | awk '
    /^COPY / { table = $2; rows[table] = 0; inside = 1; next }
    inside && $0 == "\\." { inside = 0; next }
    inside { rows[table]++ }
    END { for (t in rows) printf "%s\t%d\n", t, rows[t] }' | LC_ALL=C sort
}
photo='^[0-9a-f]{64}\.(jpg|webp)$'
# Photo file names the dump's bop_media.product_image rows reference (rendition paths), sorted.
dump_photos() {
  tool pg_restore --data-only --file=- <"$1" | awk '
    /^COPY / { inside = ($2 == "bop_media.product_image"); next }
    inside && $0 == "\\." { inside = 0; next }
    inside { print }' | { grep -oE '[0-9a-f]{64}\.(jpg|webp)' || true; } | LC_ALL=C sort -u
}
# Content-addressed photo files directly in a directory (temporary upload files are skipped).
photo_files() {
  [[ -d $1 ]] || return 0
  ls -1A "$1" | { grep -E "$photo" || true; } | while read -r name; do
    [[ -f $1/$name && ! -L $1/$name ]] && printf '%s\n' "$name"
  done | LC_ALL=C sort
}
json_number() { sed -nE "s/.*\"$2\":([0-9]+)[,}].*/\\1/p" "$1"; }

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
  media_json="" media_line=""
  if [[ -n $media ]]; then
    archive="$file.media.tar"
    list="$archive.list"
    photo_files "$media" >"$list"
    source_dir=$media
    [[ -d $source_dir ]] || source_dir=$dir
    tar -cf "$archive.partial" -C "$source_dir" -T "$list" 2>/dev/null ||
      { rm -f "$partial" "$list" "$archive.partial"; fail "media archive"; }
    referenced=$(dump_photos "$partial") || { rm -f "$partial" "$list" "$archive.partial"; fail "dump read"; }
    media_files=$(grep -c . "$list" || true)
    media_referenced=$(printf '%s' "$referenced" | grep -c . || true)
    media_missing=$(printf '%s' "$referenced" | { grep -vxF -f "$list" || true; } | grep -c . || true)
    rm -f "$list"
    mv "$archive.partial" "$archive"
    media_json=$(printf '"mediaFile":"%s","mediaBytes":%s,"mediaSha256":"%s","mediaFiles":%s,"mediaReferenced":%s,"mediaMissing":%s,' \
      "$(basename "$archive")" "$(wc -c <"$archive" | tr -d ' ')" "$(sha256 "$archive")" \
      "$media_files" "$media_referenced" "$media_missing")
    media_line=" media=$media_files mediaMissing=$media_missing"
  fi
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
    printf '"bytes":%s,"sha256":"%s","serverVersion":"%s","tableCount":%s,"rowCount":%s,%s"tables":{' \
      "$bytes" "$digest" "$server" "$tables" "$rows" "$media_json"
    printf '%s\n' "$counts" | awk -F '\t' 'NR > 1 { printf "," } { printf "\"%s\":%d", $1, $2 }'
    printf '}}\n'
  } >"$file.manifest.json"
  # Retention: newest $keep backups (by name, which sorts by UTC time) are kept.
  ls -1 "$dir" | grep -E "^$database-[0-9]{8}T[0-9]{6}Z\.dump$" | LC_ALL=C sort -r |
    tail -n +"$((keep + 1))" | while read -r old; do
    rm -f "$dir/$old" "$dir/$old.manifest.json" "$dir/$old.media.tar"
  done
  echo "PILOT_BACKUP_CREATED $(basename "$file") tables=$tables rows=$rows bytes=$bytes$media_line"
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
media_line="" media_record=""
media_name=$(sed -nE 's/.*"mediaFile":"([^"]+)".*/\1/p' "$manifest")
if [[ -n $media_name ]]; then
  [[ $media_name == "$(basename "$backup").media.tar" ]] || fail "media archive missing"
  archive="$(dirname "$backup")/$media_name"
  [[ -f $archive ]] || fail "media archive missing"
  [[ $(sha256 "$archive") == "$(sed -nE 's/.*"mediaSha256":"([0-9a-f]{64})".*/\1/p' "$manifest")" ]] ||
    fail "media checksum mismatch"
  # Only content-addressed names directly in the archive root are extracted (no paths).
  entries=$(tar -tf "$archive") || fail "media archive"
  [[ -z $entries ]] || ! printf '%s\n' "$entries" | grep -vqE "$photo" || fail "media archive"
  scratch=$(mktemp -d "$dir/drill-media.XXXXXX")
  trap 'rm -rf "$scratch"' EXIT
  tar -xf "$archive" -C "$scratch" 2>/dev/null || fail "media archive"
  restored_photos=$(photo_files "$scratch")
  [[ $(ls -1A "$scratch" | grep -c . || true) == $(printf '%s' "$restored_photos" | grep -c . || true) ]] ||
    fail "media differs"
  while read -r name; do
    [[ -z $name || $(sha256 "$scratch/$name") == "${name%.*}" ]] || fail "media differs"
  done <<<"$restored_photos"
  media_files=$(printf '%s' "$restored_photos" | grep -c . || true)
  [[ $media_files == "$(json_number "$manifest" mediaFiles)" ]] || fail "media differs"
  missing=$(dump_photos "$backup" | { grep -vxF -f <(printf '%s\n' "$restored_photos") || true; } |
    grep -c . || true)
  [[ $missing == 0 ]] || { echo "PILOT_RESTORE_MEDIA_MISSING files=$missing" >&2; fail "media missing"; }
  rm -rf "$scratch"
  trap - EXIT
  media_line=" media=$media_files"
  media_record=",\"mediaFiles\":$media_files"
fi
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
# pg_restore's own messages go to a private file beside the backups (same trust boundary as the
# dump); on failure only its exit status and that file's name are printed, and the ops monitor
# records a classified reason without data values.
errors="$dir/drill-$(date -u +%Y%m%dT%H%M%SZ).restore-errors.txt"
restore_failed() {
  echo "PILOT_RESTORE_FAILED exit=$1 errors=$(basename "$errors")" >&2
  fail "restore"
}
set +e
if [[ $client == local ]]; then
  # A seekable file argument: pg_restore reads only what it needs, nothing is piped.
  { tr -d '\r\n' <"$password_file"; printf '\n'; } | sh -c \
    'IFS= read -r p; export PGPASSWORD="$p"; exec pg_restore -h 127.0.0.1 -p "$1" -U "$2" --dbname="$3" --exit-on-error --single-transaction "$4"' \
    sh "$port" "$user" "$drill" "$backup" 2>"$errors"
  statuses=("${PIPESTATUS[@]}")
  restore_status=${statuses[1]} writer_status=${statuses[0]}
else
  # Streamed into the database container. pg_restore stops reading after the last item it needs,
  # so the writer may end with SIGPIPE (141); success is pg_restore's own exit status (with
  # --exit-on-error every item was restored), and the row counts are compared below.
  { tr -d '\r\n' <"$password_file"; printf '\n'; cat "$backup"; } | tool sh -c \
    'IFS= read -r p; export PGPASSWORD="$p"; exec pg_restore -h 127.0.0.1 -p "$1" -U "$2" --dbname="$3" --exit-on-error --single-transaction' \
    sh "$port" "$user" "$drill" 2>"$errors"
  statuses=("${PIPESTATUS[@]}")
  restore_status=${statuses[1]} writer_status=${statuses[0]}
  [[ $writer_status == 141 ]] && writer_status=0
fi
set -e
[[ $restore_status == 0 ]] || restore_failed "$restore_status"
[[ $writer_status == 0 ]] || restore_failed "input-$writer_status"
rm -f "$errors"
query=""
while IFS=$'\t' read -r table _; do
  [[ $table =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] || fail "table name"
  query+="${query:+ UNION ALL }SELECT '$table'||chr(9)||count(*) FROM ONLY $table"
done <<<"$manifest_counts"
restored=$(in_container psql --dbname="$drill" -AtX -c "SET row_security = off" -c "$query" </dev/null |
  grep -v '^SET$' | LC_ALL=C sort)
if [[ $restored != "$manifest_counts" ]]; then
  # The first table whose restored count differs (a schema.table identifier, never row data).
  differing=$(diff <(printf '%s\n' "$manifest_counts") <(printf '%s\n' "$restored") |
    sed -nE 's/^[<>] ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\t.*/\1/p' | head -n 1) || true
  echo "PILOT_RESTORE_DIFFERS table=${differing:-unknown}" >&2
  fail "restored rows differ from backup"
fi
seconds=$(($(date -u +%s) - started))
tables=$(printf '%s\n' "$manifest_counts" | wc -l | tr -d ' ')
rows=$(printf '%s\n' "$manifest_counts" | awk -F '\t' '{s += $2} END {print s}')
record="$dir/drill-$(date -u +%Y%m%dT%H%M%SZ).json"
printf '{"schemaVersion":1,"backup":"%s","sha256":"%s","drillDatabase":"%s","tables":%s,"rows":%s%s,"restoreSeconds":%s,"result":"Matched","drillDatabaseKept":%s}\n' \
  "$(basename "$backup")" "$expected" "$drill" "$tables" "$rows" "$media_record" "$seconds" \
  "$([[ $keep_drill == 1 ]] && echo true || echo false)" >"$record"
echo "PILOT_RESTORE_DRILL_MATCHED $(basename "$backup") tables=$tables rows=$rows${media_line} restoreSeconds=$seconds"
