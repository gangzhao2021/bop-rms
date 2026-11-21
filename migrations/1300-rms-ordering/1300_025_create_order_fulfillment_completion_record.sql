-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_fulfillment_completion_record (
  completion_id platform_helpers.uuid_v7 PRIMARY KEY,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  expected_source_checkpoint platform_helpers.uuid_v7 NOT NULL,
  expected_order_version integer NOT NULL CHECK (expected_order_version >= 2),
  fulfilled_order_version integer NOT NULL CHECK (
    fulfilled_order_version::bigint = expected_order_version::bigint + 1
  ),
  previous_phase text NOT NULL CHECK (previous_phase IN ('Accepted','InProgress','Ready')),
  phase text NOT NULL CHECK (phase = 'Fulfilled'),
  closure_status text NOT NULL CHECK (closure_status = 'Open'),
  workflow_version_id platform_helpers.uuid_v7 NOT NULL,
  transition_id platform_helpers.uuid_v7 NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  completed_at timestamptz NOT NULL CHECK (
    isfinite(completed_at) AND completed_at=date_trunc('milliseconds',completed_at)
  ),
  recorded_at timestamptz NOT NULL CHECK (
    isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)
    AND recorded_at >= completed_at
  ),
  completion_record_json jsonb NOT NULL,
  UNIQUE (brand_id,store_id,operation_id),
  UNIQUE (brand_id,store_id,order_id),
  UNIQUE (brand_id,store_id,source_event_id),
  UNIQUE (brand_id,store_id,audit_id),
  FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
  CONSTRAINT order_fulfillment_completion_record_binding_check CHECK ((
    jsonb_typeof(completion_record_json) = 'object'
    AND completion_record_json->'recordVersion' = '1'::jsonb
    AND completion_record_json - ARRAY['recordVersion','record'] = '{}'::jsonb
    AND jsonb_typeof(completion_record_json->'record') = 'object'
    AND completion_record_json #>> '{record,orderType}' = 'Pickup'
    AND completion_record_json #>> '{record,actorType}' = 'System'
    AND completion_record_json #> '{record,actorReference}' = 'null'::jsonb
    AND (completion_record_json #>> '{record,completionReference}') IS NOT DISTINCT FROM completion_id::text
    AND (completion_record_json #>> '{record,operationReference}') IS NOT DISTINCT FROM operation_id::text
    AND (completion_record_json #>> '{record,auditReference}') IS NOT DISTINCT FROM audit_id::text
    AND (completion_record_json #>> '{record,brandReference}') IS NOT DISTINCT FROM brand_id::text
    AND (completion_record_json #>> '{record,storeReference}') IS NOT DISTINCT FROM store_id::text
    AND (completion_record_json #>> '{record,orderReference}') IS NOT DISTINCT FROM order_id::text
    AND (completion_record_json #>> '{record,orderBatchReference}') IS NOT DISTINCT FROM order_batch_id::text
    AND (completion_record_json #>> '{record,expectedSourceCheckpoint}') IS NOT DISTINCT FROM expected_source_checkpoint::text
    AND (completion_record_json #>> '{record,expectedOrderVersion}') IS NOT DISTINCT FROM expected_order_version::text
    AND (completion_record_json #>> '{record,fulfilledOrderVersion}') IS NOT DISTINCT FROM fulfilled_order_version::text
    AND (completion_record_json #>> '{record,phaseBefore}') IS NOT DISTINCT FROM previous_phase::text
    AND (completion_record_json #>> '{record,phase}') IS NOT DISTINCT FROM phase::text
    AND (completion_record_json #>> '{record,closureStatus}') IS NOT DISTINCT FROM closure_status::text
    AND (completion_record_json #>> '{record,workflowVersionReference}') IS NOT DISTINCT FROM workflow_version_id::text
    AND (completion_record_json #>> '{record,transitionReference}') IS NOT DISTINCT FROM transition_id::text
    AND (completion_record_json #>> '{record,sourceDigest}') IS NOT DISTINCT FROM source_digest::text
    AND (completion_record_json #>> '{record,sourceEvent,eventId}') IS NOT DISTINCT FROM source_event_id::text
    AND (completion_record_json #>> '{record,sourceEvent,tenantId}') IS NOT DISTINCT FROM brand_id::text
    AND (completion_record_json #>> '{record,sourceEvent,storeId}') IS NOT DISTINCT FROM store_id::text
    AND (completion_record_json #>> '{record,sourceEvent,payload,orderReference}') IS NOT DISTINCT FROM order_id::text
    AND (completion_record_json #>> '{record,completedAt}')::timestamptz = completed_at
    AND (completion_record_json #>> '{record,recordedAt}')::timestamptz = recorded_at
    AND (completion_record_json #>> '{record,sourceEvent,occurredAt}')::timestamptz = completed_at
  ) IS TRUE)
);
CREATE RULE order_fulfillment_completion_record_no_update AS
  ON UPDATE TO rms_ordering.order_fulfillment_completion_record DO INSTEAD NOTHING;
CREATE RULE order_fulfillment_completion_record_no_delete AS
  ON DELETE TO rms_ordering.order_fulfillment_completion_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_fulfillment_completion_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_fulfillment_completion_record FORCE ROW LEVEL SECURITY;
CREATE POLICY order_fulfillment_completion_record_scope ON rms_ordering.order_fulfillment_completion_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_fulfillment_completion_record FROM PUBLIC;
