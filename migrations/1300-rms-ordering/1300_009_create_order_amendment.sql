-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_amendment (
  amendment_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  expected_order_version integer NOT NULL CHECK (expected_order_version > 0),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  quote_version integer NOT NULL CHECK (quote_version > 0),
  quote_input_digest text NOT NULL CHECK (quote_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  original_total_minor numeric NOT NULL CHECK (original_total_minor >= 0 AND original_total_minor=trunc(original_total_minor)),
  revised_total_minor numeric NOT NULL CHECK (revised_total_minor >= 0 AND revised_total_minor=trunc(revised_total_minor)),
  delta_minor numeric NOT NULL CHECK (delta_minor=trunc(delta_minor) AND revised_total_minor-original_total_minor=delta_minor),
  kitchen_status text NOT NULL CHECK (kitchen_status IN ('NotStarted','InProgress','Completed')),
  fulfillment_status text NOT NULL CHECK (fulfillment_status IN ('NotStarted','InProgress')),
  approval_required boolean NOT NULL,
  customer_notice_code text NOT NULL CHECK (customer_notice_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  requested_at timestamp with time zone NOT NULL,
  CONSTRAINT order_amendment_scope_identity_unique UNIQUE (amendment_id,brand_id,store_id,order_id),
  CONSTRAINT order_amendment_order_fk FOREIGN KEY (order_id,brand_id,store_id)
    REFERENCES rms_ordering.order_header(order_id,brand_id,store_id)
);
CREATE TABLE rms_ordering.order_amendment_change (
  amendment_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('AddItem','ReduceItem','VoidItem','ReplaceItemConfiguration','UpdateNote')),
  target_order_item_id platform_helpers.uuid_v7,
  replacement_snapshot_digest text,
  quantity_delta integer NOT NULL CHECK (quantity_delta BETWEEN -999 AND 999),
  note_code text,
  CONSTRAINT order_amendment_change_root_fk FOREIGN KEY (amendment_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_amendment(amendment_id,brand_id,store_id,order_id),
  CONSTRAINT order_amendment_change_shape_check CHECK (
    (change_kind='AddItem' AND target_order_item_id IS NULL AND replacement_snapshot_digest ~ '^sha256:[0-9a-f]{64}$' AND quantity_delta>0 AND note_code IS NULL)
    OR (change_kind IN ('ReduceItem','VoidItem') AND target_order_item_id IS NOT NULL AND replacement_snapshot_digest IS NULL AND quantity_delta<0 AND note_code IS NULL)
    OR (change_kind='ReplaceItemConfiguration' AND target_order_item_id IS NOT NULL AND replacement_snapshot_digest ~ '^sha256:[0-9a-f]{64}$' AND quantity_delta=0 AND note_code IS NULL)
    OR (change_kind='UpdateNote' AND target_order_item_id IS NOT NULL AND replacement_snapshot_digest IS NULL AND quantity_delta=0 AND note_code ~ '^[A-Z][A-Z0-9_-]{0,63}$')
  )
);
CREATE TABLE rms_ordering.order_amendment_state_record (
  amendment_state_id platform_helpers.uuid_v7 PRIMARY KEY,
  amendment_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  status text NOT NULL CHECK (status IN ('PendingKitchen','PendingApproval','Applied','Rejected','Aborted')),
  decided_by_actor_id platform_helpers.uuid_v7,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT order_amendment_state_root_fk FOREIGN KEY (amendment_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_amendment(amendment_id,brand_id,store_id,order_id),
  CONSTRAINT order_amendment_state_identity_unique UNIQUE (amendment_state_id,amendment_id,brand_id,store_id,order_id),
  CONSTRAINT order_amendment_state_version_unique UNIQUE (amendment_id,aggregate_version),
  CONSTRAINT order_amendment_state_decision_check CHECK ((status IN ('PendingKitchen','PendingApproval'))=(decided_by_actor_id IS NULL))
);
CREATE TABLE rms_ordering.order_amendment_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  amendment_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Submit','ConfirmKitchen','RejectKitchen','Approve','AbortPending')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  result_state_id platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT order_amendment_operation_state_fk
    FOREIGN KEY (result_state_id,amendment_id,brand_id,store_id,order_id)
    REFERENCES rms_ordering.order_amendment_state_record(amendment_state_id,amendment_id,brand_id,store_id,order_id)
);

CREATE RULE order_amendment_no_update AS ON UPDATE TO rms_ordering.order_amendment DO INSTEAD NOTHING;
CREATE RULE order_amendment_no_delete AS ON DELETE TO rms_ordering.order_amendment DO INSTEAD NOTHING;
CREATE RULE order_amendment_change_no_update AS ON UPDATE TO rms_ordering.order_amendment_change DO INSTEAD NOTHING;
CREATE RULE order_amendment_change_no_delete AS ON DELETE TO rms_ordering.order_amendment_change DO INSTEAD NOTHING;
CREATE RULE order_amendment_state_no_update AS ON UPDATE TO rms_ordering.order_amendment_state_record DO INSTEAD NOTHING;
CREATE RULE order_amendment_state_no_delete AS ON DELETE TO rms_ordering.order_amendment_state_record DO INSTEAD NOTHING;
CREATE RULE order_amendment_operation_no_update AS ON UPDATE TO rms_ordering.order_amendment_operation_record DO INSTEAD NOTHING;
CREATE RULE order_amendment_operation_no_delete AS ON DELETE TO rms_ordering.order_amendment_operation_record DO INSTEAD NOTHING;

CREATE INDEX order_amendment_order_idx ON rms_ordering.order_amendment(brand_id,store_id,order_id,requested_at DESC);
CREATE INDEX order_amendment_state_pending_idx ON rms_ordering.order_amendment_state_record(brand_id,store_id,status,occurred_at DESC);

ALTER TABLE rms_ordering.order_amendment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment_change FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment_state_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment_state_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_amendment_operation_record FORCE ROW LEVEL SECURITY;
CREATE POLICY order_amendment_store_scope_policy ON rms_ordering.order_amendment
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY order_amendment_change_store_scope_policy ON rms_ordering.order_amendment_change
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY order_amendment_state_store_scope_policy ON rms_ordering.order_amendment_state_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY order_amendment_operation_store_scope_policy ON rms_ordering.order_amendment_operation_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_ordering.order_amendment FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_amendment_change FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_amendment_state_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_amendment_operation_record FROM PUBLIC;
