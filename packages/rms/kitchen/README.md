# `kitchen`

Kitchen-owned, runtime-inactive confirmed-order intake, minimum Ticket / Work Item aggregate,
deterministic Station plan and Store queue projection.

## Identity and responsibility

- Module Name: `kitchen`
- Package Name: `@rms/kitchen`
- Layer / Domain: `RMS / Kitchen`
- Phase / owning Work Package: `Phase 1 / WP-1400–1403`
- Owner role: `Kitchen Engineering Owner`
- Status: `active contract surface and persistence boundary; runtime inactive`
- Responsibility: consume Ordering-owned `OrderConfirmed.v1`, resolve exact public Ordering source
  evidence, deterministically compose the Phase-1 single-Station work plan from strict injected
  Kitchen-routing and Recipe-preparation evidence, create one Store-scoped Ticket and one initial
  Work Item per exact source item, then consume `KitchenWorkCreated.v1` into a safe Store queue
  read model.
- Explicit non-goals: live Worker wiring, Station/Rule persistence or authoring, Recipe business
  logic/persistence, multi-Station routing, Accept/Start/Complete/Cancel/Ready transitions,
  API/UI/SSE/live Worker wiring, Provider calls and production activation.

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

`createKitchenWorkPlanService` implements that existing internal plan port. It resolves evidence at
the exact confirmed instant, accepts only one active `AllPreparedItems` Station/rule candidate,
requires every Recipe-owned preparation capability to be covered, and returns `null` for any
missing, ambiguous, malformed, cross-scope or incapable evidence. Station and Recipe owner adapters
receive distinct least-privilege System authorization intents and remain final authorization
authorities before reading their sources. The planner never receives Customer notes or localized
display narrative, reads a clock, generates random identity or mutates state. Its stable plan
reference binds Brand、Store、Order、Batch and confirmation; version is `1` and `generatedAt` is the
confirmed instant, so identical evidence is byte-stable across retry and concurrency.

`createKitchenQueueProjectionService` exposes one frozen runtime-inactive coordinator with
`registration`, `consume`, `rebuild`, `list` and `get`. The registration consumes only strict
`KitchenWorkCreated.v1`; incremental and rebuild paths validate authoritative Kitchen checkpoint
coverage before a complete generation switch. List/Get independently final-authorize trusted
Session/Tenant context with `kitchen.operate`, bind cursors to one generation and filter/sort digest,
and return deeply frozen safe rows with checkpoint/as-of/projected-at freshness metadata. Course,
priority, SLA/overdue, hold reason, exception, claim, ETA and structured allergen assistance are
all explicitly `NotAvailable`; none is represented as absent, false or safe. Operational
projection health is separately `NotAvailable` because this bounded runtime-inactive slice does
not claim `Rebuilding` or `Failed`. The public error contract is bounded and never reveals
existence, source dependencies or identifiers.

## Dependencies

- Allowed synchronous dependencies: public `@bop/audit`, `@bop/eventing` and `@rms/ordering`
  exports only.
- Allowed asynchronous dependencies: consumes `rms.ordering.order-confirmed.v1` and
  `rms.kitchen.kitchen-work-created.v1`; publishes `rms.kitchen.kitchen-work-created.v1`.
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
- Rebuildable projection: per-generation Store headers plus one safe row per Work Item provide one
  database-enforced Active `kitchen_work_queue_v1` generation, an explicit initialized-empty state,
  checkpoint freshness and Station-lane/exact-reference reads without becoming Kitchen truth.

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

The queue consumer uses the existing `kitchen.queue-projection:v1` identity with
`ordering: "none"`. Raw first delivery is strict-parsed and System-authorized before a dedicated
Kitchen-owned safe source read. Generic Inbox completion and a complete shadow-generation switch
share the caller transaction; `result_hash` remains `NULL`. Per-row Event-semantic digests and two
independent generation anchors detect changed evidence without reusing note-derived digests. A
completed same-Event Inbox delivery short-circuits without a second effect, while rebuild and
commit-unknown recovery converge under a Store/projection advisory transaction lock.

## Security and privacy

Module classification is `indirect_identifier,personal,health` because the immutable Work Item may
contain a Customer note that is possible-health data. Notes are NFC plain text, at most 240 Unicode
code points and four lines, with control and bidirectional-override characters rejected. A note is
never interpreted as allergy accommodation, ingredient deletion or safety approval, and never
enters Event, Audit summary, error, log, URL, metric label, analytic payload, screenshot or
non-synthetic fixture. WP-1407 remains mandatory before Kitchen Start or any food-safety claim.
The queue projection itself is `indirect_identifier` only: its dedicated source DTO and rows exclude
Customer note, health/allergen values, preparation instructions, note-derived digests and all
Payment/Provider data. Public queue results also exclude internal Event references and integrity
digests.

## Operations

- Configuration: strict injected, owner-authorized Station/routing and Recipe-preparation evidence
  only. No configuration table, authoring command or runtime adapter is included.
- Health/readiness: runtime inactive; no Worker or infrastructure readiness is claimed.
- Queue freshness: only the projection builder sets canonical checkpoint freshness (`Fresh` at
  non-negative activation lag up to two seconds, otherwise `Stale`). Query does not age an
  unchanged Store by wall clock, and stale results remain read-only.
- Telemetry: no implementation in this increment. Future metrics may use bounded outcome/reason
  labels only; all Tenant and object references, notes and digests are prohibited labels.
- Disable/recovery: Eventing owns retry/dead-letter; replay and commit-unknown converge through the
  three permanent semantic keys.

## Development and verification

```bash
pnpm kitchen-ticket:acceptance
pnpm kitchen-station-routing:acceptance
pnpm kitchen-queue:acceptance
pnpm --filter @rms/kitchen format:check
pnpm --filter @rms/kitchen lint
pnpm --filter @rms/kitchen typecheck
pnpm --filter @rms/kitchen test
pnpm --filter @rms/kitchen build
```

Synthetic tests cover strict/accessor-safe/deep-frozen contracts, exact source/plan binding,
Customer-note safety, no-placeholder creation, stable identities, same/different-Event replay,
multi-key conflict, concurrency, commit-unknown recovery, mandatory Audit/Outbox rollback and
minimal Event privacy. Queue coverage adds initialized-empty and shadow rebuild, complete
checkpoint/digest reconciliation, Consumer Inbox outcomes, cursor generation binding,
`kitchen.operate` authorization-before-read and exact Store RLS scope.

## Decisions and follow-up

- Authority: WP-0030, WP-0032, WP-0035, WP-1310 and WP-1400–WP-1403.
- External Evidence: real Ordering persistence/source adapter, real Kitchen Station/routing and
  Recipe-preparation adapters/facts, WP-2045 live Payment gate, WP-1407 allergen acknowledgement,
  runtime roles/RLS, real Store/Order facts, load/replay/restore evidence and deployment remain
  gated and unclaimed.
- Revisit triggers: live Worker composition, Station/Rule authoring or persistence, Recipe module,
  multi-Station routing, any Work Item transition, queue lifecycle/Ready Event input, export or a
  new Customer/health field.
