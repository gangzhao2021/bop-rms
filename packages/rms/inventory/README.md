# `inventory`

## Identity and responsibility

- Module: `@rms/inventory`; RMS Inventory Domain; Later / WP-2120–2123; Inventory Engineering Owner.
- Owns Inventory Item identity, lifecycle, unit / conversion, tracking / lot / expiry / negative-stock
  policy, scoped Reorder Policy and rebuildable Stock read contracts.
- Does not own SKU, Recipe, Supplier Offering / price, Purchase Order or accounting ledger.

## Public contract

`InventoryItemCommand` and `executeInventoryItemCommand` require Tenant, Brand, named Actor,
purpose, `inventory.manage`, operation idempotency and expected version. `queryStockOverview`
permits identity-only reads without Stock Scope but requires exactly one Store / StockSite / Location
scope for every quantity, reorder, quantity sort / filter / export or stock action.
`queryStockMovements` requires one explicit Stock Scope and returns immutable source, conversion,
balance-snapshot, Actor, Audit and correction-chain evidence. `correctStockMovement` can only ask an
injected Ledger port for one exact inverse of an eligible original; it never edits or deletes facts.
`executeStockCountCommand` captures expected quantities only through a server-owned snapshot port,
enforces blind-count / assignee / variance / recount / segregation policy, and posts one atomic set of
idempotent Count Adjustment Movements only after approval and Balance-version validation.
`executeStockAdjustmentCommand` validates a scoped, evidence-backed quantity delta against a
server-owned Balance / Item-policy snapshot and authorized evidence resolver, enforces independent
high-risk approval and accepts only one exact atomic immutable Adjustment Movement after approval.

## Data and security

Inventory Item is the configuration aggregate; Stock Ledger remains the quantity source of truth.
Quantities use exact signed decimal strings plus Unit and conversion snapshot, never binary floating
point. All writes authorize before reads and use injected Ledger / idempotency / Audit ports. No
schema, migration, Provider, external service, customer PII, health data, secret, opening balance or
live Store fact is implemented here. Count persistence, snapshot freezing and aggregate + Ledger
posting remain atomic injected ports because Section 50 assigns no Inventory schema.

## Verification

```bash
CI=true pnpm --filter @rms/inventory format:check
CI=true pnpm --filter @rms/inventory lint
CI=true pnpm --filter @rms/inventory typecheck
CI=true pnpm --filter @rms/inventory test
CI=true pnpm --filter @rms/inventory build
```

WP-2124 owns the scoped Waste Aggregate, threshold approval and Food Safety / Kitchen public-reference linkage. WP-2125 owns Transfer workflows. WP-2132 owns Supplier Offering mapping.
