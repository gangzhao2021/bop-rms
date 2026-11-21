-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M77, M167): staff changing a listed dish's allergen
-- answers on the Menu page changes what guests and the kitchen must be told at once, as a recipe
-- bound after listing does; it is recorded the same way ("StaffDeclared"), until the menu is
-- listed again.
ALTER TABLE rms_catalog.sellable_allergen_change DROP CONSTRAINT sellable_allergen_change_cause_check;
ALTER TABLE rms_catalog.sellable_allergen_change ADD CONSTRAINT sellable_allergen_change_cause_check
 CHECK (cause IN ('RecipeBound','RecipeEnded','StaffDeclared'));
