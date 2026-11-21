# Local v12 compensation persistence access proposal

Status: Explicitly approved by Owner on 2026-09-21; permission changes executed in WP-2402 batch423; business acceptance remains in progress.

## Scope and observed gap

WP-2402 batch369 read the current configured API-role privileges in v12. All six
compensation owners lack INSERT. Lease, Case, operations and operation-result
history also lack SELECT; action history and refund already have SELECT.
Actual Ordering owner discovery returned zero candidates, with no next page.
These findings do not establish a completed compensation journey.

Only development/InternalTest on 127.0.0.1:55435, database
bop_rms_wp2402_pilot_v12, role bop_rms_wp2402_v4_api is covered. The composed
business worker uses this existing API-role transaction factory.

## Exact requested change

Grant SELECT and INSERT to that role on these six existing Payment-owned tables:

- rms_payment.payment_compensation_lease_history
- rms_payment.payment_compensation_case_history
- rms_payment.payment_compensation_action_history
- rms_payment.payment_compensation_refund
- rms_payment.payment_compensation_operations
- rms_payment.payment_compensation_operation_history

Preserve existing privileges and all records. No UPDATE, DELETE, ownership,
BYPASSRLS, schema changes, new employee role, verified MFA or business seed is
included. Existing RLS, owner fencing, Audit and current source authorization
remain required. The grant applies at database-role/table scope; tenant/store
restriction remains enforced through the existing RLS and owner contracts.
This grant alone does not authorize a System actor to acknowledge operations
reconciliation or fabricate a cancellation/payment disposition.

## Prepared execution and acceptance

The guarded private script is
.local/pilot-v12/prepare-compensation-runtime-access.mjs. It requires development,
exact local host/port/database, checks current_database and the existing non-superuser,
non-BYPASSRLS target role, then applies the six grants in one transaction and
verifies both privileges before commit. Failure rolls back and prints only a
bounded failure code. It contains no credentials.

After approval, run this script once and read back effective privileges using the
actual API-role resource factory. Then continue runtime wiring and real scoped
compensation acceptance when genuine Ordering candidates exist. Existing
cancellation publication/activation approval is a separate pending proposal.
No real Provider refund, production deployment, automatic worker enablement,
new data deletion, or broader local authority is included in this request.

## Current runtime entry

WP-2402 batch414 wires this optional workload through the repository business
entry. After the separately required approval and prerequisites, activation uses
the corresponding explicit boolean in protected `business-worker.json`'s
`workloads` object and the normal controlled worker restart/readiness gate.
Editing the old private `business-worker.mjs` wrapper no longer activates the
current service. The current configuration remains unchanged and disabled;
this implementation note does not record approval or execution.
