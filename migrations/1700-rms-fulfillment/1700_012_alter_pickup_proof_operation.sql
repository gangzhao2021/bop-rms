-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Verification is repeatable evidence while the same proof remains valid.
-- Only issuance changes the proof generation; idempotency remains unique for every operation.
ALTER TABLE rms_fulfillment.pickup_proof_operation
  DROP CONSTRAINT pickup_proof_operation_issue_generation_unique;
CREATE UNIQUE INDEX pickup_proof_operation_issue_generation_unique
  ON rms_fulfillment.pickup_proof_operation
    (brand_id, store_id, fulfillment_id, generation, operation_kind)
  WHERE operation_kind IN ('Issue', 'Regenerate');
