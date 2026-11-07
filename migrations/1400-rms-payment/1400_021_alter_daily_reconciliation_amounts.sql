-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Daily refunds may relate to captures from earlier business dates.
-- Individual Operational payments retain their capture-backed refund limit.
ALTER TABLE rms_payment.payment_reconciliation_record
  DROP CONSTRAINT payment_reconciliation_record_amount_check;
ALTER TABLE rms_payment.payment_reconciliation_record
  ADD CONSTRAINT payment_reconciliation_record_amount_check CHECK (
    mode = 'DailySettlement' OR (
      internal_refunded_minor <= internal_captured_minor
      AND (
        provider_captured_minor IS NULL
        OR provider_refunded_minor <= provider_captured_minor
      )
    )
  );
