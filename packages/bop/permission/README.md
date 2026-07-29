# `@bop/permission`

Owns the WP-0104 server-side Permission evaluation、decision and bounded explanation contract plus
the WP-0105 Role、Role Assignment、Permission Definition、Permission Grant、Explicit Deny/Allow and
policy-state contracts.

## Contract

- Evaluation starts from a validated immutable Workforce `TenantContext`.
- Business actions are exact bounded identifiers. Wildcards and concrete catalog entries are excluded.
- Resource scope is the exact active Brand or Store from Tenant Context.
- A server-owned policy snapshot supplies normalized、effective and Actor-bound evidence.
- Precedence is `ExplicitDeny > ExplicitAllow > RolePermission > DefaultDeny`.
- Invalid or conflicting evidence fails closed. Results contain stable safe codes and no raw identifiers.
- WP-0105 policy facts use exact Brand/optional Store scope、half-open UTC effective periods and
  optimistic versions. Membership and Store Assignment are revalidated public facts, never grants.
- Materialization produces deterministic normalized evidence for the unchanged WP-0104 precedence.
- `bop_permission` owns six empty policy tables in the Stage DB-2 governance namespace. Tenant rows
  use forced RLS; PUBLIC access is revoked and this increment creates no runtime role or grant.

This package owns no API route、frontend authority、Audit append、Event、concrete action seed、
authentication Session、Provider integration or real workforce fact.

## Verification

Run `pnpm permission-evaluation:acceptance` and `pnpm permission-policy:acceptance` from the
repository root. The latter requires the repository's isolated PostgreSQL lifecycle.
