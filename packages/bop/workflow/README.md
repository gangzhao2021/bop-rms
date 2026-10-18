# Workflow

Owner: Workflow Engineering Owner. Public package: `@bop/workflow`.

Workflow owns versioned Workflow definitions, Brand base definitions and authorized Store overrides. Its private database owner is `bop_workflow.workflow_definition_version`; the [module manifest](src/module.manifest.ts) declares dependencies and data handling. Publishing owns publication/approval authority; Workflow does not manufacture a publication decision or bypass that contract.

The [public exports](src/index.ts) provide definition types, scoped resolution, persistence ports, action evaluation and publication snapshots. Resolution checks scope and effective version. Evaluation checks current resource/version, publication, authorization and rules under the owning transaction fences. RMS owns its state meanings and side effects: Workflow evaluation does not itself execute an RMS Command or create a transition record.

Unknown, unavailable, stale or mismatched authority fails closed. Cross-domain access uses these public contracts rather than private tables. Indirect identifiers are prohibited in logs, URLs and analytics; fixtures are synthetic only.

Read the [accepted specification](../../../docs/spec/README.md), [database ownership](../../../docs/adr/ADR-0029-database-ownership-evidence.md) and current owning WP before changing contracts. Existing package checks are `pnpm --filter @bop/workflow lint`, `pnpm --filter @bop/workflow typecheck` and `pnpm --filter @bop/workflow test`; listing them here is not a new passing result.
