-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_recipe.recipe_measurement_content (
 recipe_version_id platform_helpers.uuid_v7 PRIMARY KEY,
 recipe_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
 content_json jsonb NOT NULL,
 CONSTRAINT recipe_measurement_version_fk FOREIGN KEY(recipe_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id),
 CONSTRAINT recipe_measurement_content_shape CHECK ((
  jsonb_typeof(content_json)='object'
  AND content_json-ARRAY['profile','snapshot','measurements']='{}'::jsonb
  AND content_json->>'profile'='RecipeMeasurementContentV2'
  AND jsonb_typeof(content_json->'snapshot')='object'
  AND jsonb_typeof(content_json->'measurements')='array'
  AND jsonb_array_length(content_json->'measurements') BETWEEN 1 AND 256
  AND content_json->'snapshot'->>'recipeReference'=recipe_id::text
  AND content_json->'snapshot'->>'versionReference'=recipe_version_id::text
  AND content_json->'snapshot'->>'brandReference'=brand_id::text
  AND content_json->'snapshot'->>'snapshotDigest'=content_digest
 ) IS TRUE)
);
ALTER TABLE rms_recipe.recipe_measurement_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_measurement_content FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_measurement_brand_scope ON rms_recipe.recipe_measurement_content
 USING(brand_id=platform_helpers.current_brand_id()) WITH CHECK(brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.recipe_measurement_content FROM PUBLIC;
CREATE FUNCTION rms_recipe.validate_recipe_measurement_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE actual_snapshot jsonb; actual_digest text;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_recipe' OR TG_TABLE_NAME<>'recipe_measurement_content' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'RECIPE_MEASUREMENT_CONTENT_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('RecipeCatalogReferenceV1:'||NEW.brand_id::text,0));
 SELECT snapshot_json,snapshot_digest INTO actual_snapshot,actual_digest FROM rms_recipe.recipe_version
 WHERE recipe_version_id=NEW.recipe_version_id AND recipe_id=NEW.recipe_id AND brand_id=NEW.brand_id;
 IF NOT FOUND OR actual_snapshot IS NULL OR actual_snapshot IS DISTINCT FROM NEW.content_json->'snapshot' OR actual_digest IS DISTINCT FROM NEW.content_digest
 THEN RAISE EXCEPTION 'RECIPE_MEASUREMENT_CONTENT_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.validate_recipe_measurement_insert() FROM PUBLIC;
CREATE TRIGGER recipe_measurement_insert_binding BEFORE INSERT ON rms_recipe.recipe_measurement_content FOR EACH ROW EXECUTE FUNCTION rms_recipe.validate_recipe_measurement_insert();
CREATE RULE recipe_measurement_no_update AS ON UPDATE TO rms_recipe.recipe_measurement_content DO INSTEAD NOTHING;
CREATE RULE recipe_measurement_no_delete AS ON DELETE TO rms_recipe.recipe_measurement_content DO INSTEAD NOTHING;
CREATE TRIGGER recipe_measurement_no_truncate BEFORE TRUNCATE ON rms_recipe.recipe_measurement_content FOR EACH STATEMENT EXECUTE FUNCTION rms_recipe.reject_recipe_reference_truncate();
