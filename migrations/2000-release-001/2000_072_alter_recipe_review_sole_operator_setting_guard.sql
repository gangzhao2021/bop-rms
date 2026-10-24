-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (defence in depth after the v15 defect 2026-10-16, Owner
-- standing approval 2026-10-14 WP-2423 sole operator): the same database check as 2000_067 for
-- recipe reviews (2000_035) and option-recipe change reviews (2000_037) marked SoleOperator.
-- Each is recorded only while the Brand's sole-operator setting was On at the review instant and
-- is still On (Organization read, 2000_066; the setting is held until the review commits). The
-- check runs after the row's own checks, so a review that is invalid for its own reason is still
-- refused for that reason. Independent reviews and rows already recorded are unchanged.
CREATE FUNCTION rms_recipe.check_recipe_review_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.reviewed_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'recipe sole operator review needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.check_recipe_review_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER recipe_authoring_review_sole_operator_setting_on AFTER INSERT ON rms_recipe.recipe_authoring_review
  FOR EACH ROW WHEN (NEW.review_mode='SoleOperator')
  EXECUTE FUNCTION rms_recipe.check_recipe_review_sole_operator_setting();

CREATE FUNCTION rms_recipe.check_option_recipe_review_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.reviewed_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'option recipe sole operator review needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.check_option_recipe_review_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER option_recipe_change_review_sole_operator_setting_on AFTER INSERT ON rms_recipe.option_recipe_change_review
  FOR EACH ROW WHEN (NEW.review_mode='SoleOperator')
  EXECUTE FUNCTION rms_recipe.check_option_recipe_review_sole_operator_setting();
