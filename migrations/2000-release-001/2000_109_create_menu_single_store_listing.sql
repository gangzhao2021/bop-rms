-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7): a single store lists its
-- menu with one tap ("List it"), no review. The approval of the listed version is still the
-- Publishing lifecycle record (by the person who listed it); this append-only companion record
-- marks it SingleStoreListing. It is refused unless the Brand has exactly one store that is not
-- archived at that moment (Organization read, 2000_108, held until the listing commits). Every
-- other menu approval needs another person (or the re-verified sole operator, 2000_034).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_catalog.reject_menu_single_store_listing_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only menu single store listing' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.reject_menu_single_store_listing_mutation() FROM PUBLIC;

CREATE TABLE rms_catalog.menu_single_store_listing (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 menu_id platform_helpers.uuid_v7 NOT NULL,
 menu_version_id platform_helpers.uuid_v7 NOT NULL,
 lifecycle_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SingleStoreListing'),
 listing_store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 listed_at timestamptz NOT NULL CHECK (isfinite(listed_at) AND listed_at=date_trunc('milliseconds',listed_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,approval_evidence_id),
 CONSTRAINT menu_single_store_listing_operation_unique UNIQUE (brand_id,operation_id)
);

-- The Brand has exactly one store (not archived), and it is the store named; held to commit.
CREATE FUNCTION rms_catalog.check_menu_single_store_listing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF bop_tenant.brand_has_single_store(NEW.brand_id, NEW.listing_store_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'menu single store listing needs a brand with one store' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_menu_single_store_listing() FROM PUBLIC;
CREATE TRIGGER menu_single_store_listing_one_store AFTER INSERT ON rms_catalog.menu_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_menu_single_store_listing();
CREATE TRIGGER menu_single_store_listing_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.menu_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_menu_single_store_listing_mutation();
CREATE TRIGGER menu_single_store_listing_no_truncate BEFORE TRUNCATE ON rms_catalog.menu_single_store_listing
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_menu_single_store_listing_mutation();
ALTER TABLE rms_catalog.menu_single_store_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_single_store_listing FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_single_store_listing_brand_policy ON rms_catalog.menu_single_store_listing
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_catalog.menu_single_store_listing FROM PUBLIC;
