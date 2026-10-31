-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 slice 4.4: what choosing an option does to a product's recipes (no change, replace one
-- ingredient with another in the same amount, add an amount per unit chosen, remove an ingredient).
-- Each saved change is expanded into explicit Recipe modifier rules for every recipe bound to the
-- product's sizes and every quantity a customer may choose; reviewers approve the change with its
-- expansion and a publisher publishes the rules. All three tables are append-only.
CREATE TABLE rms_recipe.option_recipe_change (
  change_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  change_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  binding_id platform_helpers.uuid_v7 NOT NULL,
  option_id platform_helpers.uuid_v7 NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('NoChange', 'Replace', 'Add', 'Remove')),
  from_item_id platform_helpers.uuid_v7,
  to_item_id platform_helpers.uuid_v7,
  quantity_microunits numeric(30, 0) CHECK (quantity_microunits > 0),
  unit_cost_numerator numeric(30, 0) CHECK (unit_cost_numerator >= 0),
  loss_basis_points integer NOT NULL CHECK (loss_basis_points BETWEEN 0 AND 10000),
  change_digest text NOT NULL CHECK (change_digest ~ '^sha256:[0-9a-f]{64}$'),
  expansion_json jsonb NOT NULL CHECK (jsonb_typeof(expansion_json) = 'array'),
  author_actor_id platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  CONSTRAINT option_recipe_change_version_unique UNIQUE (brand_id, change_id, version),
  CONSTRAINT option_recipe_change_identity UNIQUE (change_version_id, brand_id),
  CONSTRAINT option_recipe_change_fields CHECK (
    (change_kind = 'NoChange' AND from_item_id IS NULL AND to_item_id IS NULL
      AND quantity_microunits IS NULL AND unit_cost_numerator IS NULL)
    OR (change_kind = 'Replace' AND from_item_id IS NOT NULL AND to_item_id IS NOT NULL
      AND from_item_id <> to_item_id AND quantity_microunits IS NULL)
    OR (change_kind = 'Add' AND from_item_id IS NULL AND to_item_id IS NOT NULL
      AND quantity_microunits IS NOT NULL)
    OR (change_kind = 'Remove' AND from_item_id IS NOT NULL AND to_item_id IS NULL
      AND quantity_microunits IS NULL AND unit_cost_numerator IS NULL)
  )
);
CREATE INDEX option_recipe_change_option_idx
  ON rms_recipe.option_recipe_change (brand_id, binding_id, option_id, version);
CREATE TABLE rms_recipe.option_recipe_change_review (
  review_id platform_helpers.uuid_v7 PRIMARY KEY,
  change_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  change_digest text NOT NULL CHECK (change_digest ~ '^sha256:[0-9a-f]{64}$'),
  review_kind text NOT NULL CHECK (review_kind IN ('Cost', 'FoodSafety')),
  decision text NOT NULL CHECK (decision IN ('Approved', 'Rejected')),
  reviewer_actor_id platform_helpers.uuid_v7 NOT NULL,
  author_actor_id platform_helpers.uuid_v7 NOT NULL,
  comment text CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 500),
  reviewed_at timestamp with time zone NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  CONSTRAINT option_recipe_change_review_change_fk FOREIGN KEY (change_version_id, brand_id)
    REFERENCES rms_recipe.option_recipe_change (change_version_id, brand_id),
  CONSTRAINT option_recipe_change_review_kind_unique UNIQUE (change_version_id, review_kind),
  CONSTRAINT option_recipe_change_review_independent CHECK (reviewer_actor_id <> author_actor_id),
  CONSTRAINT option_recipe_change_review_reason CHECK (decision = 'Approved' OR comment IS NOT NULL)
);
CREATE TABLE rms_recipe.option_recipe_change_publication (
  change_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  publisher_actor_id platform_helpers.uuid_v7 NOT NULL,
  published_at timestamp with time zone NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  CONSTRAINT option_recipe_change_publication_change_fk FOREIGN KEY (change_version_id, brand_id)
    REFERENCES rms_recipe.option_recipe_change (change_version_id, brand_id)
);
CREATE TRIGGER option_recipe_change_append_only BEFORE UPDATE OR DELETE ON rms_recipe.option_recipe_change
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_recipe_authoring_change();
CREATE TRIGGER option_recipe_change_review_append_only BEFORE UPDATE OR DELETE ON rms_recipe.option_recipe_change_review
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_recipe_authoring_change();
CREATE TRIGGER option_recipe_change_publication_append_only BEFORE UPDATE OR DELETE ON rms_recipe.option_recipe_change_publication
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_recipe_authoring_change();
ALTER TABLE rms_recipe.option_recipe_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.option_recipe_change FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.option_recipe_change_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.option_recipe_change_review FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.option_recipe_change_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.option_recipe_change_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY option_recipe_change_brand_scope ON rms_recipe.option_recipe_change
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY option_recipe_change_review_brand_scope ON rms_recipe.option_recipe_change_review
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY option_recipe_change_publication_brand_scope ON rms_recipe.option_recipe_change_publication
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.option_recipe_change, rms_recipe.option_recipe_change_review,
  rms_recipe.option_recipe_change_publication FROM PUBLIC;
