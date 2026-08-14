# `@rms/reservation-waiting`

## Identity and responsibility

- Module Name: `reservation-waiting`
- Package Name: `@rms/reservation-waiting`
- Layer / Domain: `RMS / Reservation & Waiting`
- Phase / owning Work Package: `Later / WP-2113`
- Owner role: `Reservation Engineering Owner`
- Status: `runtime-inactive contract implemented locally`
- Responsibility: Reservation identity, status, append-only revision, capacity-hold reference,
  contact snapshot and Pricing / Payment / Dining collaboration references.
- Explicit non-goals: Waitlist, actual Table / Session, money calculation, Payment mutation,
  Notification delivery, Customer profile, persistence and Provider integration.

## Public contract

- `createReservation` validates one complete Pending Reservation snapshot.
- `transitionReservation` derives Confirm, Check-in, Cancel, No-show, Expire and Dining-issued
  seating results from the current exact version.
- `reviseReservation` creates one append-only revision. A time, party-size or capacity-pool change is
  critical and requires a distinct unexpired Capacity Hold; a non-critical revision cannot alter
  Payment-owned or lifecycle facts.
- `createReservationService` authorizes `dining.operate` before repository access, enforces exact
  expected version and idempotency, and commits the Reservation, revision, Audit and minimal future
  event record through one injected transaction port.
- All inputs use strict closed-shape validation. Public errors expose controlled codes only.

## Dependencies

- Allowed synchronous dependency: `@bop/audit` public validation contract.
- Allowed asynchronous dependencies: none implemented; the future event record is transaction input,
  not a published Event Catalog claim.
- Forbidden dependencies: foreign repositories / tables, private package paths, HTTP / ORM / SDK,
  Pricing calculation, Payment mutation, Dining mutation and Notification delivery.
- Failure/degradation behavior: authorization, repository, reference and collaboration uncertainty
  fails closed without changing the current Reservation.

## Data ownership and lifecycle

- Owned facts: Reservation identity, lifecycle status, append-only revision, Capacity Hold reference,
  minimum confirmed contact snapshot and controlled collaboration references.
- Scope: every Reservation carries Tenant, Brand and Store; Actor, purpose and permission are required
  at the application boundary.
- Money: no amount is owned or represented. Pricing and Payment remain authoritative.
- Time: UTC instants only in this bounded contract; no local Business Date is inferred.
- Concurrency: exact aggregate version plus idempotent operation reference; Audit is mandatory.
- Classification: contact is personal / sensitive personal data. Logs, URLs and analytics prohibit
  it; tests use synthetic values only.
- Correction: append a controlled revision or lifecycle transition; never rewrite history.

## Persistence and eventing

Not implemented. Handoff Section 50 grants no Reservation schema or migration namespace. Repository,
transaction, outbox and projection behavior remain injected ports until an authorized WP establishes
those artifacts.

## Security and privacy

The caller supplies validated Store-scoped authorization and append-only Audit evidence for
`dining.operate`. Authorization runs before repository access. Cross-scope evidence, malformed
Audit, untrusted shapes, stale versions and unknown dependency outcomes fail closed. Contact display
and search require field permission at the BFF; no secret, unrestricted provider identifier, payment
data or contact value belongs in logs, URLs, analytics, screenshots or error payloads.

## Operations

- Configuration: none.
- Health/readiness: no runtime adapter is implemented; UI reports the authorized BFF as unavailable.
- Logs/metrics/traces: safe references and controlled outcome codes only.
- Failure/recovery/disable: no mutation occurs on denial, conflict or dependency uncertainty; retry
  uses the same operation reference and exact intent.

## Development and verification

```bash
CI=true pnpm --filter @rms/reservation-waiting typecheck
CI=true pnpm --filter @rms/reservation-waiting test
CI=true pnpm --filter @bop-rms/merchant-web typecheck
CI=true pnpm --filter @bop-rms/merchant-web test
CI=true pnpm verify
```

The suite covers strict validation, lifecycle transitions, terminal immutability, deposit separation,
critical replacement holds, non-critical bypass resistance, authorization-before-read, idempotent
replay, exact version conflict, append-only revision evidence and all WP-2113 screen states.

## Decisions and follow-up

- Authority: Handoff Sections 32, 48.5, 50 and 88.11; `docs/spec/work-packages/WP-2113.md`.
- External Evidence: real Store, capacity, contact, Pricing, Payment, Dining and Notification facts
  are unavailable and not claimed.
- Revisit trigger: an accepted Reservation persistence / Event Catalog WP or authorized BFF contract.
- Next allowed Work Package: `WP-2114`.
