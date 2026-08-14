# `procurement`

## Identity and responsibility

- Module: `@rms/procurement`; RMS Procurement & Supplier Domain; Later / WP-2131–2133; Procurement
  Engineering Owner.
- Owns Brand-scoped Supplier identity/lifecycle, contact/address references and versioned Supplier
  Qualification Entities, plus stable Supplier Item Offering mappings, append-only purchasing
  configuration Versions and append-only Supplier Price Record Versions.
  It also owns Purchase Requisition workflow, allocation relationships and explicit remainder
  cancellation/closure.
- Does not own Inventory Item/base-unit or receipt/Lot/Ledger facts, Purchase Order,
  payment/accounting, Compliance cases or Tasks.

## Public contract

`procurement_supplier_v1`, `procurement_offering_v1` and `procurement_requisition_v1` provide
permission-trimmed Supplier, Offering and Requisition reads. Commands require Tenant, Brand, Actor, purpose, exact permission, operation
reference, expected Aggregate version and Audit. Offering publication consumes exact public
Supplier, Inventory Item/base-unit, qualification, price-approval and conversion decisions. It
does not create or issue a Purchase Order, mutate Inventory, or accept arbitrary line pricing.
An Inventory Need may create only a Draft Requisition through its public handoff. Requisition
approval remains internal; allocation accepts only a validated PO Draft and never approves or
issues it.

## Dependencies and data

Only `@bop/audit` and `@bop/effective-period` public contracts are synchronous dependencies.
Supplier contacts, addresses and qualification evidence are indirect/personal/sensitive and are
prohibited in logs, URLs and analytics; price/cost and qualification fields are independently
permission-trimmed; fixtures are synthetic-only. No persistence, migration, Event transport, job or
external adapter is implemented in WP-2131–2133.

## Development and verification

```bash
pnpm --filter @rms/procurement format:check
pnpm --filter @rms/procurement lint
pnpm --filter @rms/procurement typecheck
pnpm --filter @rms/procurement test
pnpm --filter @rms/procurement build
```
