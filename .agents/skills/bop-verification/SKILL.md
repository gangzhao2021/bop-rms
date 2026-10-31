---
name: bop-verification
description: Verify a BOP-RMS Work Package before any Done claim, handoff, Ready transition, or merge. Use to select and run every existing affected check, inspect the final diff and generated drift, scan secrets/PII/scope, map actual evidence to acceptance criteria, and disclose every skip or blocker.
---

# BOP-RMS Verification

## Required inputs

- `docs/spec/README.md`, current WP brief and acceptance criteria, and applicable `AGENTS.md` files.
- Exact branch/worktree/baseline, final diff, repository scripts, and external-action authorization.

## Workflow

1. Reconfirm the named WP, cleanly explained worktree state, exact baseline/head, and affected files.
2. Derive commands only from repository scripts and the WP brief. Cover frozen install and every existing affected format, lint, typecheck, unit, integration, architecture, contract, migration, permission, accessibility, security, visual, build, and runtime check. Inventory completed, running, and missing checks before launching more work. During development run directly affected checks; at closeout execute only the remaining necessary checks.
3. Run checks from the repository root and record exact command/exit/result and tested revision, including uncommitted changes. Reuse passing evidence only when covered source, dependencies, configuration, toolchain, environment, and generated artifacts remain valid; cite its source WP/run and explain why later changes do not invalidate it. Frozen-install reuse also requires the same valid installation and unchanged manifests, lockfile, and pins. Treat missing or uncertain evidence as requiring a fresh affected run. Do not restart useful running checks or repeat valid results without relevant changes, failures, or unresolved risk. Never turn a failure into a pass by disabling a gate or rewriting unrelated tests.
4. Parse relevant structured files and inspect task/dependency graphs, executable paths, generated artifacts, lockfile drift, processes/ports/resources, and cleanup state as applicable.
5. Review the final diff for WP scope, unrelated/generated churn, secrets, PII, real Store/Provider data, permissions, Tenant/Store filters, money/time, error/recovery, migrations, production/deploy/Figma changes, and documentation drift.
6. Map evidence to every acceptance criterion. Mark each `PASS`, `FAIL`, or `BLOCKED`; name every skipped/unavailable check and reason.
7. Before Ready/merge, verify PR checks and re-fetch the exact expected head. Stop on drift, conflict, pending/skipped/failed owning checks, or unexplained changes.

## Regression scope and reuse

- Follow the root `AGENTS.md` verification policy. Record full-repository regression milestones and exact existing commands in the WP plan, rather than copying full `pnpm verify` and forced uncached integration into every small WP. A complete cross-domain journey or a release/merge gate can be a milestone; shared-contract, persistence, authorization, tooling changes or unresolved cross-module risk require reassessing and broadening affected coverage.
- Use cache bypass only for an explicit gate or concrete freshness concern. Mandatory CI and higher-authority requirements remain binding. Explicitly reconcile conflicting WP requirements with the accepted policy or user authorization before changing the plan; never silently skip them.
- Reuse a composite command's component evidence only when every required component, input, setup, ordering constraint, and artifact is covered. Do not claim that the composite command itself ran. A test count or an old summary alone does not establish equivalent coverage.
- Label acceptance evidence as fresh or reused, with its source and applicability. Record checks not executed and why, including full regression deferred to a named milestone. Report failures and blockers without hiding them behind reuse.

## Hard stops

- No fabricated pass, hidden skip, disabled gate, unrelated test rewrite, unknown-head merge, force push, or external action without separate authority.

## Output

Report commands/results, acceptance map, security/scope/diff review, cleanup, deviations/skips/blockers, branch/head/PR evidence, and the next authorized action.

## Smoke scenarios

- Positive: all affected checks and diff reviews pass, each acceptance criterion has observed evidence, and the handoff names exact SHAs/results.
- Boundary: a failing unrelated future-WP check is recorded and stops expansion; it is not repaired or omitted to claim Done.
