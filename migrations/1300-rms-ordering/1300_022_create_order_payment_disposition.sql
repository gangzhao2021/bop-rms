-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_payment_disposition_record (
  disposition_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  payment_transaction_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  payment_event_id platform_helpers.uuid_v7 NOT NULL,
  source_checkpoint platform_helpers.uuid_v7 NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  evaluated_at timestamptz NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('Confirmed','PaidWithoutFulfillableOrder')),
  confirmation_id platform_helpers.uuid_v7,
  source_snapshot_digest text CHECK (source_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  confirmed_at timestamptz,
  order_confirmed_event_id platform_helpers.uuid_v7 UNIQUE,
  reason text,
  kitchen_release_disposition text,
  UNIQUE (brand_id,store_id,payment_event_id),
  UNIQUE (brand_id,store_id,payment_transaction_id),
  FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
  FOREIGN KEY (submission_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
  CHECK (isfinite(evaluated_at) AND evaluated_at=date_trunc('milliseconds',evaluated_at)),
  CHECK (confirmed_at IS NULL OR
    (isfinite(confirmed_at) AND confirmed_at=date_trunc('milliseconds',confirmed_at))),
  CHECK (
    (disposition='Confirmed' AND confirmation_id IS NOT NULL
      AND source_snapshot_digest IS NOT NULL AND confirmed_at IS NOT NULL
      AND order_confirmed_event_id IS NOT NULL AND reason IS NULL AND kitchen_release_disposition IS NULL)
    OR
    (disposition='PaidWithoutFulfillableOrder' AND confirmation_id IS NULL
      AND source_snapshot_digest IS NULL AND confirmed_at IS NULL
      AND order_confirmed_event_id IS NULL AND reason IS NOT NULL
      AND reason IN ('CapacityExpired','SubmissionCancelled','OrderNoLongerFulfillable')
      AND kitchen_release_disposition IS NOT NULL AND kitchen_release_disposition='Blocked')
  )
);
CREATE RULE order_payment_disposition_record_no_update AS
  ON UPDATE TO rms_ordering.order_payment_disposition_record DO INSTEAD NOTHING;
CREATE RULE order_payment_disposition_record_no_delete AS
  ON DELETE TO rms_ordering.order_payment_disposition_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_payment_disposition_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_payment_disposition_record FORCE ROW LEVEL SECURITY;
CREATE POLICY order_payment_disposition_record_scope ON rms_ordering.order_payment_disposition_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_payment_disposition_record FROM PUBLIC;
