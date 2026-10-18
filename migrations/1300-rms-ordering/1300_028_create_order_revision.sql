-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_revision (
  revision_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  kind text NOT NULL CHECK (kind IN ('Initial','AdditionalBatch','Acceptance','Termination','Fulfillment')),
  version integer NOT NULL CHECK (version > 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  previous_revision_id platform_helpers.uuid_v7,
  initial_submission_id platform_helpers.uuid_v7,
  occurred_at timestamptz NOT NULL CHECK (
    isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)
  ),
  CHECK (version::bigint=expected_version::bigint+1),
  CHECK (
    (kind='Initial' AND version=1 AND previous_revision_id IS NULL
      AND initial_submission_id IS NOT NULL AND initial_submission_id=revision_id)
    OR (kind<>'Initial' AND version>1 AND previous_revision_id IS NOT NULL
      AND initial_submission_id IS NULL)
  ),
  UNIQUE (order_id,brand_id,store_id,version),
  UNIQUE (revision_id,order_id,brand_id,store_id,version),
  FOREIGN KEY (order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_header(order_id,brand_id,store_id),
  FOREIGN KEY (initial_submission_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
  FOREIGN KEY (previous_revision_id,order_id,brand_id,store_id,expected_version)
    REFERENCES rms_ordering.order_revision(revision_id,order_id,brand_id,store_id,version)
);
CREATE RULE order_revision_no_update AS ON UPDATE TO rms_ordering.order_revision DO INSTEAD NOTHING;
CREATE RULE order_revision_no_delete AS ON DELETE TO rms_ordering.order_revision DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.order_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY order_revision_scope ON rms_ordering.order_revision
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_revision FROM PUBLIC;
