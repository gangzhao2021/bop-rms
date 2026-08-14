# `procurement`

## Identity and responsibility

- Module: `@rms/procurement`; RMS Procurement & Supplier Domain; Later / WP-2131; Procurement
  Engineering Owner.
- Owns Brand-scoped Supplier identity/lifecycle, contact/address references and versioned Supplier
  Qualification Entities.
- Does not own Inventory receipt/Lot/Ledger facts, Supplier Offering/price (WP-2132), Requisition,
  Purchase Order, payment/accounting, Compliance cases or Tasks.

## Public contract

`procurement_supplier_v1` provides permission-trimmed Supplier list/detail reads. Supplier Commands
require Tenant, Brand, Actor, purpose, exact permission, operation reference, expected Aggregate
version and Audit. Qualification eligibility is a public result for later Offering/PO composition;
it does not publish, issue, cancel or receive anything.

## Dependencies and data

Only `@bop/audit` and `@bop/effective-period` public contracts are synchronous dependencies.
Supplier contacts, addresses and qualification evidence are indirect/personal/sensitive and are
prohibited in logs, URLs and analytics; fixtures are synthetic-only. No persistence, migration,
Event transport, job or external adapter is implemented in WP-2131.

## Development and verification

```bash
pnpm --filter @rms/procurement format:check
pnpm --filter @rms/procurement lint
pnpm --filter @rms/procurement typecheck
pnpm --filter @rms/procurement test
pnpm --filter @rms/procurement build
```
