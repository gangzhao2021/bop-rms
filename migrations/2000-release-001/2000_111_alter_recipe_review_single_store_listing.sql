-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7 "点上架就生效，不用审核";
-- coordinator 2026-10-28 condition 4): at a Brand with exactly one store, the author of a recipe or
-- an option-recipe change gives its Cost and FoodSafety reviews alone when they list the dish
-- ("List it"). Each such review is marked review_mode SingleStoreListing with the store it was
-- listed at, and is recorded only while that store is the Brand's one store (Tenant read 2000_108,
-- held until the review commits). The independence rules otherwise stay as 2000_035 and 2000_037
-- recorded them: one person gives both kinds only when both reviews carry the same mark. Rows
-- already recorded keep their meaning.
ALTER TABLE rms_recipe.recipe_authoring_review
 DROP CONSTRAINT recipe_authoring_review_mode_check;
ALTER TABLE rms_recipe.recipe_authoring_review
 ADD CONSTRAINT recipe_authoring_review_mode_check
  CHECK (review_mode IN ('Independent','SoleOperator','SingleStoreListing')),
 ADD COLUMN listing_store_id uuid,
 ADD CONSTRAINT recipe_authoring_review_single_store CHECK (
  (review_mode='SingleStoreListing') = (listing_store_id IS NOT NULL)
 );
ALTER TABLE rms_recipe.recipe_authoring_review
 DROP CONSTRAINT recipe_authoring_review_independent;
ALTER TABLE rms_recipe.recipe_authoring_review
 ADD CONSTRAINT recipe_authoring_review_independent CHECK (
  reviewer_actor_id <> author_actor_id OR review_mode IN ('SoleOperator','SingleStoreListing')
 );

ALTER TABLE rms_recipe.option_recipe_change_review
 DROP CONSTRAINT option_recipe_change_review_mode_check;
ALTER TABLE rms_recipe.option_recipe_change_review
 ADD CONSTRAINT option_recipe_change_review_mode_check
  CHECK (review_mode IN ('Independent','SoleOperator','SingleStoreListing')),
 ADD COLUMN listing_store_id uuid,
 ADD CONSTRAINT option_recipe_change_review_single_store CHECK (
  (review_mode='SingleStoreListing') = (listing_store_id IS NOT NULL)
 );
ALTER TABLE rms_recipe.option_recipe_change_review
 DROP CONSTRAINT option_recipe_change_review_independent;
ALTER TABLE rms_recipe.option_recipe_change_review
 ADD CONSTRAINT option_recipe_change_review_independent CHECK (
  reviewer_actor_id <> author_actor_id OR review_mode IN ('SoleOperator','SingleStoreListing')
 );

-- One person gives both kinds of review of one subject only with the same mark on both.
CREATE OR REPLACE FUNCTION rms_recipe.check_recipe_review_distinct_reviewers() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM rms_recipe.recipe_authoring_review r
  WHERE r.brand_id=NEW.brand_id AND r.recipe_version_id=NEW.recipe_version_id
   AND r.subject=NEW.subject AND r.review_kind<>NEW.review_kind
   AND r.reviewer_actor_id=NEW.reviewer_actor_id
   AND (r.review_mode='Independent' OR r.review_mode<>NEW.review_mode)
 ) THEN
  RAISE EXCEPTION 'recipe reviews of one subject need two reviewers' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION rms_recipe.check_option_recipe_review_distinct_reviewers() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM rms_recipe.option_recipe_change_review r
  WHERE r.brand_id=NEW.brand_id AND r.change_version_id=NEW.change_version_id
   AND r.review_kind<>NEW.review_kind AND r.reviewer_actor_id=NEW.reviewer_actor_id
   AND (r.review_mode='Independent' OR r.review_mode<>NEW.review_mode)
 ) THEN
  RAISE EXCEPTION 'option recipe reviews of one change need two reviewers' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

-- The Brand has exactly one store (not archived) and it is the one named; held to commit.
CREATE FUNCTION rms_recipe.check_recipe_review_single_store() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF bop_tenant.brand_has_single_store(NEW.brand_id, NEW.listing_store_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'recipe single store review needs a brand with one store' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.check_recipe_review_single_store() FROM PUBLIC;
CREATE TRIGGER recipe_authoring_review_single_store AFTER INSERT ON rms_recipe.recipe_authoring_review
 FOR EACH ROW WHEN (NEW.review_mode='SingleStoreListing')
 EXECUTE FUNCTION rms_recipe.check_recipe_review_single_store();
CREATE TRIGGER option_recipe_change_review_single_store AFTER INSERT ON rms_recipe.option_recipe_change_review
 FOR EACH ROW WHEN (NEW.review_mode='SingleStoreListing')
 EXECUTE FUNCTION rms_recipe.check_recipe_review_single_store();
