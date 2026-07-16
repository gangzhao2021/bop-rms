# PostgreSQL local environment

This directory owns only the WP-0005 PostgreSQL `18.4` local Compose lifecycle. It is not a production deployment, migration runner, application database integration, seed framework, backup/restore procedure, or WP-0006 all-service launcher.

## One-time secret setup

Run from the repository root in the accepted WSL distribution:

```bash
cp .env.example .env
install -d -m 0700 .local/postgres
umask 077
read -r -s -p 'Local PostgreSQL password: ' BOP_RMS_LOCAL_POSTGRES_PASSWORD
printf '\n'
printf '%s' "$BOP_RMS_LOCAL_POSTGRES_PASSWORD" > .local/postgres/password
unset BOP_RMS_LOCAL_POSTGRES_PASSWORD
chmod 0600 .env .local/postgres/password
```

Use a unique local-only password. Do not reuse a production, Provider, personal, or shared credential. `.env` and `.local/` are ignored by Git. Compose mounts the password as a Docker secret; it is not placed in the container environment, command, healthcheck, or normal logs.

Compose intentionally fails with a clear `BOP_RMS_POSTGRES_PASSWORD_FILE` error when the required input is absent. Before start, confirm the referenced file exists and is readable only by the local user.

## Project-scoped lifecycle

The default project is `bop-rms-local`. Its resources are:

- service: `postgres`
- container: `bop-rms-local-postgres-1`
- network: `bop-rms-local_postgres`
- named volume: `bop-rms-local_postgres-data`
- host endpoint: `127.0.0.1:5432` by default
- healthcheck: `pg_isready` over TCP against the configured database and user

Always supply the explicit project name for lifecycle and cleanup commands:

```bash
docker compose --project-name bop-rms-local --env-file .env config --quiet
docker compose --project-name bop-rms-local --env-file .env pull postgres
docker compose --project-name bop-rms-local --env-file .env up --detach --wait postgres
docker compose --project-name bop-rms-local --env-file .env ps
docker compose --project-name bop-rms-local --env-file .env logs --no-color postgres
docker compose --project-name bop-rms-local --env-file .env stop postgres
docker compose --project-name bop-rms-local --env-file .env start postgres
docker compose --project-name bop-rms-local --env-file .env restart postgres
docker compose --project-name bop-rms-local --env-file .env down --remove-orphans
```

Ordinary `stop`, `start`, `restart`, and `down` preserve the named volume. To intentionally delete only this WP-owned local database and initialize it again:

```bash
docker compose --project-name bop-rms-local --env-file .env down --volumes --remove-orphans
docker compose --project-name bop-rms-local --env-file .env up --detach --wait postgres
```

The clean-reset command is destructive only to resources labeled for the explicit `bop-rms-local` Compose project. Review `docker compose --project-name bop-rms-local --env-file .env ps --all` first. Never use `docker system prune`, wildcard container deletion, or wildcard volume deletion for this lifecycle.

## Contract verification

`./tooling/postgres/verify-local.sh` uses the isolated `bop-rms-wp0005-verify` project and port `55432` by default. It creates only synthetic temporary credentials/data, verifies config safety, localhost binding, exact image/version, connection health, initialization settings, restart persistence, clean reset/re-create, log confidentiality, resource scope, and removal of all verification resources. It does not touch the normal `bop-rms-local` project or any other Compose project.

## Rollback

Stop and remove the local project with the scoped `down` command above; add `--volumes` only when local synthetic data may be discarded. Revert the WP through the normal reviewed Git workflow. This local volume is not backup, restore, HA, DR, RDS, or production evidence.
