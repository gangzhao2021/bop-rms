-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M178): what a Store's kitchen says about cross-contact —
-- the allergens it handles and the equipment it shares — shown to guests above every dish's own
-- allergens. Ticks only (allergen codes and a fixed equipment list, no free text), so it is always
-- bilingual. Versioned: the latest row is current; append-only, Store RLS.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_store.store_kitchen_allergen_statement (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 statement_id platform_helpers.uuid_v7 NOT NULL,
 handled_allergen_codes text[] NOT NULL CHECK (
  cardinality(handled_allergen_codes) <= 30 AND array_position(handled_allergen_codes, NULL) IS NULL
  AND array_to_string(handled_allergen_codes, ',') ~ '^([A-Z][A-Z0-9_-]{1,39}(,[A-Z][A-Z0-9_-]{1,39})*)?$'),
 shared_equipment text[] NOT NULL CHECK (
  cardinality(shared_equipment) <= 6 AND array_position(shared_equipment, NULL) IS NULL
  AND shared_equipment <@ ARRAY['Woks','FryerOil','Grill','Utensils','PrepSurfaces','Steamers']::text[]),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,statement_id),
 CONSTRAINT store_kitchen_allergen_statement_operation UNIQUE (brand_id,store_id,operation_id)
);
CREATE INDEX store_kitchen_allergen_statement_current
 ON rms_store.store_kitchen_allergen_statement (brand_id,store_id,recorded_at DESC);

CREATE FUNCTION rms_store.reject_store_kitchen_allergen_statement_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen allergen statement' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER store_kitchen_allergen_statement_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_kitchen_allergen_statement
 FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_kitchen_allergen_statement_mutation();
CREATE TRIGGER store_kitchen_allergen_statement_no_truncate BEFORE TRUNCATE ON rms_store.store_kitchen_allergen_statement
 FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_kitchen_allergen_statement_mutation();

ALTER TABLE rms_store.store_kitchen_allergen_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_kitchen_allergen_statement FORCE ROW LEVEL SECURITY;
CREATE POLICY store_kitchen_allergen_statement_scope ON rms_store.store_kitchen_allergen_statement
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_kitchen_allergen_statement FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_store.reject_store_kitchen_allergen_statement_mutation() FROM PUBLIC;
