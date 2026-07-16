# Merchant web guidance

- Section 88 Screen IDs, permission/scope semantics, stale/conflict states, and responsive/accessibility rules remain canonical; this WP contains only a synthetic shell.
- Never infer authorization from hidden UI. Do not add business routes, Provider data, real Store data, or runtime remote fonts.
- Keep keyboard focus visible, landmarks ordered, state text non-color-only, and scope switching explicitly synthetic until its owning WP.
- Run this workspace's lint, typecheck, test, and build commands after changes; root guidance remains fully applicable.
