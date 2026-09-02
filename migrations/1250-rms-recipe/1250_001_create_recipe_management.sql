-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_recipe;
REVOKE ALL ON SCHEMA rms_recipe FROM PUBLIC;

CREATE TABLE rms_recipe.recipe (
  recipe_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_brand_code_unique UNIQUE (brand_id,stable_code),
  CONSTRAINT recipe_scope_identity_unique UNIQUE (recipe_id,brand_id),
  CONSTRAINT recipe_time_order_check CHECK (updated_at >= created_at)
);
CREATE TABLE rms_recipe.recipe_version (
  recipe_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Published','Invalidated','Archived')),
  display_name_code text NOT NULL CHECK (display_name_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  yield_quantity_microunits numeric NOT NULL CHECK (yield_quantity_microunits > 0 AND yield_quantity_microunits=trunc(yield_quantity_microunits)),
  yield_unit_code text NOT NULL CHECK (yield_unit_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  yield_dimension text NOT NULL CHECK (yield_dimension IN ('Mass','Volume','Count')),
  preparation_version_id platform_helpers.uuid_v7 NOT NULL,
  substitution_policy_id platform_helpers.uuid_v7,
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  effective_time_zone text NOT NULL,
  invalidation_reason_code text,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_version_root_fk FOREIGN KEY (recipe_id,brand_id) REFERENCES rms_recipe.recipe(recipe_id,brand_id),
  CONSTRAINT recipe_version_identity_unique UNIQUE (recipe_version_id,recipe_id,brand_id),
  CONSTRAINT recipe_version_number_unique UNIQUE (recipe_id,version_number),
  CONSTRAINT recipe_version_period_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT recipe_version_invalidation_check CHECK ((lifecycle='Invalidated')=(invalidation_reason_code IS NOT NULL))
);
ALTER TABLE rms_recipe.recipe ADD CONSTRAINT recipe_current_version_fk FOREIGN KEY (current_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id);

CREATE TABLE rms_recipe.recipe_ingredient_requirement (
  requirement_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('InventoryItem','SubRecipe')),
  source_id platform_helpers.uuid_v7 NOT NULL,
  source_version_id platform_helpers.uuid_v7 NOT NULL,
  quantity_microunits numeric NOT NULL CHECK (quantity_microunits > 0 AND quantity_microunits=trunc(quantity_microunits)),
  unit_dimension text NOT NULL CHECK (unit_dimension IN ('Mass','Volume','Count')),
  conversion_numerator numeric NOT NULL CHECK (conversion_numerator > 0 AND conversion_numerator=trunc(conversion_numerator)),
  conversion_denominator numeric NOT NULL CHECK (conversion_denominator > 0 AND conversion_denominator=trunc(conversion_denominator)),
  loss_basis_points integer NOT NULL CHECK (loss_basis_points BETWEEN 0 AND 10000),
  unit_cost_minor_numerator numeric NOT NULL CHECK (unit_cost_minor_numerator >= 0 AND unit_cost_minor_numerator=trunc(unit_cost_minor_numerator)),
  unit_cost_denominator numeric NOT NULL CHECK (unit_cost_denominator > 0 AND unit_cost_denominator=trunc(unit_cost_denominator)),
  CONSTRAINT recipe_requirement_version_fk FOREIGN KEY (recipe_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id),
  CONSTRAINT recipe_requirement_brand_identity_unique UNIQUE (requirement_id,brand_id),
  CONSTRAINT recipe_requirement_source_unique UNIQUE (recipe_version_id,source_kind,source_id)
);
CREATE TABLE rms_recipe.recipe_allergen_evidence (
  recipe_allergen_evidence_id platform_helpers.uuid_v7 PRIMARY KEY,
  requirement_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  allergen_id platform_helpers.uuid_v7 NOT NULL,
  evidence_id platform_helpers.uuid_v7 NOT NULL,
  verified boolean NOT NULL,
  CONSTRAINT recipe_allergen_requirement_fk FOREIGN KEY (requirement_id,brand_id) REFERENCES rms_recipe.recipe_ingredient_requirement(requirement_id,brand_id),
  CONSTRAINT recipe_allergen_unique UNIQUE (requirement_id,allergen_id)
);
CREATE TABLE rms_recipe.recipe_preparation_step (
  step_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  sequence_group integer NOT NULL CHECK (sequence_group >= 0),
  instruction_code text NOT NULL CHECK (instruction_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 86400),
  capability_code text NOT NULL CHECK (capability_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  CONSTRAINT recipe_step_version_fk FOREIGN KEY (recipe_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id)
);
CREATE TABLE rms_recipe.recipe_scope_binding (
  recipe_scope_binding_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  sku_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  option_binding_id platform_helpers.uuid_v7,
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  CONSTRAINT recipe_binding_version_fk FOREIGN KEY (recipe_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id),
  CONSTRAINT recipe_binding_period_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT recipe_binding_resolution_unique UNIQUE NULLS NOT DISTINCT (brand_id,sku_id,store_id,option_binding_id,effective_from)
);
CREATE TABLE rms_recipe.recipe_review_record (
  review_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  review_kind text NOT NULL CHECK (review_kind IN ('Cost','FoodSafety')),
  reviewer_actor_id platform_helpers.uuid_v7 NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('Approved','Rejected')),
  reviewed_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_review_version_fk FOREIGN KEY (recipe_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id),
  CONSTRAINT recipe_review_kind_unique UNIQUE (recipe_version_id,review_kind)
);
CREATE TABLE rms_recipe.recipe_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft','ReplaceDraft','Publish','Invalidate','Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  result_version_id platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_operation_root_fk FOREIGN KEY (recipe_id,brand_id) REFERENCES rms_recipe.recipe(recipe_id,brand_id),
  CONSTRAINT recipe_operation_version_fk FOREIGN KEY (result_version_id,recipe_id,brand_id) REFERENCES rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id)
);

CREATE TABLE rms_recipe.recipe_admin_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  built_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_generation_brand_unique UNIQUE (generation_id,brand_id)
);
CREATE TABLE rms_recipe.recipe_admin_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  lifecycle text NOT NULL,
  yield_summary text NOT NULL,
  cost_minor numeric NOT NULL CHECK (cost_minor >= 0 AND cost_minor=trunc(cost_minor)),
  allergen_status text NOT NULL CHECK (allergen_status IN ('Verified','Unverified','MissingEvidence')),
  usage_summary text NOT NULL,
  mapping_missing boolean NOT NULL,
  cost_changed boolean NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  effective_from timestamp with time zone NOT NULL,
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY (generation_id,recipe_id),
  CONSTRAINT recipe_projection_generation_fk FOREIGN KEY (generation_id,brand_id) REFERENCES rms_recipe.recipe_admin_projection_generation(generation_id,brand_id)
);
CREATE TABLE rms_recipe.recipe_admin_ingredient_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  requirement_id platform_helpers.uuid_v7 NOT NULL,
  source_id platform_helpers.uuid_v7 NOT NULL,
  source_kind text NOT NULL,
  allergen_count integer NOT NULL CHECK (allergen_count >= 0),
  unresolved boolean NOT NULL,
  PRIMARY KEY (generation_id,requirement_id),
  CONSTRAINT recipe_ingredient_projection_generation_fk FOREIGN KEY (generation_id,brand_id) REFERENCES rms_recipe.recipe_admin_projection_generation(generation_id,brand_id)
);
CREATE TABLE rms_recipe.recipe_admin_projection_checkpoint (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_checkpoint_generation_fk FOREIGN KEY (active_generation_id,brand_id) REFERENCES rms_recipe.recipe_admin_projection_generation(generation_id,brand_id)
);

CREATE RULE recipe_version_no_update AS ON UPDATE TO rms_recipe.recipe_version DO INSTEAD NOTHING;
CREATE RULE recipe_version_no_delete AS ON DELETE TO rms_recipe.recipe_version DO INSTEAD NOTHING;
CREATE RULE recipe_requirement_no_update AS ON UPDATE TO rms_recipe.recipe_ingredient_requirement DO INSTEAD NOTHING;
CREATE RULE recipe_requirement_no_delete AS ON DELETE TO rms_recipe.recipe_ingredient_requirement DO INSTEAD NOTHING;
CREATE RULE recipe_allergen_no_update AS ON UPDATE TO rms_recipe.recipe_allergen_evidence DO INSTEAD NOTHING;
CREATE RULE recipe_allergen_no_delete AS ON DELETE TO rms_recipe.recipe_allergen_evidence DO INSTEAD NOTHING;
CREATE RULE recipe_step_no_update AS ON UPDATE TO rms_recipe.recipe_preparation_step DO INSTEAD NOTHING;
CREATE RULE recipe_step_no_delete AS ON DELETE TO rms_recipe.recipe_preparation_step DO INSTEAD NOTHING;
CREATE RULE recipe_binding_no_update AS ON UPDATE TO rms_recipe.recipe_scope_binding DO INSTEAD NOTHING;
CREATE RULE recipe_binding_no_delete AS ON DELETE TO rms_recipe.recipe_scope_binding DO INSTEAD NOTHING;
CREATE RULE recipe_review_no_update AS ON UPDATE TO rms_recipe.recipe_review_record DO INSTEAD NOTHING;
CREATE RULE recipe_review_no_delete AS ON DELETE TO rms_recipe.recipe_review_record DO INSTEAD NOTHING;
CREATE RULE recipe_operation_no_update AS ON UPDATE TO rms_recipe.recipe_operation_record DO INSTEAD NOTHING;
CREATE RULE recipe_operation_no_delete AS ON DELETE TO rms_recipe.recipe_operation_record DO INSTEAD NOTHING;
CREATE RULE recipe_generation_no_update AS ON UPDATE TO rms_recipe.recipe_admin_projection_generation DO INSTEAD NOTHING;
CREATE RULE recipe_generation_no_delete AS ON DELETE TO rms_recipe.recipe_admin_projection_generation DO INSTEAD NOTHING;

ALTER TABLE rms_recipe.recipe ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_ingredient_requirement ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_ingredient_requirement FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_allergen_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_allergen_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_preparation_step ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_preparation_step FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_scope_binding ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_scope_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_review_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_review_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_projection_generation ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_admin_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_admin_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_ingredient_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_admin_ingredient_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_admin_projection_checkpoint ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_recipe.recipe_admin_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY recipe_brand_scope_policy ON rms_recipe.recipe USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_version_brand_scope_policy ON rms_recipe.recipe_version USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_requirement_brand_scope_policy ON rms_recipe.recipe_ingredient_requirement USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_allergen_brand_scope_policy ON rms_recipe.recipe_allergen_evidence USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_step_brand_scope_policy ON rms_recipe.recipe_preparation_step USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_binding_brand_scope_policy ON rms_recipe.recipe_scope_binding USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY recipe_review_brand_scope_policy ON rms_recipe.recipe_review_record USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_operation_brand_scope_policy ON rms_recipe.recipe_operation_record USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_generation_brand_scope_policy ON rms_recipe.recipe_admin_projection_generation USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_projection_brand_scope_policy ON rms_recipe.recipe_admin_projection USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_ingredient_projection_brand_scope_policy ON rms_recipe.recipe_admin_ingredient_projection USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY recipe_checkpoint_brand_scope_policy ON rms_recipe.recipe_admin_projection_checkpoint USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());

REVOKE ALL ON TABLE rms_recipe.recipe,rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_allergen_evidence,rms_recipe.recipe_preparation_step,rms_recipe.recipe_scope_binding,rms_recipe.recipe_review_record,rms_recipe.recipe_operation_record,rms_recipe.recipe_admin_projection_generation,rms_recipe.recipe_admin_projection,rms_recipe.recipe_admin_ingredient_projection,rms_recipe.recipe_admin_projection_checkpoint FROM PUBLIC;
