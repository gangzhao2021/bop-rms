-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_recipe.recipe_admin_core_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  publication_revision bigint NOT NULL CHECK (publication_revision > 0),
  projection_version integer NOT NULL CHECK (projection_version=2),
  core_digest text NOT NULL CHECK (core_digest ~ '^sha256:[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 2048),
  graph_json jsonb NOT NULL,
  UNIQUE (generation_id,tenant_id,brand_id,publication_revision),
  FOREIGN KEY (generation_id,tenant_id,brand_id,publication_revision)
    REFERENCES rms_recipe.recipe_admin_source_generation(generation_id,tenant_id,brand_id,publication_revision),
  CHECK ((jsonb_typeof(graph_json)='object'
    AND graph_json #>> '{source,coverage,tenantReference}'=tenant_id::text
    AND graph_json #>> '{source,coverage,brandReference}'=brand_id::text
    AND graph_json #>> '{source,coverage,family}'='Recipe'
    AND graph_json #>> '{source,coverage,complete}'='true'
    AND jsonb_array_length(graph_json->'currentRoots')=row_count
    AND graph_json - ARRAY['source','currentRoots','nodes','edges','postorderVersions']='{}'::jsonb
  ) IS TRUE)
);
CREATE TABLE rms_recipe.recipe_admin_core_row (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  publication_revision bigint NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  row_json jsonb NOT NULL,
  PRIMARY KEY (generation_id,recipe_id),
  FOREIGN KEY (generation_id,tenant_id,brand_id,publication_revision)
    REFERENCES rms_recipe.recipe_admin_core_generation(generation_id,tenant_id,brand_id,publication_revision),
  CHECK ((jsonb_typeof(row_json)='object'
    AND row_json->>'recipeReference'=recipe_id::text
    AND row_json->>'versionReference'=recipe_version_id::text
    AND row_json->>'snapshotDigest'=snapshot_digest
    AND row_json->>'lifecycle' IN ('Draft','Published','Invalidated','Archived')
    AND jsonb_typeof(row_json->'ingredients')='array'
    AND row_json - ARRAY['recipeReference','versionReference','stableCode','aggregateVersion','versionNumber',
      'snapshotDigest','lifecycle','displayNameCode','yieldQuantityMicrounits','yieldUnitCode','yieldDimension',
      'ingredients','preparationVersionReference','steps','substitutionPolicyReference','effectivePeriod',
      'invalidationReasonCode','createdAt']='{}'::jsonb
    AND NOT jsonb_path_exists(row_json,'$.ingredients[*].unitCostMinorNumerator')
    AND NOT jsonb_path_exists(row_json,'$.ingredients[*].unitCostDenominator')
    AND NOT jsonb_path_exists(row_json,'$.ingredients[*].allergens')
  ) IS TRUE)
);
CREATE TABLE rms_recipe.recipe_admin_core_checkpoint (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  publication_revision bigint NOT NULL CHECK (publication_revision>=0),
  active_generation_id platform_helpers.uuid_v7,
  PRIMARY KEY (tenant_id,brand_id),
  FOREIGN KEY (active_generation_id,tenant_id,brand_id,publication_revision)
    REFERENCES rms_recipe.recipe_admin_core_generation(generation_id,tenant_id,brand_id,publication_revision),
  CHECK ((publication_revision=0)=(active_generation_id IS NULL))
);
CREATE RULE recipe_core_generation_no_update AS
  ON UPDATE TO rms_recipe.recipe_admin_core_generation DO INSTEAD NOTHING;
CREATE RULE recipe_core_generation_no_delete AS
  ON DELETE TO rms_recipe.recipe_admin_core_generation DO INSTEAD NOTHING;
CREATE RULE recipe_core_row_no_update AS
  ON UPDATE TO rms_recipe.recipe_admin_core_row DO INSTEAD NOTHING;
CREATE RULE recipe_core_row_no_delete AS
  ON DELETE TO rms_recipe.recipe_admin_core_row DO INSTEAD NOTHING;
ALTER TABLE rms_recipe.recipe_admin_core_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_core_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_core_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_core_row FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_core_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_core_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_core_generation_scope ON rms_recipe.recipe_admin_core_generation
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY recipe_core_row_scope ON rms_recipe.recipe_admin_core_row
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY recipe_core_checkpoint_scope ON rms_recipe.recipe_admin_core_checkpoint
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_recipe.recipe_admin_core_generation,rms_recipe.recipe_admin_core_row,rms_recipe.recipe_admin_core_checkpoint FROM PUBLIC;
