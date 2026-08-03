# `payment`

Payment-owned, Provider-neutral contracts for intent, attempt and transaction integration.

## Identity and responsibility

- Module Name: `payment`
- Package Name: `@rms/payment`
- Layer / Domain: `RMS / Payment`
- Phase / owning Work Package: `Phase 1 / WP-1301–1303`
- Owner role: `Payment Engineering Owner`
- Status: `active contract surface`
- Responsibility: strict Provider adapter normalization, authorized/idempotent online Payment Intent
  creation and Stripe raw-byte webhook signature verification.
- Explicit non-goals: Provider API SDK/HTTP route, durable webhook acceptance/idempotency,
  authoritative Payment success/Transaction state, Order advancement and refund approval/allocation.

## Public contract

`PaymentProviderAdapter` exposes create, retrieve, cancel, capture and refund ports for later
Payment application services. Runtime constructors require Brand/Store, Attempt and operation scope;
mutations additionally require purpose and a deterministic Provider idempotency key. Failures are
closed safe data. `createPaymentIntentCreationService` accepts the internal WP-1302 command, proves
authorization and Ordering's atomically committed Payment Pending/capacity boundary, persists one
Intent/Attempt claim, then invokes `createIntent`. It exports no HTTP route, Event, Projection or
Provider implementation.

`createProviderWebhookVerificationService` resolves server-owned direct-account scope before using
the Stripe HMAC adapter. The adapter verifies the bounded `Stripe-Signature` header against untouched
raw bytes, an inclusive five-minute timestamp window and current/next secret overlap of at most seven
days. Only then does the service extract a minimal safe Event envelope. WP-1304 owns persistence,
dedupe and `2xx`; verification alone never advances Payment.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: public `@rms/pricing` Money, `@rms/ordering`
  payment-preparation evidence and `@bop/audit` record contracts.
- Allowed asynchronous dependencies: authorized Ordering preparation, Restricted audit construction,
  Payment-owned repository claim and the Payment Provider adapter through explicit application ports.
- Forbidden dependencies: private paths, foreign persistence, HTTP/ORM/Provider API SDK and raw
  payloads outside the controlled webhook adapter boundary.
- Failure/degradation behavior: normalized failure code/retry disposition or explicit `Unknown` state.

## Data ownership and lifecycle

- Owned Aggregates / Entities / records / Projections: Payment Intent root, canonical Attempt 1,
  permanent operation record and append-only normalized Provider observation; no Projection yet.
- Write owner and allowed read patterns: `@rms/payment` owner repositories only until later public
  query contracts.
- Tenant / Brand / Store scope: Brand and Store are explicit in every adapter operation.
- Money representation: Pricing `Money` in CAD integer minor units; binary floating point rejected.
- Time / Business Date: normalized observations use UTC instants; Business Date is not owned here.
- Concurrency / idempotency / audit: WP-1302 permanently binds Payment operation intent, atomically
  claims one Attempt before Provider invocation, records a Restricted audit fact and leaves a
  concurrent unresolved claim `Processing`.
- Data classification / retention / redaction: payment and indirect identifiers; synthetic fixtures
  only; logs, URLs and analytics prohibited. Restricted raw webhook evidence is transferred only as
  owned bytes toward WP-1304's future 30-day persistence boundary.
- Correction model: later approved compensating operations; never history edits.

## Persistence and eventing

`rms_payment` owns `payment_intent`, `payment_attempt`,
`payment_intent_operation_record` and `payment_provider_observation`. Tables force Store RLS,
grant no runtime access in WP-1302 and preserve operation/Attempt/observation history. Repository
adapters remain ports; Webhook Inbox/Transaction persistence belongs to later WPs.

## Security and privacy

The creation service authorizes the scoped operation before business reads, then verifies that
Ordering evidence carries the same Guest Session, Brand and Store. This contract accepts no secret,
credential, client secret, PAN/CVV, fingerprint, unrestricted metadata, raw Provider object or
Provider message. Public failure reasons are bounded codes.

Webhook signing material is supplied as per-request owned bytes by an injected server configuration
port, is zeroed after verification and never appears in the verified result, error or audit input.
Signature failures expose stable codes only. Real Secrets Manager and account facts remain External
Evidence.

## Operations

- Configuration: the server selects validated `Test` or `Live` direct-account scope. Webhook
  configuration may carry current plus one next secret during an explicit overlap of at most seven
  days; it is never business configuration or public input.
- Health/readiness: Provider API and durable Webhook Inbox adapters are not implemented in WP-1303.
- Logs/metrics/traces: not implemented; adapter values are prohibited from general telemetry.
- Failure/recovery/disable: closed retry dispositions inform later orchestration.

## Development and verification

```bash
pnpm payment-adapter:acceptance
pnpm payment-intent:acceptance
pnpm payment-webhook-verification:acceptance
pnpm --filter @rms/payment lint
pnpm --filter @rms/payment typecheck
pnpm --filter @rms/payment test
pnpm --filter @rms/payment build
```

Tests cover operation closure, method/capture policy, authorization ordering, Ordering durability,
permanent replay/conflict behavior, one-attempt Provider invocation, safe Unknown handling, strict
runtime shapes, immutable results, SQL constraints/RLS and sensitive/raw field rejection. Actual
evidence is recorded in `docs/spec/work-packages/WP-1301.md` through `WP-1303.md`.

## Decisions and follow-up

- ADR / IDR references: Handoff Sections 28 and 58.25–58.26; SPIKE-1300.
- External Evidence: real account/contract, privacy/data-residency, PCI, reader and Interac tests.
- Revisit triggers: first infrastructure adapter must pin/revalidate exact Stripe API/SDK versions.
- Next allowed Work Package: `WP-1304` after WP-1303 is integrated and exact-main verified.
