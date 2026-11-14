-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- A Dining Order has multiple independently validated submissions.
-- Keep submission/operation/validation uniqueness and all immutable history.
ALTER TABLE rms_inventory.submission_final_validation
  DROP CONSTRAINT submission_final_validation_tenant_id_brand_id_store_id_ord_key;
CREATE INDEX submission_final_validation_order_idx
  ON rms_inventory.submission_final_validation (tenant_id,brand_id,store_id,order_id);
