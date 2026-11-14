-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (Owner 2026-10-28 decision 10, approach B
-- confirmed by the Owner 2026-10-28): a combo is authored in the Bundle aggregate (1107) and
-- compiled for orders into one dish sold at the combo price with one choice group per slot.
--  * bundle_operation_snapshot: the exact result of each Bundle operation (replay of a retried
--    request), as the Option Set records keep theirs.
--  * A Bundle version is written once; publishing it sets its status, digest and time in place
--    and nothing else (the 1107 rule silently ignored every update, publishing included).
--  * bundle_combo_dish: the dish a combo is compiled into (one per combo, never reassigned).
--  * bundle_combo_choice: which dish each choice of a slot stands for (one dish per choice, never
--    reassigned), read by the kitchen to make each dish of a combo on its own.
--  * bundle_single_store_listing: a combo version listed alone ("List it", no pricing review) at
--    a Brand with exactly one store (Organization read 2000_108, held until the listing commits);
--    once per version.
-- Grants: api SELECT/INSERT (and UPDATE of bundle, bundle_version) (Owner standing approval
-- 2026-10-14, WP-2423).
CREATE FUNCTION rms_catalog.reject_bundle_combo_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only bundle combo record' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.reject_bundle_combo_mutation() FROM PUBLIC;

DROP RULE bundle_version_no_update ON rms_catalog.bundle_version;
CREATE FUNCTION rms_catalog.check_bundle_version_publish() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF OLD.status <> 'Draft' OR NEW.status <> 'Published'
  OR NEW.bundle_version_id IS DISTINCT FROM OLD.bundle_version_id
  OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id
  OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
  OR NEW.default_locale IS DISTINCT FROM OLD.default_locale
  OR NEW.localized_names_json IS DISTINCT FROM OLD.localized_names_json
  OR NEW.localized_descriptions_json IS DISTINCT FROM OLD.localized_descriptions_json
  OR NEW.price_mode IS DISTINCT FROM OLD.price_mode
  OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
  OR NEW.fixed_amount_minor IS DISTINCT FROM OLD.fixed_amount_minor
  OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'a bundle version only changes by being published' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_bundle_version_publish() FROM PUBLIC;
CREATE TRIGGER bundle_version_publish_only BEFORE UPDATE ON rms_catalog.bundle_version
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_bundle_version_publish();

CREATE TABLE rms_catalog.bundle_operation_snapshot (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 bundle_id platform_helpers.uuid_v7 NOT NULL,
 record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object'),
 CONSTRAINT bundle_operation_snapshot_bundle_fk FOREIGN KEY (bundle_id,brand_id)
  REFERENCES rms_catalog.bundle (bundle_id,brand_id)
);

CREATE TABLE rms_catalog.bundle_combo_dish (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 bundle_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 sku_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 PRIMARY KEY (brand_id,bundle_id),
 CONSTRAINT bundle_combo_dish_sku_unique UNIQUE (brand_id,sku_id),
 CONSTRAINT bundle_combo_dish_bundle_fk FOREIGN KEY (bundle_id,brand_id)
  REFERENCES rms_catalog.bundle (bundle_id,brand_id)
);

CREATE TABLE rms_catalog.bundle_combo_choice (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_id platform_helpers.uuid_v7 NOT NULL,
 option_set_id platform_helpers.uuid_v7 NOT NULL,
 bundle_id platform_helpers.uuid_v7 NOT NULL,
 group_code text NOT NULL CHECK (group_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
 dish_sku_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 PRIMARY KEY (brand_id,option_id),
 -- One choice per dish in a slot.
 CONSTRAINT bundle_combo_choice_dish_unique UNIQUE (brand_id,option_set_id,dish_sku_id),
 CONSTRAINT bundle_combo_choice_bundle_fk FOREIGN KEY (bundle_id,brand_id)
  REFERENCES rms_catalog.bundle (bundle_id,brand_id)
);

-- The choice is an option of that set, at the same Brand.
CREATE FUNCTION rms_catalog.check_bundle_combo_choice_option() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM rms_catalog.option o
  WHERE o.option_id=NEW.option_id AND o.option_set_id=NEW.option_set_id AND o.brand_id=NEW.brand_id
 ) THEN
  RAISE EXCEPTION 'bundle combo choice needs an option of its set' USING ERRCODE='23503';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_bundle_combo_choice_option() FROM PUBLIC;
CREATE TRIGGER bundle_combo_choice_option AFTER INSERT ON rms_catalog.bundle_combo_choice
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_bundle_combo_choice_option();

CREATE TABLE rms_catalog.bundle_single_store_listing (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 bundle_id platform_helpers.uuid_v7 NOT NULL,
 bundle_version_id platform_helpers.uuid_v7 NOT NULL,
 approval_mode text NOT NULL CHECK (approval_mode='SingleStoreListing'),
 listing_store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 listed_at timestamptz NOT NULL CHECK (isfinite(listed_at) AND listed_at=date_trunc('milliseconds',listed_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,operation_id),
 CONSTRAINT bundle_single_store_listing_version_once UNIQUE (brand_id,bundle_version_id),
 CONSTRAINT bundle_single_store_listing_version_fk FOREIGN KEY (bundle_version_id,bundle_id,brand_id)
  REFERENCES rms_catalog.bundle_version (bundle_version_id,bundle_id,brand_id)
);

-- The Brand has exactly one store (not archived), and it is the store named; held to commit.
CREATE FUNCTION rms_catalog.check_bundle_single_store_listing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF bop_tenant.brand_has_single_store(NEW.brand_id, NEW.listing_store_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'bundle single store listing needs a brand with one store' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_bundle_single_store_listing() FROM PUBLIC;
CREATE TRIGGER bundle_single_store_listing_one_store AFTER INSERT ON rms_catalog.bundle_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_bundle_single_store_listing();

CREATE TRIGGER bundle_operation_snapshot_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.bundle_operation_snapshot
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_operation_snapshot_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_operation_snapshot
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_combo_dish_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.bundle_combo_dish
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_combo_dish_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_combo_dish
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_combo_choice_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.bundle_combo_choice
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_combo_choice_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_combo_choice
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_single_store_listing_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.bundle_single_store_listing
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();
CREATE TRIGGER bundle_single_store_listing_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_single_store_listing
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_combo_mutation();

ALTER TABLE rms_catalog.bundle_operation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_operation_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_combo_dish ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_combo_dish FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_combo_choice ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_combo_choice FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_single_store_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_single_store_listing FORCE ROW LEVEL SECURITY;
CREATE POLICY bundle_operation_snapshot_brand_policy ON rms_catalog.bundle_operation_snapshot
 USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
-- The compiled records are the Brand's, read in its stores (the kitchen) as well.
CREATE POLICY bundle_combo_dish_brand_policy ON rms_catalog.bundle_combo_dish
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY bundle_combo_choice_brand_policy ON rms_catalog.bundle_combo_choice
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY bundle_single_store_listing_brand_policy ON rms_catalog.bundle_single_store_listing
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_catalog.bundle_operation_snapshot, rms_catalog.bundle_combo_dish,
 rms_catalog.bundle_combo_choice, rms_catalog.bundle_single_store_listing FROM PUBLIC;
