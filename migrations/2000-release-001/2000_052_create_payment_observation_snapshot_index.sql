-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 600000
-- recovery: forward-fix
-- WP-2423 pilot resilience (2026-10-15): Provider observations are append-only facts, so one
-- payment attempt can collect many Snapshot rows. The receipt coverage and compensation source
-- reads take the latest two Snapshots and the highest refunded amount of one attempt; without
-- these indexes each read sorted every row of the attempt (v15 held ~650k rows, the read hit the
-- 5 s statement timeout and the worker stopped). Indexes only: no row is changed or removed, no
-- grant changes (Owner standing approval 2026-10-14, WP-2423 pilot resilience).
CREATE INDEX payment_provider_observation_snapshot_latest_idx
  ON rms_payment.payment_provider_observation
  (brand_id, store_id, payment_attempt_id, provider_observed_at DESC, recorded_at DESC,
    provider_observation_id DESC)
  WHERE observation_kind = 'Snapshot';
CREATE INDEX payment_provider_observation_snapshot_refunded_idx
  ON rms_payment.payment_provider_observation
  (brand_id, store_id, payment_attempt_id, refunded_minor DESC)
  INCLUDE (payment_intent_id)
  WHERE observation_kind = 'Snapshot';
