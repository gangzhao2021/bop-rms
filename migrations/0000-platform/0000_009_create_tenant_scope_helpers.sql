-- bop-rms-migration: 1
-- owner: shared-infrastructure/helpers
-- schema: platform_helpers
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION platform_helpers.current_brand_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
RETURN NULLIF(pg_catalog.current_setting('bop.brand_id', true), '')::uuid;

CREATE FUNCTION platform_helpers.current_store_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
RETURN NULLIF(pg_catalog.current_setting('bop.store_id', true), '')::uuid;

REVOKE ALL ON FUNCTION platform_helpers.current_brand_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_helpers.current_store_id() FROM PUBLIC;
