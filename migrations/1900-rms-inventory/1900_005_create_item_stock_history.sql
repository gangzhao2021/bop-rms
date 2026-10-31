-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION rms_inventory.record_item_first_movement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE item_reference platform_helpers.uuid_v7;
DECLARE previous rms_inventory.inventory_item_version%ROWTYPE;
BEGIN
 SELECT item_id INTO STRICT item_reference FROM rms_inventory.stock_account
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND account_id=NEW.account_id;
 PERFORM 1 FROM rms_inventory.inventory_item
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=item_reference FOR UPDATE;
 SELECT * INTO STRICT previous FROM rms_inventory.inventory_item_version
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=item_reference ORDER BY version DESC LIMIT 1;
 IF NEW.occurred_at<previous.recorded_at THEN
  RAISE EXCEPTION 'movement predates current Item state' USING ERRCODE='23514';
 END IF;
 IF (previous.snapshot_json->>'hasMovementHistory')::boolean IS NOT TRUE THEN
  INSERT INTO rms_inventory.inventory_item_version
   (tenant_id,brand_id,item_id,version,snapshot_json,recorded_at)
  VALUES (NEW.tenant_id,NEW.brand_id,item_reference,previous.version+1,
   previous.snapshot_json || jsonb_build_object(
    'hasMovementHistory',true,'aggregateVersion',previous.version+1,
    'updatedAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedBy',(NEW.record_json->>'performedBy')::platform_helpers.uuid_v7),NEW.occurred_at);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.record_item_first_movement() FROM PUBLIC;
CREATE TRIGGER stock_movement_00_item_history BEFORE INSERT ON rms_inventory.stock_movement
FOR EACH ROW EXECUTE FUNCTION rms_inventory.record_item_first_movement();

CREATE FUNCTION rms_inventory.enforce_item_stock_policy() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_inventory.inventory_item_version%ROWTYPE;
BEGIN
 PERFORM 1 FROM rms_inventory.inventory_item
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=NEW.item_id FOR UPDATE;
 SELECT * INTO previous FROM rms_inventory.inventory_item_version
  WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=NEW.item_id ORDER BY version DESC LIMIT 1;
 IF FOUND AND (previous.snapshot_json->>'hasMovementHistory')::boolean IS TRUE THEN
  IF (NEW.snapshot_json->>'hasMovementHistory')::boolean IS NOT TRUE
   OR NEW.snapshot_json->'baseUnit' IS DISTINCT FROM previous.snapshot_json->'baseUnit'
   OR NEW.snapshot_json->'trackingPolicy' IS DISTINCT FROM previous.snapshot_json->'trackingPolicy' THEN
   RAISE EXCEPTION 'stock history requires fixed Item policy' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_item_stock_policy() FROM PUBLIC;
CREATE TRIGGER inventory_item_version_stock_policy BEFORE INSERT ON rms_inventory.inventory_item_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_item_stock_policy();
