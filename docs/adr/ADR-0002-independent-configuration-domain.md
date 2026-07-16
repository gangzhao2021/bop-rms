# ADR-0002 — Independent Configuration Domain

- Status: `Proposed`
- Owner: Architecture Owner
- Affected modules: Catalog, Store, Pricing, BOP Configuration
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Domain-owned configuration and shared contracts currently preserve clear write ownership.

## Decision

Do not extract an independent Configuration Domain in the current baseline.

## Consequences

Configuration remains with its fact owner; shared publication or write ownership is not invented centrally.

## Revisit trigger

Cross-domain configuration requires one write owner or a shared publication workflow, before extracting a shared configuration runtime.
