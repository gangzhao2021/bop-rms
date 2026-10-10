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

## Delivery and execution

- Use a complete usable business workflow as the delivery unit: ordinary entry, current reads, authorized commands, persistence, post-write refresh and error/retry recovery, with rendered UI where applicable. A contract, adapter, passing suite or internal checkpoint is implementation progress, not a completed feature.
- Plan the smallest implementation that completes that workflow. Split independent implementation/review work across agents, but keep one coordinator, one acceptance inventory and one workflow closeout. Internal subtasks do not require separate milestone plans or completion reports.
- Prioritize the path that makes the workflow usable. Reuse existing owners, sources and components; add a layer, profile or abstraction only for an identified requirement or incompatibility that blocks the current delivery. Do not implement speculative extensions before the ordinary flow works.
- Keep one concise current plan, remaining-work list and check inventory in the owning WP. Update current planning/status in place; preserve original evidence and historical records. Record each command/result once and link to it instead of copying the same evidence into multiple summaries.
- A chat continuation or completed internal dependency does not require a new fingerprint checkpoint, repeated repository-wide inventory or documentation closeout. Record a reproducible source checkpoint at a real workflow handoff/delivery, or when needed to protect retained work or support evidence reuse.
- Report progress in terms of usable behavior and specific unfinished work. Do not infer project completion percentages or dates from milestone counts or test counts; label unmeasured estimates as provisional. Separate repository-completable work from real external acceptance without treating missing software composition as an external gate.

## Verification and handoff

- Run the current WP's required commands from the repository root unless the WP says otherwise. Cover frozen install plus every existing affected format, lint, typecheck, test, integration, architecture, contract, migration, build, and security check using fresh runs or valid recorded evidence under the rules below.
- During development, run directly affected checks. At WP closeout, inventory completed, running, and missing checks and execute only the remaining necessary checks; do not restart a useful running check or repeat a passing check without a relevant change, failure, or unresolved risk.
- Reuse evidence only with its source WP/run, command, result, tested revision and any uncommitted changes, and a reason its covered inputs remain unchanged. Consider dependencies, configuration, toolchain, environment, and generated artifacts as well as source files. Reuse frozen-install evidence only for the same valid installation and unchanged manifests, lockfile, and pinned toolchain. Missing or uncertain evidence requires a fresh affected check; reused evidence is not a new run.
- Name full-repository regression milestones and their commands in the WP plan, such as a complete cross-domain journey or release/merge gate. Broaden checks for changed shared contracts, persistence, authorization, tooling, or unresolved cross-module risk. Do not default every small WP to full `pnpm verify` or forced uncached integration; bypass caches only for an explicit gate or concrete freshness concern. Mandatory CI and higher-authority gates still apply, and conflicting WP requirements must be explicitly reconciled before execution, never silently skipped.
- Before running checks, add a concise selection to the WP: the acceptance question or risk, affected inputs, smallest existing command/filter, and whether evidence is fresh, reusable or not applicable. Do not create a separate verification framework or duplicate evidence report for a routine change.
- For documentation-only changes, check the changed text, relevant sources/links and formatting; do not run business suites, database acceptance or application builds. For local code/tooling changes, use directly affected behavior tests and lint/type checks. Expand to consumers or integration only for changed shared contracts, persistence, authorization, actual consumer dependencies or an identified cross-module risk.
- A new WP number, branch rename, progress update, evidence write-up or closeout is not itself a reason to rerun unchanged code checks, reinstall valid dependencies, clear caches or start full regression. A new worktree still needs a valid installation; mandatory exact-head CI still applies where required.
- One coordinator owns the check inventory across agents. Assign each necessary check once and reuse its result; other agents review the relevant diff instead of independently repeating the same suite. Batch independent reads and retain resolved source facts rather than rereading large documents without a new question.
- Stop local verification once all acceptance questions have evidence, remaining required checks are resolved and the scoped diff is reviewed. Broaden or rerun only after identifying a relevant input change, failure, unresolved risk or mandatory gate; record that reason before execution. Do not keep testing merely to accumulate more passing results.
- Review the final diff for scope, generated files, migrations, secrets, PII, permissions, tenant/store filters, error states, and documentation drift.
- Done means every acceptance criterion has evidence. Report skipped or blocked checks exactly; never claim an unrun check passed.
- Do not commit, push, merge, deploy, rotate credentials, alter external services, or perform destructive data/Git operations unless the assigned task explicitly authorizes that action.

## Pilot track (WP-2423)

- While WP-2423 is active, a routine change records one line in WP-2423: what changed, the check command and its result. No fingerprint checkpoint, evidence write-up or crosswalk.
- Full evidence discipline still applies to payment, refund, reconciliation, settlement, migrations, authorization and data classification.
- Do not work on items listed as bypassed in WP-2423 unless the pilot path is blocked by them.
- Commercial fidelity (Owner, 2026-10-07): design for how a real store operates, never choose an option because it is simpler. Existing designs that fall short must be listed in WP-2423 and corrected. Test-environment-only shortcuts must be labelled as such.
- Operating continuity: every pilot workflow names what staff do when the network, cloud host, Provider or store device fails, and that path must be usable in the product or the runbook, not assumed.
- No reachable stubs: a route, screen or panel in the pilot customer or merchant path either works against real sources or is hidden; never ship a permanent "Unavailable" placeholder to customers or staff.
- Customer respect: no forced login, account, follow or marketing consent to order; collect only the contact needed to fulfil the order and say why; customer and staff text uses their language, never internal codes, IDs or technical terms.
