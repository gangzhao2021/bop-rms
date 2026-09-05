# Packages

This directory contains reusable BOP and RMS modules and their public contracts.

The package families follow the accepted repository blueprint:

- `bop/` contains business-agnostic platform modules and must not depend on RMS modules.
- `rms/` contains restaurant-specific modules.
- `contracts/` contains stable cross-module public contracts.
- `database/` contains shared persistence infrastructure, not domain-owned tables or rules.
- `testing/` is a reserved blueprint family, not a materialized package. Current reusable isolated
  database fixtures live under `database/test-support/`; application fixtures remain in their owned
  test-support directories.

`ui/` supplies the shared semantic-token and accessibility foundation. Existing BOP/RMS modules contain Domain contracts, application services and the persistence adapters accepted by their owning Work Packages. A schema, port or test fixture alone does not establish a connected application runtime.

See the [current delivery-status ledger](../docs/spec/project-status.md) for implementation and integration boundaries. Add packages, business components or persistence only within the owning Work Package; shared infrastructure never acquires another Domain's facts or rules.
