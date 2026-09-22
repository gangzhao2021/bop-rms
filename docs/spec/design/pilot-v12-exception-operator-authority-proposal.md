# Local v12 exception workbench employee authority

Status: Explicitly approved by Owner on 2026-09-21; permission changes executed in WP-2402 batch423; business acceptance remains in progress.

WP-2402 batch403 loads the persistent workbench in the actual HTTPS process.
The authenticated page returns403. Actual API-role inspection confirms neither
an active permission definition nor an effective employee grant exists for
operations.order-exception.manage.

## Exact proposed change

Only database bop_rms_wp2402_pilot_v12 at127.0.0.1:55435:

- Add the single permission definition operations.order-exception.manage if absent.
- Create internal_pilot_exception_operator as a Store-scoped role for the existing
  configured DEMO employee, Brand, Store, membership and Store assignment.
- Grant only that permission; role, assignment and grant expire with the existing
  InternalTest profile. Do not extend its validity.
- Increment the existing permission policy version under lock and append an Audit
  record. All changes commit atomically or roll back.

The existing canonical permission controls workbench access and its authorized
operations, including compensation review; it is not a new read-only permission.
Underlying operation eligibility, current role checks, MFA and independent
approval remain enforced. No refund, compensation, Task, exception or Provider
command is executed by this configuration script.

No database ACL, Brand-wide employee role, other permission, MFA state or existing
assignment is changed. This is independent of approved projection/Dining database
reads and pending cancellation/compensation/reconciliation privileges.

Prepared script: .local/pilot-v12/prepare-exception-operator-authority.mjs.
It verifies the exact local target, unexpired InternalTest profile and unique
existing membership/Store assignment, refuses an already existing named role,
locks policy state, and prints only bounded status. After approval, verify the
actual employee page: current partial source coverage must remain Stale/read-only.
