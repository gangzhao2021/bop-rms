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

The module does not implement Cart creation transport, Catalog Option validation, Pricing Quote
attachment, expiration/abandonment actions, Checkout, Order, Event, Projection, UI, or external
evidence. Those remain owned by later Work Packages.
Cart identifiers and attribution references are indirect identifiers and are prohibited from logs,
URLs, analytics, screenshots, and non-synthetic fixtures.

```bash
pnpm --filter @rms/ordering test
pnpm ordering-cart:acceptance
```
