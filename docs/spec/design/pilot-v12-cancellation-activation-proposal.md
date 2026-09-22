# Local v12 cancellation activation proposal

Status: Explicitly approved by Owner on 2026-09-21; permission changes executed in WP-2402 batch423; normal publication, actual cancellation and local activation completed in batches424–426. Multi-batch paid/table/session preservation acceptance remains separate.

## Current evidence and scope

WP-2402 batch356 matched the migrated six-transition cancellation Draft exactly
against the v12 database and restored its missing private configuration file.
At batch356 the Draft was not Published and cancellation-history INSERT was absent.
Batch423 grants INSERT; batch424 publishes unchanged Workflow version2 through
normal Publishing commands. Batches425–426 verify actual API-role Inventory
failure rollback, successful cancellation and exact replay, then enable the workload. Order revision, Inventory reservation history,
stock movement and Audit already have SELECT and INSERT; no new grant is proposed
for those tables. The resources used by this cancellation composition use the API
role, even when hosted by a worker.

Only development/InternalTest on 127.0.0.1:55435, database
bop_rms_wp2402_pilot_v12 and the existing configured DEMO scope are covered.
The preserved v11 database is not changed.

## Exact requested authority and actions

1. Create a separate expiring Brand-scoped internal_pilot_cancellation_publisher
   role for the existing configured employee and membership, with only
   publishing.draft.create, publishing.review.submit, publishing.review.approve,
   and publishing.release.publish. Existing roles remain unchanged. Expiry equals
   the existing DEMO configuration expiry. Update the policy version and append
   its Audit record in one guarded transaction. These are real Brand-wide
   application permissions; the permission schema does not constrain this role
   to a single Workflow. Execution in this task is limited to the family below.
2. Grant INSERT on rms_ordering.order_batch_checkout_cancellation to
   bop_rms_wp2402_v4_api in this local database. No UPDATE, DELETE, ownership,
   bypass-RLS or additional table privileges are included.
3. Through actual Publishing and Workflow owner commands, review and publish
   only the existing InternalTestBatchCancellation family, DineIn applicability,
   with its six unchanged transitions. Do not synthesize approval/publication
   evidence or bypass any required independent-review, permission or release gate.
   A remaining unsatisfied owner gate must be reported rather than overridden.
4. After actual publication and focused acceptance, enable the local cancellation
   workload with current Payment, Kitchen, Dining and Inventory fences. It may
   act only on genuinely Failed, expired, unaccepted/unstarted unpaid batches.
   Preserve other paid batches, occupied tables and shared sessions. Unknown
   payment results are not Failed and must not be cancelled by this workflow.
   Check atomic Inventory release and operation replay before unattended enablement.

The six pairs are Submitted to Submitted/Cancelled, Accepted to Accepted, and
InProgress to InProgress/Ready/Fulfilled. They describe the aggregate Order after
removing the eligible unpaid batch; they do not authorize cancelling accepted work.

## Prepared implementation and verification

Private guarded scripts: .local/pilot-v12/prepare-publication-authority.mjs and
.local/pilot-v12/prepare-cancellation-runtime-access.mjs. Both permission scripts were executed in batch423.
The first is adapted from the earlier v11 proposal, not an executed migration.

Historical execution plan, completed through426: recheck current scope/schema and existing role state, execute only
these changes, read back exact privileges and verify the four application actions
through current membership/permission sources. Then perform normal publication,
focused cancellation/Inventory rollback and replay checks, and actual local
expired-batch acceptance. Do not rerun unrelated business suites. Publishing or
workflow command defects discovered in this path remain work to implement.

Earlier automatic approval review rejected Brand-level publication authority in
WP-2402 batch259 for lack of specific authorization. Ordinary refund business
approval and the v12 MFA grant approval do not cover this change. This document
makes the current request concrete; approval is not a claim that it has run.

No real Provider transaction, production permission, production deployment,
verified MFA, external publication, or change to the accepted Dining rule is included.

## Current runtime entry

WP-2402 batch414 wires this optional workload through the repository business
entry. After the separately required approval and prerequisites, activation uses
the corresponding explicit boolean in protected `business-worker.json`'s
`workloads` object and the normal controlled worker restart/readiness gate.
Editing the old private `business-worker.mjs` wrapper no longer activates the
current service. The current configuration explicitly enables batchCancellation and keeps compensation disabled;
batch426 records actual approved activation.
