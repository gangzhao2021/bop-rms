-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_fulfillment.fulfillment_creation_operation
  ADD COLUMN creation_record_json jsonb;
ALTER TABLE rms_fulfillment.fulfillment_creation_operation
  ADD CONSTRAINT fulfillment_creation_record_binding_check CHECK (
    creation_record_json IS NULL OR (
      jsonb_typeof(creation_record_json) = 'object'
      AND creation_record_json->'recordVersion' = '1'::jsonb
      AND creation_record_json - ARRAY['recordVersion','effect'] = '{}'::jsonb
      AND jsonb_typeof(creation_record_json->'effect') = 'object'
      AND (creation_record_json #>> '{effect,aggregate,fulfillmentReference}') IS NOT DISTINCT FROM fulfillment_id::text
      AND (creation_record_json #>> '{effect,aggregate,brandReference}') IS NOT DISTINCT FROM brand_id::text
      AND (creation_record_json #>> '{effect,aggregate,storeReference}') IS NOT DISTINCT FROM store_id::text
      AND (creation_record_json #>> '{effect,aggregate,orderReference}') IS NOT DISTINCT FROM order_id::text
      AND (creation_record_json #>> '{effect,aggregate,confirmationReference}') IS NOT DISTINCT FROM confirmation_id::text
      AND (creation_record_json #>> '{effect,aggregate,sourceEventReference}') IS NOT DISTINCT FROM source_event_id::text
      AND (creation_record_json #>> '{effect,aggregate,sourceEvidenceDigest}') IS NOT DISTINCT FROM source_evidence_digest::text
      AND (creation_record_json #>> '{effect,operation,operationReference}') IS NOT DISTINCT FROM fulfillment_creation_operation_id::text
      AND (creation_record_json #>> '{effect,operation,fulfillmentReference}') IS NOT DISTINCT FROM fulfillment_id::text
      AND (creation_record_json #>> '{effect,operation,brandReference}') IS NOT DISTINCT FROM brand_id::text
      AND (creation_record_json #>> '{effect,operation,storeReference}') IS NOT DISTINCT FROM store_id::text
      AND (creation_record_json #>> '{effect,operation,orderReference}') IS NOT DISTINCT FROM order_id::text
      AND (creation_record_json #>> '{effect,operation,confirmationReference}') IS NOT DISTINCT FROM confirmation_id::text
      AND (creation_record_json #>> '{effect,operation,sourceEventReference}') IS NOT DISTINCT FROM source_event_id::text
      AND (creation_record_json #>> '{effect,operation,sourceEvidenceDigest}') IS NOT DISTINCT FROM source_evidence_digest::text
      AND (creation_record_json #>> '{effect,operation,semanticBindingDigest}') IS NOT DISTINCT FROM semantic_binding_digest::text
    ) IS TRUE
  );
