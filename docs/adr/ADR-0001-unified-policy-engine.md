# ADR-0001 — Unified Policy Engine / Rule DSL

- Status: `Proposed`
- Owner: Architecture Owner
- Affected modules: BOP Policy, Pricing, Promotion, Availability, Compliance
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Current modules can share evaluation contracts without a generic rule-authoring runtime.

## Decision

Do not introduce a unified Policy Engine or Rule DSL in the current baseline. Keep rule ownership in the owning Domain and use explicit shared contracts.

## Consequences

This avoids premature abstraction. Repeated authoring and explainability work may remain duplicated until evidence supports extraction.

## Revisit trigger

Three or more modules duplicate rule authoring and require shared evaluation and explainability, before the first shared policy-authoring WP.
