-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_recipe.recipe_admin_source_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  publication_revision bigint NOT NULL CHECK (publication_revision > 0),
  built_at timestamptz NOT NULL CHECK (isfinite(built_at) AND built_at=date_trunc('milliseconds',built_at)),
  builder_actor_id platform_helpers.uuid_v7 NOT NULL,
  record_json jsonb NOT NULL,
  UNIQUE (tenant_id,brand_id,publication_revision),
  UNIQUE (generation_id,tenant_id,brand_id,publication_revision),
  CHECK ((jsonb_typeof(record_json)='object'
    AND record_json->>'generationReference'=generation_id::text
    AND record_json->>'actorReference'=builder_actor_id::text
    AND record_json->>'purpose'='RecipeProjectionBuild'
    AND (record_json->>'builtAt')::timestamptz=built_at
    AND record_json #>> '{coverage,tenantReference}'=tenant_id::text
    AND record_json #>> '{coverage,brandReference}'=brand_id::text
    AND jsonb_array_length(record_json #> '{coverage,sources}')=7
    AND (record_json->>'expectedRevision')::bigint=publication_revision-1
  ) IS TRUE)
);
CREATE TABLE rms_recipe.recipe_admin_source_checkpoint (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  publication_revision bigint NOT NULL CHECK (publication_revision >= 0),
  active_generation_id platform_helpers.uuid_v7,
  PRIMARY KEY (tenant_id,brand_id),
  FOREIGN KEY (active_generation_id,tenant_id,brand_id,publication_revision)
    REFERENCES rms_recipe.recipe_admin_source_generation(generation_id,tenant_id,brand_id,publication_revision),
  CHECK ((publication_revision=0)=(active_generation_id IS NULL))
);
CREATE RULE recipe_source_generation_no_update AS
  ON UPDATE TO rms_recipe.recipe_admin_source_generation DO INSTEAD NOTHING;
CREATE RULE recipe_source_generation_no_delete AS
  ON DELETE TO rms_recipe.recipe_admin_source_generation DO INSTEAD NOTHING;
ALTER TABLE rms_recipe.recipe_admin_source_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_source_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_source_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_source_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_source_generation_scope ON rms_recipe.recipe_admin_source_generation
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id())
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_source_checkpoint_scope ON rms_recipe.recipe_admin_source_checkpoint
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id())
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.recipe_admin_source_generation,rms_recipe.recipe_admin_source_checkpoint FROM PUBLIC;

CREATE TABLE rms_recipe.recipe_admin_source_binding (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  source_family text NOT NULL CHECK (source_family IN ('Recipe','Inventory','Supplier','Allergen','Preparation','Substitution','Usage')),
  binding_kind text NOT NULL CHECK (binding_kind IN ('Snapshot','ObjectVersion')),
  object_id platform_helpers.uuid_v7,
  version_id platform_helpers.uuid_v7 NOT NULL,
  binding_json jsonb NOT NULL,
  first_generation_id platform_helpers.uuid_v7 NOT NULL,
  first_publication_revision bigint NOT NULL CHECK (first_publication_revision > 0),
  UNIQUE NULLS NOT DISTINCT (tenant_id,brand_id,source_family,binding_kind,object_id,version_id),
  CHECK ((binding_kind='Snapshot')=(object_id IS NULL)),
  CHECK ((jsonb_typeof(binding_json)='object' AND binding_json->>'digest' ~ '^sha256:[0-9a-f]{64}$') IS TRUE),
  FOREIGN KEY (first_generation_id,tenant_id,brand_id,first_publication_revision)
    REFERENCES rms_recipe.recipe_admin_source_generation(generation_id,tenant_id,brand_id,publication_revision)
);
CREATE RULE recipe_source_binding_no_update AS
  ON UPDATE TO rms_recipe.recipe_admin_source_binding DO INSTEAD NOTHING;
CREATE RULE recipe_source_binding_no_delete AS
  ON DELETE TO rms_recipe.recipe_admin_source_binding DO INSTEAD NOTHING;
ALTER TABLE rms_recipe.recipe_admin_source_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_source_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_source_binding_scope ON rms_recipe.recipe_admin_source_binding
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id())
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.recipe_admin_source_binding FROM PUBLIC;

CREATE TABLE rms_recipe.recipe_admin_source_capture (
  snapshot_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  source_family text NOT NULL CHECK (source_family IN ('Recipe','Preparation','Substitution','Usage')),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL CHECK (isfinite(captured_at) AND captured_at=date_trunc('milliseconds',captured_at)),
  captured_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  coverage_json jsonb NOT NULL,
  UNIQUE (tenant_id,brand_id,source_family,content_digest),
  CHECK ((jsonb_typeof(coverage_json)='object'
    AND coverage_json->>'family'=source_family
    AND coverage_json->>'tenantReference'=tenant_id::text
    AND coverage_json->>'brandReference'=brand_id::text
    AND coverage_json->>'snapshotReference'=snapshot_id::text
    AND coverage_json->>'digest'=content_digest
    AND coverage_json->>'complete'='true'
    AND jsonb_array_length(coverage_json->'dependencies')<=2048
  ) IS TRUE)
);
CREATE RULE recipe_source_capture_no_update AS
  ON UPDATE TO rms_recipe.recipe_admin_source_capture DO INSTEAD NOTHING;
CREATE RULE recipe_source_capture_no_delete AS
  ON DELETE TO rms_recipe.recipe_admin_source_capture DO INSTEAD NOTHING;
ALTER TABLE rms_recipe.recipe_admin_source_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_source_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_source_capture_scope ON rms_recipe.recipe_admin_source_capture
  USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id())
  WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.recipe_admin_source_capture FROM PUBLIC;
