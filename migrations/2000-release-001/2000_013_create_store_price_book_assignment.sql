-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: the Brand price book a Store charges. A Published price book
-- version is assigned to a Store from a moment on; assigning another one ends the current assignment
-- (superseded). Assignments and their ends are append-only; a Store has at most one open assignment.
CREATE TABLE rms_pricing.store_price_book_assignment (
  assignment_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  price_book_version_id platform_helpers.uuid_v7 NOT NULL,
  effective_from timestamp with time zone NOT NULL
    CHECK (date_trunc('milliseconds', effective_from) = effective_from),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
    CHECK (data_classification = 'ConfigurationMetadata'),
  FOREIGN KEY (price_book_version_id, price_book_id, brand_id)
    REFERENCES rms_pricing.price_book_version (price_book_version_id, price_book_id, brand_id)
);
CREATE INDEX store_price_book_assignment_store
  ON rms_pricing.store_price_book_assignment (brand_id, store_id, effective_from DESC);
CREATE TABLE rms_pricing.store_price_book_assignment_end (
  assignment_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_pricing.store_price_book_assignment (assignment_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  ended_at timestamp with time zone NOT NULL
    CHECK (date_trunc('milliseconds', ended_at) = ended_at),
  reason_code text NOT NULL CHECK (reason_code = 'SUPERSEDED'),
  superseded_by_assignment_id platform_helpers.uuid_v7 NOT NULL
    REFERENCES rms_pricing.store_price_book_assignment (assignment_id),
  CHECK (superseded_by_assignment_id <> assignment_id)
);
CREATE FUNCTION rms_pricing.reject_store_price_book_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Store price book assignments are append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_store_price_book_assignment_change() FROM PUBLIC;
CREATE TRIGGER store_price_book_assignment_append_only
  BEFORE UPDATE OR DELETE ON rms_pricing.store_price_book_assignment
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_store_price_book_assignment_change();
CREATE TRIGGER store_price_book_assignment_end_append_only
  BEFORE UPDATE OR DELETE ON rms_pricing.store_price_book_assignment_end
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_store_price_book_assignment_change();
-- Only a Published version can be assigned.
CREATE FUNCTION rms_pricing.check_store_price_book_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rms_pricing.price_book_version v
     WHERE v.price_book_version_id = NEW.price_book_version_id
       AND v.price_book_id = NEW.price_book_id AND v.brand_id = NEW.brand_id
       AND v.lifecycle = 'Published') THEN
    RAISE EXCEPTION 'Only a Published price book version can be assigned to a Store'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_store_price_book_assignment() FROM PUBLIC;
CREATE TRIGGER store_price_book_assignment_published
  BEFORE INSERT ON rms_pricing.store_price_book_assignment
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_store_price_book_assignment();
-- An end belongs to its assignment's Store, follows it, and names a later assignment of that Store.
CREATE FUNCTION rms_pricing.check_store_price_book_assignment_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  ended rms_pricing.store_price_book_assignment%ROWTYPE;
  successor rms_pricing.store_price_book_assignment%ROWTYPE;
BEGIN
  SELECT * INTO ended FROM rms_pricing.store_price_book_assignment
   WHERE assignment_id = NEW.assignment_id;
  SELECT * INTO successor FROM rms_pricing.store_price_book_assignment
   WHERE assignment_id = NEW.superseded_by_assignment_id;
  IF ended.assignment_id IS NULL OR successor.assignment_id IS NULL
     OR ended.brand_id <> NEW.brand_id OR ended.store_id <> NEW.store_id
     OR successor.brand_id <> NEW.brand_id OR successor.store_id <> NEW.store_id
     OR NEW.ended_at < ended.effective_from OR NEW.ended_at <> successor.effective_from THEN
    RAISE EXCEPTION 'Store price book assignment end does not match its assignments'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_store_price_book_assignment_end() FROM PUBLIC;
CREATE TRIGGER store_price_book_assignment_end_matches
  BEFORE INSERT ON rms_pricing.store_price_book_assignment_end
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_store_price_book_assignment_end();
-- At commit, a Store has at most one open assignment.
CREATE FUNCTION rms_pricing.check_single_open_store_price_book_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (SELECT count(*) FROM rms_pricing.store_price_book_assignment a
       WHERE a.brand_id = NEW.brand_id AND a.store_id = NEW.store_id
         AND NOT EXISTS (SELECT 1 FROM rms_pricing.store_price_book_assignment_end e
                          WHERE e.assignment_id = a.assignment_id)) > 1 THEN
    RAISE EXCEPTION 'A Store has more than one open price book assignment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_single_open_store_price_book_assignment() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER store_price_book_assignment_single_open
  AFTER INSERT ON rms_pricing.store_price_book_assignment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_single_open_store_price_book_assignment();
ALTER TABLE rms_pricing.store_price_book_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.store_price_book_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.store_price_book_assignment_end ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.store_price_book_assignment_end FORCE ROW LEVEL SECURITY;
CREATE POLICY store_price_book_assignment_store_scope ON rms_pricing.store_price_book_assignment
  USING (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
CREATE POLICY store_price_book_assignment_end_store_scope ON rms_pricing.store_price_book_assignment_end
  USING (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_pricing.store_price_book_assignment,
  rms_pricing.store_price_book_assignment_end FROM PUBLIC;
