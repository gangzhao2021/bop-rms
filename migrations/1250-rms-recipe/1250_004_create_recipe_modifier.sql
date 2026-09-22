-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_recipe.recipe_modifier_version (
 rule_version_id platform_helpers.uuid_v7 PRIMARY KEY,
 rule_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version>0),
 recipe_id platform_helpers.uuid_v7 NOT NULL,
 recipe_version_id platform_helpers.uuid_v7 NOT NULL,
 binding_id platform_helpers.uuid_v7 NOT NULL,
 option_id platform_helpers.uuid_v7 NOT NULL,
 selected_quantity integer NOT NULL CHECK (selected_quantity BETWEEN 1 AND 10000),
 lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Published','Invalidated','Archived')),
 rule_digest text NOT NULL CHECK (rule_digest ~ '^sha256:[0-9a-f]{64}$'),
 rule_json jsonb NOT NULL CHECK (jsonb_typeof(rule_json)='object'),
 review_evidence_json jsonb,
 effective_from timestamptz NOT NULL,
 effective_until timestamptz,
 operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL,
 UNIQUE (brand_id,rule_id,version),
 FOREIGN KEY (recipe_version_id,recipe_id,brand_id)
  REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id),
 CHECK (effective_until IS NULL OR effective_until>effective_from),
 CHECK (isfinite(effective_from) AND isfinite(occurred_at)
  AND (effective_until IS NULL OR isfinite(effective_until))),
 CHECK (lifecycle<>'Published' OR
  (review_evidence_json IS NOT NULL AND jsonb_typeof(review_evidence_json)='object')),
 CHECK ((
  rule_json->>'ruleReference'=rule_id::text
  AND rule_json->>'ruleVersionReference'=rule_version_id::text
  AND rule_json->>'ruleDigest'=rule_digest
  AND rule_json->>'brandReference'=brand_id::text
  AND rule_json->>'recipeVersionReference'=recipe_version_id::text
  AND rule_json->'selection'->>'bindingReference'=binding_id::text
  AND rule_json->'selection'->>'optionReference'=option_id::text
  AND rule_json->'selection'->>'quantity'=selected_quantity::text
  AND jsonb_typeof(rule_json->'changes')='array'
 ) IS TRUE)
);
CREATE FUNCTION rms_recipe.enforce_modifier_version_sequence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_recipe.recipe_modifier_version%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('RecipeModifier:'||NEW.brand_id::text||':'||NEW.rule_id::text,0));
 SELECT * INTO previous FROM rms_recipe.recipe_modifier_version
 WHERE brand_id=NEW.brand_id AND rule_id=NEW.rule_id ORDER BY version DESC LIMIT 1;
 IF FOUND THEN
  IF NEW.version<>previous.version+1 OR NEW.occurred_at<previous.occurred_at THEN
   RAISE EXCEPTION 'Recipe modifier version conflict' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.version<>1 THEN
  RAISE EXCEPTION 'Initial Recipe modifier version invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.enforce_modifier_version_sequence() FROM PUBLIC;
CREATE TRIGGER recipe_modifier_sequence BEFORE INSERT ON rms_recipe.recipe_modifier_version
FOR EACH ROW EXECUTE FUNCTION rms_recipe.enforce_modifier_version_sequence();
CREATE FUNCTION rms_recipe.reject_modifier_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'Recipe modifier history is immutable' USING ERRCODE='23514';
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.reject_modifier_history_mutation() FROM PUBLIC;
CREATE TRIGGER recipe_modifier_no_mutation BEFORE UPDATE OR DELETE ON rms_recipe.recipe_modifier_version
FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_modifier_history_mutation();
CREATE TRIGGER recipe_modifier_no_truncate BEFORE TRUNCATE ON rms_recipe.recipe_modifier_version
FOR EACH STATEMENT EXECUTE FUNCTION rms_recipe.reject_modifier_history_mutation();
ALTER TABLE rms_recipe.recipe_modifier_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_modifier_version FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_modifier_brand_scope ON rms_recipe.recipe_modifier_version
USING (brand_id=platform_helpers.current_brand_id())
WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.recipe_modifier_version FROM PUBLIC;
