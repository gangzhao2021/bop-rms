# ADR-0019 — Barcode Namespace and Scanner Context

- Status: `Accepted`
- Owner: Catalog + Inventory Owners
- Affected modules: Catalog, Inventory
- Source: Canonical Handoff Sections 70.8 and 80.6–80.7, version `0.5.3`

## Context

Barcode values can collide across namespaces and scanner contexts.

## Decision

Use namespace-aware uniqueness and context-specific barcode resolution.

## Consequences

SKU and Inventory lookup ambiguity is prevented; consumers must not assume one global unqualified barcode namespace.

## Revisit trigger

An approved global identity service replaces namespace/context resolution.
