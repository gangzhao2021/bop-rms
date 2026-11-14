-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑧ (Owner decision 5, coordinator 2026-10-30): one kitchen screen, each dish
-- marked with the kitchen section (档口) that makes it, and the screen filtered by section. The
-- Store's sections are a versioned list the owner names (each change the next version, with who
-- and when); a dish's section is its next version at the Store, like its "not prepared" mark. A
-- dish with no section is shown as "no section". Append-only, Store RLS.
-- Grants: api SELECT/INSERT on both tables (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_kitchen.kitchen_section_list (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 -- [{"sectionReference": uuid, "name": text}], at most 12, names unique.
 sections jsonb NOT NULL CHECK (
  jsonb_typeof(sections)='array' AND jsonb_array_length(sections)<=12 AND octet_length(sections::text)<=4096
 ),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT kitchen_section_list_operation UNIQUE (brand_id,store_id,operation_id)
);

CREATE TABLE rms_kitchen.kitchen_product_section (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 -- Null: the dish has no section.
 section_id platform_helpers.uuid_v7,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,product_id,version),
 CONSTRAINT kitchen_product_section_operation UNIQUE (brand_id,store_id,operation_id)
);

-- Each list version follows the last; every entry has a reference and a name, names unique.
CREATE FUNCTION rms_kitchen.validate_kitchen_section_list() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('KitchenSections:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM rms_kitchen.kitchen_section_list
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'kitchen section list version out of order' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(NEW.sections) e
   WHERE jsonb_typeof(e)<>'object' OR NOT (e ?& ARRAY['sectionReference','name'])
    OR (e - ARRAY['sectionReference','name'])<>'{}'::jsonb
    OR NOT (e->>'sectionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR jsonb_typeof(e->'name')<>'string' OR char_length(e->>'name') NOT BETWEEN 1 AND 24
    OR btrim(e->>'name')<>(e->>'name')
 ) OR (SELECT count(DISTINCT e->>'name')<>count(*) OR count(DISTINCT e->>'sectionReference')<>count(*)
        FROM jsonb_array_elements(NEW.sections) e) THEN
  RAISE EXCEPTION 'kitchen section list invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_section_list_order BEFORE INSERT ON rms_kitchen.kitchen_section_list
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.validate_kitchen_section_list();

-- A dish's section versions follow one another.
CREATE FUNCTION rms_kitchen.validate_kitchen_product_section() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('KitchenProductSection:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.product_id,0));
 SELECT max(version) INTO latest FROM rms_kitchen.kitchen_product_section
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND product_id=NEW.product_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'kitchen product section version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_product_section_order BEFORE INSERT ON rms_kitchen.kitchen_product_section
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.validate_kitchen_product_section();

CREATE FUNCTION rms_kitchen.reject_kitchen_section_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only kitchen section record' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER kitchen_section_list_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_section_list
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_section_mutation();
CREATE TRIGGER kitchen_section_list_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_section_list
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_section_mutation();
CREATE TRIGGER kitchen_product_section_no_mutation BEFORE UPDATE OR DELETE ON rms_kitchen.kitchen_product_section
 FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_section_mutation();
CREATE TRIGGER kitchen_product_section_no_truncate BEFORE TRUNCATE ON rms_kitchen.kitchen_product_section
 FOR EACH STATEMENT EXECUTE FUNCTION rms_kitchen.reject_kitchen_section_mutation();

ALTER TABLE rms_kitchen.kitchen_section_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_section_list FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_section_list_scope ON rms_kitchen.kitchen_section_list
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_kitchen.kitchen_product_section ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_product_section FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_product_section_scope ON rms_kitchen.kitchen_product_section
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_section_list FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_product_section FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_kitchen.validate_kitchen_section_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_kitchen.validate_kitchen_product_section() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_kitchen.reject_kitchen_section_mutation() FROM PUBLIC;
