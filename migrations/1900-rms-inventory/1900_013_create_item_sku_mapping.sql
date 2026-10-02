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
CREATE TABLE rms_inventory.item_sku_mapping_version (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 item_id platform_helpers.uuid_v7 NOT NULL,
 mapping_id platform_helpers.uuid_v7 NOT NULL,
 mapping_version integer NOT NULL CHECK(mapping_version>=1),
 item_version bigint NOT NULL CHECK(item_version BETWEEN 1 AND 9007199254740991),
 configuration_operation_id platform_helpers.uuid_v7 NOT NULL,
 action text NOT NULL CHECK(action IN ('Set','Clear')),
 product_id platform_helpers.uuid_v7,
 product_version_id platform_helpers.uuid_v7,
 sku_id platform_helpers.uuid_v7,
 catalog_configuration_digest text,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 audit_json jsonb NOT NULL,
 PRIMARY KEY(tenant_id,brand_id,item_id,mapping_version),
 UNIQUE(tenant_id,brand_id,mapping_id,mapping_version),
 UNIQUE(tenant_id,brand_id,operation_id),
 FOREIGN KEY(tenant_id,brand_id,item_id) REFERENCES rms_inventory.inventory_item(tenant_id,brand_id,item_id),
 FOREIGN KEY(tenant_id,brand_id,configuration_operation_id) REFERENCES rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id),
 CHECK (((action='Set' AND product_id IS NOT NULL AND product_version_id IS NOT NULL AND sku_id IS NOT NULL AND catalog_configuration_digest ~ '^sha256:[0-9a-f]{64}$') OR (action='Clear' AND product_id IS NULL AND product_version_id IS NULL AND sku_id IS NULL AND catalog_configuration_digest IS NULL)) IS TRUE),
 CHECK ((jsonb_typeof(audit_json)='object'
 AND audit_json->>'auditId'=audit_id::text
 AND audit_json->>'brandId'=brand_id::text
 AND audit_json->>'targetType'='InventorySkuMapping'
 AND audit_json->>'targetId'=mapping_id::text
 AND audit_json->>'correlationId'=operation_id::text
 AND audit_json->>'actionCode'='INVENTORY_SKU_MAPPING_'||upper(action)
 AND audit_json->'actor'->>'type'='User'
 AND audit_json->'actor'->>'reference'=actor_id::text
 AND audit_json->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 AND audit_json->>'reasonCode'=reason_code
 AND audit_json->>'dataClassification'='Internal'
 ) IS TRUE)
);
ALTER TABLE rms_inventory.item_sku_mapping_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.item_sku_mapping_version FORCE ROW LEVEL SECURITY;
CREATE POLICY item_sku_mapping_version_scope ON rms_inventory.item_sku_mapping_version
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.item_sku_mapping_version FROM PUBLIC;
CREATE TRIGGER item_sku_mapping_version_immutable BEFORE UPDATE OR DELETE ON rms_inventory.item_sku_mapping_version FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER item_sku_mapping_version_no_truncate BEFORE TRUNCATE ON rms_inventory.item_sku_mapping_version FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE FUNCTION rms_inventory.enforce_item_sku_mapping_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE previous rms_inventory.item_sku_mapping_version%ROWTYPE;
current_item_type text;current_lifecycle text;current_item_version bigint;current_operation uuid;current_recorded_at timestamptz;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_inventory' OR TG_TABLE_NAME<>'item_sku_mapping_version' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_UNAVAILABLE' USING ERRCODE='25000'; END IF;
 IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 -- FK checks acquire Item KEY SHARE. Hold it before the owning Brand fence to
 -- avoid inversion against normal Item writers' earlier FOR UPDATE root lock.
 PERFORM item_id FROM rms_inventory.inventory_item WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=NEW.item_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('InventoryCatalogReferenceV1:'||NEW.tenant_id::text||':'||NEW.brand_id::text,0));
 SELECT i.item_type,v.version,v.snapshot_json->>'lifecycle',v.recorded_at,o.operation_id
 INTO current_item_type,current_item_version,current_lifecycle,current_recorded_at,current_operation
 FROM rms_inventory.inventory_item i
 JOIN LATERAL (SELECT version,snapshot_json,recorded_at FROM rms_inventory.inventory_item_version WHERE tenant_id=i.tenant_id AND brand_id=i.brand_id AND item_id=i.item_id ORDER BY version DESC LIMIT 1) v ON true
 JOIN rms_inventory.inventory_item_operation o ON o.tenant_id=i.tenant_id AND o.brand_id=i.brand_id AND o.item_id=i.item_id AND o.version=v.version
 WHERE i.tenant_id=NEW.tenant_id AND i.brand_id=NEW.brand_id AND i.item_id=NEW.item_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF (current_item_type='FinishedGood' AND current_lifecycle IN ('Active','Inactive') AND current_item_version=NEW.item_version AND current_operation=NEW.configuration_operation_id AND NEW.occurred_at>=current_recorded_at AND NEW.occurred_at<=statement_timestamp()) IS NOT TRUE THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=NEW.item_id ORDER BY mapping_version DESC LIMIT 1;
 IF FOUND THEN
  IF NEW.mapping_id<>previous.mapping_id OR NEW.mapping_version::bigint<>previous.mapping_version::bigint+1 OR NEW.occurred_at<previous.occurred_at THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.mapping_version<>1 THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_CONFLICT' USING ERRCODE='23514'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND mapping_id=NEW.mapping_id AND item_id<>NEW.item_id) THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_CONFLICT' USING ERRCODE='23514'; END IF;
 IF NEW.sku_id IS NOT NULL AND EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (item_id) item_id,sku_id FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id ORDER BY item_id,mapping_version DESC) latest WHERE latest.sku_id=NEW.sku_id AND latest.item_id<>NEW.item_id) THEN RAISE EXCEPTION 'INVENTORY_SKU_MAPPING_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_item_sku_mapping_version() FROM PUBLIC;
CREATE TRIGGER item_sku_mapping_version_sequence BEFORE INSERT ON rms_inventory.item_sku_mapping_version FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_item_sku_mapping_version();
CREATE OR REPLACE FUNCTION rms_inventory.advance_configuration_reference_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE previous_tenant text:=current_setting('bop.tenant_id',true);
previous_brand text:=current_setting('bop.brand_id',true);
previous_store text:=current_setting('bop.store_id',true);
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_inventory' OR TG_TABLE_NAME NOT IN ('inventory_item','inventory_item_version','inventory_item_operation','item_sku_mapping_version') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
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
CREATE TRIGGER item_sku_mapping_version_configuration_reference_fence AFTER INSERT ON rms_inventory.item_sku_mapping_version FOR EACH ROW EXECUTE FUNCTION rms_inventory.advance_configuration_reference_generation();
