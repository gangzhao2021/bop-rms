---
name: bop-screen-contract
description: Resolve the complete BOP-RMS Screen contract for Figma or code changes affecting a Screen, Pattern, Route, shared component, responsive behavior, or UI state. Use to map Screen ID, placement, fields, permissions, Projections, Commands, states, accessibility, privacy, and tests before design or UI implementation.
---

# BOP-RMS Screen Contract

## Required inputs

- Owning WP and applicable `AGENTS.md` chain.
- `docs/spec/README.md`, current WP brief, and `docs/product/screen-registry.yaml`.
- Section 88 authority and, for visual work, the Accepted Figma frame/node and source version.

## Workflow

1. Resolve the canonical Screen ID, surface, `kind`, `route_mode`, route/parent/family, Phase/feature gate, and owning WP.
2. Enumerate fields, views, search/filter/sort, actions, Commands, Permissions, Projections, navigation, and analytics/privacy classification.
3. Enumerate default, loading, empty, unauthorized/forbidden/permission-denied, not-found, validation, conflict, rate-limit, offline, stale, Provider pending/unknown, disabled, and recovery states that apply.
4. Resolve viewport, reflow, keyboard/focus, accessible-name, error-association, non-color state, touch-target, localization, zoom, and reduced-motion requirements.
5. Compare Registry, Handoff, Accepted Figma, code, and tests. Revise the lower-authority artifact or stop for an approved decision change.
6. Map every applicable state and permission outcome to implementation plus behavior, accessibility, and visual evidence using synthetic data.

## Hard stops

- Do not let pixels, Make output, fixtures, or client state weaken server validation, authorization, money/tax/lifecycle truth, or Section 88 semantics.
- Do not turn an embedded/contextual/alias entry into a standalone route, perform a generic redesign, publish Figma/Make, or write Figma without explicit target authority.

## Output

Return the resolved Screen contract, source references, implementation/test map, discrepancies, approved deviations, blockers, and external-action boundary.

## Smoke scenarios

- Positive: a route task resolves Screen ID, permission, all applicable states, responsive/accessibility rules, and tests before code changes.
- Boundary: a screenshot-only request that omits or conflicts with a permission-denied state rejects the visual shortcut and preserves the server contract.
