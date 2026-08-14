# `procurement`

## Identity and responsibility

- Module: `@rms/procurement`; RMS Procurement & Supplier Domain; Later / WP-2131–2132; Procurement
  Engineering Owner.
- Owns Brand-scoped Supplier identity/lifecycle, contact/address references and versioned Supplier
  Qualification Entities, plus stable Supplier Item Offering mappings, append-only purchasing
  configuration Versions and append-only Supplier Price Record Versions.
- Does not own Inventory Item/base-unit or receipt/Lot/Ledger facts, Requisition, Purchase Order,
  payment/accounting, Compliance cases or Tasks.

## Public contract

`procurement_supplier_v1` and `procurement_offering_v1` provide permission-trimmed Supplier and
Offering reads. Commands require Tenant, Brand, Actor, purpose, exact permission, operation
reference, expected Aggregate version and Audit. Offering publication consumes exact public
Supplier, Inventory Item/base-unit, qualification, price-approval and conversion decisions. It
does not create or issue a Purchase Order, mutate Inventory, or accept arbitrary line pricing.

## Dependencies and data

Only `@bop/audit` and `@bop/effective-period` public contracts are synchronous dependencies.
Supplier contacts, addresses and qualification evidence are indirect/personal/sensitive and are
prohibited in logs, URLs and analytics; price/cost and qualification fields are independently
permission-trimmed; fixtures are synthetic-only. No persistence, migration, Event transport, job or
external adapter is implemented in WP-2131–2132.

## Development and verification

```bash
pnpm --filter @rms/procurement format:check
pnpm --filter @rms/procurement lint
pnpm --filter @rms/procurement typecheck
pnpm --filter @rms/procurement test
pnpm --filter @rms/procurement build
```
