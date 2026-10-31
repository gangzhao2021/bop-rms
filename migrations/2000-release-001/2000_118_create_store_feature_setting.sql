-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 6): which modules a Store uses
-- (counter ordering, pickup and its handover, inventory and recipes, loyalty and marketing,
-- compliance documents) and the template they came from ("FullService" turns them off). A Store
-- never set keeps every module. Each change is the next version, with who changed it and when.
-- Append-only, Store RLS. Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_store.store_feature_setting (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 template_code text NOT NULL CHECK (template_code IN ('FullService','Custom')),
 counter_order boolean NOT NULL,
 pickup boolean NOT NULL,
 inventory boolean NOT NULL,
 loyalty boolean NOT NULL,
 compliance_documents boolean NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT store_feature_setting_operation UNIQUE (brand_id,store_id,operation_id)
);

-- Versions follow one another: 1, then each change the next.
CREATE FUNCTION rms_store.validate_store_feature_setting() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreFeatureSetting:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM rms_store.store_feature_setting
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'store feature setting version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER store_feature_setting_order BEFORE INSERT ON rms_store.store_feature_setting
 FOR EACH ROW EXECUTE FUNCTION rms_store.validate_store_feature_setting();

CREATE FUNCTION rms_store.reject_store_feature_setting_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only store feature setting' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER store_feature_setting_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_feature_setting
 FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_feature_setting_mutation();
CREATE TRIGGER store_feature_setting_no_truncate BEFORE TRUNCATE ON rms_store.store_feature_setting
 FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_feature_setting_mutation();

ALTER TABLE rms_store.store_feature_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_feature_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY store_feature_setting_scope ON rms_store.store_feature_setting
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_feature_setting FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_store.validate_store_feature_setting() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_store.reject_store_feature_setting_mutation() FROM PUBLIC;
