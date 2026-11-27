-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-17): the refund of a Provider charge that matches no Order counts in the store
-- business day of the Provider's refund creation time, the time the Provider statement uses (the
-- day-end settlement already counts it so). The confirmed outcome now keeps that time so the
-- Settlement page puts the refund on the same day; before, the page used the time the refund
-- result was observed, which can fall after the business day ends (a refund confirmed just after
-- the day's end, or recovered later by approving again).
-- Outcomes recorded before this migration keep no creation time (NOT VALID: they are not
-- changed); every new outcome must carry one, whole seconds, no later than its observation.
ALTER TABLE rms_payment.unmatched_capture_refund_outcome
 ADD COLUMN provider_created_at timestamptz;
ALTER TABLE rms_payment.unmatched_capture_refund_outcome
 ADD CONSTRAINT unmatched_capture_refund_outcome_provider_created_check
 CHECK (provider_created_at IS NOT NULL AND isfinite(provider_created_at)
  AND provider_created_at=date_trunc('second',provider_created_at)
  AND provider_created_at<=provider_observed_at)
 NOT VALID;
