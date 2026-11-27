-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M166 with M77, b7): a choice answered on a listed dish
-- (egg in egg fried rice) is told to guests and the kitchen at once. The change keeps the dish's
-- allergens with every choice's (allergens_json, as before, so every reader that knows nothing
-- of choices still never leaves one out), and now also says which are the dish's own and what
-- each choice adds: {"dish":[...],"options":{"<option reference>":[...]}} (same entry shape as
-- allergens_json). Guests then read the egg under Egg fried rice, and the kitchen only on a dish
-- ordered with it. Only a staff answer carries it. Column of an append-only table; the existing
-- api SELECT/INSERT grants cover it (no grant change).
ALTER TABLE rms_catalog.sellable_allergen_change ADD COLUMN choices_json jsonb NULL;
ALTER TABLE rms_catalog.sellable_allergen_change ADD CONSTRAINT sellable_allergen_change_choices_check
 CHECK (choices_json IS NULL OR (
   cause='StaffDeclared' AND allergens_json IS NOT NULL AND jsonb_typeof(choices_json)='object'
   AND jsonb_typeof(choices_json->'dish')='array' AND jsonb_array_length(choices_json->'dish')<=64
   AND jsonb_typeof(choices_json->'options')='object'));
