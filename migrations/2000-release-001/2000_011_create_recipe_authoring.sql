-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-RECIPE-AUTHORING: Merchant recipe authoring facts kept beside the immutable Recipe
-- versions. All three tables are append-only.
--   * presentation: the human name and kitchen step texts/stations of each version, and the recipe
--     family (a published recipe is revised as a new recipe of the same family);
--   * review: one Cost and one FoodSafety decision per reviewed subject (a draft version, or the
--     kitchen instructions of a published version), bound to the subject digest;
--   * binding end: the instant a SKU binding stops applying (superseded by a revision or removed).
CREATE TABLE rms_recipe.recipe_version_presentation (
  recipe_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  family_id platform_helpers.uuid_v7 NOT NULL,
  family_revision integer NOT NULL CHECK (family_revision BETWEEN 1 AND 999),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  presentation_json jsonb NOT NULL CHECK (jsonb_typeof(presentation_json) = 'object'),
  author_actor_id platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  CONSTRAINT recipe_presentation_version_fk FOREIGN KEY (recipe_version_id, recipe_id, brand_id)
    REFERENCES rms_recipe.recipe_version (recipe_version_id, recipe_id, brand_id)
);
CREATE INDEX recipe_presentation_family_idx
  ON rms_recipe.recipe_version_presentation (brand_id, family_id, family_revision);
CREATE TABLE rms_recipe.recipe_authoring_review (
  review_id platform_helpers.uuid_v7 PRIMARY KEY,
  recipe_version_id platform_helpers.uuid_v7 NOT NULL,
  recipe_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  subject text NOT NULL CHECK (subject IN ('Recipe', 'Preparation')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  review_kind text NOT NULL CHECK (review_kind IN ('Cost', 'FoodSafety')),
  decision text NOT NULL CHECK (decision IN ('Approved', 'Rejected')),
  reviewer_actor_id platform_helpers.uuid_v7 NOT NULL,
  author_actor_id platform_helpers.uuid_v7 NOT NULL,
  comment text CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 500),
  reviewed_at timestamp with time zone NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  CONSTRAINT recipe_authoring_review_version_fk FOREIGN KEY (recipe_version_id, recipe_id, brand_id)
    REFERENCES rms_recipe.recipe_version (recipe_version_id, recipe_id, brand_id),
  CONSTRAINT recipe_authoring_review_kind_unique UNIQUE (recipe_version_id, subject, review_kind),
  CONSTRAINT recipe_authoring_review_independent CHECK (reviewer_actor_id <> author_actor_id)
);
CREATE TABLE rms_recipe.recipe_scope_binding_end (
  recipe_scope_binding_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_recipe.recipe_scope_binding (recipe_scope_binding_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  ended_at timestamp with time zone NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('SUPERSEDED', 'REMOVED')),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL
);
CREATE FUNCTION rms_recipe.reject_recipe_authoring_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Recipe authoring records are append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.reject_recipe_authoring_change() FROM PUBLIC;
CREATE TRIGGER recipe_version_presentation_append_only BEFORE UPDATE OR DELETE ON rms_recipe.recipe_version_presentation
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_recipe_authoring_change();
CREATE TRIGGER recipe_authoring_review_append_only BEFORE UPDATE OR DELETE ON rms_recipe.recipe_authoring_review
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_recipe_authoring_change();
CREATE TRIGGER recipe_scope_binding_end_append_only BEFORE UPDATE OR DELETE ON rms_recipe.recipe_scope_binding_end
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_recipe_authoring_change();
CREATE FUNCTION rms_recipe.check_recipe_scope_binding_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  binding rms_recipe.recipe_scope_binding%ROWTYPE;
BEGIN
  SELECT * INTO binding FROM rms_recipe.recipe_scope_binding
   WHERE recipe_scope_binding_id = NEW.recipe_scope_binding_id;
  IF NOT FOUND OR binding.brand_id <> NEW.brand_id OR binding.store_id IS DISTINCT FROM NEW.store_id
     OR NEW.ended_at < binding.effective_from
     OR (binding.effective_until IS NOT NULL AND NEW.ended_at > binding.effective_until) THEN
    RAISE EXCEPTION 'Recipe binding end does not match its binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.check_recipe_scope_binding_end() FROM PUBLIC;
CREATE TRIGGER recipe_scope_binding_end_matches BEFORE INSERT ON rms_recipe.recipe_scope_binding_end
  FOR EACH ROW EXECUTE FUNCTION rms_recipe.check_recipe_scope_binding_end();
ALTER TABLE rms_recipe.recipe_version_presentation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_version_presentation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_authoring_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_authoring_review FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_scope_binding_end ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.recipe_scope_binding_end FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_version_presentation_brand_scope ON rms_recipe.recipe_version_presentation
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY recipe_authoring_review_brand_scope ON rms_recipe.recipe_authoring_review
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY recipe_scope_binding_end_scope ON rms_recipe.recipe_scope_binding_end
  USING (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
REVOKE ALL ON TABLE rms_recipe.recipe_version_presentation, rms_recipe.recipe_authoring_review,
  rms_recipe.recipe_scope_binding_end FROM PUBLIC;
