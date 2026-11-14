-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M171, Owner decision 17, 2026-11-06): staff mark the
-- allergens a table must avoid, so every kitchen ticket of that table shows them in red. Allergen
-- codes only (no free text), tied to the table's Dining Session (never to a guest, phone or
-- contact); the latest mark of a Session is its current set, an empty set clears it, and readers
-- show marks only while the Session is open ("cleared when the table closes"). Health-adjacent:
-- never logged, exported or put on a receipt. Append-only, Dining Store RLS.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_dining.dining_table_allergy_mark (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 mark_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 allergen_codes text[] NOT NULL CHECK (
  cardinality(allergen_codes) <= 14 AND array_position(allergen_codes, NULL) IS NULL
  AND array_to_string(allergen_codes, ',') ~ '^([A-Z][A-Z0-9_-]{1,39}(,[A-Z][A-Z0-9_-]{1,39})*)?$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (brand_id,store_id,mark_id),
 CONSTRAINT dining_table_allergy_mark_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT dining_table_allergy_mark_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
  REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id)
);
CREATE INDEX dining_table_allergy_mark_session_idx
 ON rms_dining.dining_table_allergy_mark (brand_id,store_id,session_id,recorded_at DESC);

-- Only an open table is marked.
CREATE FUNCTION rms_dining.validate_dining_table_allergy_mark() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_dining.dining_session WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND phase IN ('Active','Closing')) THEN
  RAISE EXCEPTION 'table allergy for a table that is not open' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dining_table_allergy_mark_source BEFORE INSERT ON rms_dining.dining_table_allergy_mark
 FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_dining_table_allergy_mark();

CREATE FUNCTION rms_dining.reject_dining_table_allergy_mark_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only table allergy history' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dining_table_allergy_mark_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_table_allergy_mark
 FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_dining_table_allergy_mark_mutation();
CREATE TRIGGER dining_table_allergy_mark_no_truncate BEFORE TRUNCATE ON rms_dining.dining_table_allergy_mark
 FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_dining_table_allergy_mark_mutation();

ALTER TABLE rms_dining.dining_table_allergy_mark ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_table_allergy_mark FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_allergy_mark_scope ON rms_dining.dining_table_allergy_mark
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_table_allergy_mark FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.validate_dining_table_allergy_mark() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_dining.reject_dining_table_allergy_mark_mutation() FROM PUBLIC;
