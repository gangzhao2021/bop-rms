# `kitchen`

Kitchen-owned, runtime-inactive confirmed-order intake contracts.

## Identity and responsibility

- Module Name: `kitchen`
- Package Name: `@rms/kitchen`
- Layer / Domain: `RMS / Kitchen`
- Phase / owning Work Package: `Phase 1 / WP-1400`
- Owner role: `Kitchen Engineering Owner`
- Status: `active contract surface; runtime inactive`
- Responsibility: strict, authorized and idempotent intake of Ordering-owned `OrderConfirmed.v1`.
- Explicit non-goals: Ticket / Work Item creation, Station routing, queue projection, Kitchen Event,
  migration, persistence adapter, Worker composition and live Payment-to-Kitchen activation.

## Public contract

`createConfirmedOrderConsumerService` exposes registration `kitchen.confirmed-order:v1` and a
caller-transaction coordinator. Both intake paths strict-parse the public Ordering contract and
require System authorization for `ConsumeConfirmedOrder / CreateKitchenIntake`. The immutable
receipt retains only Store-scoped indirect identifiers and an event-ID-independent semantic digest.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: public `@bop/eventing` and `@rms/ordering` exports only.
- Allowed asynchronous dependencies: Ordering-owned `rms.ordering.order-confirmed.v1`.
- Forbidden dependencies: private paths, foreign repositories/tables, HTTP/ORM/Provider SDK and
  current Ordering/Catalog reconstruction.
- Failure/degradation behavior: bounded non-retryable rejection versus
  `CONSUMER_TEMPORARY_FAILURE`; no custom scheduler or retry store.

## Data ownership and lifecycle

- Owned Aggregates / Entities / records / Projections: none in WP-1400; only an immutable receipt
  contract is defined.
- Write owner and allowed read patterns: a later Kitchen adapter may implement the injected port;
  foreign tables are never queried.
- Tenant / Brand / Store / location scope: exact Brand and Store on every operation.
- Money representation: no money is accepted.
- Time / Business Date: producer-confirmed canonical UTC instant only; no Business Date fact.
- Concurrency / idempotency / audit: platform Inbox key `consumer + eventId` plus scoped confirmation
  and Batch semantic uniqueness; Ticket audit belongs to WP-1401.
- Data classification / retention / redaction: `indirect_identifier`; synthetic fixtures only;
  logs, URLs, analytics and screenshots prohibited.
- Correction model: immutable receipt; later changes require an approved compensating operation.

## Persistence and eventing

The manifest reserves future schema ownership `rms_kitchen` with zero tables. No migration,
Repository adapter, Outbox Event or runtime Worker registration is implemented. The injected intake
port and Eventing Inbox share one caller-owned transaction.

## Security and privacy

Only a strict System Event is accepted and authorization remains mandatory. The receipt excludes
causation, Payment, Provider, Customer, note, allergy/health, money, secret and free-text fields.
Errors are bounded and reveal no object existence.

## Operations

- Configuration: none.
- Health/readiness: runtime inactive; no infrastructure readiness is claimed.
- Logs/metrics/traces: no telemetry implementation; identifiers remain prohibited.
- Failure/recovery/disable: Eventing retry/dead-letter owns temporary failures; exact replay and
  commit-unknown recovery converge through the three-key intake port.

## Development and verification

```bash
pnpm kitchen-confirmed-order:acceptance
pnpm --filter @rms/kitchen format:check
pnpm --filter @rms/kitchen lint
pnpm --filter @rms/kitchen typecheck
pnpm --filter @rms/kitchen test
pnpm --filter @rms/kitchen build
```

Synthetic tests cover producer compatibility, registry declarations, direct-handler and facade
authorization, Inbox replay, semantic replay, multi-key conflict, malformed dependency responses,
commit-unknown recovery, privacy and immutable output.

## Decisions and follow-up

- ADR / IDR references: WP-0030, WP-0032, WP-0035 and WP-1310 accepted contracts.
- External Evidence: WP-2045, durable Worker/transaction adapter, real Store/Order facts and live
  security evidence remain gated.
- Revisit triggers: first Kitchen persistence adapter or runtime registration composition.
- Next allowed Work Package: `WP-1401` only after WP-1400 integration and exact-main verification.
