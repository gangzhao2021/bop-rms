# `@bop/permission`

Owns the WP-0104 server-side Permission evaluation、decision and bounded explanation contract.

## Contract

- Evaluation starts from a validated immutable Workforce `TenantContext`.
- Business actions are exact bounded identifiers. Wildcards and concrete catalog entries are excluded.
- Resource scope is the exact active Brand or Store from Tenant Context.
- A server-owned policy snapshot supplies normalized、effective and Actor-bound evidence.
- Precedence is `ExplicitDeny > ExplicitAllow > RolePermission > DefaultDeny`.
- Invalid or conflicting evidence fails closed. Results contain stable safe codes and no raw identifiers.

WP-0105 owns Role、Permission Grant、Explicit Deny/Allow lifecycle and persistence. This package
owns no database、API route、frontend authority、Audit write、Event or Provider integration.

## Verification

Run `pnpm permission-evaluation:acceptance` from the repository root.
