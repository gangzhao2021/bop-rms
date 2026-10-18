-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- A logical requirement or step can survive into another immutable Recipe version.
ALTER TABLE rms_recipe.recipe_allergen_evidence ADD COLUMN recipe_version_id platform_helpers.uuid_v7;
-- Backfill only the new identity column from the existing unambiguous FK.
DROP RULE recipe_allergen_no_update ON rms_recipe.recipe_allergen_evidence;
UPDATE rms_recipe.recipe_allergen_evidence e SET recipe_version_id=r.recipe_version_id
FROM rms_recipe.recipe_ingredient_requirement r
WHERE e.requirement_id=r.requirement_id AND e.brand_id=r.brand_id;
CREATE RULE recipe_allergen_no_update AS ON UPDATE TO rms_recipe.recipe_allergen_evidence DO INSTEAD NOTHING;
ALTER TABLE rms_recipe.recipe_allergen_evidence ALTER COLUMN recipe_version_id SET NOT NULL;
ALTER TABLE rms_recipe.recipe_allergen_evidence DROP CONSTRAINT recipe_allergen_requirement_fk;
ALTER TABLE rms_recipe.recipe_allergen_evidence DROP CONSTRAINT recipe_allergen_unique;
ALTER TABLE rms_recipe.recipe_ingredient_requirement DROP CONSTRAINT recipe_requirement_brand_identity_unique;
ALTER TABLE rms_recipe.recipe_ingredient_requirement DROP CONSTRAINT recipe_ingredient_requirement_pkey;
ALTER TABLE rms_recipe.recipe_ingredient_requirement
 ADD PRIMARY KEY (recipe_version_id,requirement_id),
 ADD CONSTRAINT recipe_requirement_brand_identity_unique UNIQUE (recipe_version_id,requirement_id,brand_id);
ALTER TABLE rms_recipe.recipe_allergen_evidence
 ADD CONSTRAINT recipe_allergen_requirement_fk FOREIGN KEY (recipe_version_id,requirement_id,brand_id)
 REFERENCES rms_recipe.recipe_ingredient_requirement(recipe_version_id,requirement_id,brand_id),
 ADD CONSTRAINT recipe_allergen_unique UNIQUE (recipe_version_id,requirement_id,allergen_id);
ALTER TABLE rms_recipe.recipe_preparation_step DROP CONSTRAINT recipe_preparation_step_pkey;
ALTER TABLE rms_recipe.recipe_preparation_step ADD PRIMARY KEY (recipe_version_id,step_id);
