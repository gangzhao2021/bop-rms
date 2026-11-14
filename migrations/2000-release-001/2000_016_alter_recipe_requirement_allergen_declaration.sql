-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-ALLERGEN-DECLARATIONS: the ingredient allergen declaration (Catalog source evidence) a
-- recipe requirement was built from; null for sub-recipe requirements and recipes saved before
-- declarations existed.
ALTER TABLE rms_recipe.recipe_ingredient_requirement
  ADD COLUMN allergen_declaration_evidence_id platform_helpers.uuid_v7;
