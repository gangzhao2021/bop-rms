# Architecture Decision Records

This directory materializes the stable Architecture Decision Register from Canonical Handoff Section 80.7 and later accepted Sections, accepted composite Sections 0–97; the source identifying itself as `0.5.9` is governed by the [spec index](../spec/README.md#authority).

- `ADR-0001` through `ADR-0017` are `Proposed` future-trigger decisions. Their current position is binding: the proposed platform or Domain is not part of the current baseline until its trigger is met and the ADR is accepted.
- `ADR-0018` through `ADR-0034` are `Accepted` decisions and must be followed by affected Work Packages.
- Use [`ADR-0000-template.md`](ADR-0000-template.md) for a new decision. Never reuse or renumber an existing ID.
- ADRs do not replace the Complete Handoff Package, current WP brief, or External Evidence. A semantic change requires the normal accepted review path.

Run `pnpm repository-guidance:check` after any ADR change.
