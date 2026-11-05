-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-MERCHANT-LOCK-SCOPE: Recipe writes already take RecipeCatalogReferenceV1:<brand>
-- exclusive, and Recipe readers now hold it shared instead of locking every merchant's tables. Guests
-- hold it too (an order and a kitchen ticket read the recipe), and a waiting writer stops every new
-- reader behind it. So a recipe save beside a menu review waits only briefly here, before its first
-- row, then gives way and the route's own retry tries again: a merchant's guests never queue behind
-- its own manager. recipe_preparation_content had its own table lock: it gets its own key.
LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_version,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_measurement_content,rms_recipe.recipe_preparation_content IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION rms_recipe.take_recipe_reference_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 scope_brand uuid;
 fence bigint;
 previous_timeout text;
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN scope_brand:=OLD.brand_id; ELSE scope_brand:=NEW.brand_id; END IF;
 fence:=hashtextextended('RecipeCatalogReferenceV1:'||scope_brand::text,0);
 IF NOT pg_try_advisory_xact_lock(fence) THEN
  previous_timeout:=current_setting('lock_timeout');
  PERFORM set_config('lock_timeout','300ms',true);
  PERFORM pg_advisory_xact_lock(fence);
  PERFORM set_config('lock_timeout',previous_timeout,true);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.take_recipe_reference_fence() FROM PUBLIC;
CREATE FUNCTION rms_recipe.take_brand_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>1 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.brand_id IS DISTINCT FROM NEW.brand_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||NEW.brand_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.take_brand_fence() FROM PUBLIC;
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_version FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_scope_binding FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_modifier_version FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_ingredient_requirement FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_measurement_content FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_preparation_content FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_brand_fence('RecipePreparationContentFence');
