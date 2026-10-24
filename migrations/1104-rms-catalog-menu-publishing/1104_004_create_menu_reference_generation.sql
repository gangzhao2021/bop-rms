-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
LOCK TABLE rms_catalog.menu_review_content,rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security=off;
CREATE TABLE rms_catalog.menu_reference_generation (
 brand_id platform_helpers.uuid_v7 PRIMARY KEY,
 generation bigint NOT NULL CHECK(generation>=0)
);
INSERT INTO rms_catalog.menu_reference_generation
 SELECT brand_id,0 FROM (SELECT brand_id FROM rms_catalog.menu_review_content
 UNION SELECT brand_id FROM rms_catalog.menu_publication_revision
 UNION SELECT brand_id FROM rms_catalog.menu_publication_release
 UNION SELECT brand_id FROM rms_catalog.menu_release_effective_period) existing;
ALTER TABLE rms_catalog.menu_reference_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_reference_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_reference_generation_scope ON rms_catalog.menu_reference_generation
 USING(brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.menu_reference_generation FROM PUBLIC;
CREATE FUNCTION rms_catalog.maintain_menu_reference_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
 previous_brand text:=current_setting('bop.brand_id',true);
 previous_store text:=current_setting('bop.store_id',true);
 old_brand uuid; new_brand uuid; scope_brand uuid;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('menu_review_content','menu_publication_revision','menu_publication_release','menu_release_effective_period') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE')
 THEN RAISE EXCEPTION 'MENU_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN old_brand:=OLD.brand_id; END IF;
 IF TG_OP<>'DELETE' THEN new_brand:=NEW.brand_id; END IF;
 FOR scope_brand IN SELECT DISTINCT b FROM unnest(ARRAY[old_brand,new_brand]) AS b WHERE b IS NOT NULL ORDER BY b LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('CatalogMenuReferenceV1:'||scope_brand::text,0));
  PERFORM set_config('bop.brand_id',scope_brand::text,true);
  PERFORM set_config('bop.store_id','',true);
  IF NOT EXISTS(SELECT 1 FROM rms_catalog.menu_reference_generation WHERE brand_id=scope_brand) THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MENU_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   IF (SELECT count(*) FROM (
      SELECT 1 FROM rms_catalog.menu_review_content WHERE brand_id=scope_brand
      UNION ALL SELECT 1 FROM rms_catalog.menu_publication_revision WHERE brand_id=scope_brand
      UNION ALL SELECT 1 FROM rms_catalog.menu_publication_release WHERE brand_id=scope_brand
      UNION ALL SELECT 1 FROM rms_catalog.menu_release_effective_period WHERE brand_id=scope_brand
    ) stored)>1 THEN RAISE EXCEPTION 'MENU_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
   INSERT INTO rms_catalog.menu_reference_generation VALUES(scope_brand,0);
  END IF;
  UPDATE rms_catalog.menu_reference_generation SET generation=generation+1 WHERE brand_id=scope_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'MENU_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 END LOOP;
 PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
 PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.maintain_menu_reference_generation() FROM PUBLIC;
CREATE FUNCTION rms_catalog.reject_menu_reference_truncate()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'MENU_REFERENCE_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_catalog.reject_menu_reference_truncate() FROM PUBLIC;
CREATE TRIGGER menu_review_content_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.menu_review_content FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_menu_reference_generation();
CREATE TRIGGER menu_review_content_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.menu_review_content FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_menu_reference_truncate();
CREATE TRIGGER menu_publication_revision_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.menu_publication_revision FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_menu_reference_generation();
CREATE TRIGGER menu_publication_revision_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.menu_publication_revision FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_menu_reference_truncate();
CREATE TRIGGER menu_publication_release_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.menu_publication_release FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_menu_reference_generation();
CREATE TRIGGER menu_publication_release_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.menu_publication_release FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_menu_reference_truncate();
CREATE TRIGGER menu_release_effective_period_reference_fence AFTER INSERT OR UPDATE OR DELETE ON rms_catalog.menu_release_effective_period FOR EACH ROW EXECUTE FUNCTION rms_catalog.maintain_menu_reference_generation();
CREATE TRIGGER menu_release_effective_period_reference_no_truncate BEFORE TRUNCATE ON rms_catalog.menu_release_effective_period FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_menu_reference_truncate();
SET LOCAL row_security=on;
