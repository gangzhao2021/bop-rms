# Whole-project delivery decision inputs

This record organizes remaining inputs; it accepts no new business policy. The [scenario coverage](business-scenario-coverage.md) is the project status view, the [candidate register](../../runbooks/project-candidate-register.md) owns integration identity, and higher accepted Handoff Sections remain authoritative. Each disposition must identify source/version, accountable owner, affected contracts, accepted/rejected/deferred result, evidence and owning WP. Missing inputs remain `Decision required` or External Evidence.

Owner-delegated design clarification (2026-09-29): software design choices, Figma/local interface baselines, rules, mappings and repository composition in this record are our delivery duties. They are not artifacts the Owner must supply. The [current design closure inventory](whole-project-design-closure.md) separates these tasks from unfinished implementation and actual operational/professional/release evidence. Accepted higher-authority rules and real evidence boundaries remain unchanged.

## Operating day and approval

Resolve [AOD-D01–03](approval-and-operating-day.md) with Store Operations, Approval owners and Product: allowed source types; resource-scoped permissions and outcome receipts; substitute approvers and escalation; software versus manual steps; Table readiness/cleaning; unclosed items carried to the next Business Date; evidence retention and stop conditions. Preserve the already accepted assisted InternalTest boundary. Independent operator takeover is not silently reintroduced as its prerequisite.

Acceptance question: can each transition identify its authorized actor, current source/version, entry/exit condition and failure escalation without assuming a manual task occurred? A document proposal cannot supply actual Store or operator evidence.

## Compatibility and privacy

For [SC-D01/02](system-completeness-contracts.md), Product/PWA/API/Release/Database/Worker owners provide exact supported build cohorts and old/new component tuples, retirement/support periods, observation window, schema contract sequence, rollback compatibility and safe recovery. Handoff 80.8.4 already accepts browser-family coverage: latest and previous major iOS Safari/Android Chrome for Customer; latest/previous Chrome/Edge and latest Safari for Merchant manager workflows. Customer responsive widths are 320–1440 px; approved Kitchen/Pickup touch profiles have minimum 1024 × 768 logical resolution. Merchant actions require keyboard access and the WCAG 2.2 AA target with focus/contrast/labels/errors, 200% zoom, reduced motion and touch acceptance. Unsupported browsers receive an explicit upgrade message without silently changing Payment/Order semantics. This does not define application build coexistence or a rollback window.

For SC-D03/04, Privacy and each source/Projection/Archive owner inventory data surfaces and copies, right applicability, legal/hold exceptions, fulfillment or denial evidence, changed manifests and restore/replay tombstone coverage. Professional policy and real requests require their applicable authorized evidence. A projection or backup must not resurrect data prohibited by an applicable tombstone before traffic resumes.

## Accepted performance floors and remaining measurement inputs

Handoff **80.8** already sets engineering targets. These are accepted objectives, not measured results:

| Surface                              | Accepted objective                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Customer ordering                    | Availability 99.9%; RPO ≤5 minutes; RTO ≤60 minutes, with approved maintenance exclusions                  |
| Merchant operations                  | Availability 99.9%; RPO ≤5 minutes; RTO ≤60 minutes                                                        |
| Configuration authoring              | Availability 99.5%; RPO ≤15 minutes; RTO ≤4 hours; published configuration remains available during outage |
| BI/export                            | Availability 99.0%; RPO ≤24 hours; RTO ≤24 hours                                                           |
| Public Menu/Product server reads     | p95 ≤300 ms; p99 ≤800 ms under approved pilot load                                                         |
| Cart Quote                           | p95 ≤500 ms; p99 ≤1.2 seconds excluding Provider latency                                                   |
| Submit before Payment                | p95 ≤800 ms; p99 ≤2 seconds                                                                                |
| Merchant first page, at most 50 rows | p95 ≤500 ms                                                                                                |
| Master-data Command source commit    | p95 ≤800 ms                                                                                                |
| Product/SKU/Inventory projection     | Normal ≤5 seconds; stale signal after 30 seconds                                                           |
| Kitchen/Pickup projection            | Normal ≤2 seconds; alert after 10 seconds                                                                  |
| Customer PWA                         | LCP p75 ≤2.5 seconds on defined mid-tier/4G; INP p75 ≤200 ms; CLS ≤0.1                                     |

Minimum test floors are 60 Customer sessions/Store, 20 Merchant/Kitchen/Pickup sessions/Store, 5 submissions/second/Brand for a 5-minute burst, 100,000 Product/SKU search records/Brand, 250,000 InventoryItem plus scoped-balance records/Brand, and 1,000,000 Order/Payment/Movement history records for retention-query smoke. Production forecast plus headroom must replace these floors when available.

SC-D05/06 still need Product, Store Operations, Domain owners and SRE to bind approved profiles, operation start/end boundaries, eligibility/exclusions, observation windows and minimum samples, resource allocations including rollout overlap, overload priorities and finite stop/recovery conditions. Preserve the accepted 70% database-connection ceiling from the [capacity policy](../../security/cloud-operations-evidence-baseline.json). Report logical operations separately from retry attempts, and Unknown separately from success. Unknown samples or unmatched environments yield `Not evaluable`; breaches yield `Fail`. Neither becomes a production readiness claim.

## Stage and event commitments

Product and owning Domain owners must identify which Later/Future capabilities are delivery commitments, with persisted source, HTTP/normal entry, authorization, recovery and scenario evidence for each. The [coverage table](business-scenario-coverage.md) includes the whole product; a component result does not close its entire row.

The existing [WP-2135](../work-packages/WP-2135.md) leaves GoodsReceiptPosted/Adjusted/Voided transport/persistence to a later owner. That follow-up needs registered producer/consumer, schema/version, scope, Inbox/Outbox, idempotency, replay/retention and owning WP. This record does not claim those events are already transported.
