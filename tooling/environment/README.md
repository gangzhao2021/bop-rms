# Root local environment

WP-0006 owns startup-time validation and orchestration of the services already integrated by WP-0004 and WP-0005. It is a local developer workflow, not a production process manager or deployment system.

## Commands

Run all commands from the repository root in the same WSL/Linux distribution:

```bash
pnpm environment:check
pnpm dev
pnpm local:status
pnpm local:stop
```

`pnpm dev` is a foreground supervisor. It validates the environment, builds the four skeletons, starts only the configured Compose PostgreSQL service, launches API/Worker/Merchant Web/Customer PWA, waits finitely for health, and then remains attached. `Ctrl+C`, `SIGTERM`, a child failure, or `pnpm local:stop` stops the application children and the configured PostgreSQL service. The PostgreSQL named volume is preserved.

Runtime metadata lives under ignored `.local/environment/`. A status command trusts it only while the recorded supervisor PID is alive and the configured endpoints match. Application output may interleave in the foreground terminal; the supervisor never prints environment values or reads the PostgreSQL secret.

## Validation boundary

The validator requires:

- Linux and a repository real path outside `/mnt/*`
- Linux-resolved Git, Node, Corepack, pnpm, and Docker executables; the Docker Desktop Linux CLI bridge under `/mnt/wsl/docker-desktop/` is accepted
- Node `24.18.0`, Corepack `0.35.0`, pnpm `11.13.0`, and Turbo `2.10.5`
- a reachable Linux Docker Engine and Compose
- the complete `.env` contract, valid identifiers, and unique localhost ports
- a non-empty, non-symlink PostgreSQL secret file with Linux mode `0600`
- free configured ports before startup

The non-secret contract is documented by `.env.example`. The root supervisor passes only an individual `PORT` to the API and explicit CLI ports to Vite. It does not pass the PostgreSQL password or the rest of `.env` into application processes.

## Truthful readiness and cleanup

Startup requires API `/health`, both Vite shells, a live Worker process, and a healthy Compose PostgreSQL service. API `/ready` must still return `503`, `not_ready`, and database `not_configured`; no driver, ORM, migration, schema, seed, Repository, or application database connection is present.

The normal stop command preserves the WP-0005 volume. `pnpm environment:verify` instead uses a dedicated `bop-rms-wp0006-verify` Compose project, synthetic temporary credentials under ignored `.local/`, alternate localhost ports, and final `down --volumes` cleanup. It does not inspect, stop, or delete another Compose project's resources.
