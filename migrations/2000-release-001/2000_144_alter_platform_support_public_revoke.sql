-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (full regression 2026-11-02): 2000_143 never stated these revocations, as every other
-- migration does. Default privileges (0000_002) had already kept PUBLIC out, on v15 too, so this
-- changes no one's rights today; it holds if those defaults ever differ. Forward-only: 2000_143 is
-- applied on v15. Roles gain nothing: triggers run without the writer holding EXECUTE.
REVOKE ALL ON bop_permission.platform_support_person FROM PUBLIC;
REVOKE ALL ON bop_permission.store_support_permission FROM PUBLIC;
REVOKE ALL ON bop_permission.store_support_access_log FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.validate_store_support_permission() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.reject_platform_support_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.reject_support_person_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.reject_role_holder_as_support() FROM PUBLIC;
