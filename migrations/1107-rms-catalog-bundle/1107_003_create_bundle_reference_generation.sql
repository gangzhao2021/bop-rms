-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
LOCK TABLE rms_catalog.bundle,rms_catalog.bundle_version,rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security=off;
CREATE TABLE rms_catalog.bundle_reference_generation (
 brand_id platform_helpers.uuid_v7 PRIMARY KEY,
 generation bigint NOT NULL CHECK(generation>=0)
);
INSERT INTO rms_catalog.bundle_reference_generation SELECT DISTINCT brand_id,0 FROM rms_catalog.bundle;
ALTER TABLE rms_catalog.bundle_reference_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.bundle_reference_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY bundle_reference_generation_scope ON rms_catalog.bundle_reference_generation
 USING(brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.bundle_reference_generation FROM PUBLIC;
CREATE FUNCTION rms_catalog.maintain_bundle_reference_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
 previous_brand text:=current_setting('bop.brand_id',true);
 previous_store text:=current_setting('bop.store_id',true);
 old_brand uuid; new_brand uuid; scope_brand uuid;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('bundle','bundle_version','bundle_component_group','bundle_component_sellable') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE')
 THEN RAISE EXCEPTION 'BUNDLE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN old_brand:=OLD.brand_id; END IF;
 IF TG_OP<>'DELETE' THEN new_brand:=NEW.brand_id; END IF;
 FOR scope_brand IN SELECT DISTINCT b FROM unnest(ARRAY[old_brand,new_brand]) AS b WHERE b IS NOT NULL ORDER BY b LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('CatalogBundleReferenceV1:'||scope_brand::text,0));
  PERFORM set_config('bop.brand_id',scope_brand::text,true);
  PERFORM set_config('bop.store_id','',true);
  IF NOT EXISTS(SELECT 1 FROM rms_catalog.bundle_reference_generation WHERE brand_id=scope_brand) THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BUNDLE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   IF TG_TABLE_NAME='bundle' THEN
    IF EXISTS(SELECT 1 FROM rms_catalog.bundle WHERE brand_id=scope_brand AND bundle_id<>NEW.bundle_id) THEN RAISE EXCEPTION 'BUNDLE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   ELSE
    IF EXISTS(SELECT 1 FROM rms_catalog.bundle WHERE brand_id=scope_brand) THEN RAISE EXCEPTION 'BUNDLE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   END IF;
   INSERT INTO rms_catalog.bundle_reference_generation VALUES(scope_brand,0);
  END IF;
  UPDATE rms_catalog.bundle_reference_generation SET generation=generation+1 WHERE brand_id=scope_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'BUNDLE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 END LOOP;
 PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
 PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.maintain_bundle_reference_generation() FROM PUBLIC;
CREATE FUNCTION rms_catalog.reject_bundle_reference_truncate()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'BUNDLE_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_catalog.reject_bundle_reference_truncate() FROM PUBLIC;
CREATE TRIGGER bundle_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.bundle FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_bundle_reference_generation();
CREATE TRIGGER bundle_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_reference_truncate();
CREATE TRIGGER bundle_version_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.bundle_version FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_bundle_reference_generation();
CREATE TRIGGER bundle_version_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_version FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_reference_truncate();
CREATE TRIGGER bundle_component_group_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.bundle_component_group FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_bundle_reference_generation();
CREATE TRIGGER bundle_component_group_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_component_group FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_reference_truncate();
CREATE TRIGGER bundle_component_sellable_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.bundle_component_sellable FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_bundle_reference_generation();
CREATE TRIGGER bundle_component_sellable_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.bundle_component_sellable FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_bundle_reference_truncate();
SET LOCAL row_security=on;
