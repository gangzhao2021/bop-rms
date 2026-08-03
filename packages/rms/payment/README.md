# `payment`

Payment-owned, Provider-neutral contracts for intent, attempt and transaction integration.

## Identity and responsibility

- Module Name: `payment`
- Package Name: `@rms/payment`
- Layer / Domain: `RMS / Payment`
- Phase / owning Work Package: `Phase 1 / WP-1301–1307`
- Owner role: `Payment Engineering Owner`
- Status: `active contract surface`
- Responsibility: strict Provider adapter normalization, authorized/idempotent online Payment Intent
  creation, Stripe raw-byte webhook verification, durable Payment Webhook Inbox idempotency and
  authoritative append-only Payment success/failure facts, a rebuildable status projection and
  bounded operational/daily-settlement reconciliation.
- Explicit non-goals: Provider API SDK/public HTTP deployment, Order advancement, kill switch,
  capture watchdog, compensation and refund approval/allocation.

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
days. Only then does the service extract a minimal safe Event envelope. Verification alone never
advances Payment.

`createPaymentWebhookInboxService` re-hashes that verified raw evidence and atomically accepts one
immutable receipt plus Restricted evidence before returning `Acknowledge`. Provider, environment,
account and Event ID form the dedupe key; same-digest retries return the original receipt while a
digest conflict fails closed. Its stable Consumer transaction couples a synthetic/later mapper
effect to one append-only completion marker, so failed work can replay but committed work cannot
run twice. Receipt acceptance remains distinct from Payment success.

`createPaymentTerminalService` accepts only a closed normalized terminal observation from that
transaction-owned mapper, resolves its exact Intent/Attempt/Provider account scope and requires
exact CAD minor units for captured success. It atomically commits one append-only terminal fact,
Restricted Audit input and `PaymentSucceeded.v1` or `PaymentFailed.v1` Outbox event. Unknown,
Processing, amount/scope mismatch and a conflicting second terminal outcome fail closed.

`createPaymentStatusProjectionService` consumes those terminal Events through the stable
`payment.status-projection:v1` Inbox identity and atomically replaces one active projection
generation. Rebuild uses an authorized exact Event feed and shadow generation switch. The paired
query service authorizes exact Brand/Store scope before bounded list/detail reads and exposes
checkpoint/freshness explicitly.

`createPaymentReconciliationService` owns the `payment-reconciliation:v1` bounded job contract. It
authorizes and leases an exact Store run, compares approved internal facts with normalized Provider
retrieval or settlement evidence, retains Unknown, delegates eligible terminal truth to WP-1305 and
atomically records immutable checks/Open exceptions. Its query service authorizes before bounded
safe list reads. Provider retrieval uses an independent causation reference and never invents a
webhook receipt/Event.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: public `@rms/pricing` Money, `@rms/ordering`
  payment-preparation evidence, `@bop/audit` record contracts and `@bop/eventing` envelopes.
- Allowed asynchronous dependencies: authorized Ordering preparation, Restricted audit construction,
  Payment-owned repository claim and the Payment Provider adapter through explicit application ports.
- Forbidden dependencies: private paths, foreign persistence, HTTP/ORM/Provider API SDK and raw
  payloads outside the controlled webhook adapter boundary.
- Failure/degradation behavior: normalized failure code/retry disposition or explicit `Unknown` state.

## Data ownership and lifecycle

- Owned Aggregates / Entities / records / Projections: Payment Intent root, canonical Attempt 1,
  permanent operation record, append-only normalized Provider observation and terminal Payment
  fact, rebuildable `payment_status_v1` projection and append-only reconciliation run/check/Open
  exception records.
- Write owner and allowed read patterns: `@rms/payment` owner repositories only until later public
  query contracts.
- Tenant / Brand / Store scope: Brand and Store are explicit in every adapter operation.
- Money representation: Pricing `Money` in CAD integer minor units; binary floating point rejected.
- Time / Business Date: normalized observations use UTC instants; Business Date is not owned here.
- Concurrency / idempotency / audit: WP-1302 permanently binds Payment operation intent and claims
  one Attempt before Provider invocation. WP-1304 atomically deduplicates concurrent Provider
  deliveries and transactionally binds a mapper effect to one Consumer completion. WP-1305 commits
  at most one terminal fact/Audit/Outbox set per Intent and rejects conflicting outcomes.
- Data classification / retention / redaction: payment and indirect identifiers; synthetic fixtures
  only; logs, URLs and analytics prohibited. Restricted raw webhook evidence expires after 30 days;
  the immutable receipt/dedupe record remains at least 90 days.
- Correction model: later approved compensating operations; never history edits.

## Persistence and eventing

`rms_payment` owns `payment_intent`, `payment_attempt`,
`payment_intent_operation_record`, `payment_provider_observation`, `provider_webhook_record`,
`provider_webhook_raw_evidence`, `provider_webhook_processing_record` and
`payment_terminal_fact`, `payment_status_projection`, `payment_reconciliation_run`,
`payment_reconciliation_record` and `payment_reconciliation_exception`. Tables force Store RLS,
grant no PUBLIC access and preserve
receipt/completion/financial history. Only expired raw evidence is erasable; repository adapters
remain explicit ports.

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
- Health/readiness: Provider API, HTTP deployment and operational retention scheduler are not
  implemented in WP-1305.
- Logs/metrics/traces: not implemented; adapter values are prohibited from general telemetry.
- Failure/recovery/disable: closed retry dispositions inform later orchestration.

## Development and verification

```bash
pnpm payment-adapter:acceptance
pnpm payment-intent:acceptance
pnpm payment-webhook-verification:acceptance
pnpm payment-webhook-inbox:acceptance
pnpm payment-terminal:acceptance
pnpm payment-status:acceptance
pnpm payment-reconciliation:acceptance
pnpm --filter @rms/payment lint
pnpm --filter @rms/payment typecheck
pnpm --filter @rms/payment test
pnpm --filter @rms/payment build
```

Tests cover operation closure, method/capture policy, authorization ordering, Ordering durability,
permanent replay/conflict behavior, one-attempt Provider invocation, safe Unknown handling, strict
runtime shapes, immutable results, SQL constraints/RLS and sensitive/raw field rejection. Actual
evidence is recorded in `docs/spec/work-packages/WP-1301.md` through `WP-1307.md`.

## Decisions and follow-up

- ADR / IDR references: Handoff Sections 28 and 58.25–58.26; SPIKE-1300.
- External Evidence: real account/contract, privacy/data-residency, PCI, reader and Interac tests.
- Revisit triggers: first infrastructure adapter must pin/revalidate exact Stripe API/SDK versions.
- Next allowed Work Package: `WP-1308` after WP-1307 is integrated and exact-main verified.
