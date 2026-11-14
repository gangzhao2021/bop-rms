---
name: bop-work-package
description: Resolve and plan a BOP-RMS Work Package before implementation or handoff. Use for every new WP brief, execution plan, scope review, or next-WP handoff; establish authority, readiness, files, commands, acceptance evidence, non-goals, and external-action boundaries without inventing evidence.
---

# BOP-RMS Work Package

## Required inputs

- Repository root and named Work Package.
- `docs/spec/README.md`, applicable `AGENTS.md` files, and the current `docs/spec/work-packages/WP-xxxx.md` when it exists; for a new brief, use the authorized task scope and accepted sources.
- The exact Canonical Handoff version and only the authoritative sections cited by the brief or needed to prepare it.
- Current Git/worktree state and explicit user authorization.

## Workflow

1. Read the instruction chain and resolve later accepted decisions before older text.
2. Verify the repository root, current branch/worktree, baseline commit, remote state, and unrelated changes read-only.
3. Record Definition of Ready inputs, dependencies, External Evidence, and real blockers. Treat future triggers as gates, not defects.
4. Map each acceptance criterion to owned files, existing commands/tests, evidence, rollback, and a named non-goal.
   Apply the root `AGENTS.md` verification policy: plan directly affected checks during iteration and one remaining closeout set. Inventory reusable evidence with its source run/revision, covered inputs, and validity rationale; do not treat reused checks as fresh runs. Name the milestone and existing commands for broader regression, plus concrete changes or risks that trigger it. Do not mechanically require full `pnpm verify` or forced uncached integration for every small WP. Preserve mandatory CI/higher-authority gates and explicitly reconcile conflicting brief requirements before execution.
5. Produce or refresh the bounded WP brief without copying the full Handoff Package.
6. Plan the smallest implementation. Keep one WP per branch/worktree and distinguish local edits from commit, push, PR, merge, deploy, Figma, or Provider actions.
7. End with the next allowed WP/action and all skipped checks, deviations, or blockers.

## Hard stops

- Do not begin implementation against a missing or stale brief. Continue authorized planning and creation/refresh of the brief from accepted sources; pause dependent implementation while scope or authority remains unresolved.
- Pause writes that could overwrite unexplained worktree changes or depend on an uncertain baseline. Continue read-only investigation and safely isolated authorized work; preserve unrelated changes.
- Stop the affected mutation on a conflicting higher-authority decision, a wrong baseline, or missing authorization.
- Do not implement another WP, invent credentials/evidence, silently reopen an accepted decision, or treat a terminal request as broader authority.

## Output

Report WP identity, resolved sources/version, baseline, scope/files, non-goals, dependencies, commands, acceptance/evidence map, risks, rollback, External Evidence, authorization boundaries, and next allowed action.

## Smoke scenarios

- Positive: authorized new-WP planning creates a bounded brief and executable verification map when no brief exists, while preserving unrelated worktree changes.
- Boundary: a request to add migration work to a documentation-only WP stops and reports the owning future WP instead of editing persistence files.
