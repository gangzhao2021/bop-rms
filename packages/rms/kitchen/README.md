# `kitchen`

Kitchen-owned, runtime-inactive confirmed-order intake and minimum Ticket / Work Item aggregate.

## Identity and responsibility

- Module Name: `kitchen`
- Package Name: `@rms/kitchen`
- Layer / Domain: `RMS / Kitchen`
- Phase / owning Work Package: `Phase 1 / WP-1400–1401`
- Owner role: `Kitchen Engineering Owner`
- Status: `active contract surface and persistence boundary; runtime inactive`
- Responsibility: consume Ordering-owned `OrderConfirmed.v1`, resolve exact public Ordering source
  evidence plus an injected Kitchen work plan, then create one Store-scoped Ticket and one initial
  Work Item per exact source item.
- Explicit non-goals: live Worker wiring, real Station/Recipe plan production, queue projection,
  Accept/Start/Complete/Cancel/Ready transitions, API/UI, Provider calls and production activation.

## Public contract

`createConfirmedOrderConsumerService` retains registration `kitchen.confirmed-order:v1`.
`createKitchenTicketIntakeAdapter` implements its existing `intakes.resolveByIdentity` / `accept`
port through `createKitchenTicketCreationService`, without changing the WP-1400 consumer.

The source query receives only the exact parsed receipt scope and independently authorizes
`ResolveConfirmedOrderKitchenSource / CreateKitchenWork`. Kitchen projects the validated source to
a strict, deeply frozen planning DTO containing references, quantities and opaque line/evidence
digests only; Customer notes, localized names and other narrative never cross the plan port. The
injected `KitchenWorkPlan` must bind the exact source-evidence digest and item set, with one
ordinal-1 item per source item, one opaque Station/routing snapshot and one Recipe/Preparation
snapshot. Kitchen alone computes the final execution digest from the complete source plus plan.
Missing, placeholder, extra, stale or changed data fails before any effect.

## Dependencies

- Allowed synchronous dependencies: public `@bop/audit`, `@bop/eventing` and `@rms/ordering`
  exports only.
- Allowed asynchronous dependencies: consumes `rms.ordering.order-confirmed.v1`; publishes
  `rms.kitchen.kitchen-work-created.v1`.
- Forbidden dependencies: Ordering private paths/repository/tables, current Catalog/Recipe lookup,
  HTTP/ORM/Provider SDK, cross-domain transaction and inferred routing.
- Failure behavior: closed safe codes distinguish invalid input, permission denial, conflict and
  temporary dependency failure without object or dependency detail.

## Data ownership and lifecycle

- Aggregate Root: `KitchenTicket`, version `1`, status `Open`.
- Child Entity: one `KitchenWorkItem`, split ordinal `1`, status `Queued`, required quantity copied
  exactly and completed quantity `0` for every Ordering source item.
- Append-only record: one `KITCHEN_TICKET_CREATED` action per stable Ticket creation effect,
  explicitly attributed to the System actor, Event Consumer channel and Restricted classification.
- Immutable execution snapshot: display names, selected Options, bounded Customer note, source-line
  digest, Station/routing evidence, preparation evidence/instructions and execution digest.
- Ticket identity derives from Brand + Store + Batch; Work Item, action, Audit and Event references
  derive from the stable Ticket effect, never a run ID or wall-clock bucket.
- The Ticket retains every WP-1400 receipt anchor, including consumer/version, source Event,
  aggregate version/snapshot digest, confirmation, correlation, confirmed time and semantic digest,
  so durable replay can reconstruct and exact-compare the original receipt.

## Persistence, atomicity and eventing

The repository port resolves the scoped source Event, confirmation and Batch semantic keys. All
keys must be missing or converge on the same complete stored effect. New creation atomically
persists the intake binding, Ticket, all Work Items, append-only action, Restricted System Audit and
one `KitchenWorkCreated.v1` Outbox Event in the caller-owned Consumer transaction. Commit-unknown
recovery rereads permanent semantic keys; a changed or split effect is never adopted.

The public Event is minimal: `kitchenTicketReference`, Order, Batch, confirmation, item count,
aggregate version and created UTC instant. Its envelope is Store scoped, correlated to the original
intake and caused by `OrderConfirmed`. It contains no item snapshot, Customer note, Station,
preparation narrative, Money, Payment, Provider or health data.

## Security and privacy

Module classification is `indirect_identifier,personal,health` because the immutable Work Item may
contain a Customer note that is possible-health data. Notes are NFC plain text, at most 240 Unicode
code points and four lines, with control and bidirectional-override characters rejected. A note is
never interpreted as allergy accommodation, ingredient deletion or safety approval, and never
enters Event, Audit summary, error, log, URL, metric label, analytic payload, screenshot or
non-synthetic fixture. WP-1407 remains mandatory before Kitchen Start or any food-safety claim.

## Operations

- Configuration: none; the real plan producer belongs to WP-1402.
- Health/readiness: runtime inactive; no Worker or infrastructure readiness is claimed.
- Telemetry: no implementation in this increment. Future metrics may use bounded outcome/reason
  labels only; all Tenant and object references, notes and digests are prohibited labels.
- Disable/recovery: Eventing owns retry/dead-letter; replay and commit-unknown converge through the
  three permanent semantic keys.

## Development and verification

```bash
pnpm kitchen-ticket:acceptance
pnpm --filter @rms/kitchen format:check
pnpm --filter @rms/kitchen lint
pnpm --filter @rms/kitchen typecheck
pnpm --filter @rms/kitchen test
pnpm --filter @rms/kitchen build
```

Synthetic tests cover strict/accessor-safe/deep-frozen contracts, exact source/plan binding,
Customer-note safety, no-placeholder creation, stable identities, same/different-Event replay,
multi-key conflict, concurrency, commit-unknown recovery, mandatory Audit/Outbox rollback and
minimal Event privacy.

## Decisions and follow-up

- Authority: WP-0030, WP-0032, WP-0035, WP-1310, WP-1400 and WP-1401.
- External Evidence: real Ordering persistence/source adapter, WP-1402 plan producer, WP-2045 live
  Payment gate, WP-1407 allergen acknowledgement, runtime roles/RLS, real Store/Order/Station facts,
  load/replay/restore evidence and deployment remain gated and unclaimed.
- Revisit triggers: live Worker composition, Station-routing producer, any Work Item transition or
  a new Customer/health field.
