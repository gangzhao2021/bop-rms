# `@rms/ordering`

`@rms/ordering` owns the Phase-1 Cart and formal Order lifecycle. WP-1200 establishes only the
Store-scoped Cart aggregate, its Product-owned Cart Item entities, strict public parsing contract,
and the first `rms_ordering` persistence boundary.

A Cart is a temporary, mutable purchase intent and is not an Order. Cart Item configuration stores
only opaque Sellable and selected Option references plus integer quantities; it never accepts or
stores a client price. Dine-in Cart context must reference one Dining Session, while Pickup must not.
Participant attribution is optional for Pickup and mandatory for Dine-in items.

WP-1201 adds Guest Session-bound Add/Update/Remove commands with exact Cart optimistic version,
24-hour idempotency, System Audit and same-Participant enforcement for Shared Cart edits. Customer
Note is normalized bounded plain text classified as personal/possible health data; it never enters
telemetry, URLs, analytics, screenshots or non-synthetic fixtures.

WP-1202 requires Add and Update to obtain one exact current Catalog `Validate Selection` result.
Accepted Cart Items retain pinned Menu, Product, Binding and Option Set version evidence. Catalog
owns Sellable/Option validity; Ordering fails closed on rejected, unavailable, stale or mismatched
evidence and never reads Catalog private tables.

WP-1203 attaches an immutable Pricing Quote snapshot to one exact current Cart Version. The
Ordering command derives the Pricing request from the server-owned Cart, accepts no client
financial fields, verifies complete scope/line/Currency/total/UTC evidence, and appends the
attachment without incrementing Cart Version. Later Item mutation invalidates eligibility through
the pinned version; prior Quote attachments remain history.

WP-1204 adds version-pinned idle and absolute Cart lifecycle deadlines without inventing a Pilot
duration. Item mutations advance idle expiry up to the absolute boundary. Customer abandonment and
System expiration are authorized, audited, idempotent terminal transitions that preserve Cart Item
and Quote history. Legacy, deadline-reached, Abandoned and Expired Carts fail closed for new Item or
Quote commands.

The module does not implement Cart creation transport, lifecycle scheduler registration, physical
retention cleanup, Event, Projection, UI, or external evidence. WP-1220 adds fail-closed Checkout
validation evidence. WP-1221 consumes only current evidence to create the first immutable minimum
`Order → Order Batch → Order Item identity` aggregate in `Submitted + Open`; transaction snapshots,
business date/order number, durable idempotency, Payment, API and lifecycle transitions remain
owned by later Work Packages. WP-1222 adds the pure line-level snapshot boundary that copies exact
Catalog names/versions, selected Option configuration, final bigint Money, Price resolution and Tax
rule/rate/amount evidence. Snapshots are closed and deeply frozen and are never reconstructed from
current configuration; WP-1224 remains responsible for authorized atomic creation and persistence.
WP-1223 consumes only Store-owned Business Date resolution evidence and defines canonical decimal
Order Numbers backed by a Store + Business Date counter and append-only allocation history. DST
gap/overlap behavior is deterministic; WP-1224 must allocate the number and create the Order in one
authorized database transaction. WP-1224 provides that public internal application API: it
authorizes before reads, permanently binds one Submission reference to the exact Cart Version and
Quote intent, revalidates all immutable source snapshots, and requires atomic persistence of the
Order, first Batch, Items, allocation and Audit. Exact replay returns the first result. The later
Payment command owns public HTTP transport and Provider interaction under Section 87.
Cart identifiers and attribution references are indirect identifiers and are prohibited from logs,
URLs, analytics, screenshots, and non-synthetic fixtures.

WP-1310 adds the contract-first `ordering.payment-outcome:v1` consumer. It strictly consumes
Store-scoped Payment success or failure facts, authorizes before Ordering reads and uses the caller's
local Inbox transaction for the one replayable result. Only an exact Ordering-owned `Confirmed`
source appends `OrderConfirmed.v1`; `AwaitingAcceptance` retries, paid-without-fulfillable exposes a
blocked public compensation disposition, and Payment failure records a no-confirmation result. The
injected source and repository ports do not claim a durable runtime adapter, acceptance producer,
Kitchen release, Provider action or live F13.1 activation.

WP-1401 adds Ordering's public `ConfirmedOrderKitchenSourceEvidence` query boundary. The query
strictly parses its exact Brand, Store, Order, Batch, confirmation, source Event, aggregate-version
and snapshot-digest identity, authorizes `ResolveConfirmedOrderKitchenSource` for the
`CreateKitchenWork` purpose, and only then reads its injected Ordering-owned source. It returns one
to 100 lossy, deeply frozen Item snapshots and recomputes every line digest plus the evidence
digest. Missing, malformed, stale, cross-scope, ambiguous or changed evidence fails closed. This is
not a Kitchen runtime adapter and it exposes no Ordering persistence.

The lossy snapshot intentionally excludes prices, tax, Money, Quote, Cart, Customer/Guest,
contact, Staff/Actor/Participant and Payment/Provider fields. Customer Note is opaque
personal/possible-health text: NFC normalized, limited to 240 Unicode code points and four lines,
and rejected when it contains control or bidirectional-override characters. Ordering and Kitchen
must not infer allergy truth from it or emit it in Events, Audit, errors, logs, URLs, analytics,
screenshots or non-synthetic fixtures.

WP-2110 adds the Phase-2 Order Amendment contract. Add, Reduce / Void, Replace Configuration and
Update Note are explicit Store-scoped, idempotent actions over immutable Order facts. Pricing alone
supplies the pinned Quote and integer-minor-unit delta; employees cannot enter price, tax or refund
values. Fulfilled / Closed Orders fail closed, destructive changes wait for Kitchen confirmation
after work starts, and policy-required approval uses a distinct Actor. Applied changes append one
minimal `OrderAmended.v1` fact for the collaborating public consumers; they do not claim Payment,
Kitchen, Inventory or Fulfillment side effects completed.

```bash
pnpm --filter @rms/ordering test
pnpm ordering-cart:acceptance
pnpm ordering-business-date:acceptance
pnpm ordering-create-order:acceptance
pnpm order-amendment:acceptance
```

WP-2223 exports `createPostgresCartLifecycleStore({ brandReference, storeReference, runner })`
for the existing `CartLifecycleCommandPorts.repository`. It locks the scoped Cart before reading
Items, recomputes the existing terminal transition, atomically appends the original result and
Audit, and returns the durable original for identical concurrent commits. Changed intent or
snapshot conflicts, stale versions fail, and Item/Quote history is preserved. Authorization stays
with `createCartLifecycleCommandService`; the adapter adds no HTTP, scheduler or default runtime
wiring. Verify with `pnpm cart-lifecycle-store:acceptance` and `pnpm ordering-cart:acceptance`.
