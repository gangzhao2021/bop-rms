# Local v12 reconciliation read access proposal

Status: Explicitly approved by Owner on 2026-09-21; permission changes executed in WP-2402 batch423; business acceptance remains in progress.

WP-2402 batch382 actual API-role catalog read confirms SELECT is absent on both
existing Payment reconciliation tables. Batch381 confirmed schema USAGE exists.
The exception reader and authoritative identity enrichment cannot operate without
these reads; unit tests are not live acceptance.

## Exact change

Only development/InternalTest database bop_rms_wp2402_pilot_v12 at
127.0.0.1:55435, existing role bop_rms_wp2402_v4_api:

- SELECT on rms_payment.payment_reconciliation_exception.
- SELECT on rms_payment.payment_reconciliation_record.

No INSERT, UPDATE, DELETE, schema privilege, ownership or BYPASSRLS change.
No business rows, Provider calls or service activation. Existing scope/RLS remains
required. Returned application sources exclude financial amounts and Provider
references; unresolved daily-settlement/order identity remains unresolved.

Prepared script: .local/pilot-v12/prepare-reconciliation-read-access.mjs.
It checks exact local database/host/port and non-superuser/non-BYPASSRLS target,
grants only these reads atomically, verifies before commit and rolls back on
failure. No embedded or printed credentials. After approval, use the actual API
role and public reader to verify access; an empty result does not prove positive
reconciliation acceptance or complete exception coverage.

This scope is separate from approved MFA/projection privileges and from pending
cancellation activation and six-table compensation privileges.
