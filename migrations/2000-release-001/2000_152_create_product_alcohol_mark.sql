-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"): a dish that contains alcohol. The owner marks it
-- on the menu and the mark applies at once, without listing the menu again, so a beer can't stay on
-- sale as an ordinary item until the next publication. Each change is the dish's next version, with
-- who and when. Append-only, Brand RLS.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_catalog.product_alcohol_mark (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 contains_alcohol boolean NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,product_id,version),
 CONSTRAINT product_alcohol_mark_operation UNIQUE (brand_id,operation_id)
);

-- The mark's versions follow one another per dish.
CREATE FUNCTION rms_catalog.validate_product_alcohol_mark() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ProductAlcoholMark:'||NEW.brand_id||':'||NEW.product_id,0));
 SELECT max(version) INTO latest FROM rms_catalog.product_alcohol_mark
  WHERE brand_id=NEW.brand_id AND product_id=NEW.product_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'alcohol mark version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_alcohol_mark_order BEFORE INSERT ON rms_catalog.product_alcohol_mark
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.validate_product_alcohol_mark();

CREATE FUNCTION rms_catalog.reject_product_alcohol_mark_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only alcohol mark' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER product_alcohol_mark_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.product_alcohol_mark
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_product_alcohol_mark_mutation();
CREATE TRIGGER product_alcohol_mark_no_truncate BEFORE TRUNCATE ON rms_catalog.product_alcohol_mark
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_product_alcohol_mark_mutation();

ALTER TABLE rms_catalog.product_alcohol_mark ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_alcohol_mark FORCE ROW LEVEL SECURITY;
CREATE POLICY product_alcohol_mark_scope ON rms_catalog.product_alcohol_mark
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_catalog.product_alcohol_mark FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.validate_product_alcohol_mark() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_catalog.reject_product_alcohol_mark_mutation() FROM PUBLIC;
