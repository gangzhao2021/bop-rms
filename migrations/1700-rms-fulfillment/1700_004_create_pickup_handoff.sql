-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_fulfillment.fulfillment_item
  ADD CONSTRAINT fulfillment_item_scope_unique
  UNIQUE (brand_id, store_id, fulfillment_id, fulfillment_item_id);
ALTER TABLE rms_fulfillment.pickup_proof_verification
  ADD CONSTRAINT pickup_proof_verification_scope_unique
  UNIQUE (brand_id, store_id, fulfillment_id, pickup_proof_verification_id);

CREATE TABLE rms_fulfillment.pickup_handoff_record (
  pickup_handoff_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  pickup_location_id platform_helpers.uuid_v7 NOT NULL,
  pickup_proof_verification_id platform_helpers.uuid_v7 NOT NULL,
  verification_method text NOT NULL CHECK (verification_method IN ('Opaque', 'HumanCode')),
  recipient_type text NOT NULL CHECK (recipient_type IN ('Customer', 'Delegate')),
  recipient_display_mask text NOT NULL CHECK (
    char_length(recipient_display_mask) BETWEEN 1 AND 64
    AND recipient_display_mask !~ E'[<>/@\\n\\r\\t]'
  ),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  handed_over_at timestamp with time zone NOT NULL,
  validation_status text NOT NULL CHECK (validation_status = 'Validated'),
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT pickup_handoff_record_pkey PRIMARY KEY (brand_id, store_id, pickup_handoff_id),
  CONSTRAINT pickup_handoff_record_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT pickup_handoff_record_verification_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, pickup_proof_verification_id)
    REFERENCES rms_fulfillment.pickup_proof_verification (
      brand_id, store_id, fulfillment_id, pickup_proof_verification_id
    ),
  CONSTRAINT pickup_handoff_record_verification_unique
    UNIQUE (brand_id, store_id, pickup_proof_verification_id),
  CONSTRAINT pickup_handoff_record_scope_unique
    UNIQUE (brand_id, store_id, fulfillment_id, pickup_handoff_id)
);

CREATE TABLE rms_fulfillment.pickup_handoff_item (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  pickup_handoff_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_item_id platform_helpers.uuid_v7 NOT NULL,
  handed_over_quantity integer NOT NULL CHECK (handed_over_quantity BETWEEN 1 AND 999),
  cumulative_handed_over_quantity integer NOT NULL CHECK (
    cumulative_handed_over_quantity BETWEEN handed_over_quantity AND 999
  ),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT pickup_handoff_item_pkey
    PRIMARY KEY (brand_id, store_id, pickup_handoff_id, fulfillment_item_id),
  CONSTRAINT pickup_handoff_item_record_fkey
    FOREIGN KEY (brand_id, store_id, pickup_handoff_id)
    REFERENCES rms_fulfillment.pickup_handoff_record (brand_id, store_id, pickup_handoff_id),
  CONSTRAINT pickup_handoff_item_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, fulfillment_item_id)
    REFERENCES rms_fulfillment.fulfillment_item (
      brand_id, store_id, fulfillment_id, fulfillment_item_id
    )
);

CREATE TABLE rms_fulfillment.pickup_handoff_operation (
  pickup_handoff_operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  pickup_handoff_id platform_helpers.uuid_v7 NOT NULL,
  idempotency_id platform_helpers.uuid_v7 NOT NULL,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version_before bigint NOT NULL CHECK (aggregate_version_before > 0),
  aggregate_version_after bigint NOT NULL CHECK (aggregate_version_after = aggregate_version_before + 1),
  phase_before text NOT NULL CHECK (phase_before IN ('Ready', 'InProgress')),
  phase_after text NOT NULL CHECK (phase_after IN ('InProgress', 'Completed')),
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT pickup_handoff_operation_pkey
    PRIMARY KEY (brand_id, store_id, pickup_handoff_operation_id),
  CONSTRAINT pickup_handoff_operation_record_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id, pickup_handoff_id)
    REFERENCES rms_fulfillment.pickup_handoff_record (
      brand_id, store_id, fulfillment_id, pickup_handoff_id
    ),
  CONSTRAINT pickup_handoff_operation_idempotency_unique
    UNIQUE (brand_id, store_id, idempotency_id),
  CONSTRAINT pickup_handoff_operation_handoff_unique
    UNIQUE (brand_id, store_id, pickup_handoff_id)
);

CREATE INDEX pickup_handoff_record_history_idx ON rms_fulfillment.pickup_handoff_record
  (brand_id, store_id, fulfillment_id, handed_over_at, pickup_handoff_id);
CREATE INDEX pickup_handoff_item_cumulative_idx ON rms_fulfillment.pickup_handoff_item
  (brand_id, store_id, fulfillment_id, fulfillment_item_id, cumulative_handed_over_quantity);

CREATE TRIGGER pickup_handoff_record_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.pickup_handoff_record FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_handoff_record_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_handoff_record DO INSTEAD NOTHING;
CREATE TRIGGER pickup_handoff_item_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.pickup_handoff_item FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_handoff_item_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_handoff_item DO INSTEAD NOTHING;
CREATE TRIGGER pickup_handoff_operation_no_update_trigger BEFORE UPDATE
  ON rms_fulfillment.pickup_handoff_operation FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE pickup_handoff_operation_no_delete AS
  ON DELETE TO rms_fulfillment.pickup_handoff_operation DO INSTEAD NOTHING;

ALTER TABLE rms_fulfillment.pickup_handoff_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_handoff_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_handoff_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_handoff_item FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_handoff_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.pickup_handoff_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY pickup_handoff_record_store_scope_policy ON rms_fulfillment.pickup_handoff_record
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY pickup_handoff_item_store_scope_policy ON rms_fulfillment.pickup_handoff_item
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY pickup_handoff_operation_store_scope_policy ON rms_fulfillment.pickup_handoff_operation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_fulfillment.pickup_handoff_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.pickup_handoff_item FROM PUBLIC;
REVOKE ALL ON TABLE rms_fulfillment.pickup_handoff_operation FROM PUBLIC;
