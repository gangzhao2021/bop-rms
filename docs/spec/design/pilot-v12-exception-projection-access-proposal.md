# Local v12 exception projection access proposal

Status: Explicitly approved by the Owner and executed in WP-2402 batch378.

WP-2402 batch377 actual current API-role catalog read confirms that
platform_projection.order_exception_source exists, but the role has no schema
USAGE, SELECT or INSERT. The earlier name-resolved privilege probe therefore
failed. Source implementation and successful fixture tests do not overcome this
runtime permission gap.

## Exact change

Only on development/InternalTest 127.0.0.1:55435, database
bop_rms_wp2402_pilot_v12, role bop_rms_wp2402_v4_api:

- GRANT USAGE ON SCHEMA platform_projection.
- GRANT SELECT, INSERT ON platform_projection.order_exception_source.

No privileges on other tables, UPDATE, DELETE, schema CREATE, ownership or
BYPASSRLS are requested. Existing tenant/Brand/Store RLS and public owner source
validation remain required. No business rows or synthetic exception records are
inserted by the grant script. Schema USAGE allows object name resolution; it does
not grant data access to other projection tables.

The prepared script is .local/pilot-v12/prepare-exception-projection-access.mjs.
It checks exact local environment/database/host/port and existing non-superuser,
non-BYPASSRLS target role, applies grants atomically, verifies them before commit,
and rolls back on failure. No credentials are embedded or printed.

This is separate from the pending six Payment compensation-table proposal and
from the approved MFA access change. An approval of either earlier scope does
not cover this additional projection schema/table. Batch378 actual API-role readback confirms schema USAGE and table SELECT/INSERT,
with UPDATE and DELETE false. The public Projection store read succeeds with zero
rows and no next page; no business rows were inserted. Current workbench remains Stale until complete source coverage is proven;
these grants alone never establish Fresh status or authorize case closure.

Execution evidence: cac31d committed the guarded grant transaction; 7dd204
confirmed the exact database/API role and successful read through the public owner
store. This establishes local access only, not source coverage or pilot acceptance.
