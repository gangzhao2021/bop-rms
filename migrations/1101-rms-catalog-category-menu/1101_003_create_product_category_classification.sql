-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Preexisting and legacy producer Versions retain unknown classification.
ALTER TABLE rms_catalog.product_version
  ADD COLUMN category_classification_known boolean NOT NULL DEFAULT false,
  ADD COLUMN primary_category_id platform_helpers.uuid_v7,
  ADD CONSTRAINT product_version_category_coverage_check
    CHECK (category_classification_known OR primary_category_id IS NULL),
  ADD CONSTRAINT product_version_category_coverage_identity_unique
    UNIQUE (product_version_id, product_id, brand_id, category_classification_known);

CREATE TABLE rms_catalog.product_version_category_assignment (
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  category_id platform_helpers.uuid_v7 NOT NULL,
  category_classification_known boolean NOT NULL DEFAULT true CHECK (category_classification_known),
  PRIMARY KEY (product_version_id, category_id),
  CONSTRAINT product_version_category_assignment_identity_unique
    UNIQUE (product_version_id, product_id, brand_id, category_id),
  CONSTRAINT product_version_category_assignment_version_fk
    FOREIGN KEY (product_version_id, product_id, brand_id, category_classification_known)
    REFERENCES rms_catalog.product_version (product_version_id, product_id, brand_id, category_classification_known)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT product_version_category_assignment_category_fk
    FOREIGN KEY (category_id, brand_id)
    REFERENCES rms_catalog.category (category_id, brand_id)
);
ALTER TABLE rms_catalog.product_version
  ADD CONSTRAINT product_version_primary_category_member_fk
    FOREIGN KEY (product_version_id, product_id, brand_id, primary_category_id)
    REFERENCES rms_catalog.product_version_category_assignment (product_version_id, product_id, brand_id, category_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION rms_catalog.guard_product_category_coverage() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $body$
BEGIN
  IF OLD.category_classification_known AND NOT NEW.category_classification_known THEN
    RAISE EXCEPTION 'known Product classification cannot become unknown' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION rms_catalog.guard_product_category_coverage() FROM PUBLIC;
CREATE TRIGGER product_version_category_coverage_guard
  BEFORE UPDATE OF category_classification_known ON rms_catalog.product_version
  FOR EACH ROW EXECUTE FUNCTION rms_catalog.guard_product_category_coverage();

REVOKE ALL ON TABLE rms_catalog.product_version_category_assignment FROM PUBLIC;
ALTER TABLE rms_catalog.product_version_category_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_version_category_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY product_version_category_assignment_brand_scope ON rms_catalog.product_version_category_assignment
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
