-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Existing historical rows remain unchanged. Automatic child operations carry no command record.
ALTER TABLE rms_kitchen.kitchen_work_lifecycle_operation
  ADD COLUMN effect_record_json jsonb,
  ADD CONSTRAINT kitchen_work_lifecycle_effect_record_binding_check CHECK (
    effect_record_json IS NULL OR (
      idempotency_key IS NOT NULL
      AND jsonb_typeof(effect_record_json)='object'
      AND effect_record_json->'recordVersion'='1'::jsonb
      AND effect_record_json-ARRAY['recordVersion','effect']='{}'::jsonb
      AND jsonb_typeof(effect_record_json->'effect')='object'
    AND (effect_record_json #>> '{effect,operation,operationReference}') IS NOT DISTINCT FROM kitchen_work_lifecycle_operation_id::text
    AND (effect_record_json #>> '{effect,operation,brandReference}') IS NOT DISTINCT FROM brand_id::text
    AND (effect_record_json #>> '{effect,operation,storeReference}') IS NOT DISTINCT FROM store_id::text
    AND (effect_record_json #>> '{effect,operation,ticketReference}') IS NOT DISTINCT FROM kitchen_ticket_id::text
    AND (effect_record_json #>> '{effect,operation,workItemReference}') IS NOT DISTINCT FROM kitchen_work_item_id::text
    AND (effect_record_json #>> '{effect,operation,orderItemReference}') IS NOT DISTINCT FROM order_item_id::text
    AND (effect_record_json #>> '{effect,operation,idempotencyKey}') IS NOT DISTINCT FROM idempotency_key::text
    AND (effect_record_json #>> '{effect,operation,intentDigest}') IS NOT DISTINCT FROM intent_digest::text
    AND (effect_record_json #>> '{effect,effectDigest}') IS NOT DISTINCT FROM effect_digest::text
    AND (effect_record_json #>> '{effect,operation,auditReference}') IS NOT DISTINCT FROM audit_id::text
    AND (effect_record_json #>> '{effect,operation,eventReference}') IS NOT DISTINCT FROM outbox_event_id::text
    AND (effect_record_json #>> '{effect,operation,expectedTicketVersion}') IS NOT DISTINCT FROM expected_ticket_version::text
    AND (effect_record_json #>> '{effect,operation,resultTicketVersion}') IS NOT DISTINCT FROM result_ticket_version::text
    AND (effect_record_json #>> '{effect,operation,expectedWorkItemVersion}') IS NOT DISTINCT FROM expected_work_item_version::text
    AND (effect_record_json #>> '{effect,operation,resultWorkItemVersion}') IS NOT DISTINCT FROM result_work_item_version::text
    AND (effect_record_json #>> '{effect,command,idempotencyKey}') IS NOT DISTINCT FROM idempotency_key::text
    ) IS TRUE
  );
