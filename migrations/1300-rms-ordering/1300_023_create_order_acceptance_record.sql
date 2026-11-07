-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_acceptance_record (
  acceptance_id platform_helpers.uuid_v7 PRIMARY KEY,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  expected_order_version integer NOT NULL CHECK (expected_order_version > 0),
  accepted_order_version integer NOT NULL CHECK (
    accepted_order_version::bigint = expected_order_version::bigint + 1
  ),
  actor_type text NOT NULL CHECK (actor_type IN ('User','System')),
  actor_id platform_helpers.uuid_v7,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  permission_code text NOT NULL CHECK (permission_code ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  workflow_version_id platform_helpers.uuid_v7 NOT NULL,
  transition_id platform_helpers.uuid_v7 NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL CHECK (
    isfinite(accepted_at) AND accepted_at=date_trunc('milliseconds',accepted_at)
  ),
  UNIQUE (brand_id,store_id,operation_id),
  UNIQUE (brand_id,store_id,order_id,accepted_order_version),
  FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
  CHECK ((actor_type='User' AND actor_id IS NOT NULL)
    OR (actor_type='System' AND actor_id IS NULL))
);
CREATE RULE order_acceptance_record_no_update AS
  ON UPDATE TO rms_ordering.order_acceptance_record DO INSTEAD NOTHING;
CREATE RULE order_acceptance_record_no_delete AS
  ON DELETE TO rms_ordering.order_acceptance_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_acceptance_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_acceptance_record FORCE ROW LEVEL SECURITY;
CREATE POLICY order_acceptance_record_scope ON rms_ordering.order_acceptance_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_acceptance_record FROM PUBLIC;
