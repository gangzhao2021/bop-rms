-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_fulfillment.fulfillment_ready_operation ADD COLUMN ready_record_json jsonb;
ALTER TABLE rms_fulfillment.fulfillment_ready_operation
  ADD CONSTRAINT fulfillment_ready_record_binding_check CHECK (
    ready_record_json IS NULL OR (
      jsonb_typeof(ready_record_json) = 'object'
      AND ready_record_json->'recordVersion' = '1'::jsonb
      AND ready_record_json - ARRAY['recordVersion','effect'] = '{}'::jsonb
      AND jsonb_typeof(ready_record_json->'effect') = 'object'
      AND (ready_record_json #>> '{effect,operation,operationReference}') IS NOT DISTINCT FROM fulfillment_ready_operation_id::text
      AND (ready_record_json #>> '{effect,operation,brandReference}') IS NOT DISTINCT FROM brand_id::text
      AND (ready_record_json #>> '{effect,operation,storeReference}') IS NOT DISTINCT FROM store_id::text
      AND (ready_record_json #>> '{effect,operation,fulfillmentReference}') IS NOT DISTINCT FROM fulfillment_id::text
      AND (ready_record_json #>> '{effect,operation,fulfillmentItemReference}') IS NOT DISTINCT FROM fulfillment_item_id::text
      AND (ready_record_json #>> '{effect,operation,kitchenReadyResultReference}') IS NOT DISTINCT FROM kitchen_ready_result_id::text
      AND (ready_record_json #>> '{effect,operation,sourceEventReference}') IS NOT DISTINCT FROM source_event_id::text
      AND (ready_record_json #>> '{effect,operation,aggregateVersionBefore}') IS NOT DISTINCT FROM aggregate_version_before::text
      AND (ready_record_json #>> '{effect,operation,aggregateVersionAfter}') IS NOT DISTINCT FROM aggregate_version_after::text
      AND (ready_record_json #>> '{effect,operation,phaseBefore}') IS NOT DISTINCT FROM phase_before::text
      AND (ready_record_json #>> '{effect,operation,phaseAfter}') IS NOT DISTINCT FROM phase_after::text
      AND (ready_record_json #>> '{effect,operation,semanticBindingDigest}') IS NOT DISTINCT FROM semantic_binding_digest::text
      AND (ready_record_json #>> '{effect,result,resultReference}') IS NOT DISTINCT FROM fulfillment_item_ready_result_id::text
      AND (ready_record_json #>> '{effect,result,fulfillmentReference}') IS NOT DISTINCT FROM fulfillment_id::text
      AND (ready_record_json #>> '{effect,result,fulfillmentItemReference}') IS NOT DISTINCT FROM fulfillment_item_id::text
      AND (ready_record_json #>> '{effect,result,kitchenReadyResultReference}') IS NOT DISTINCT FROM kitchen_ready_result_id::text
      AND (ready_record_json #>> '{effect,result,sourceEventReference}') IS NOT DISTINCT FROM source_event_id::text
    ) IS TRUE
  );
