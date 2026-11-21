# Local reconciliation access for canonical198

Status: Owner approved on 2026-09-22; applied to `bop_rms_wp2402_restore_upgrade538` in batch543. Applied to `bop_rms_wp2402_pilot_v14` during batch546 quiesced cutover. Supersedes the unexecuted
[canonical197 capture-only proposal](pilot-provider-capture-access-proposal.md).

## Exact scope

Endpoint `127.0.0.1:55435`; existing role `bop_rms_wp2402_v4_api`;
only these two databases:

- `bop_rms_wp2402_restore_upgrade538`, the canonical198 isolated restored dataset.
- `bop_rms_wp2402_pilot_v14`, only after canonical198 creation and preserved-data
  restoration; this permission does not itself authorize or perform cutover.

Grant only `SELECT, INSERT` on:

- `rms_payment.provider_capture_exception_evidence`: retain unmatched simulated
  Provider captures as immutable evidence for owner reconciliation.
- `rms_payment.reconciliation_follow_up_history`: retain acknowledged/assigned
  operator actions and versioned replay history, with existing transactional Audit.

No new role, credentials, membership, schema privileges, UPDATE, DELETE, TRUNCATE,
REFERENCES, TRIGGER, grant option or BYPASSRLS. Existing forced RLS and append-only
triggers remain. The grant script changes no business rows; subsequent scoped
InternalTest capture evidence and personnel-follow-up acceptance writes are part
of the requested pilot implementation. This does not enable automatic compensation,
refund a payment, resolve the financial difference, or access an external Provider.

## Executable preparation

Protected `.local/pilot-v13/reconciliation541-access.mjs <target>` defaults to
read-only inspection. Only an explicit `--apply` executes the two grants in one
transaction. Exact target allowlist, local endpoint, canonical198 migration
verification, role non-super/non-bypass/non-owner, forced RLS and pre/post effective
privilege checks are required. Pre-existing privileges must be empty or precisely
SELECT/INSERT; an unexpected wider state aborts. Failure rolls back both grants.

Batches538–540 verify preserved data, original ACLs, paired installation and actual
API-role historical financial reads on upgrade538. Batches512/514 cover the capture
writer;526/531 cover real follow-up history/Audit atomicity and scoped access;
535–537 cover UI retry/conflict/self-assignment. These do not replace actual
newly granted API-role end-to-end acceptance.

Prior approvals named other tables; explicit confirmation was obtained for these
new table privileges in batch543. The earlier520 question is superseded by this consolidated
scope; no separate response to520 is needed. Automatic compensation approval
remains independent.
