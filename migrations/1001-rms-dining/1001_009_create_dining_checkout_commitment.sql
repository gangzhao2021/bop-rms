-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_checkout_commitment (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 commitment_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 payment_operation_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 3),
 previous_version bigint,
 state text NOT NULL CHECK (state IN ('Prepared','PaymentPending','Expired')),
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at)),
 record_json jsonb NOT NULL,
 CONSTRAINT dining_checkout_pk PRIMARY KEY (tenant_id,brand_id,store_id,commitment_id,version),
 CONSTRAINT dining_checkout_state_once UNIQUE (tenant_id,brand_id,store_id,commitment_id,state),
 CONSTRAINT dining_checkout_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
 REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_checkout_previous_fk FOREIGN KEY (tenant_id,brand_id,store_id,commitment_id,previous_version)
 REFERENCES rms_dining.dining_checkout_commitment(tenant_id,brand_id,store_id,commitment_id,version),
 CONSTRAINT dining_checkout_version CHECK (
  (version=1 AND previous_version IS NULL AND state='Prepared') OR
  (version=2 AND previous_version=1 AND state IN ('PaymentPending','Expired')) OR
  (version=3 AND previous_version=2 AND state='Expired')),
 CONSTRAINT dining_checkout_shape CHECK ((
  jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=16384
  AND record_json ?& ARRAY['commitmentReference','brandReference','storeReference','diningSessionReference','tableReference','participantReference','guestSessionReference','cartReference','quoteReference','submissionReference','orderReference','orderBatchReference','paymentOperationReference','sessionVersion','tableAssignmentVersion','participantVersion','cartVersion','intentHash','preparedAt','preparationValidUntil','state','orderingLinkedAt','paymentRequestedAt','capacityExpiresAt']
  AND record_json - ARRAY['commitmentReference','brandReference','storeReference','diningSessionReference','tableReference','participantReference','guestSessionReference','cartReference','quoteReference','submissionReference','orderReference','orderBatchReference','paymentOperationReference','sessionVersion','tableAssignmentVersion','participantVersion','cartVersion','intentHash','preparedAt','preparationValidUntil','state','orderingLinkedAt','paymentRequestedAt','capacityExpiresAt']='{}'::jsonb
  AND record_json->>'commitmentReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'brandReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'storeReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'diningSessionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'tableReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'participantReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'guestSessionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'cartReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'quoteReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'submissionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'orderReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'orderBatchReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'paymentOperationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND record_json->>'commitmentReference'=commitment_id::text
  AND record_json->>'brandReference'=brand_id::text
  AND record_json->>'storeReference'=store_id::text
  AND record_json->>'diningSessionReference'=session_id::text
  AND record_json->>'submissionReference'=submission_id::text
  AND record_json->>'paymentOperationReference'=payment_operation_id::text
  AND record_json->>'state'=state::text
  AND jsonb_typeof(record_json->'sessionVersion')='number' AND (record_json->>'sessionVersion')::numeric BETWEEN 1 AND 9007199254740991 AND (record_json->>'sessionVersion')::numeric=trunc((record_json->>'sessionVersion')::numeric)
  AND jsonb_typeof(record_json->'tableAssignmentVersion')='number' AND (record_json->>'tableAssignmentVersion')::numeric BETWEEN 1 AND 9007199254740991 AND (record_json->>'tableAssignmentVersion')::numeric=trunc((record_json->>'tableAssignmentVersion')::numeric)
  AND jsonb_typeof(record_json->'participantVersion')='number' AND (record_json->>'participantVersion')::numeric BETWEEN 1 AND 9007199254740991 AND (record_json->>'participantVersion')::numeric=trunc((record_json->>'participantVersion')::numeric)
  AND jsonb_typeof(record_json->'cartVersion')='number' AND (record_json->>'cartVersion')::numeric BETWEEN 1 AND 9007199254740991 AND (record_json->>'cartVersion')::numeric=trunc((record_json->>'cartVersion')::numeric)
  AND record_json->>'intentHash' ~ '^[0-9a-f]{64}$'
  AND record_json->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND record_json->>'preparationValidUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (record_json->>'preparationValidUntil')::timestamptz>(record_json->>'preparedAt')::timestamptz
  AND recorded_at >= (record_json->>'preparedAt')::timestamptz
  AND (
    (record_json->'orderingLinkedAt'='null'::jsonb AND record_json->'paymentRequestedAt'='null'::jsonb
     AND record_json->'capacityExpiresAt'='null'::jsonb AND state IN ('Prepared','Expired'))
    OR (
      state IN ('PaymentPending','Expired')
      AND record_json->>'orderingLinkedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND record_json->>'paymentRequestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND record_json->>'capacityExpiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND (record_json->>'orderingLinkedAt')::timestamptz >= (record_json->>'preparedAt')::timestamptz
      AND (record_json->>'paymentRequestedAt')::timestamptz >= (record_json->>'orderingLinkedAt')::timestamptz
      AND (record_json->>'paymentRequestedAt')::timestamptz < (record_json->>'preparationValidUntil')::timestamptz
      AND (record_json->>'capacityExpiresAt')::timestamptz =
          (record_json->>'paymentRequestedAt')::timestamptz + interval '30 minutes'
      AND recorded_at >= (record_json->>'paymentRequestedAt')::timestamptz
    )
  )
  AND (state <> 'Expired' OR recorded_at >= COALESCE(
    (record_json->>'capacityExpiresAt')::timestamptz,(record_json->>'preparationValidUntil')::timestamptz))
 ) IS TRUE)
);
CREATE UNIQUE INDEX dining_checkout_submission_once ON rms_dining.dining_checkout_commitment
 (tenant_id,brand_id,store_id,submission_id) WHERE version=1;
CREATE UNIQUE INDEX dining_checkout_payment_once ON rms_dining.dining_checkout_commitment
 (tenant_id,brand_id,store_id,payment_operation_id) WHERE version=1;
CREATE INDEX dining_checkout_session ON rms_dining.dining_checkout_commitment
 (tenant_id,brand_id,store_id,session_id);
CREATE RULE dining_checkout_no_update AS ON UPDATE TO rms_dining.dining_checkout_commitment DO INSTEAD NOTHING;
CREATE RULE dining_checkout_no_delete AS ON DELETE TO rms_dining.dining_checkout_commitment DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_checkout_commitment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_checkout_commitment FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_checkout_scope_policy ON rms_dining.dining_checkout_commitment
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_checkout_commitment FROM PUBLIC;
