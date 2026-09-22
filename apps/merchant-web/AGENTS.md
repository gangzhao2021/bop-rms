# Merchant web guidance

- Section 88 Screen IDs, permission/scope semantics, stale/conflict states, and responsive/accessibility rules remain canonical.
- Never infer authorization from hidden UI. Do not add Provider data, real Store data, or runtime remote fonts.
- Keep keyboard focus visible, landmarks ordered, state text non-color-only, and implement business routes and scope switching only within the owning WP and Section 88 contract.
- Follow the root `AGENTS.md` verification policy: run or reuse affected workspace lint, typecheck, test, and build checks; documentation-only changes need text, source/link, and format review.
