# Approval, Work Routing and Operating-day Handover

## Status and authority

This is the documentation proposal for [WP-2224](../work-packages/WP-2224.md), based on
`main@cedc44c9b6a6a1b389f77342078cc6f2d540dabe`. Accepted rules below remain unchanged.
`AOD-D01` through `AOD-D03` are proposed follow-up contracts, not accepted runtime behavior,
new Work Packages or an instruction to operate a real Store. The external Handoff must be
reconciled before implementation. No operating procedure or test is claimed as executed here.

## Accepted baseline

| Source                                                                         | Preserved rule                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Section 88 Screen Registry](../../product/screen-registry.yaml)               | `APPROVAL-INBOX`, `TASK-INBOX`, `TASK-DETAIL` and `ALERT-CENTER` keep their canonical routes, scope, states and source-action boundaries.                                                                                                                       |
| [WP-0125](../work-packages/WP-0125.md)                                         | Task owns assignment, claim, due/escalation and Task outcome; it is independent of Approval, Workflow and Notification. Completing a Task does not complete its source business action.                                                                         |
| [WP-0045](../work-packages/WP-0045.md)                                         | Observability owns technical alert routing and runbooks; role destinations and transport plans do not prove delivery or business incident resolution.                                                                                                           |
| [WP-1807](../work-packages/WP-1807.md)                                         | Server-authorized navigation is permission-trimmed; a link grants neither direct-route access nor command permission. Store switching refreshes authorized scope.                                                                                               |
| [WP-1809](../work-packages/WP-1809.md), [WP-1310](../work-packages/WP-1310.md) | Order exception actions route to source owners. Compensation closure requires the exact Provider-confirmed refund and Operations reconciliation receipts; Task completion is insufficient. The accepted Critical exception visibility target remains unchanged. |
| [WP-2192](../work-packages/WP-2192.md), [WP-1905](../work-packages/WP-1905.md) | Store owns hours, service pauses and Business Day Start; dashboards expose source freshness and completeness and do not own transaction truth.                                                                                                                  |
| [WP-1007](../work-packages/WP-1007.md), [WP-1605](../work-packages/WP-1605.md) | Dining closure can preserve unpaid Orders and required exception Tasks. Fulfilled does not mean Order Closed.                                                                                                                                                   |
| [WP-1408](../work-packages/WP-1408.md), [WP-1808](../work-packages/WP-1808.md) | KDS handover locks/ends the former named Session before the next operator; recovery requeries source truth without replaying commands.                                                                                                                          |

## AOD-D01 — Canonical work surfaces and source routing

### Follow-up ownership record

The Registry maps the Approval Inbox and Task screens to WP-0125, but that WP explicitly
excludes their UI/Projection and source resolution flows. It also separates Task from Approval.
The Alert Center maps to WP-0045, whose bounded implementation is technical alert routing.
These mappings identify prerequisites; they do not establish complete business-screen delivery.
This record supplies the missing follow-up scope without editing the Registry or changing its
`workflow` label into a new owning module.

| Follow-up scope                   | Proposed accountable roles                                                        | Required completion artifact                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval Inbox source adapters    | Product + Merchant Web; each participating source Domain owner                    | Closed source allowlist, immutable request/impact reference, exact source permission and approve/reject/result contract for every admitted source type. |
| Task Inbox/Detail composition     | Task owner + Merchant Web; participating source owners                            | Authorized query, claim/assignment eligibility, source navigation, source-finality reconciliation and escalation integration.                           |
| Merchant Alert Center composition | Product + Merchant Web + business source owners; Observability reviews separation | Business alert lifecycle/acknowledgement ownership and query contract; source workbench links; explicit exclusion of Platform-only alerts.              |

The later WP must resolve the query/Projection implementation owner and precise asset access
before persistence. No `organization_*_v1` table, generic Approval Domain, new permission or
catch-all source adapter is authorized by this proposal. Unsupported source types are unavailable.

### Canonical entry points and semantics

All four surfaces retain the Registry's `workflow.operate` screen permission. Server-side field,
Task-action and source-command permissions are additional checks; the screen permission does not
grant them. Existing source-specific permissions remain authoritative; no prefix/wildcard grant
or invented common approval command is permitted.

| Canonical screen and route          | User purpose                                                                                             | Boundary                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `APPROVAL-INBOX` — `/app/approvals` | Eligible approver finds a request, reviews current impact, opens or executes an allowed source decision. | Source Domain validates independent approval and owns the decision; claiming work never grants approval authority.           |
| `TASK-INBOX` — `/app/tasks`         | Authorized Actor finds, claims or assigns scoped work and opens its source.                              | Task owns assignment; acknowledging a reminder does not accept the source outcome.                                           |
| `TASK-DETAIL` — `/app/tasks/{id}`   | Review timeline, due/SLA, current assignment and allowed source resolution.                              | Controlled comments require an approved content contract; WP-0125's no-free-form boundary is not relaxed here.               |
| `ALERT-CENTER` — `/app/alerts`      | Triage a business signal and open its Task, incident or source workbench.                                | Acknowledgement is distinct from source resolution; Platform-only technical alerts stay in their established operator route. |

### Proposed interaction sequence

1. Query with trusted Tenant, Brand, Store, Actor, purpose and field permission. Return only safe
   source references, source type/version, authorized display, owner/assignment, due-policy reference,
   freshness and permitted navigation. Querying or sorting never changes an assignment or source.
2. Open one item and re-read its owner-issued request and impact. Source reference, version and
   reviewed impact must match. A changed request invalidates the previous review; a cached row
   cannot authorize approval. Missing scope, evidence or permission produces a bounded denial.
3. Claim/assign only through the accepted Task contract when applicable, with exact eligibility,
   expected Task version and idempotency. Keep Task version separate from source request version.
4. Invoke only the source owner's accepted command, revalidating exact scope, permission, Actor,
   purpose, expected source version, independent-approver rules and required evidence. Retain one
   operation identity for an exact intent. Audit and source changes use that owner's transaction.
5. Requery the source receipt and affected work item. Display pending, rejected, conflict, unknown
   and final outcomes distinctly. Do not commit a cross-Domain transaction or equate successful
   transport, acknowledgement, Notification delivery or Task completion with source completion.
6. Return to the same authorized queue/filter context and reconcile the row. If the Store or
   permission changed, load the new authorized context; never carry a former scope's mutable draft
   or authorization into it. No sensitive filters or draft content enter URLs or persistent caches.

| Candidate source family                               | Routing and finality to preserve                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Menu, Store, Role, Inventory and Procurement approval | Open the corresponding canonical source editor/workbench. Only that owner's current policy and approval receipt permit the next publish/post/issue step.                                   |
| Dining unpaid/indeterminate Batch                     | Manager work routes to `OPS-ORDER-EXCEPTION` and its Task; Dining may close only under WP-1007's terminal-execution and Task-receipt rules.                                                |
| Payment reconciliation/compensation                   | Payment handles Provider truth and financial action; authorized Operations supplies the separate reconciliation receipt. Refund-only or Operations-only evidence leaves compensation Open. |
| Food Safety finding or failed verification            | Open the owning Compliance case/workbench; containment, verification and release remain source-owned. A reminder acknowledgement never releases a block.                                   |
| Technical service/security failure                    | Use WP-0045's Observability runbook/role routing. Do not expose Platform-only diagnostics or reuse a technical alert as a Merchant business-resolution record.                             |

Each family is a proposed integration candidate, not an enabled allowlist. The follow-up WP must
enumerate exact source types, canonical destinations, minimal fields, permissions and receipts.

## AOD-D02 — Approval coverage, unavailable sources and escalation

| Condition                                      | Proposed operator response                                                                                                                              | Authority that remains required                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Source stale, partial or unavailable           | Approver refreshes; source owner investigates source health. Manager keeps the work visibly unresolved and arranges operational coverage.               | No approval or finality from the old snapshot; unknown counts are not empty queues.                     |
| Source version/impact changed                  | Show a conflict, retrieve the new impact and require a new explicit decision.                                                                           | Owner's current version/policy; no silent reuse of prior approval.                                      |
| Permission lost or Session/scope changed       | Stop issuing commands, remove restricted context and reauthenticate/reselect authorized scope. Manager arranges an eligible replacement.                | Reauthorization precedes any read/retry; waiting work grants no privilege.                              |
| Approver unavailable or segregation would fail | Route to an already eligible independent approver under the source policy; otherwise escalate the unresolved dependency to its owner.                   | No self-approval, automatic override or emergency grant invented by the Inbox.                          |
| Due/escalation policy missing                  | Show that the policy is unresolved and have Product/source owner close the activation dependency.                                                       | No fabricated numeric SLA, implicit no-deadline policy or automatic reassignment.                       |
| Existing source deadline overdue               | Authorized Task owner evaluates due time and appends escalation through the accepted contract; manager follows the approved role-based escalation path. | Source policy controls deadline/severity; scheduler/delivery require their own accepted implementation. |
| Response lost after command                    | Keep outcome unknown; reauthenticate if required, then retrieve/reconcile using the exact original operation identity before retrying.                  | Source replay semantics and original intent; no fresh key to bypass uncertainty.                        |
| Notification or escalation delivery fails      | Retain unresolved work and delivery failure separately; responsible manager uses the approved alternate contact procedure.                              | Failure cannot complete, cancel or approve a source request; actual contacts remain outside Git.        |

The Source Domain owner defines decision eligibility and finality. Task owner manages assignment
and escalation records. Store Operations owns staffing coverage; Platform on-call handles technical
outage through the existing runbook. These are proposed responsibilities, not named assignments.
Before activation, obtain source-approved escalation policy, role coverage and delivery/recovery
evidence. Preserve existing explicit SLAs, including WP-1809, rather than replacing them here.

## AOD-D03 — Operating-day SOP and unresolved-work handover

This proposed SOP coordinates existing owners; it introduces no global Close Store aggregate,
financial settlement command, scheduling/time-clock platform or cross-Domain atomic operation.
It preserves [ADR-0007](../../adr/ADR-0007-finance-accounting-domain.md),
[ADR-0003](../../adr/ADR-0003-generic-workforce-scheduling-domain.md) and the Dine-in/Pickup
Pilot boundary in [ADR-0028](../../adr/ADR-0028-pilot-store-fulfillment-baseline.md).
The owner must decide which steps are software-assisted and which remain an approved manual SOP.

| Stage                     | Responsible role and proposed procedure                                                                                                                                                         | Exit/failure behavior                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare/open              | Store Manager checks exact Store, current hours/service configuration, accepted Live Gate, authorized operator coverage, menu availability and applicable safety/device evidence.               | Unavailable evidence is explicit; do not certify readiness or enable a service by completing a checklist. Source commands and real operating approvals remain required.                           |
| Accept previous work      | Incoming Manager reads unresolved Orders, Pickup, Dining, Payment and Tasks across relevant original Business Dates, with source as-of/completeness.                                            | Acknowledge responsibility only after current source review. Missing source/coverage remains an outstanding handover item.                                                                        |
| Operate                   | Named Staff, Kitchen and Pickup operators use existing command gates; Manager reviews exception/approval queues and policy-based due work.                                                      | A stale board is read-only; interruption never queues business mutations for reconnect replay.                                                                                                    |
| Pause a service           | Authorized Store operator applies the approved mode-specific pause/closure through Store controls and confirms its source result.                                                               | Pause affects admission according to existing rules; it does not cancel accepted Orders, stop Kitchen work, void Payment or imply a refund. Unknown pause outcome requires source reconciliation. |
| Wind down                 | Manager reviews in-flight, unfulfilled, uncollected and amended Orders; source operators finish or use existing authorized exception/compensation paths.                                        | Do not bulk-mark work Fulfilled/Closed. Outstanding work remains source-visible with a responsible role and next action.                                                                          |
| Close Dining Sessions     | Authorized Staff/Host follows WP-1007: terminal execution evidence, admission lock and required exception Task receipts.                                                                        | Non-terminal execution blocks Dining close; unpaid/indeterminate Orders remain Open with their exception responsibilities.                                                                        |
| Hand over operations      | Outgoing Manager presents unresolved source references and proposed next owners; incoming eligible roles review and accept responsibility. KDS operators follow lock-then-new-Session handover. | If no eligible recipient accepts, record incomplete handover and escalate to the approved operational backup. Never report successful handover or grant privileges by timeout.                    |
| Review next operating day | Incoming Manager requeries retained source references, reconciles late Payment/fulfillment facts and checks remaining due work before relying on summaries.                                     | Preserve original source facts and Business Dates. Late evidence creates the owner's normal append-only updates; it does not rewrite yesterday's transactions.                                    |

### Handover information and closure distinctions

Proposed handover information is a minimized review bundle, not a new system of record: exact
scope, review UTC instant, relevant source Business Date(s), source type/reference/version,
freshness/completeness, safe unresolved-reason code, current Task/assignment when present,
next source-owned action, approved due/escalation-policy reference and acceptance outcome.
Any durable handover record, retention policy or acknowledgement command requires a later owner
and schema/contract decision. Do not put customer notes, contact, health, payment instruments,
Provider payloads, credentials or operational evidence bytes in this document or a handover URL.

- Calendar midnight, Store Business Day Start, an operator handover and physical closing time are
  different events. Use the configured IANA timezone and source-owned Business Date attribution;
  display the review time separately. Never relabel an old Order or financial fact to clear a queue.
- The manager may record that operating work was handed over without declaring every Order Paid,
  every refund confirmed, every Task resolved or the accounting day closed. Physical premises
  procedures and staffing obligations require approved Store policy; this proposal defines neither.
- Dining `Closed` is not proof that a Table is clean or available for seating. WP-1007 originally
  points to WP-2112 for Table follow-up, but [WP-2112](../work-packages/WP-2112.md) explicitly
  excludes Table cleaning. Record that future ownership and the manual boundary. Existing
  [WP-2173](../work-packages/WP-2173.md) Cleaning evidence does not itself change Dining availability.
- Do not require unresolved refunds to be guessed final at closing. WP-1310 cases retain the
  original method, pending/unknown status and required independent receipts; in-person Interac
  action remains subject to its existing evidence gate.

### Decisions required before a follow-up implementation

| Proposal | Required decision/evidence                                                                                                                                                           | Proposed accountable role                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| AOD-D01  | Reconcile external Section 88; approve exact source types, query/Projection owner, canonical navigation, action permissions and result adapters for the four existing work surfaces. | Product + Merchant Web + Task/source owners                              |
| AOD-D02  | Approve per-source eligibility/segregation, alternate coverage, due/escalation policy, recovery semantics and operational delivery evidence; retain accepted deadlines.              | Source owners + Store Operations; Security reviews permission boundaries |
| AOD-D03  | Approve software/manual split, opening/pause/closing checklist applicability, unresolved-work acceptance, Table readiness ownership and retention of any future handover record.     | Store Operations + Product; relevant Domain and Privacy owners           |

Real staffing, Store, accessibility, device/network, support and go/no-go evidence remain the
existing [Pilot readiness gates](../../runbooks/pilot-integration-readiness-inventory.md).
An accepted document or a synthetic test cannot substitute for those records.

## Future acceptance scenarios and existing command anchors

Every scenario below is **proposed, not newly implemented or executed in WP-2224**. Commands
already exist in [root package.json](../../../package.json) or the named workspace manifest.
They are regression anchors; their existence or historical pass does not prove these journeys.
Future implementation must add scenario-specific behavior evidence and run its owning WP checks.

| ID     | Required scenario evidence                                                                                                                                                     | Existing regression anchor                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| AOD-01 | Authorized source row opens only its canonical workbench; foreign Store, missing source permission and unsupported type fail closed.                                           | `pnpm screen-registry:check`; `pnpm --filter @bop-rms/merchant-web test`                                          |
| AOD-02 | Task claim/assignment leaves source approval untouched; only an eligible independent Actor can invoke the exact source decision.                                               | `pnpm task:acceptance`; `pnpm --filter @bop/permission test`; `pnpm --filter @bop-rms/merchant-web test`          |
| AOD-03 | Changed impact/version or stale/unavailable source invalidates action readiness; refresh never fabricates an empty/resolved queue.                                             | `pnpm task:acceptance`; `pnpm --filter @rms/store test`; `pnpm --filter @bop-rms/merchant-web test`               |
| AOD-04 | Lost command response, expired Session and Store switch retain exact intent and prevent retry under another scope or a new operation identity.                                 | `pnpm task:acceptance`; `pnpm merchant-bff:acceptance`; `pnpm --filter @bop/permission test`                      |
| AOD-05 | Unavailable approver, overdue work and failed notification preserve independent approval, pending work and policy-based escalation; technical alerts remain separately routed. | `pnpm task:acceptance`; `pnpm notification:acceptance`; `pnpm alert-routing:acceptance`                           |
| AOD-06 | Opening/service pause uses current Store authority; missing evidence blocks readiness claims; existing Orders and Payment facts remain unchanged by checklist actions.         | `pnpm store-configuration:acceptance`; `pnpm --filter @rms/ordering test`                                         |
| AOD-07 | Terminal Dining execution plus required exception receipts permit only the accepted closure; unpaid Orders persist and Table cleanliness is not inferred.                      | `pnpm dining-closing:acceptance`; `pnpm --filter @bop-rms/merchant-web test`                                      |
| AOD-08 | Operator handover locks former KDS Session; stale/offline recovery requeries without replay; missing recipient leaves handover incomplete.                                     | `pnpm kds-continuity:acceptance`; `pnpm kds-profile:acceptance`                                                   |
| AOD-09 | Pending/unknown refund survives handover; late confirmed evidence and separate Operations receipt converge without duplicate financial action.                                 | `pnpm payment-reconciliation:acceptance`; `pnpm payment-compensation:acceptance`                                  |
| AOD-10 | Review across Business Day Start/DST retains original source dates, exposes missing sources and carries unresolved responsibility into the next review.                        | `pnpm --filter @rms/store test`; `pnpm --filter @bop/projection test`; `pnpm --filter @bop-rms/merchant-web test` |

Role and Store approval are example source anchors; each admitted source needs its own tests.
No dedicated end-to-end approval-routing or operating-day script currently proves this proposal.
The follow-up WP must explicitly add the missing journey evidence; existing demo route smoke tests
and Domain tests cannot be relabelled as its completed acceptance.
