-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_inventory.inventory_item_operation ADD COLUMN audit_json jsonb;
ALTER TABLE rms_inventory.inventory_item_operation ADD CONSTRAINT inventory_item_operation_audit_binding
CHECK (audit_json IS NULL OR (
  jsonb_typeof(audit_json)='object'
  AND audit_json->>'auditId'=audit_id::text
  AND audit_json->>'brandId'=brand_id::text
  AND audit_json->>'targetId'=item_id::text
  AND audit_json->>'targetType'='InventoryItem'
  AND audit_json->>'correlationId'=operation_id::text
) IS TRUE);
