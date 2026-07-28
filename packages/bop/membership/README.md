# `membership`

## Identity and responsibility

- Module Name: `membership`
- Package Name: `@bop/membership`
- Layer / Domain: `BOP / Membership`
- Phase / owning Work Package: `Phase 0 / WP-0102`
- Owner role: `Membership Engineering Owner`
- Status: `active`
- Responsibility: Workforce User Membership in a Brand and Store Assignment lifecycle facts.
- Explicit non-goals: authentication/session mutation, employment truth, roles, permissions,
  authorization evaluation, UI, Provider integration, notifications, events, and outbox delivery.

## Public contract

The public root exports strict aggregate factories, lifecycle transitions, exact active resolvers,
opaque reference parsers, the suspension result and the `MembershipPort`. Membership creation accepts
only an active Workforce `User` supplied through the public `@bop/identity` contract. Assignment
creation accepts a public `@bop/tenant` Store and verifies its immutable Brand relationship.

Resolvers use half-open UTC periods and fail closed for zero or multiple matches. Transitions require
an expected version. Suspension returns only bounded invalidation references; it does not revoke an
Identity session. Errors use closed codes and safe messages and never echo input.

## Dependencies

- Allowed synchronous dependencies: public roots of `@bop/identity` and `@bop/tenant`.
- Allowed asynchronous dependencies: none in WP-0102.
- Forbidden dependencies: private module paths, foreign repositories/tables, HTTP/ORM/SDK in Domain
  code, BOP-to-RMS dependencies, and direct Identity mutation.
- Failure/degradation behavior: exact resolution returns a safe not-found or ambiguous error; no
  permissive fallback exists.

## Data ownership and lifecycle

- Owned Aggregates / Entities: `Membership` and `StoreAssignment`.
- Write owner and allowed read patterns: `@bop/membership`; owner Repository and public query contract.
- Scope: Membership is Actor plus Brand; Store Assignment is Membership plus exact Brand and Store.
- Money: not applicable.
- Time: canonical UTC instants; effective periods are `[effective_from, effective_until)`.
- Concurrency / idempotency / audit: positive expected versions; idempotent command and audit
  composition are future owning-WP work.
- Classification: Actor and workforce evidence references are indirect/sensitive identifiers.
  Logs, URLs and analytics are prohibited; fixtures must be synthetic.
- Correction: lifecycle transitions only; immutable Actor, Brand, Store and parent references.

## Persistence and eventing

Migration `0200_003_create_membership.sql` owns only `bop_membership.membership` and
`bop_membership.store_assignment`. It creates no role, grant, cross-Domain foreign key, seed, event,
outbox or Provider fact. The port requires atomic persistence of parent suspension, active-child
suspension and bounded invalidation. A concrete Repository adapter and eventing remain unimplemented.

## Security and privacy

Authentication is consumed only as the public active Workforce User fact. Permission evaluation is
not inferred. Forced RLS requires exact Brand scope for Membership and exact Brand plus Store scope
for Store Assignment. `PUBLIC` receives no schema/table access and no runtime role is created here.
Real employee data, unrestricted PII, secrets and Provider payloads are prohibited.

## Operations

- Configuration: none.
- Health/readiness: no new runtime dependency.
- Logs/metrics/traces: no implementation in WP-0102; sensitive references remain excluded.
- Failure/recovery/disable: migration recovery is forward-fix; access resolution fails closed.

## Development and verification

```bash
pnpm membership-aggregate:acceptance
pnpm migration:check
pnpm database-ownership:check
pnpm domain-layer-boundary:check
```

Unit coverage proves strict shapes, Workforce-only admission, evidence, immutable scope, lifecycle,
versioning, half-open exact resolution and cascading suspension. Database acceptance proves
constraints, local-only foreign keys, forced RLS, least privilege and fail-closed Brand/Store scope.

## Decisions and follow-up

- ADR / IDR references: Canonical Handoff Sections 50, 56, 87 and 92–94.
- External Evidence: real workforce/employment truth remains unavailable and is not claimed.
- Revisit triggers: WP-0103 Tenant Context, WP-0104 Permission Evaluation, WP-0105 Grants, and
  WP-0108 session/access composition.
- Next allowed Work Package: WP-0103.
