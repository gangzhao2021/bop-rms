# ADR-0034 — Test Fixture and Isolated Database Ownership Boundary

- Status: `Accepted`
- Owner: BOP-RMS Owner
- Decision date: `2026-07-21`
- Affected modules: shared database test support and persistence acceptance consumers
- Source: Canonical Handoff Section 97
- Related Work Package: [WP-0024](../spec/work-packages/WP-0024.md)
- Implementation decision: `IDR-0047`

## Context

Accepted Section 97 closes the test-only ownership contract already referenced by WP-0024. This ADR materializes that accepted decision; it grants no new runtime or infrastructure authority.

## Decision

`packages/database/test-support/isolated-database.mjs` owns the isolated lifecycle through `withIsolatedDatabase`. Consumers reuse that runner and provide explicit synthetic fixtures; no implicit business seed is permitted. Each run owns unique Compose/database/port/lease/temp resources. Cleanup is bounded, idempotent and fail-safe on success, failure, SIGINT, SIGTERM and timeout, and may touch only the run's owned resources.

Diagnostics, exit codes, failure injection and residue evidence follow the closed Section 90.21.7 allowlist and Section 97. A local test result does not prove a production restore, external service result or another candidate's acceptance.

## Consequences

Persistence acceptance has a single lifecycle owner without changing migration ownership, grants, roles, accounts, Provider integrations, deployment or dependencies. Consumers do not add independent Docker orchestration or clean unowned resources. See the [accepted source index](../spec/README.md) and existing runner for the exact executable contract.

## Revisit trigger

Revisit only when an owning persistence acceptance demonstrates that the accepted lifecycle cannot safely isolate or clean its owned resources, or an accepted higher Section supersedes its diagnostic or ownership contract.
