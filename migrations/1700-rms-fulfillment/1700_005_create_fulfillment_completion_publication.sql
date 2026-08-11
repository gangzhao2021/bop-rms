-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_fulfillment.fulfillment_completion_publication (
  fulfillment_completion_publication_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  pickup_handoff_id platform_helpers.uuid_v7 NOT NULL,
  verification_method text NOT NULL CHECK (verification_method IN ('Opaque', 'HumanCode')),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 1),
  outbox_event_id platform_helpers.uuid_v7 NOT NULL,
  event_semantic_digest text NOT NULL CHECK (event_semantic_digest ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  causation_operation_id platform_helpers.uuid_v7 NOT NULL,
  completed_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  retention_policy_code text NOT NULL CHECK (retention_policy_code = 'FulfillmentBusinessRecord'),
  CONSTRAINT fulfillment_completion_publication_pkey
    PRIMARY KEY (brand_id, store_id, fulfillment_completion_publication_id),
  CONSTRAINT fulfillment_completion_publication_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_completion_publication_handoff_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, pickup_handoff_id)
    REFERENCES rms_fulfillment.pickup_handoff_record (
      brand_id, store_id, fulfillment_id, pickup_handoff_id
    ),
  CONSTRAINT fulfillment_completion_publication_fulfillment_unique
    UNIQUE (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_completion_publication_handoff_unique
    UNIQUE (brand_id, store_id, pickup_handoff_id),
  CONSTRAINT fulfillment_completion_publication_event_unique
    UNIQUE (brand_id, store_id, outbox_event_id),
  CONSTRAINT fulfillment_completion_publication_distinct_check CHECK (
    fulfillment_completion_publication_id <> fulfillment_id
    AND fulfillment_completion_publication_id <> order_id
    AND fulfillment_completion_publication_id <> pickup_handoff_id
    AND fulfillment_completion_publication_id <> outbox_event_id
    AND fulfillment_completion_publication_id <> correlation_id
    AND fulfillment_completion_publication_id <> causation_operation_id
    AND outbox_event_id <> fulfillment_id
    AND outbox_event_id <> order_id
    AND outbox_event_id <> pickup_handoff_id
    AND outbox_event_id <> correlation_id
    AND outbox_event_id <> causation_operation_id
  )
);

CREATE INDEX fulfillment_completion_publication_history_idx
  ON rms_fulfillment.fulfillment_completion_publication (
    brand_id, store_id, completed_at, fulfillment_completion_publication_id
  );
CREATE TRIGGER fulfillment_completion_publication_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.fulfillment_completion_publication FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_completion_publication_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_completion_publication DO INSTEAD NOTHING;
ALTER TABLE rms_fulfillment.fulfillment_completion_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_completion_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY fulfillment_completion_publication_store_scope_policy
  ON rms_fulfillment.fulfillment_completion_publication
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.fulfillment_completion_publication FROM PUBLIC;
