-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7): a single store lists its
-- menu with one tap and no review; a Brand with more than one store reviews. The Organization
-- owner's database read: does the Brand have exactly one store that is not archived, and is it the
-- store named (a draft or suspended store counts: the Brand is setting up its second store)? It holds the Brand's stores
-- (shared) until the asking transaction ends; adding a store or bringing one back from archived
-- takes the same hold exclusively, so a listing never commits beside a second store being added.
-- The function reads as the migration owner (SECURITY DEFINER, row_security off); the API may call
-- it (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION bop_tenant.brand_has_single_store(target_brand_id uuid, target_store_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 stores integer;
BEGIN
 IF target_brand_id IS NULL OR target_store_id IS NULL THEN
  RETURN false;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('BrandStores:'||target_brand_id::text,0));
 SELECT count(*) INTO stores FROM bop_tenant.store s
  WHERE s.brand_id=target_brand_id AND s.lifecycle<>'Archived';
 RETURN stores=1 AND EXISTS (SELECT 1 FROM bop_tenant.store s WHERE s.brand_id=target_brand_id
  AND s.store_id=target_store_id AND s.lifecycle<>'Archived');
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_has_single_store(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION bop_tenant.hold_brand_stores_for_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('BrandStores:'||NEW.brand_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.hold_brand_stores_for_change() FROM PUBLIC;
CREATE TRIGGER store_hold_brand_stores_insert BEFORE INSERT ON bop_tenant.store
 FOR EACH ROW EXECUTE FUNCTION bop_tenant.hold_brand_stores_for_change();
CREATE TRIGGER store_hold_brand_stores_lifecycle BEFORE UPDATE OF lifecycle ON bop_tenant.store
 FOR EACH ROW WHEN (OLD.lifecycle IS DISTINCT FROM NEW.lifecycle)
 EXECUTE FUNCTION bop_tenant.hold_brand_stores_for_change();
