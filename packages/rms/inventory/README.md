# `inventory`

## Identity and responsibility

- Module: `@rms/inventory`; RMS Inventory Domain; Later / WP-2120; Inventory Engineering Owner.
- Owns Inventory Item identity, lifecycle, unit / conversion, tracking / lot / expiry / negative-stock
  policy, scoped Reorder Policy and rebuildable Stock read contracts.
- Does not own SKU, Recipe, Supplier Offering / price, Purchase Order, accounting ledger, or any
  Movement workflow not explicitly implemented by a later WP.

## Public contract

`InventoryItemCommand` and `executeInventoryItemCommand` require Tenant, Brand, named Actor,
purpose, `inventory.manage`, operation idempotency and expected version. `queryStockOverview`
permits identity-only reads without Stock Scope but requires exactly one Store / StockSite / Location
scope for every quantity, reorder, quantity sort / filter / export or stock action.

## Data and security

Inventory Item is the configuration aggregate; Stock Ledger remains the quantity source of truth.
Quantities use exact decimal strings plus Unit and never binary floating point. All writes authorize
before reads and use injected repository / Audit ports. No schema, migration, Provider, external
service, customer PII, health data, secret, opening balance or live Store fact is implemented here.

## Verification

```bash
CI=true pnpm --filter @rms/inventory format:check
CI=true pnpm --filter @rms/inventory lint
CI=true pnpm --filter @rms/inventory typecheck
CI=true pnpm --filter @rms/inventory test
CI=true pnpm --filter @rms/inventory build
```

WP-2121 may add immutable Movement contracts; WP-2122–2125 own Count, Adjustment, Transfer and
Waste. WP-2132 owns Supplier Offering mapping.
