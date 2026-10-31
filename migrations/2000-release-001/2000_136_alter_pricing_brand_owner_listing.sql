-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31, a revision of
-- Owner trade-off 7 under the Owner's standing authority; the Owner may overrule it): at a Brand
-- with several Stores, a Brand menu change (names, options, new dishes, combos, allergens, prices)
-- is listed directly only by someone with Brand Owner authority, recorded as BrandOwnerListing
-- with who listed it, as a single-store listing is. Anyone else's Brand change stays a draft for
-- the Brand Owner. The single-store rule (2000_108) is unchanged.
ALTER TABLE rms_pricing.price_book_single_store_listing DROP CONSTRAINT price_book_single_store_listing_approval_mode_check;
ALTER TABLE rms_pricing.price_book_single_store_listing ADD CONSTRAINT price_book_single_store_listing_approval_mode_check
 CHECK (approval_mode IN ('SingleStoreListing','BrandOwnerListing'));
ALTER TABLE rms_pricing.option_price_single_store_listing DROP CONSTRAINT option_price_single_store_listing_approval_mode_check;
ALTER TABLE rms_pricing.option_price_single_store_listing ADD CONSTRAINT option_price_single_store_listing_approval_mode_check
 CHECK (approval_mode IN ('SingleStoreListing','BrandOwnerListing'));

CREATE OR REPLACE FUNCTION rms_pricing.check_pricing_single_store() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF NEW.approval_mode='BrandOwnerListing' THEN
  IF bop_permission.actor_holds_brand_owner_authority(NEW.brand_id, NEW.actor_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'pricing brand owner listing needs Brand Owner authority' USING ERRCODE='23514';
  END IF;
 ELSIF bop_tenant.brand_has_single_store(NEW.brand_id, NEW.listing_store_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'pricing single store listing needs a brand with one store' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
