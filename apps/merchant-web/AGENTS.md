# Merchant web guidance

- Section 88 Screen IDs, permission/scope semantics, stale/conflict states, and responsive/accessibility rules remain canonical for the implemented screens and every later change.
- Never infer authorization from hidden UI. Add or connect business routes and Provider/Store dependencies only within their owning Work Package; unavailable authorization or evidence must fail closed. Never invent real Store/Provider facts or add runtime remote fonts.
- Keep keyboard focus visible, landmarks ordered, and state text non-color-only. Scope switching must use the owning Session/Permission contract; synthetic navigation is not evidence of an authorized real Session.
- See the [current delivery-status ledger](../../docs/spec/project-status.md) for runtime and acceptance boundaries. The local demo is explicitly synthetic and read-only; it does not activate production routes or permissions.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
