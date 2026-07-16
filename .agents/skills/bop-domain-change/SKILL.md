---
name: bop-domain-change
description: Review and plan BOP-RMS changes to Domain objects, Commands, Events, Projections, Repositories, persistence, or migrations. Use whenever behavior may affect fact ownership, aggregate lifecycle, public contracts, idempotency, expected version, Tenant/Store scope, money/time, outbox/inbox, replay, or cross-domain tests.
---

# BOP-RMS Domain Change

## Required inputs

- `docs/spec/README.md`, current WP brief, applicable `AGENTS.md`, and the authoritative architecture/Domain sections cited by the brief.
- Existing module public interface, ownership metadata, tests, and persistence artifacts when present.

## Workflow

1. Identify the owning Domain, Aggregate/Entity/Projection, immutable facts, lifecycle, write owner, and allowed readers.
2. Define Actor, purpose, Permission, Tenant/Brand/Store scope, expected version, idempotency key, audit, and data classification.
3. Define Command/Query inputs, public result/error contract, compatibility/versioning, and cross-domain collaboration through public interface, Event, Query Contract, Snapshot, or Reference.
4. Represent money without binary floating point and time as UTC instants plus explicit IANA zone and Business Date where relevant.
5. For writes, define transaction, append-only history, Outbox emission, Inbox/idempotent consumption, retry, failure, compensation, and replay behavior.
6. For persistence changes, verify owning schema/table, migration ordering/rollback, isolation, concurrency, and cross-domain tests. Use the owning future WP if persistence is not authorized now.
7. Map invariants and failure modes to unit, integration, contract, architecture, migration, replay, permission, and security tests that already exist or are owned by the WP.

## Hard stops

- No foreign private-table access/write, Domain dependency on ORM/HTTP/SDK, binary-float money, silent history edit, missing Tenant/Store scope, or invented Provider/Store fact.
- Stop when a change alters a frozen Module boundary, public ownership, Tenant boundary, or transaction fact without the required ADR/Handoff revision.

## Output

Report ownership, lifecycle/invariants, contract, scope/permission, concurrency/idempotency, money/time, eventing/persistence/replay, tests, risks, and decision/WP blockers.

## Smoke scenarios

- Positive: a new Command plan includes owner, expected version, Tenant/Store, idempotency, audit, Outbox, errors, and tests.
- Boundary: a request for a Catalog handler to update Inventory private tables is rejected and redirected to a public contract/Event design.
