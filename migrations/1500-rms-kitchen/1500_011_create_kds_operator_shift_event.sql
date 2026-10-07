-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: Kitchen-owned facts that a named KDS Operator Session started or was released at one
-- Store. Kitchen derives kds_operator_handover from these facts, so it never reads another
-- Session through Identity's per-Session isolated tables.
CREATE TABLE rms_kitchen.kds_operator_shift_event (
  kds_operator_shift_event_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  session_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  session_version integer NOT NULL CHECK (session_version > 0),
  event_kind text NOT NULL CHECK (event_kind IN ('Started', 'Released')),
  occurred_at timestamp with time zone NOT NULL,
  session_valid_until timestamp with time zone NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Personal'),
  CONSTRAINT kds_operator_shift_event_pkey PRIMARY KEY (brand_id, store_id, kds_operator_shift_event_id),
  CONSTRAINT kds_operator_shift_event_once_unique UNIQUE (brand_id, store_id, session_id, event_kind),
  CONSTRAINT kds_operator_shift_event_time_check CHECK (
    occurred_at <= recorded_at AND occurred_at < session_valid_until
  )
);
CREATE INDEX kds_operator_shift_event_history_idx
  ON rms_kitchen.kds_operator_shift_event (brand_id, store_id, event_kind, occurred_at);
CREATE TRIGGER kds_operator_shift_event_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kds_operator_shift_event
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kds_operator_shift_event_no_delete AS
  ON DELETE TO rms_kitchen.kds_operator_shift_event DO INSTEAD NOTHING;
ALTER TABLE rms_kitchen.kds_operator_shift_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kds_operator_shift_event FORCE ROW LEVEL SECURITY;
CREATE POLICY kds_operator_shift_event_store_scope_policy ON rms_kitchen.kds_operator_shift_event
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kds_operator_shift_event FROM PUBLIC;
