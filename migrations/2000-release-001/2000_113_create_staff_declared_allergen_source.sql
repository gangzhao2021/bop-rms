-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (coordinator 2026-10-28, accepted with four conditions):
-- a dish's (or a choice's) allergens declared by staff reach the menu through the existing
-- allergen chain: an inventory item standing for the dish or the choice, not stock-tracked, holds
-- the staff declaration; the dish's recipe is generated with that one item (an option change adds
-- it). This append-only record labels each such item, and the dish's generated recipe, as
-- AllergensDeclaredByStaff: it is never a costed recipe, never used for stock, and the merchant
-- page asks staff to replace it with a real recipe once the store keeps inventory and recipes.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE FUNCTION rms_recipe.reject_staff_declared_allergen_source_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only staff declared allergen source' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.reject_staff_declared_allergen_source_mutation() FROM PUBLIC;

CREATE TABLE rms_recipe.staff_declared_allergen_source (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 inventory_item_id platform_helpers.uuid_v7 NOT NULL,
 label text NOT NULL CHECK (label='AllergensDeclaredByStaff'),
 subject_kind text NOT NULL CHECK (subject_kind IN ('Dish','Option')),
 sku_id platform_helpers.uuid_v7,
 recipe_id platform_helpers.uuid_v7,
 binding_id platform_helpers.uuid_v7,
 option_id platform_helpers.uuid_v7,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,inventory_item_id),
 CONSTRAINT staff_declared_allergen_source_operation_unique UNIQUE (brand_id,operation_id),
 CONSTRAINT staff_declared_allergen_source_subject CHECK (
  (subject_kind='Dish' AND sku_id IS NOT NULL AND recipe_id IS NOT NULL AND binding_id IS NULL AND option_id IS NULL)
  OR (subject_kind='Option' AND sku_id IS NULL AND recipe_id IS NULL AND binding_id IS NOT NULL AND option_id IS NOT NULL)
 )
);
-- One generated source per dish size and per choice of a product's choice group.
CREATE UNIQUE INDEX staff_declared_allergen_source_dish
 ON rms_recipe.staff_declared_allergen_source (brand_id,sku_id) WHERE subject_kind='Dish';
CREATE UNIQUE INDEX staff_declared_allergen_source_recipe
 ON rms_recipe.staff_declared_allergen_source (brand_id,recipe_id) WHERE subject_kind='Dish';
CREATE UNIQUE INDEX staff_declared_allergen_source_option
 ON rms_recipe.staff_declared_allergen_source (brand_id,binding_id,option_id) WHERE subject_kind='Option';

-- The generated recipe is the Brand's own recipe.
CREATE FUNCTION rms_recipe.check_staff_declared_allergen_recipe() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.subject_kind='Dish' AND NOT EXISTS (
  SELECT 1 FROM rms_recipe.recipe r WHERE r.recipe_id=NEW.recipe_id AND r.brand_id=NEW.brand_id
 ) THEN
  RAISE EXCEPTION 'staff declared allergen source needs the brand''s recipe' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_recipe.check_staff_declared_allergen_recipe() FROM PUBLIC;
CREATE TRIGGER staff_declared_allergen_source_recipe BEFORE INSERT ON rms_recipe.staff_declared_allergen_source
 FOR EACH ROW EXECUTE FUNCTION rms_recipe.check_staff_declared_allergen_recipe();
CREATE TRIGGER staff_declared_allergen_source_no_mutation BEFORE UPDATE OR DELETE ON rms_recipe.staff_declared_allergen_source
 FOR EACH ROW EXECUTE FUNCTION rms_recipe.reject_staff_declared_allergen_source_mutation();
CREATE TRIGGER staff_declared_allergen_source_no_truncate BEFORE TRUNCATE ON rms_recipe.staff_declared_allergen_source
 FOR EACH STATEMENT EXECUTE FUNCTION rms_recipe.reject_staff_declared_allergen_source_mutation();

ALTER TABLE rms_recipe.staff_declared_allergen_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_recipe.staff_declared_allergen_source FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_declared_allergen_source_brand_scope ON rms_recipe.staff_declared_allergen_source
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_recipe.staff_declared_allergen_source FROM PUBLIC;
