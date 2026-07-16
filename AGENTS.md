# BOP-RMS Agent Guide

## Scope and authority
- Work only inside the assigned Work Package. Do not expand scope, reopen accepted decisions, or write unrelated business code.
- Read `docs/spec/README.md` and the current `docs/spec/work-packages/WP-xxxx.md` before editing.
- Decision precedence is the Handoff Package rule referenced by the spec index. Higher accepted Sections supersede conflicting older text.
- External Evidence and Future Triggers are gates, not defects. Never invent credentials, accounts, legal facts, Provider results, Store facts, test evidence, or approvals.

## Environment
- On Windows, run the agent and all repository tools in WSL2. Keep the checkout and worktrees in the WSL Linux filesystem, normally `~/src/bop-rms`; do not use `/mnt/c`, OneDrive, or a mixed Windows/Linux toolchain for this repository.
- Use the exact Node and pnpm pins in `.nvmrc` and `package.json`; use pnpm only and keep the lockfile frozen in CI.
- Repository text uses LF and case-sensitive path semantics. Never create files that differ only by case.

## Architecture invariants
- Each fact has one owning Domain. Cross-domain access uses public contracts, Commands, Events, or approved Projections; never query another Domain's private tables.
- Keep Tenant, Brand, Store, Actor, purpose, permission, expected version, idempotency, audit, and data classification explicit where the contract requires them.
- Money never uses binary floating point. Store UTC instants internally and resolve IANA time zone plus Business Date explicitly.
- Transaction, ledger, audit, event, and evidence history is append-only; correct through an approved compensating operation.
- Never place secrets, tokens, unrestricted object IDs, payment data, allergy/health facts, or unnecessary PII in logs, URLs, analytics, fixtures, screenshots, or error payloads.
- Section 88 Screen IDs, routes, permissions, states, responsive/accessibility rules, and Projection ownership are canonical for UI work.

## Change discipline
- Inspect repository status first and preserve unrelated user changes.
- One branch/worktree and one WP at a time. Avoid unrelated refactors, dependency upgrades, generated churn, or speculative abstractions.
- Add or update tests with behavior. Do not bypass type, lint, architecture, contract, migration, permission, accessibility, or security checks.
- Use only commands and scripts that exist in the current repository. If a required command is missing, treat that as a WP defect instead of inventing a successful result.

## Verification and handoff
- Run the current WP's required commands from the repository root unless the WP says otherwise. At minimum, use frozen install plus every existing affected format, lint, typecheck, test, integration, architecture, contract, migration, build, and security check.
- Review the final diff for scope, generated files, migrations, secrets, PII, permissions, tenant/store filters, error states, and documentation drift.
- Done means every acceptance criterion has evidence. Report skipped or blocked checks exactly; never claim an unrun check passed.
- Do not commit, push, merge, deploy, rotate credentials, alter external services, or perform destructive data/Git operations unless the assigned task explicitly authorizes that action.
