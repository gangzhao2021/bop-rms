-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.kds_operator_handover (
  kds_operator_handover_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  prior_session_id platform_helpers.uuid_v7 NOT NULL,
  prior_actor_id platform_helpers.uuid_v7 NOT NULL,
  prior_final_state text NOT NULL CHECK (prior_final_state IN ('Locked', 'Ended')),
  prior_finalized_at timestamp with time zone NOT NULL,
  next_session_id platform_helpers.uuid_v7 NOT NULL,
  next_actor_id platform_helpers.uuid_v7 NOT NULL,
  next_activated_at timestamp with time zone NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('ShiftHandover', 'Break', 'OperatorReplacement')),
  data_classification text NOT NULL CHECK (data_classification = 'Personal'),
  CONSTRAINT kds_operator_handover_pkey PRIMARY KEY (brand_id, store_id, kds_operator_handover_id),
  CONSTRAINT kds_operator_handover_prior_session_unique UNIQUE (brand_id, store_id, prior_session_id),
  CONSTRAINT kds_operator_handover_next_session_unique UNIQUE (brand_id, store_id, next_session_id),
  CONSTRAINT kds_operator_handover_distinct_check CHECK (
    prior_session_id <> next_session_id AND prior_actor_id <> next_actor_id
  ),
  CONSTRAINT kds_operator_handover_time_check CHECK (
    prior_finalized_at <= next_activated_at AND next_activated_at <= recorded_at
  )
);

CREATE TABLE rms_kitchen.kds_recovery_reconciliation (
  kds_recovery_reconciliation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operator_actor_id platform_helpers.uuid_v7 NOT NULL,
  offline_snapshot_digest text NOT NULL CHECK (offline_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  offline_checkpoint_id platform_helpers.uuid_v7 NOT NULL,
  offline_captured_at timestamp with time zone NOT NULL,
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_checkpoint_id platform_helpers.uuid_v7 NOT NULL,
  source_loaded_at timestamp with time zone NOT NULL,
  manual_continuity_evidence_id platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code IN ('NoOfflineMutation', 'ManualContinuityUsed', 'SourceChanged')),
  reconciliation_outcome text NOT NULL CHECK (
    reconciliation_outcome IN ('ConvergedNoAction', 'RequiresAuthorizedResolution')
  ),
  command_replay_count integer NOT NULL CHECK (command_replay_count = 0),
  reconciled_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT kds_recovery_reconciliation_pkey
    PRIMARY KEY (brand_id, store_id, kds_recovery_reconciliation_id),
  CONSTRAINT kds_recovery_reconciliation_time_check CHECK (
    offline_captured_at <= source_loaded_at AND source_loaded_at <= reconciled_at
  ),
  CONSTRAINT kds_recovery_reconciliation_outcome_check CHECK (
    (reason_code = 'NoOfflineMutation'
      AND reconciliation_outcome = 'ConvergedNoAction'
      AND manual_continuity_evidence_id IS NULL
      AND offline_snapshot_digest = source_snapshot_digest
      AND offline_checkpoint_id = source_checkpoint_id)
    OR
    (reason_code = 'SourceChanged'
      AND reconciliation_outcome = 'RequiresAuthorizedResolution'
      AND manual_continuity_evidence_id IS NULL
      AND (offline_snapshot_digest <> source_snapshot_digest
        OR offline_checkpoint_id <> source_checkpoint_id))
    OR
    (reason_code = 'ManualContinuityUsed'
      AND reconciliation_outcome = 'RequiresAuthorizedResolution'
      AND manual_continuity_evidence_id IS NOT NULL)
  )
);

CREATE INDEX kds_operator_handover_history_idx
  ON rms_kitchen.kds_operator_handover (brand_id, store_id, recorded_at, kds_operator_handover_id);
CREATE INDEX kds_recovery_reconciliation_history_idx
  ON rms_kitchen.kds_recovery_reconciliation (
    brand_id, store_id, reconciled_at, kds_recovery_reconciliation_id
  );

CREATE TRIGGER kds_operator_handover_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kds_operator_handover
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kds_operator_handover_no_delete AS
  ON DELETE TO rms_kitchen.kds_operator_handover DO INSTEAD NOTHING;
CREATE TRIGGER kds_recovery_reconciliation_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kds_recovery_reconciliation
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kds_recovery_reconciliation_no_delete AS
  ON DELETE TO rms_kitchen.kds_recovery_reconciliation DO INSTEAD NOTHING;

ALTER TABLE rms_kitchen.kds_operator_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kds_operator_handover FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kds_recovery_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kds_recovery_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY kds_operator_handover_store_scope_policy ON rms_kitchen.kds_operator_handover
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kds_recovery_reconciliation_store_scope_policy
  ON rms_kitchen.kds_recovery_reconciliation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kds_operator_handover FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kds_recovery_reconciliation FROM PUBLIC;
