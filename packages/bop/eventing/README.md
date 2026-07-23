# `eventing`

## Identity and responsibility

- Module Name: `eventing`
- Package Name: `@bop/eventing`
- Layer / Domain: `BOP / shared Eventing infrastructure`
- Phase / owning Work Package: `Phase 0 / WP-0030`
- Owner role: `Shared Eventing Infrastructure Steward`
- Status: `active`
- Responsibility: stable Domain Event Envelope and caller-transaction Outbox append
- Explicit non-goals: concrete business Events、publishing、Inbox、retry/dead-letter、catalog tooling and SSE

## Public contract

The root export exposes the versioned, business-agnostic `DomainEventEnvelope`,
`OutboxTransaction`, validation errors and `appendEventInTransaction`. The caller
must supply server-resolved Tenant、Store、Actor、Correlation and Aggregate facts,
application-generated UUIDv7 IDs and an already-open transaction.

The package exports no ORM entity. It never opens、commits or rolls back a
transaction and never writes a business table.

## Dependencies

This first bounded slice has no synchronous package dependency. Common Kernel and
Observability are still required architecture dependencies, but their packages do
not yet exist and are not invented by WP-0030. The contract uses structural types
until their owning Work Packages provide stable public exports.

## Data ownership and lifecycle

The Module owns no business schema or table. The shared platform registry owns
`platform_eventing.outbox_event`. Events are Brand scoped, optionally Store scoped,
and inserted once. Event facts are immutable through this API. Delivery metadata is
reserved for later Eventing Work Packages.

Payload and replay metadata must be JSON objects. Redaction classification is
explicit. Secrets、credentials、payment data、health/allergy facts and unnecessary
PII are prohibited. A concrete producer remains blocked until WP-0035 registers its
payload、compatibility、consumer、retention and replay contract.

## Persistence and eventing

`appendEventInTransaction` performs one parameterized insert through the supplied
transaction. PostgreSQL RLS is defense in depth; application authorization remains
the primary control. No runtime database grant is created by WP-0030.

## Development and verification

```bash
pnpm --filter @bop/eventing test
pnpm --filter @bop/eventing typecheck
pnpm database-ownership:check
pnpm outbox:acceptance
```

## Decisions and follow-up

- Authority: Handoff Sections 48.3.8、50.15、52.15、80.6.3 and 87.7.5；ADR-0029–0033
- External Evidence: actual runtime roles/grants、RDS、volume/query plans、retention and producer catalog approval
- Next allowed Work Package: `WP-0031`
