---
name: bop-work-package
description: Resolve and plan a BOP-RMS Work Package before implementation or handoff. Use for every new WP brief, execution plan, scope review, or next-WP handoff; establish authority, readiness, files, commands, acceptance evidence, non-goals, and external-action boundaries without inventing evidence.
---

# BOP-RMS Work Package

## Required inputs

- Repository root and named Work Package.
- `docs/spec/README.md`, the current `docs/spec/work-packages/WP-xxxx.md`, and applicable `AGENTS.md` files.
- The exact Canonical Handoff version and only the authoritative sections cited by the brief.
- Current Git/worktree state and explicit user authorization.

## Workflow

1. Read the instruction chain and resolve later accepted decisions before older text.
2. Verify the repository root, current branch/worktree, baseline commit, remote state, and unrelated changes read-only.
3. Record Definition of Ready inputs, dependencies, External Evidence, and real blockers. Treat future triggers as gates, not defects.
4. Map each acceptance criterion to owned files, existing commands/tests, evidence, rollback, and a named non-goal.
5. Produce or refresh the bounded WP brief without copying the full Handoff Package.
6. Plan the smallest implementation. Keep one WP per branch/worktree and distinguish local edits from commit, push, PR, merge, deploy, Figma, or Provider actions.
7. End with the next allowed WP/action and all skipped checks, deviations, or blockers.

## Hard stops

- Stop on a stale or missing brief, a conflicting higher-authority decision, an unexplained dirty worktree, a wrong baseline, or missing authorization for the proposed mutation.
- Do not implement another WP, invent credentials/evidence, silently reopen an accepted decision, or treat a terminal request as broader authority.

## Output

Report WP identity, resolved sources/version, baseline, scope/files, non-goals, dependencies, commands, acceptance/evidence map, risks, rollback, External Evidence, authorization boundaries, and next allowed action.

## Smoke scenarios

- Positive: a clean exact-baseline task produces a bounded brief and executable verification map.
- Boundary: a request to add migration work to a documentation-only WP stops and reports the owning future WP instead of editing persistence files.
