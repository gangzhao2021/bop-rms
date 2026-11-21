-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_recipe.recipe_modifier_version ADD CONSTRAINT recipe_modifier_preparation_scope_unique
  UNIQUE (brand_id,recipe_version_id,rule_version_id);
CREATE TABLE rms_recipe.recipe_preparation_content (
  content_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  modifier_rule_version_id platform_helpers.uuid_v7,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL CHECK (isfinite(published_at) AND published_at=date_trunc('milliseconds',published_at)),
  record_json jsonb NOT NULL,
  UNIQUE (brand_id,operation_id),
  UNIQUE (brand_id,audit_id),
  UNIQUE NULLS NOT DISTINCT (brand_id,recipe_version_id,modifier_rule_version_id),
  FOREIGN KEY (recipe_version_id,recipe_id,brand_id)
    REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id),
  FOREIGN KEY (brand_id,recipe_version_id,modifier_rule_version_id)
    REFERENCES rms_recipe.recipe_modifier_version(brand_id,recipe_version_id,rule_version_id),
  CHECK ((
    jsonb_typeof(record_json)='object'
    AND record_json->>'operationReference'=operation_id::text
    AND record_json->>'actorReference'=actor_id::text
    AND record_json->>'brandReference'=brand_id::text
    AND record_json->>'recipeReference'=recipe_id::text
    AND record_json->>'recipeVersionReference'=recipe_version_id::text
    AND (record_json->>'modifierRuleVersionReference') IS NOT DISTINCT FROM modifier_rule_version_id::text
    AND (record_json->>'publishedAt')::timestamptz=published_at
    AND record_json #>> '{content,contentReference}'=content_id::text
    AND record_json #>> '{content,contentDigest}'=content_digest
    AND record_json #>> '{reviewEvidence,contentReference}'=content_id::text
    AND record_json #>> '{reviewEvidence,contentDigest}'=content_digest
    AND jsonb_array_length(record_json #> '{reviewEvidence,reviews}')=2
  ) IS TRUE)
);
CREATE RULE recipe_preparation_content_no_update AS
  ON UPDATE TO rms_recipe.recipe_preparation_content DO INSTEAD NOTHING;
CREATE RULE recipe_preparation_content_no_delete AS
  ON DELETE TO rms_recipe.recipe_preparation_content DO INSTEAD NOTHING;
ALTER TABLE rms_recipe.recipe_preparation_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_preparation_content FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_preparation_content_scope ON rms_recipe.recipe_preparation_content
  USING (brand_id=platform_helpers.current_brand_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.recipe_preparation_content FROM PUBLIC;
