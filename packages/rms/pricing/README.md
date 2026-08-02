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

This package does not contain a real Ontario rate, legal classification, Store registration,
Price Book, price resolution, Promotion, Quote/API, Order, Payment, persistence or event. WP-1101
owns Store Tax Configuration, WP-1102 owns price resolution, and WP-1103 owns Quote creation.
Production seed and receipt semantics remain blocked on accountant-approved evidence under
IDR-0024. All fixtures are synthetic and External Evidence is not claimed.

Verification:

```bash
pnpm pricing-money-tax:acceptance
pnpm module-manifest:check
pnpm domain-layer-boundary:check
pnpm import-boundary:check
```
