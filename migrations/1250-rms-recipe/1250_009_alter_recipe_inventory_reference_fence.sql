-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_version,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version,rms_recipe.recipe_ingredient_requirement IN SHARE ROW EXCLUSIVE MODE;
CREATE OR REPLACE FUNCTION rms_recipe.maintain_recipe_reference_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
 previous_brand text:=current_setting('bop.brand_id',true);
 previous_store text:=current_setting('bop.store_id',true);
 old_brand uuid; new_brand uuid; scope_brand uuid;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_recipe' OR TG_TABLE_NAME NOT IN ('recipe','recipe_version','recipe_scope_binding','recipe_modifier_version','recipe_ingredient_requirement') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE')
 THEN RAISE EXCEPTION 'RECIPE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN old_brand:=OLD.brand_id; END IF;
 IF TG_OP<>'DELETE' THEN new_brand:=NEW.brand_id; END IF;
 FOR scope_brand IN SELECT DISTINCT b FROM unnest(ARRAY[old_brand,new_brand]) AS b WHERE b IS NOT NULL ORDER BY b LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('RecipeCatalogReferenceV1:'||scope_brand::text,0));
  PERFORM set_config('bop.brand_id',scope_brand::text,true);
  PERFORM set_config('bop.store_id','',true);
  IF NOT EXISTS(SELECT 1 FROM rms_recipe.recipe_reference_generation WHERE brand_id=scope_brand) THEN
   IF TG_OP<>'INSERT' OR TG_TABLE_NAME<>'recipe' THEN RAISE EXCEPTION 'RECIPE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   IF EXISTS(SELECT 1 FROM rms_recipe.recipe WHERE brand_id=scope_brand AND recipe_id<>NEW.recipe_id) THEN RAISE EXCEPTION 'RECIPE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   INSERT INTO rms_recipe.recipe_reference_generation VALUES(scope_brand,0,0);
  END IF;
  IF TG_TABLE_NAME='recipe_scope_binding' THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RECIPE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   INSERT INTO rms_recipe.recipe_reference_binding VALUES(NEW.recipe_scope_binding_id,NEW.recipe_version_id,NEW.recipe_id,NEW.brand_id,NEW.sku_id,NEW.store_id,NEW.option_binding_id,NEW.effective_from,NEW.effective_until);
   UPDATE rms_recipe.recipe_reference_generation SET binding_count=binding_count+1 WHERE brand_id=scope_brand;
  END IF;
  UPDATE rms_recipe.recipe_reference_generation SET generation=generation+1 WHERE brand_id=scope_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECIPE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 END LOOP;
 PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
 PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.maintain_recipe_reference_projection() FROM PUBLIC;
CREATE TRIGGER recipe_ingredient_requirement_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_recipe.recipe_ingredient_requirement FOR EACH ROW EXECUTE FUNCTION rms_recipe.maintain_recipe_reference_projection();
CREATE TRIGGER recipe_ingredient_requirement_reference_no_truncate BEFORE TRUNCATE ON rms_recipe.recipe_ingredient_requirement FOR EACH STATEMENT EXECUTE FUNCTION rms_recipe.reject_recipe_reference_truncate();
