# `payment`

Payment-owned, Provider-neutral contracts for intent, attempt and transaction integration.

## Identity and responsibility

- Module Name: `payment`
- Package Name: `@rms/payment`
- Layer / Domain: `RMS / Payment`
- Phase / owning Work Package: `Phase 1 / WP-1301`
- Owner role: `Payment Engineering Owner`
- Status: `active contract surface`
- Responsibility: strict Provider adapter request/result/failure normalization.
- Explicit non-goals: Provider SDK/HTTP, raw payloads, persistence, webhook processing, Payment state,
  Order state and refund approval/allocation.

## Public contract

`PaymentProviderAdapter` exposes create, retrieve, cancel, capture and refund ports for later
Payment application services. Runtime constructors require Brand/Store, Attempt and operation scope;
mutations additionally require purpose and a deterministic Provider idempotency key. Failures are
closed safe data. This WP exports no Command, Event, Projection or Provider implementation.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: public `@rms/pricing` Money contract only.
- Allowed asynchronous dependencies: none in WP-1301.
- Forbidden dependencies: private paths, foreign persistence, HTTP/ORM/Provider SDK and raw payloads.
- Failure/degradation behavior: normalized failure code/retry disposition or explicit `Unknown` state.

## Data ownership and lifecycle

- Owned Aggregates / Entities / records / Projections: none in WP-1301.
- Write owner and allowed read patterns: not implemented.
- Tenant / Brand / Store scope: Brand and Store are explicit in every adapter operation.
- Money representation: Pricing `Money` in CAD integer minor units; binary floating point rejected.
- Time / Business Date: normalized observations use UTC instants; Business Date is not owned here.
- Concurrency / idempotency / audit: mutations require operation and idempotency references; durable
  idempotency/audit belongs to later WPs.
- Data classification / retention / redaction: payment and indirect identifiers; synthetic fixtures
  only; logs, URLs and analytics prohibited.
- Correction model: later approved compensating operations; never history edits.

## Persistence and eventing

Not implemented. The manifest reserves `rms_payment` ownership with no tables.

## Security and privacy

Calling application services remain responsible for actor permission and tenant authorization. This
contract accepts no secret, credential, client secret, PAN/CVV, fingerprint, unrestricted metadata,
raw Provider object or Provider message. Public failure reasons are bounded codes.

## Operations

- Configuration: none.
- Health/readiness: no infrastructure dependency exists in WP-1301.
- Logs/metrics/traces: not implemented; adapter values are prohibited from general telemetry.
- Failure/recovery/disable: closed retry dispositions inform later orchestration.

## Development and verification

```bash
pnpm payment-adapter:acceptance
pnpm --filter @rms/payment lint
pnpm --filter @rms/payment typecheck
pnpm --filter @rms/payment test
pnpm --filter @rms/payment build
```

Tests cover operation closure, method/capture policy, strict runtime shapes, immutable results,
normalized amount/state invariants and sensitive/raw field rejection. Actual evidence is recorded in
`docs/spec/work-packages/WP-1301.md`.

## Decisions and follow-up

- ADR / IDR references: Handoff Sections 28 and 58.25–58.26; SPIKE-1300.
- External Evidence: real account/contract, privacy/data-residency, PCI, reader and Interac tests.
- Revisit triggers: first infrastructure adapter must pin/revalidate exact Stripe API/SDK versions.
- Next allowed Work Package: `WP-1302` after WP-1301 is integrated and exact-main verified.
