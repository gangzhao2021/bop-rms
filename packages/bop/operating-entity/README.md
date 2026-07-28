# `@bop/operating-entity`

Owns the WP-0101 Operating Entity aggregate, effective-dated Brand/Store assignments and the `bop_operating_entity` schema.

## Contract

- v0.1 supports only `LegalEntity` in jurisdiction `CA-ON`.
- Activation requires an opaque External Evidence reference; no legal, tax, banking or settlement fact is invented.
- Business functions are closed to receipt issuer, tax registrant, settlement owner, procurement buyer, licence holder and employer.
- Store resolution requires one exact active Brand + Store + business-function assignment at the requested instant. Zero or multiple matches fail closed, and Brand assignments never act as Store fallback.
- Inputs, versions, transitions, references and instants follow the strict public `@bop/tenant` contract.

## Persistence and isolation

The module owns `operating_entity`, `brand_operating_entity_assignment`, and `store_operating_entity_assignment`. Tenant references are validated opaque public identifiers: there is no cross-Domain foreign key to `bop_tenant` private tables. Tables use forced RLS, no `PUBLIC` authority and no migration-created runtime grants.

Real registrations, tax identifiers, billing identities, settlement accounts and assignment facts remain External Evidence.

## Verification

Run `pnpm --filter @bop/operating-entity test`, `pnpm --filter @bop/operating-entity typecheck`, and the root `pnpm organization-aggregate:acceptance`.
