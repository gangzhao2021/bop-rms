-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
LOCK TABLE rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL row_security=off;
CREATE TABLE rms_inventory.configuration_reference_generation (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 generation bigint NOT NULL CHECK(generation>=0),
 PRIMARY KEY(tenant_id,brand_id)
);
ALTER TABLE rms_inventory.configuration_reference_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.configuration_reference_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY configuration_reference_generation_scope ON rms_inventory.configuration_reference_generation
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.configuration_reference_generation FROM PUBLIC;
INSERT INTO rms_inventory.configuration_reference_generation SELECT DISTINCT tenant_id,brand_id,0 FROM rms_inventory.inventory_item;
CREATE FUNCTION rms_inventory.advance_configuration_reference_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE previous_tenant text:=current_setting('bop.tenant_id',true);
previous_brand text:=current_setting('bop.brand_id',true);
previous_store text:=current_setting('bop.store_id',true);
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_inventory' OR TG_TABLE_NAME NOT IN ('inventory_item','inventory_item_version','inventory_item_operation') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'INVENTORY_CONFIGURATION_REFERENCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('InventoryCatalogReferenceV1:'||NEW.tenant_id::text||':'||NEW.brand_id::text,0));
 PERFORM set_config('bop.tenant_id',NEW.tenant_id::text,true);
 PERFORM set_config('bop.brand_id',NEW.brand_id::text,true);
 PERFORM set_config('bop.store_id','',true);
 IF NOT EXISTS(SELECT 1 FROM rms_inventory.configuration_reference_generation WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id) THEN
  IF TG_TABLE_NAME<>'inventory_item' THEN RAISE EXCEPTION 'INVENTORY_CONFIGURATION_REFERENCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM rms_inventory.inventory_item WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id<>NEW.item_id) THEN RAISE EXCEPTION 'INVENTORY_CONFIGURATION_REFERENCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  INSERT INTO rms_inventory.configuration_reference_generation VALUES(NEW.tenant_id,NEW.brand_id,0);
 END IF;
 UPDATE rms_inventory.configuration_reference_generation SET generation=generation+1 WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_CONFIGURATION_REFERENCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM set_config('bop.tenant_id',COALESCE(previous_tenant,''),true);
 PERFORM set_config('bop.brand_id',COALESCE(previous_brand,''),true);
 PERFORM set_config('bop.store_id',COALESCE(previous_store,''),true);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.advance_configuration_reference_generation() FROM PUBLIC;
CREATE TRIGGER inventory_item_configuration_reference_fence AFTER INSERT ON rms_inventory.inventory_item FOR EACH ROW EXECUTE FUNCTION rms_inventory.advance_configuration_reference_generation();
CREATE TRIGGER inventory_item_version_configuration_reference_fence AFTER INSERT ON rms_inventory.inventory_item_version FOR EACH ROW EXECUTE FUNCTION rms_inventory.advance_configuration_reference_generation();
CREATE TRIGGER inventory_item_operation_configuration_reference_fence AFTER INSERT ON rms_inventory.inventory_item_operation FOR EACH ROW EXECUTE FUNCTION rms_inventory.advance_configuration_reference_generation();
