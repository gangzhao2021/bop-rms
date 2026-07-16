# `<Module display name>`

> Template only. Replace every angle-bracket placeholder when an owning Work Package creates a module. Delete sections that are genuinely not applicable only with an explicit reason.

## Identity and responsibility

- Package: `<@bop-rms/...>`
- Layer / Domain: `<BOP or RMS / owning Domain>`
- Phase / owning Work Package: `<Phase / WP-xxxx>`
- Owner role: `<role>`
- Status: `<planned | active | deprecated>`
- Responsibility: `<facts and lifecycle owned here>`
- Explicit non-goals: `<facts and workflows owned elsewhere>`

## Public contract

List versioned Commands, Queries, Events, Projections, and public types exported through the module public interface. For each, name consumers, required Tenant/Brand/Store/Actor/purpose/permission context, expected version and idempotency where applicable, compatibility rule, and error model.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: `<public application interfaces>`
- Allowed asynchronous dependencies: `<events / query contracts / snapshots>`
- Forbidden dependencies: `<private module paths, foreign repositories/tables, Domain-to-infrastructure/HTTP/ORM/SDK, BOP-to-RMS>`
- Failure/degradation behavior: `<timeout, retry, stale/unknown, compensation>`

## Data ownership and lifecycle

- Owned Aggregates / Entities / append-only records / Projections: `<names>`
- Write owner and allowed read patterns: `<module and contracts>`
- Tenant / Brand / Store / location scope: `<rules>`
- Money representation: `<integer minor units or exact decimal; never binary float>`
- Time / Business Date: `<UTC instant, IANA zone, Business Date rules>`
- Concurrency / idempotency / audit: `<expected version, key scope, audit facts>`
- Data classification / retention / redaction: `<public, internal, PII, sensitive, payment, health, credential>`
- Correction model: `<approved compensating operation; no history edits>`

## Persistence and eventing

Describe only artifacts authorized by the owning WP: schema/table ownership, migration namespace/order/rollback, Repository ports/adapters, transaction boundary, Outbox, Inbox, retry/DLQ, replay, and Projection rebuild. Until those WPs exist, state `Not implemented` rather than adding placeholders that execute.

## Security and privacy

Document authentication assumptions, permission checks, least privilege, tenant isolation, field-level restrictions, secret handling, abuse controls, export/upload controls, and sensitive-data exclusions from logs, URLs, analytics, fixtures, screenshots, and errors.

## Operations

- Configuration: `<validated non-business settings; secret references only>`
- Health/readiness: `<truthful dependency state>`
- Logs/metrics/traces: `<safe identifiers, redaction, useful signals>`
- Failure/recovery/disable: `<operator behavior and compensating path>`

## Development and verification

```bash
<existing repository commands from the owning WP>
```

List unit, integration, contract, architecture, migration, permission, security, failure-injection, and acceptance scenarios. Record real commands/results in the WP handoff, not in this template.

## Decisions and follow-up

- ADR / IDR references: `<IDs>`
- External Evidence: `<real gates, owners, timing>`
- Revisit triggers: `<registered triggers>`
- Next allowed Work Package: `<WP ID>`
