# `eventing`

## Identity and responsibility

- Module Name: `eventing`
- Package Name: `@bop/eventing`
- Layer / Domain: `BOP / shared Eventing infrastructure`
- Phase / owning Work Package: `Phase 0 / WP-0030–0031`
- Owner role: `Shared Eventing Infrastructure Steward`
- Status: `active`
- Responsibility: stable Domain Event Envelope、caller-transaction Outbox append and transport-neutral leased dispatch persistence
- Explicit non-goals: concrete business Events、external broker adapters、Inbox、retry/dead-letter、catalog tooling and SSE

## Public contract

The root export exposes the versioned, business-agnostic `DomainEventEnvelope`,
`OutboxTransaction`, validation errors and `appendEventInTransaction`. The caller
must supply server-resolved Tenant、Store、Actor、Correlation and Aggregate facts,
application-generated UUIDv7 IDs and an already-open transaction.

The package exports no ORM entity. It never opens、commits or rolls back a
transaction and never writes a business table.

WP-0031 adds bounded claim、conditional publish-complete and failure-parking
operations. The caller supplies a short transaction already scoped to exactly one
authorized Brand and optional Store. Claim uses `FOR UPDATE SKIP LOCKED`; external
publication occurs only after that transaction commits. Completion is fenced by
the Event ID and lease token.

## Dependencies

This bounded slice has no synchronous package dependency. Common Kernel and
Observability are still required architecture dependencies, but their packages do
not yet exist and are not invented by WP-0030. The contract uses structural types
until their owning Work Packages provide stable public exports.

## Data ownership and lifecycle

The Module owns no business schema or table. The shared platform registry owns
`platform_eventing.outbox_event`. Events are Brand scoped, optionally Store scoped,
and inserted once. Event facts are immutable through this API. Delivery metadata is
mutable only through the WP-0031 fenced dispatch contract.

Payload and replay metadata must be JSON objects. Redaction classification is
explicit. Secrets、credentials、payment data、health/allergy facts and unnecessary
PII are prohibited. A concrete producer remains blocked until WP-0035 registers its
payload、compatibility、consumer、retention and replay contract.

## Persistence and eventing

`appendEventInTransaction` performs one parameterized insert through the supplied
transaction. PostgreSQL RLS is defense in depth; application authorization remains
the primary control. No runtime database role or grant is created by WP-0030 or
WP-0031.

## Development and verification

```bash
pnpm --filter @bop/eventing test
pnpm --filter @bop/eventing typecheck
pnpm database-ownership:check
pnpm outbox:acceptance
pnpm outbox-dispatcher:acceptance
```

## Decisions and follow-up

- Authority: Handoff Sections 48.3.8、50.15、52.15、56.11、80.6.3 and 87.7.4–87.7.6；ADR-0029–0033
- External Evidence: actual runtime roles/grants、RDS、volume/query plans、retention and producer catalog approval
- Next allowed Work Package after WP-0031 closeout: `WP-0032`
