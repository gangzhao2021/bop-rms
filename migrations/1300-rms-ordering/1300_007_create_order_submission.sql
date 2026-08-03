-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.order_number_allocation
  ADD CONSTRAINT order_number_allocation_scope_identity_unique
  UNIQUE (order_id, brand_id, store_id, business_date, order_number);

CREATE TABLE rms_ordering.order_header (
  order_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  business_date date NOT NULL,
  order_number text NOT NULL CHECK (order_number ~ '^[1-9][0-9]{0,18}$'),
  order_type text NOT NULL CHECK (order_type IN ('DineIn', 'Pickup')),
  source_channel text NOT NULL CHECK (source_channel IN ('Api', 'Pos', 'Qr', 'Web')),
  dining_session_id platform_helpers.uuid_v7,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  submitted_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version = 1),
  canonical_phase text NOT NULL CHECK (canonical_phase = 'Submitted'),
  closure_status text NOT NULL CHECK (closure_status = 'Open'),
  payment_status text NOT NULL CHECK (payment_status = 'NotReported'),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT order_header_scope_identity_unique UNIQUE (order_id, brand_id, store_id),
  CONSTRAINT order_header_scope_number_unique UNIQUE (brand_id, store_id, business_date, order_number),
  CONSTRAINT order_header_number_allocation_fk
    FOREIGN KEY (order_id, brand_id, store_id, business_date, order_number)
    REFERENCES rms_ordering.order_number_allocation
      (order_id, brand_id, store_id, business_date, order_number),
  CONSTRAINT order_header_dining_context_check CHECK (
    (order_type = 'DineIn' AND dining_session_id IS NOT NULL)
    OR (order_type = 'Pickup' AND dining_session_id IS NULL)
  )
);

CREATE TABLE rms_ordering.order_submission_record (
  submission_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_cart_id platform_helpers.uuid_v7 NOT NULL,
  source_cart_version integer NOT NULL CHECK (source_cart_version > 0),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT order_submission_scope_identity_unique
    UNIQUE (submission_id, brand_id, store_id, order_id),
  CONSTRAINT order_submission_order_unique UNIQUE (order_id),
  CONSTRAINT order_submission_order_fk
    FOREIGN KEY (order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_header (order_id, brand_id, store_id)
);

CREATE TABLE rms_ordering.order_batch (
  order_batch_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  source_cart_id platform_helpers.uuid_v7 NOT NULL,
  source_cart_version integer NOT NULL CHECK (source_cart_version > 0),
  checkout_validation_id platform_helpers.uuid_v7 NOT NULL,
  quote_id platform_helpers.uuid_v7 NOT NULL,
  submitted_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  submitted_at timestamp with time zone NOT NULL,
  CONSTRAINT order_batch_scope_identity_unique
    UNIQUE (order_batch_id, order_id, brand_id, store_id),
  CONSTRAINT order_batch_first_submission_unique UNIQUE (order_id, submission_id),
  CONSTRAINT order_batch_order_fk
    FOREIGN KEY (order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_header (order_id, brand_id, store_id),
  CONSTRAINT order_batch_submission_fk
    FOREIGN KEY (submission_id, brand_id, store_id, order_id)
    REFERENCES rms_ordering.order_submission_record (submission_id, brand_id, store_id, order_id)
);

CREATE TABLE rms_ordering.order_item (
  order_item_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  source_cart_line_id platform_helpers.uuid_v7 NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  catalog_snapshot_digest text NOT NULL CHECK (catalog_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  quote_input_digest text NOT NULL CHECK (quote_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  transaction_snapshot_json jsonb NOT NULL CHECK (
    jsonb_typeof(transaction_snapshot_json) = 'object'
    AND transaction_snapshot_json ? 'catalog'
    AND transaction_snapshot_json ? 'pricing'
  ),
  snapshot_captured_at timestamp with time zone NOT NULL,
  CONSTRAINT order_item_scope_identity_unique
    UNIQUE (order_item_id, order_batch_id, order_id, brand_id, store_id),
  CONSTRAINT order_item_cart_line_unique UNIQUE (order_batch_id, source_cart_line_id),
  CONSTRAINT order_item_batch_fk
    FOREIGN KEY (order_batch_id, order_id, brand_id, store_id)
    REFERENCES rms_ordering.order_batch (order_batch_id, order_id, brand_id, store_id)
);

CREATE RULE order_header_identity_no_update AS
  ON UPDATE TO rms_ordering.order_header
  WHERE (
    OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.business_date IS DISTINCT FROM NEW.business_date
    OR OLD.order_number IS DISTINCT FROM NEW.order_number
    OR OLD.order_type IS DISTINCT FROM NEW.order_type
    OR OLD.source_channel IS DISTINCT FROM NEW.source_channel
    OR OLD.dining_session_id IS DISTINCT FROM NEW.dining_session_id
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
    OR OLD.submitted_by_actor_id IS DISTINCT FROM NEW.submitted_by_actor_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  )
  DO INSTEAD NOTHING;
CREATE RULE order_header_no_delete AS ON DELETE TO rms_ordering.order_header DO INSTEAD NOTHING;
CREATE RULE order_submission_record_no_update AS
  ON UPDATE TO rms_ordering.order_submission_record DO INSTEAD NOTHING;
CREATE RULE order_submission_record_no_delete AS
  ON DELETE TO rms_ordering.order_submission_record DO INSTEAD NOTHING;
CREATE RULE order_batch_no_update AS ON UPDATE TO rms_ordering.order_batch DO INSTEAD NOTHING;
CREATE RULE order_batch_no_delete AS ON DELETE TO rms_ordering.order_batch DO INSTEAD NOTHING;
CREATE RULE order_item_no_update AS ON UPDATE TO rms_ordering.order_item DO INSTEAD NOTHING;
CREATE RULE order_item_no_delete AS ON DELETE TO rms_ordering.order_item DO INSTEAD NOTHING;

CREATE INDEX order_header_store_created_idx
  ON rms_ordering.order_header (brand_id, store_id, created_at DESC);
CREATE INDEX order_submission_cart_idx
  ON rms_ordering.order_submission_record
  (brand_id, store_id, source_cart_id, source_cart_version, created_at DESC);
CREATE INDEX order_batch_order_idx
  ON rms_ordering.order_batch (brand_id, store_id, order_id, submitted_at);
CREATE INDEX order_item_order_idx
  ON rms_ordering.order_item (brand_id, store_id, order_id, order_batch_id);

ALTER TABLE rms_ordering.order_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_header FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_submission_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_submission_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_item FORCE ROW LEVEL SECURITY;

CREATE POLICY order_header_store_scope_policy ON rms_ordering.order_header
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY order_submission_record_store_scope_policy
  ON rms_ordering.order_submission_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY order_batch_store_scope_policy ON rms_ordering.order_batch
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY order_item_store_scope_policy ON rms_ordering.order_item
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_ordering.order_header FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_submission_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_batch FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_item FROM PUBLIC;
