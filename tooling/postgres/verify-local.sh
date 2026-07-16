#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly COMPOSE_FILE="$ROOT_DIR/compose.yaml"
readonly PROJECT_NAME="${BOP_RMS_VERIFY_PROJECT:-bop-rms-wp0005-verify}"
readonly HOST_PORT="${BOP_RMS_VERIFY_PORT:-55432}"
readonly POSTGRES_DB="bop_rms_wp0005_verify"
readonly POSTGRES_USER="bop_rms_wp0005_verify"
readonly IMAGE_REF="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly EXPECTED_INDEX_DIGEST="sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly SYNTHETIC_PASSWORD="wp0005-synthetic-only-9e2d70f9"
readonly SYNTHETIC_MARKER="wp0005-synthetic-persistence-probe"

case "$PROJECT_NAME" in
  bop-rms-wp0005-verify | bop-rms-wp0005-verify-[a-z0-9]*) ;;
  *)
    printf 'Refusing unsafe verification project name: %s\n' "$PROJECT_NAME" >&2
    exit 1
    ;;
esac

case "$HOST_PORT" in
  '' | *[!0-9]*)
    printf 'BOP_RMS_VERIFY_PORT must be numeric.\n' >&2
    exit 1
    ;;
esac

readonly TEMP_DIR="$(mktemp -d -t bop-rms-wp0005-verify.XXXXXX)"
readonly SECRET_FILE="$TEMP_DIR/postgres_password"
readonly ENV_FILE="$TEMP_DIR/compose.env"
readonly PGPASS_FILE="$TEMP_DIR/pgpass"
readonly CONFIG_JSON="$TEMP_DIR/compose-config.json"
readonly LOG_FILE="$TEMP_DIR/postgres.log"
readonly CLIENT_NAME="${PROJECT_NAME}-client"

compose() {
  docker compose \
    --project-directory "$ROOT_DIR" \
    --project-name "$PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

remove_client() {
  docker rm --force "$CLIENT_NAME" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  remove_client
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

fail() {
  printf 'WP-0005 verification failed: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label expected '$expected' but received '$actual'"
  fi
}

assert_project_absent() {
  if [[ -n "$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME")" ]]; then
    fail "verification container remains after scoped clean reset"
  fi
  if [[ -n "$(docker network ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME")" ]]; then
    fail "verification network remains after scoped clean reset"
  fi
  if [[ -n "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME")" ]]; then
    fail "verification volume remains after scoped clean reset"
  fi
}

wait_for_health() {
  local container_id
  container_id="$(compose ps --quiet postgres)"
  [[ -n "$container_id" ]] || fail "PostgreSQL container was not created"
  local attempt
  for attempt in $(seq 1 60); do
    if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" == "healthy" ]]; then
      return
    fi
    sleep 1
  done
  compose ps --all >&2 || true
  compose logs --no-color postgres >&2 || true
  fail "PostgreSQL did not become healthy"
}

psql_host() {
  remove_client
  docker run --rm \
    --name "$CLIENT_NAME" \
    --label com.bop-rms.owner=wp-0005-verification \
    --network host \
    --volume "$PGPASS_FILE:/run/secrets/pgpass:ro" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "$IMAGE_REF" \
    psql --no-psqlrc --host 127.0.0.1 --port "$HOST_PORT" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --set ON_ERROR_STOP=1 "$@"
}

verify_runtime_contract() {
  assert_equal "180004" "$(psql_host --command "SELECT current_setting('server_version_num')")" "server version number"
  assert_equal "UTF8" "$(psql_host --command 'SHOW server_encoding')" "server encoding"
  assert_equal "C|C" "$(psql_host --command "SELECT datcollate || '|' || datctype FROM pg_database WHERE datname = current_database()")" "database collation and character classification"
  assert_equal "UTC" "$(psql_host --command 'SHOW TimeZone')" "session timezone"
  assert_equal "ISO, YMD" "$(psql_host --command 'SHOW DateStyle')" "DateStyle"
}

verify_scoped_resources() {
  local container_id
  container_id="$(compose ps --quiet postgres)"
  assert_equal "$PROJECT_NAME" "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")" "container Compose project label"
  assert_equal "wp-0005" "$(docker inspect --format '{{index .Config.Labels "com.bop-rms.owner"}}' "$container_id")" "container owner label"

  local network_count volume_count
  network_count="$(docker network ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" | wc -l | tr -d ' ')"
  volume_count="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" | wc -l | tr -d ' ')"
  assert_equal "1" "$network_count" "project network count"
  assert_equal "1" "$volume_count" "project named volume count"
}

verify_logs() {
  compose logs --no-color postgres > "$LOG_FILE"
  if grep --fixed-strings --quiet "$SYNTHETIC_PASSWORD" "$LOG_FILE"; then
    fail "synthetic password leaked into container logs"
  fi
  if grep --fixed-strings --quiet "$SYNTHETIC_MARKER" "$LOG_FILE"; then
    fail "synthetic probe data leaked into container logs"
  fi
}

printf '%s' "$SYNTHETIC_PASSWORD" > "$SECRET_FILE"
chmod 0600 "$SECRET_FILE"
printf 'BOP_RMS_POSTGRES_PASSWORD_FILE=%s\nBOP_RMS_POSTGRES_PORT=%s\nBOP_RMS_POSTGRES_DB=%s\nBOP_RMS_POSTGRES_USER=%s\n' \
  "$SECRET_FILE" "$HOST_PORT" "$POSTGRES_DB" "$POSTGRES_USER" > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
printf '127.0.0.1:%s:%s:%s:%s\n' "$HOST_PORT" "$POSTGRES_DB" "$POSTGRES_USER" "$SYNTHETIC_PASSWORD" > "$PGPASS_FILE"
chmod 0600 "$PGPASS_FILE"

if docker compose --project-directory "$ROOT_DIR" --project-name "$PROJECT_NAME" --env-file /dev/null --file "$COMPOSE_FILE" config --quiet > "$TEMP_DIR/missing-env.out" 2>&1; then
  fail "Compose config succeeded without the required password-file variable"
fi
grep --fixed-strings --quiet BOP_RMS_POSTGRES_PASSWORD_FILE "$TEMP_DIR/missing-env.out" || fail "missing-variable failure was not understandable"

compose config --quiet
compose config --format json > "$CONFIG_JSON"
node --input-type=module --eval '
  import fs from "node:fs";
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const postgres = config.services?.postgres;
  if (!postgres) throw new Error("postgres service is missing");
  if (postgres.image !== process.argv[2]) throw new Error(`unexpected image: ${postgres.image}`);
  const ports = postgres.ports ?? [];
  if (ports.length !== 1 || ports[0].host_ip !== "127.0.0.1" || ports[0].target !== 5432) {
    throw new Error(`PostgreSQL port is not localhost-only: ${JSON.stringify(ports)}`);
  }
  if (!postgres.healthcheck?.test?.join(" ").includes("pg_isready")) throw new Error("connection healthcheck is missing");
  if ((postgres.environment ?? {}).POSTGRES_PASSWORD !== undefined) throw new Error("password must not be a container environment variable");
' "$CONFIG_JSON" "$IMAGE_REF"

compose down --volumes --remove-orphans >/dev/null 2>&1 || true
assert_project_absent
compose pull --quiet postgres
compose up --detach --wait --wait-timeout 120 postgres
wait_for_health
verify_scoped_resources

readonly CONTAINER_ID="$(compose ps --quiet postgres)"
readonly REPO_DIGESTS="$(docker image inspect "$IMAGE_REF" --format '{{join .RepoDigests "\n"}}')"
grep --fixed-strings --quiet "$EXPECTED_INDEX_DIGEST" <<< "$REPO_DIGESTS" || fail "pulled image does not record the pinned OCI digest"
assert_equal "$IMAGE_REF" "$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_ID")" "container image reference"

verify_runtime_contract
psql_host --command "CREATE TABLE public.wp0005_persistence_probe (marker text PRIMARY KEY); INSERT INTO public.wp0005_persistence_probe(marker) VALUES ('$SYNTHETIC_MARKER')" >/dev/null
compose restart postgres >/dev/null
wait_for_health
assert_equal "$SYNTHETIC_MARKER" "$(psql_host --command 'SELECT marker FROM public.wp0005_persistence_probe')" "restart persistence probe"
verify_logs

compose down --volumes --remove-orphans
assert_project_absent
compose up --detach --wait --wait-timeout 120 postgres
wait_for_health
verify_scoped_resources
verify_runtime_contract
assert_equal "" "$(psql_host --command "SELECT COALESCE(to_regclass('public.wp0005_persistence_probe')::text, '')")" "clean-reset probe absence"
verify_logs

compose down --volumes --remove-orphans
assert_project_absent
printf 'WP-0005 PostgreSQL local environment verification passed.\n'
