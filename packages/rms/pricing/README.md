# `@rms/pricing`

WP-1100 establishes the provider-neutral Money and tax-calculation Domain contract for Pricing.
Money is always a signed PostgreSQL-bigint-compatible minor-unit value plus an explicit ISO
4217-shaped Currency Code. Decimal tax rates are canonical strings, converted to exact bigint
rationals, and never enter calculation as JavaScript `number` or database floating point.

The public contract provides checked same-currency arithmetic, deterministic signed rounding,
exact minor-unit allocation, version-pinned Currency metadata and resolved Tax Rule snapshots,
and reproducible exclusive/inclusive tax calculation. Results retain the exact rule and Currency
metadata references/digests needed to explain and replay the calculation without consulting later
mutable configuration.

WP-1101 adds Store-scoped, versioned `CA-ON/CAD` Tax Configuration snapshots. Published versions
require exact registration applicability and professionally reviewed fixture evidence, resolve by
effective time plus Catalog classification/order/charge context, preserve component order and
compound behavior, and fail closed for missing/expired/conflicting coverage. Persistence is owned
by `@rms/pricing`, append-only below the mutable aggregate pointer, and protected by exact Brand +
Store forced RLS.

This package does not contain a real Ontario rate, legal classification, actual Store registration,
Promotion, Order, Payment or event.

WP-1102 adds versioned single-Currency Price Books and Sellable Price Entries. Resolution follows
the canonical Store qualified, Store, Store Group qualified, Store Group, Region qualified, Region,
Brand qualified, Brand default order. Effective Period controls eligibility only. Missing coverage
and same-priority ambiguity fail closed; every result pins the Price Book version, snapshot digest,
Entry, scope and reason. Store Group/Region membership and Catalog Sellable validity are injected
facts, not Pricing-owned state.

WP-1103 composes authoritative Price and exclusive-tax resolution into an immutable Price Quote
snapshot. Each Quote pins Cart/Input, Catalog Product/Menu versions, Price Book/Entry, Tax
Configuration/rules, Currency metadata, line totals and expiry. Discount/Fee/Promotion fields are
explicit zero/empty placeholders, never inferred. The API accepts no client amount. Inclusive Pilot
quote composition, expiry/requote decisions and price-increase reconfirmation remain owned by later
WP-1104/1105 work.
Production seed and receipt semantics remain blocked on accountant-approved evidence under
IDR-0024. All fixtures are synthetic and External Evidence is not claimed.

WP-2225 corrects relational line identity for requotes: the same Cart line reference may occur in
different Quotes, while lines and tax components remain unique within each Quote. A forward
migration preserves existing rows, scoped foreign keys, forced RLS and immutable history.
This prerequisite does not supply a full Quote repository.

WP-2226 adds `parsePriceQuoteSnapshot`, `encodePriceQuoteSnapshot` and `decodePriceQuoteSnapshot`.
The version-1 JSON-compatible envelope preserves all Phase-1 Quote fields, currency exponent,
resolution/calculation evidence and array order; amounts use canonical decimal strings. Decoding
rechecks totals and exclusive tax calculations from stored rules without current source lookups.
Objects are independent and deeply immutable. Unsupported adjustments, extra/missing fields and
inconsistent evidence fail with `QUOTE_SNAPSHOT_INVALID`. These functions do not authenticate
sources or authorize a Customer/Store; they are not the existing Customer HTTP response format.
Database fields, atomic persistence and runtime composition remain separate work.

Verification:

```bash
pnpm pricing-money-tax:acceptance
pnpm pricing-tax-configuration:acceptance
pnpm pricing-price-resolution:acceptance
pnpm pricing-quote:acceptance
pnpm module-manifest:check
pnpm domain-layer-boundary:check
pnpm import-boundary:check
```
