-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL, as for recipe reviews in 2000_035): while the Brand Owner
-- runs the Brand alone (sole operator in effect), the one person may review their own option-recipe
-- change and give both the Cost and the FoodSafety review. Each such review is marked (review_mode
-- SoleOperator) with the reviewer's second-factor time, at most 15 minutes before the review. Any
-- other review keeps the existing rules: never the author, and two reviewers for the two kinds
-- (now also checked by the database). Existing reviews are Independent and keep their meaning.
ALTER TABLE rms_recipe.option_recipe_change_review
 ADD COLUMN review_mode text NOT NULL DEFAULT 'Independent'
  CONSTRAINT option_recipe_change_review_mode_check CHECK (review_mode IN ('Independent','SoleOperator')),
 ADD COLUMN reviewer_mfa_at timestamptz;
ALTER TABLE rms_recipe.option_recipe_change_review
 DROP CONSTRAINT option_recipe_change_review_independent;
ALTER TABLE rms_recipe.option_recipe_change_review
 ADD CONSTRAINT option_recipe_change_review_independent CHECK (
  reviewer_actor_id <> author_actor_id OR review_mode='SoleOperator'
 );
ALTER TABLE rms_recipe.option_recipe_change_review
 ADD CONSTRAINT option_recipe_change_review_sole_operator_mfa CHECK (
  (review_mode='SoleOperator') = (reviewer_mfa_at IS NOT NULL)
  AND (reviewer_mfa_at IS NULL OR (
   isfinite(reviewer_mfa_at) AND reviewer_mfa_at BETWEEN reviewed_at-interval '15 minutes' AND reviewed_at
  ))
 );

-- One person gives both kinds of review of one change version only as sole operator (both marked).
CREATE FUNCTION rms_recipe.check_option_recipe_review_distinct_reviewers() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM rms_recipe.option_recipe_change_review r
  WHERE r.brand_id=NEW.brand_id AND r.change_version_id=NEW.change_version_id
   AND r.review_kind<>NEW.review_kind AND r.reviewer_actor_id=NEW.reviewer_actor_id
   AND (r.review_mode<>'SoleOperator' OR NEW.review_mode<>'SoleOperator')
 ) THEN
  RAISE EXCEPTION 'option recipe reviews of one change need two reviewers' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.check_option_recipe_review_distinct_reviewers() FROM PUBLIC;
CREATE TRIGGER option_recipe_change_review_distinct_reviewers BEFORE INSERT ON rms_recipe.option_recipe_change_review
 FOR EACH ROW EXECUTE FUNCTION rms_recipe.check_option_recipe_review_distinct_reviewers();
