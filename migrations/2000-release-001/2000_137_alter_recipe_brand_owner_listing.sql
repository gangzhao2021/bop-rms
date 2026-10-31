-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
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
ALTER TABLE rms_recipe.recipe_authoring_review
 DROP CONSTRAINT recipe_authoring_review_mode_check,
 ADD CONSTRAINT recipe_authoring_review_mode_check
  CHECK (review_mode IN ('Independent','SoleOperator','SingleStoreListing','BrandOwnerListing')),
 DROP CONSTRAINT recipe_authoring_review_single_store,
 ADD CONSTRAINT recipe_authoring_review_single_store CHECK (
  (review_mode IN ('SingleStoreListing','BrandOwnerListing')) = (listing_store_id IS NOT NULL)
 ),
 DROP CONSTRAINT recipe_authoring_review_independent,
 ADD CONSTRAINT recipe_authoring_review_independent CHECK (
  reviewer_actor_id <> author_actor_id OR review_mode IN ('SoleOperator','SingleStoreListing','BrandOwnerListing')
 );
ALTER TABLE rms_recipe.option_recipe_change_review
 DROP CONSTRAINT option_recipe_change_review_mode_check,
 ADD CONSTRAINT option_recipe_change_review_mode_check
  CHECK (review_mode IN ('Independent','SoleOperator','SingleStoreListing','BrandOwnerListing')),
 DROP CONSTRAINT option_recipe_change_review_single_store,
 ADD CONSTRAINT option_recipe_change_review_single_store CHECK (
  (review_mode IN ('SingleStoreListing','BrandOwnerListing')) = (listing_store_id IS NOT NULL)
 ),
 DROP CONSTRAINT option_recipe_change_review_independent,
 ADD CONSTRAINT option_recipe_change_review_independent CHECK (
  reviewer_actor_id <> author_actor_id OR review_mode IN ('SoleOperator','SingleStoreListing','BrandOwnerListing')
 );

CREATE OR REPLACE FUNCTION rms_recipe.check_recipe_review_single_store() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF NEW.review_mode='BrandOwnerListing' THEN
  IF bop_permission.actor_holds_brand_owner_authority(NEW.brand_id, NEW.reviewer_actor_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'recipe brand owner review needs Brand Owner authority' USING ERRCODE='23514';
  END IF;
 ELSIF bop_tenant.brand_has_single_store(NEW.brand_id, NEW.listing_store_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'recipe single store review needs a brand with one store' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER recipe_authoring_review_brand_owner AFTER INSERT ON rms_recipe.recipe_authoring_review
 FOR EACH ROW WHEN (NEW.review_mode='BrandOwnerListing')
 EXECUTE FUNCTION rms_recipe.check_recipe_review_single_store();
CREATE TRIGGER option_recipe_change_review_brand_owner AFTER INSERT ON rms_recipe.option_recipe_change_review
 FOR EACH ROW WHEN (NEW.review_mode='BrandOwnerListing')
 EXECUTE FUNCTION rms_recipe.check_recipe_review_single_store();
