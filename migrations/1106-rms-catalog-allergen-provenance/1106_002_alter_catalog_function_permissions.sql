-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
REVOKE ALL ON FUNCTION rms_catalog.enforce_category_tree() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.enforce_menu_inheritance() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.reject_menu_effective_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.enforce_published_menu_checkpoint_order() FROM PUBLIC;
