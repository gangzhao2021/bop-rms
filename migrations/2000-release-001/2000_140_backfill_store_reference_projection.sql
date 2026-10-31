-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION, v15 2026-10-31 (coordinator): no Store could be
-- opened on v15 (STORE_REFERENCE_SOURCE_INVALID). v15 was built by applying the migrations to an
-- empty database and then loading v14's rows with `pg_restore --data-only --disable-triggers`
-- (WP-2423, 2026-10-07): 0200_020's backfill ran while bop_tenant.brand and .store were still
-- empty, and the load skipped the trigger that keeps the Store reference registry, so the Brand
-- had no generation row and its Store no projection row. Adding a Store requires both.
-- This repair writes, for every Brand and Store that lacks them, exactly what the trigger and
-- 0200_020/0200_023 write (generation 0 with the Brand's Store count; each Store's lifecycle,
-- version, times, code and display name). Rows that exist are never touched. It runs here and is
-- kept as an owner-only function, because the same data-only upgrade path runs migrations before
-- it loads rows: `tooling/environment/pilot-upgrade-data-plan.mjs` names it as a step after the load.
CREATE FUNCTION bop_tenant.repair_store_reference_projection()
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 brands bigint;
 stores bigint;
BEGIN
 -- Serialize against organization writers, as 0200_020 and 0200_023 do.
 LOCK TABLE bop_tenant.brand, bop_tenant.store, bop_tenant.store_reference_generation,
  bop_tenant.store_reference_projection IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO bop_tenant.store_reference_generation (brand_id, generation, reference_count)
  SELECT b.brand_id, 0, (SELECT count(*) FROM bop_tenant.store s WHERE s.brand_id = b.brand_id)
  FROM bop_tenant.brand b
  WHERE NOT EXISTS (SELECT 1 FROM bop_tenant.store_reference_generation g WHERE g.brand_id = b.brand_id);
 GET DIAGNOSTICS brands = ROW_COUNT;
 INSERT INTO bop_tenant.store_reference_projection
  (brand_id, store_id, lifecycle, version, created_at, updated_at, code, display_name)
  SELECT s.brand_id, s.store_id, s.lifecycle, s.version, s.created_at, s.updated_at, s.code, s.display_name
  FROM bop_tenant.store s
  WHERE NOT EXISTS (SELECT 1 FROM bop_tenant.store_reference_projection p
   WHERE p.brand_id = s.brand_id AND p.store_id = s.store_id);
 GET DIAGNOSTICS stores = ROW_COUNT;
 RETURN brands + stores;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.repair_store_reference_projection() FROM PUBLIC;
SELECT bop_tenant.repair_store_reference_projection();
