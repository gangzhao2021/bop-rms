-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31 rule 1): when
-- the Brand Owner lists a Brand price change, every Store of the Brand charges it (each keeping its
-- own Store prices). The Organization owner's read of which Stores those are: the Brand's Stores
-- that are not archived, only for the Brand the asking transaction is scoped to, held (shared, as
-- 2000_108) until it ends so a Store being added waits for the listing.
-- Pilot access: api EXECUTE (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION bop_tenant.brand_store_ids(target_brand_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF target_brand_id IS NULL
  OR target_brand_id::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_id', true), '') THEN
  RETURN;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('BrandStores:'||target_brand_id::text,0));
 RETURN QUERY SELECT s.store_id::uuid FROM bop_tenant.store s
  WHERE s.brand_id=target_brand_id AND s.lifecycle<>'Archived' ORDER BY s.created_at, s.store_id;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_store_ids(uuid) FROM PUBLIC;
