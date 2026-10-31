-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE UNIQUE INDEX dining_move_session_identity_idx ON rms_dining.dining_session_move_operation (tenant_id,brand_id,store_id,session_id,operation_id);
CREATE UNIQUE INDEX dining_move_session_version_idx ON rms_dining.dining_session_move_operation (tenant_id,brand_id,store_id,session_id,((record_json->'session'->>'version')::numeric));
ALTER TABLE rms_dining.dining_join_regeneration_operation
  ADD COLUMN move_operation_id platform_helpers.uuid_v7,
  ADD CONSTRAINT dining_join_regeneration_move_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,move_operation_id)
    REFERENCES rms_dining.dining_session_move_operation(tenant_id,brand_id,store_id,session_id,operation_id);
