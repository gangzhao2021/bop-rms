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
Cart identifiers and attribution references are indirect identifiers and are prohibited from logs,
URLs, analytics, screenshots, and non-synthetic fixtures.

```bash
pnpm --filter @rms/ordering test
pnpm ordering-cart:acceptance
```
