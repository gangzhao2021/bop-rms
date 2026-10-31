# Local Provider capture evidence access

Status: Superseded, not executed. See [current canonical198 two-table proposal](pilot-reconciliation-198-access-proposal.md). The scope below is historical and must not be executed against current198 targets.

## Concrete scope

On 127.0.0.1:55435 only, grant the existing role
`bop_rms_wp2402_v4_api` SELECT and INSERT on the single table
`rms_payment.provider_capture_exception_evidence` in:

- `bop_rms_wp2402_restore_upgrade517`, the existing isolated upgrade rehearsal.
- `bop_rms_wp2402_pilot_v14`, only after it has been created with canonical197
  migrations and the preserved pilot dataset for a separately recorded cutover.

No new role, password, membership, schema grant, UPDATE, DELETE, TRUNCATE,
BYPASSRLS or grant option. Existing forced Brand/Store RLS and append-only triggers
remain required. The role is already used by the configured reconciliation worker.
The new access permits recording original unmatched simulated capture evidence;
existing exception and Audit writes remain under their previously granted access.
It does not authorize a refund or operator resolution of an unmatched capture.

## Preparation and evidence

WP-2402 batches512/514 prove atomic writer, rollback, concurrency, scoped access and
actual simulator-to-Projection composition. Batches517–519 prove canonical197 data
transfer, preservation of354 original ACL entries and configured financial reads.
The new table retains canonical default access and has not received this grant.

Protected `.local/pilot-v13/capture520-access.mjs` accepts only the two exact target
databases, verifies local endpoint, canonical migration verification, role safety,
forced RLS and an empty pre-existing privilege set or precisely SELECT/INSERT.
It grants only those two privileges in one transaction and verifies the resulting
privilege set before commit. No business rows are changed by this script.

This access is independent of the pending automatic compensation activation.
The previously approved compensation/exception table access does not name this
new evidence table. Request explicit confirmation for this bounded addition.
