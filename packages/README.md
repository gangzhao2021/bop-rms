# Packages

This directory contains reusable BOP and RMS modules and their public contracts.

Future packages follow the accepted repository blueprint:

- `bop/` contains business-agnostic platform modules and must not depend on RMS modules.
- `rms/` contains restaurant-specific modules.
- `contracts/` contains stable cross-module public contracts.
- `database/` contains shared persistence infrastructure, not domain-owned tables or rules.
- `testing/` contains test harnesses, fixture builders, and assertion helpers.

WP-0002 establishes only the top-level boundary. Later Work Packages create a subdirectory when they have real owned content; empty module trees and placeholder package manifests are intentionally excluded.
