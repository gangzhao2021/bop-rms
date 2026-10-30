-- bop-rms-migration: 1
-- owner: @rms/recipe
-- schema: rms_recipe
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (coordinator 2026-10-29): the owner declares that a menu item
-- such as the per-head tea uses no stock ingredients (a charge). It is recorded like a dish's
-- staff-declared allergens (the same generated recipe of one item standing for the dish, not
-- stock-tracked; who and when), labelled NoIngredientsDeclaredByStaff so it is never taken for a
-- costed recipe nor asked to become one. Existing rows keep their label.
LOCK TABLE rms_recipe.staff_declared_allergen_source IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rms_recipe.staff_declared_allergen_source DROP CONSTRAINT staff_declared_allergen_source_label_check;
ALTER TABLE rms_recipe.staff_declared_allergen_source ADD CONSTRAINT staff_declared_allergen_source_label_check CHECK (
 label IN ('AllergensDeclaredByStaff','NoIngredientsDeclaredByStaff')
 AND (label='AllergensDeclaredByStaff' OR subject_kind='Dish')
);
