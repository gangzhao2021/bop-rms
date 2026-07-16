# Packages

This directory contains reusable BOP and RMS modules and their public contracts.

Future packages follow the accepted repository blueprint:

- `bop/` contains business-agnostic platform modules and must not depend on RMS modules.
- `rms/` contains restaurant-specific modules.
- `contracts/` contains stable cross-module public contracts.
- `database/` contains shared persistence infrastructure, not domain-owned tables or rules.
- `testing/` contains test harnesses, fixture builders, and assertion helpers.

WP-0004 adds only `packages/ui`, justified as the minimal shared semantic-token and accessibility-wrapper foundation for two web shells. Business components and all other package families remain deferred to their owning Work Packages.
