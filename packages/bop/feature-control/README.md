# `@bop/feature-control`

Owns the WP-0120 provider-neutral minimum contract for Release Flags、Kill Switches、exact
Brand/Store scope、deterministic basis-point rollout、shutdown policy、bounded recovery and
evaluation records.

## Contract

- Every definition has a strict `module.capability.variant` key、owner、purpose、explicit default、
  review/expiry、half-open UTC effective interval and positive version.
- Exact Store definitions override their same-key Brand definition only inside that Brand.
- Rollout consumes an opaque precomputed bucket; raw Actor、Customer、device and network identity
  never enters this package.
- One immutable evaluation drives the frontend visibility hint and authoritative backend decision.
  Frontend hiding is never authorization.
- Active Kill Switches block new work and return the caller-owned in-flight policy. Business Domains
  remain responsible for safe pause、termination、compensation and completed facts.
- State changes require an exact `@bop/permission` decision and an injected unit of work that
  atomically commits the next immutable control version with a bounded `@bop/audit` record.
- Recovery evidence is exact scope/version bound、time bounded and required for progressive or full
  reopening.

This package owns no database object、runtime role/grant、generic Policy Engine、production route、
Section 88 Screen、Provider/WAF/cloud flag service、real Tenant/control fact or deployment.

## Verification

Run `pnpm feature-control:acceptance` from the repository root.
