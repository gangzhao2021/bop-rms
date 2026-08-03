-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
DROP RULE payment_terminal_fact_no_update ON rms_payment.payment_terminal_fact;
DROP RULE payment_terminal_fact_no_delete ON rms_payment.payment_terminal_fact;

ALTER TABLE rms_payment.payment_terminal_fact
  ALTER COLUMN webhook_receipt_id DROP NOT NULL,
  ALTER COLUMN provider_event_id DROP NOT NULL,
  ADD COLUMN causation_id platform_helpers.uuid_v7;

UPDATE rms_payment.payment_terminal_fact
SET causation_id = webhook_receipt_id;

ALTER TABLE rms_payment.payment_terminal_fact
  ALTER COLUMN causation_id SET NOT NULL,
  ADD CONSTRAINT payment_terminal_fact_authoritative_source_shape_check CHECK (
    (
      authoritative_source = 'VerifiedWebhook'
      AND webhook_receipt_id IS NOT NULL
      AND provider_event_id IS NOT NULL
      AND causation_id = webhook_receipt_id
    ) OR (
      authoritative_source = 'ProviderRetrieval'
      AND webhook_receipt_id IS NULL
      AND provider_event_id IS NULL
    )
  );

CREATE RULE payment_terminal_fact_no_update AS
  ON UPDATE TO rms_payment.payment_terminal_fact DO INSTEAD NOTHING;
CREATE RULE payment_terminal_fact_no_delete AS
  ON DELETE TO rms_payment.payment_terminal_fact DO INSTEAD NOTHING;

CREATE TABLE rms_payment.payment_reconciliation_run (
  reconciliation_run_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  mode text NOT NULL CHECK (mode IN ('Operational', 'DailySettlement')),
  actor_id platform_helpers.uuid_v7,
  purpose text NOT NULL CHECK (purpose = 'ReconcilePayments'),
  scheduled_at timestamp with time zone NOT NULL,
  cutoff_at timestamp with time zone NOT NULL,
  max_candidates integer NOT NULL CHECK (max_candidates BETWEEN 1 AND 100),
  completed_at timestamp with time zone NOT NULL,
  matched_count integer NOT NULL CHECK (matched_count >= 0),
  healed_count integer NOT NULL CHECK (healed_count >= 0),
  unresolved_count integer NOT NULL CHECK (unresolved_count >= 0),
  unavailable_count integer NOT NULL CHECK (unavailable_count >= 0),
  difference_count integer NOT NULL CHECK (difference_count >= 0),
  CONSTRAINT payment_reconciliation_run_scope_identity_unique
    UNIQUE (reconciliation_run_id, brand_id, store_id),
  CONSTRAINT payment_reconciliation_run_time_check CHECK (
    cutoff_at <= scheduled_at AND scheduled_at <= completed_at
  ),
  CONSTRAINT payment_reconciliation_run_count_check CHECK (
    matched_count + healed_count + unresolved_count + unavailable_count + difference_count
      <= max_candidates
  )
);

CREATE TABLE rms_payment.payment_reconciliation_exception (
  reconciliation_exception_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  candidate_id platform_helpers.uuid_v7 NOT NULL,
  reason text NOT NULL CHECK (
    reason IN ('StateMismatch', 'AmountMismatch', 'RefundMismatch', 'TerminalConflict')
  ),
  severity text NOT NULL CHECK (severity IN ('Error', 'Critical')),
  status text NOT NULL CHECK (status = 'Open'),
  opened_at timestamp with time zone NOT NULL,
  CONSTRAINT payment_reconciliation_exception_stable_unique
    UNIQUE (brand_id, store_id, candidate_id, reason),
  CONSTRAINT payment_reconciliation_exception_scope_identity_unique
    UNIQUE (reconciliation_exception_id, brand_id, store_id, candidate_id),
  CONSTRAINT payment_reconciliation_exception_reason_severity_check CHECK (
    (reason = 'TerminalConflict' AND severity = 'Critical')
    OR (reason <> 'TerminalConflict' AND severity = 'Error')
  )
);

CREATE TABLE rms_payment.payment_reconciliation_record (
  reconciliation_check_id platform_helpers.uuid_v7 PRIMARY KEY,
  reconciliation_run_id platform_helpers.uuid_v7 NOT NULL,
  candidate_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  mode text NOT NULL CHECK (mode IN ('Operational', 'DailySettlement')),
  payment_intent_id platform_helpers.uuid_v7,
  settlement_reference text CHECK (
    settlement_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'
  ),
  outcome text NOT NULL CHECK (
    outcome IN ('Matched', 'Healed', 'Unresolved', 'Unavailable', 'Difference')
  ),
  difference_reason text CHECK (
    difference_reason IN ('StateMismatch', 'AmountMismatch', 'RefundMismatch', 'TerminalConflict')
  ),
  internal_status text CHECK (
    internal_status IN (
      'RequiresCustomerAction', 'Pending', 'Authorized', 'Captured', 'Cancelled', 'Failed', 'Unknown'
    )
  ),
  provider_status text CHECK (
    provider_status IN (
      'RequiresCustomerAction', 'Pending', 'Authorized', 'Captured', 'Cancelled', 'Failed', 'Unknown'
    )
  ),
  internal_captured_minor bigint NOT NULL CHECK (internal_captured_minor >= 0),
  provider_captured_minor bigint CHECK (provider_captured_minor >= 0),
  internal_refunded_minor bigint NOT NULL CHECK (internal_refunded_minor >= 0),
  provider_refunded_minor bigint CHECK (provider_refunded_minor >= 0),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  reconciliation_exception_id platform_helpers.uuid_v7,
  safe_code text CHECK (safe_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  checked_at timestamp with time zone NOT NULL,
  CONSTRAINT payment_reconciliation_record_run_candidate_unique
    UNIQUE (reconciliation_run_id, candidate_id),
  CONSTRAINT payment_reconciliation_record_run_fk
    FOREIGN KEY (reconciliation_run_id, brand_id, store_id)
    REFERENCES rms_payment.payment_reconciliation_run
      (reconciliation_run_id, brand_id, store_id),
  CONSTRAINT payment_reconciliation_record_exception_fk
    FOREIGN KEY (reconciliation_exception_id, brand_id, store_id, candidate_id)
    REFERENCES rms_payment.payment_reconciliation_exception
      (reconciliation_exception_id, brand_id, store_id, candidate_id),
  CONSTRAINT payment_reconciliation_record_mode_shape_check CHECK (
    (
      mode = 'Operational'
      AND payment_intent_id IS NOT NULL
      AND settlement_reference IS NULL
      AND internal_status IS NOT NULL
    ) OR (
      mode = 'DailySettlement'
      AND payment_intent_id IS NULL
      AND settlement_reference IS NOT NULL
      AND internal_status IS NULL
      AND provider_status IS NULL
    )
  ),
  CONSTRAINT payment_reconciliation_record_outcome_shape_check CHECK (
    (
      outcome = 'Difference'
      AND difference_reason IS NOT NULL
      AND reconciliation_exception_id IS NOT NULL
      AND safe_code IS NULL
    ) OR (
      outcome = 'Unavailable'
      AND difference_reason IS NULL
      AND reconciliation_exception_id IS NULL
      AND safe_code IS NOT NULL
      AND provider_captured_minor IS NULL
      AND provider_refunded_minor IS NULL
    ) OR (
      outcome IN ('Matched', 'Healed', 'Unresolved')
      AND difference_reason IS NULL
      AND reconciliation_exception_id IS NULL
      AND safe_code IS NULL
      AND provider_captured_minor IS NOT NULL
      AND provider_refunded_minor IS NOT NULL
    )
  ),
  CONSTRAINT payment_reconciliation_record_amount_check CHECK (
    internal_refunded_minor <= internal_captured_minor
    AND (
      provider_captured_minor IS NULL
      OR provider_refunded_minor <= provider_captured_minor
    )
  )
);

CREATE RULE payment_reconciliation_run_no_update AS
  ON UPDATE TO rms_payment.payment_reconciliation_run DO INSTEAD NOTHING;
CREATE RULE payment_reconciliation_run_no_delete AS
  ON DELETE TO rms_payment.payment_reconciliation_run DO INSTEAD NOTHING;
CREATE RULE payment_reconciliation_exception_no_update AS
  ON UPDATE TO rms_payment.payment_reconciliation_exception DO INSTEAD NOTHING;
CREATE RULE payment_reconciliation_exception_no_delete AS
  ON DELETE TO rms_payment.payment_reconciliation_exception DO INSTEAD NOTHING;
CREATE RULE payment_reconciliation_record_no_update AS
  ON UPDATE TO rms_payment.payment_reconciliation_record DO INSTEAD NOTHING;
CREATE RULE payment_reconciliation_record_no_delete AS
  ON DELETE TO rms_payment.payment_reconciliation_record DO INSTEAD NOTHING;

CREATE INDEX payment_reconciliation_run_store_time_idx
  ON rms_payment.payment_reconciliation_run (brand_id, store_id, completed_at DESC);
CREATE INDEX payment_reconciliation_exception_store_open_idx
  ON rms_payment.payment_reconciliation_exception
    (brand_id, store_id, status, opened_at DESC, reconciliation_exception_id);
CREATE INDEX payment_reconciliation_record_store_time_idx
  ON rms_payment.payment_reconciliation_record
    (brand_id, store_id, checked_at DESC, reconciliation_check_id);
CREATE INDEX payment_reconciliation_record_payment_idx
  ON rms_payment.payment_reconciliation_record
    (brand_id, store_id, payment_intent_id, checked_at DESC)
  WHERE payment_intent_id IS NOT NULL;

ALTER TABLE rms_payment.payment_reconciliation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_reconciliation_run FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_reconciliation_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_reconciliation_exception FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_reconciliation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_reconciliation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_reconciliation_run_store_scope_policy
  ON rms_payment.payment_reconciliation_run
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY payment_reconciliation_exception_store_scope_policy
  ON rms_payment.payment_reconciliation_exception
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY payment_reconciliation_record_store_scope_policy
  ON rms_payment.payment_reconciliation_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_payment.payment_reconciliation_run FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.payment_reconciliation_exception FROM PUBLIC;
REVOKE ALL ON TABLE rms_payment.payment_reconciliation_record FROM PUBLIC;
