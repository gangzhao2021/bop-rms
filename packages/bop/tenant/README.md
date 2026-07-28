# `@bop/tenant`

Owns the WP-0101 Brand and Store aggregate contract and the `bop_tenant` schema.

## Contract

- Brand is the primary tenant boundary.
- Every Store belongs to exactly one immutable Brand reference.
- v0.1 supports CAD only; Store requires a canonical IANA time zone and locale.
- Brand and Store use closed lifecycle transitions, positive optimistic versions, UUIDv7 opaque references and canonical UTC millisecond instants.
- Inputs are strict closed plain objects; errors expose stable codes and safe messages.

## Persistence and isolation

The module owns `bop_tenant.brand` and `bop_tenant.store`. Both tables use forced RLS. Brand context requires exact Brand with no Store; Store context requires exact Brand and Store. `PUBLIC` receives no schema or table authority, and migrations create no runtime grants.

The package publishes only its root contract. Consumers must not query its private tables. Real Brand/Store facts and Provider data are External Evidence and are not supplied here.

## Verification

Run `pnpm --filter @bop/tenant test`, `pnpm --filter @bop/tenant typecheck`, and the root `pnpm organization-aggregate:acceptance`.
