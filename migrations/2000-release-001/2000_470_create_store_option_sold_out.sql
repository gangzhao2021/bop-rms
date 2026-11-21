-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 sold-out-and-allergen-safety (M24): a Store marks one choice or extra sold out (pearls,
-- an add-on) for the rest of its business day or until further notice, and brings it back. One
-- mark stops it in every dish whose option set offers it, at this Store only. Each change is the
-- choice's next version at the Store, with who and when; the latest version is the current answer
-- and a mark ends by itself at `sold_out_until`. Append-only, Catalog Brand RLS (as Store
-- availability rules: read with no Store selected, filtered by store_id).
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_catalog.store_option_sold_out (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 option_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 sold_out boolean NOT NULL,
 -- Null while sold out: until further notice. Always null for "back on".
 sold_out_until timestamptz NULL CHECK (sold_out_until IS NULL OR (isfinite(sold_out_until) AND sold_out_until=date_trunc('milliseconds',sold_out_until))),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,option_id,version),
 CONSTRAINT store_option_sold_out_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT store_option_sold_out_option FOREIGN KEY (option_id) REFERENCES rms_catalog.option(option_id),
 CONSTRAINT store_option_sold_out_until CHECK (sold_out OR sold_out_until IS NULL),
 CONSTRAINT store_option_sold_out_until_after CHECK (sold_out_until IS NULL OR sold_out_until > occurred_at)
);

-- The choice is the Brand's, and the versions follow one another per choice and Store.
CREATE FUNCTION rms_catalog.validate_store_option_sold_out() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_catalog.option o WHERE o.option_id=NEW.option_id AND o.brand_id=NEW.brand_id) THEN
  RAISE EXCEPTION 'option sold-out for another Brand''s choice' USING ERRCODE='23503';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreOptionSoldOut:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.option_id,0));
 SELECT max(version) INTO latest FROM rms_catalog.store_option_sold_out
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND option_id=NEW.option_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'option sold-out version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER store_option_sold_out_order BEFORE INSERT ON rms_catalog.store_option_sold_out
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.validate_store_option_sold_out();

CREATE FUNCTION rms_catalog.reject_store_option_sold_out_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only option sold-out record' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER store_option_sold_out_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.store_option_sold_out
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_store_option_sold_out_mutation();
CREATE TRIGGER store_option_sold_out_no_truncate BEFORE TRUNCATE ON rms_catalog.store_option_sold_out
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_store_option_sold_out_mutation();

ALTER TABLE rms_catalog.store_option_sold_out ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.store_option_sold_out FORCE ROW LEVEL SECURITY;
CREATE POLICY store_option_sold_out_scope ON rms_catalog.store_option_sold_out
 USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.store_option_sold_out FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.validate_store_option_sold_out() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.reject_store_option_sold_out_mutation() FROM PUBLIC;
