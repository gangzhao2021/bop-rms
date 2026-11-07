-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- A current verification is evidence for independently authorized remaining-quantity handoffs.
ALTER TABLE rms_fulfillment.pickup_handoff_record
  DROP CONSTRAINT pickup_handoff_record_verification_unique;
ALTER TABLE rms_fulfillment.pickup_handoff_operation ADD COLUMN handoff_record_json jsonb;
ALTER TABLE rms_fulfillment.pickup_handoff_operation
  ADD CONSTRAINT pickup_handoff_record_binding_check CHECK (
    handoff_record_json IS NULL OR (
      jsonb_typeof(handoff_record_json) = 'object'
      AND (handoff_record_json->'recordVersion') IS NOT DISTINCT FROM '1'::jsonb
      AND handoff_record_json - ARRAY['recordVersion','effect'] = '{}'::jsonb
      AND jsonb_typeof(handoff_record_json->'effect') = 'object'
      AND (handoff_record_json #>> '{effect,operation,operationReference}') IS NOT DISTINCT FROM pickup_handoff_operation_id::text
      AND (handoff_record_json #>> '{effect,operation,idempotencyReference}') IS NOT DISTINCT FROM idempotency_id::text
      AND (handoff_record_json #>> '{effect,operation,correlationReference}') IS NOT DISTINCT FROM correlation_id::text
      AND (handoff_record_json #>> '{effect,operation,aggregateVersionBefore}') IS NOT DISTINCT FROM aggregate_version_before::text
      AND (handoff_record_json #>> '{effect,operation,aggregateVersionAfter}') IS NOT DISTINCT FROM aggregate_version_after::text
      AND (handoff_record_json #>> '{effect,operation,phaseBefore}') IS NOT DISTINCT FROM phase_before::text
      AND (handoff_record_json #>> '{effect,operation,phaseAfter}') IS NOT DISTINCT FROM phase_after::text
      AND (handoff_record_json #>> '{effect,record,brandReference}') IS NOT DISTINCT FROM brand_id::text
      AND (handoff_record_json #>> '{effect,record,storeReference}') IS NOT DISTINCT FROM store_id::text
      AND (handoff_record_json #>> '{effect,record,fulfillmentReference}') IS NOT DISTINCT FROM fulfillment_id::text
      AND (handoff_record_json #>> '{effect,record,handoffReference}') IS NOT DISTINCT FROM pickup_handoff_id::text
      AND (handoff_record_json #>> '{effect,record,actorReference}') IS NOT DISTINCT FROM actor_id::text
    )
  );
