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
Price Book, price resolution, Promotion, Quote/API, Order, Payment or event. WP-1102 owns price
resolution, and WP-1103 owns Quote creation.
Production seed and receipt semantics remain blocked on accountant-approved evidence under
IDR-0024. All fixtures are synthetic and External Evidence is not claimed.

Verification:

```bash
pnpm pricing-money-tax:acceptance
pnpm pricing-tax-configuration:acceptance
pnpm module-manifest:check
pnpm domain-layer-boundary:check
pnpm import-boundary:check
```
