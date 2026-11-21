-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M77, M167): a recipe bound to a dish, or a Store's own
-- recipe ended, changes what the dish contains at once (Inventory uses the new recipe), while the
-- listed menu still names what was reviewed. Each such change records the dish's allergens as now
-- resolved (null: they could not be resolved), for one Store or the whole Brand. Until the menu is
-- listed again, guests and the kitchen read the listed allergens together with these, so the
-- listed list never leaves an allergen out; a later listing supersedes it (readers ignore changes
-- recorded before that menu version was first reviewed). Append-only, Catalog Brand RLS (read with
-- no Store selected, filtered by store_id).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_catalog.sellable_allergen_change (
 change_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 -- Null: every Store of the Brand (a Brand-wide recipe).
 store_id platform_helpers.uuid_v7 NULL,
 sku_id platform_helpers.uuid_v7 NOT NULL,
 cause text NOT NULL CHECK (cause IN ('RecipeBound','RecipeEnded')),
 -- [{allergenReference, code, localizedNames, classification}], at most 64; null: not resolved.
 allergens_json jsonb NULL CHECK (allergens_json IS NULL OR (jsonb_typeof(allergens_json)='array' AND jsonb_array_length(allergens_json)<=64)),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 CONSTRAINT sellable_allergen_change_operation UNIQUE (brand_id,operation_id),
 CONSTRAINT sellable_allergen_change_sku FOREIGN KEY (sku_id) REFERENCES rms_catalog.sku(sku_id)
);
CREATE INDEX sellable_allergen_change_read ON rms_catalog.sellable_allergen_change (brand_id,sku_id,recorded_at DESC);

-- The dish is the Brand's.
CREATE FUNCTION rms_catalog.validate_sellable_allergen_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_catalog.sku s WHERE s.sku_id=NEW.sku_id AND s.brand_id=NEW.brand_id) THEN
  RAISE EXCEPTION 'allergen change for another Brand''s dish' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sellable_allergen_change_brand BEFORE INSERT ON rms_catalog.sellable_allergen_change
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.validate_sellable_allergen_change();

CREATE FUNCTION rms_catalog.reject_sellable_allergen_change_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only sellable allergen change' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER sellable_allergen_change_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.sellable_allergen_change
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_sellable_allergen_change_mutation();
CREATE TRIGGER sellable_allergen_change_no_truncate BEFORE TRUNCATE ON rms_catalog.sellable_allergen_change
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_sellable_allergen_change_mutation();

ALTER TABLE rms_catalog.sellable_allergen_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.sellable_allergen_change FORCE ROW LEVEL SECURITY;
CREATE POLICY sellable_allergen_change_scope ON rms_catalog.sellable_allergen_change
 USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.sellable_allergen_change FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.validate_sellable_allergen_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.reject_sellable_allergen_change_mutation() FROM PUBLIC;
