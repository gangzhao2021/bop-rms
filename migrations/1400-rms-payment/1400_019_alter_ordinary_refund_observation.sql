-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_payment.ordinary_refund_observation
  DROP CONSTRAINT ordinary_refund_observation_outcome_kind_check;
ALTER TABLE rms_payment.ordinary_refund_observation
  ADD CONSTRAINT ordinary_refund_observation_outcome_kind_check
    CHECK (outcome_kind IN ('Snapshot','Failure','RefundObservation'));
ALTER TABLE rms_payment.ordinary_refund_observation
  ADD CONSTRAINT ordinary_refund_individual_observation_binding CHECK (
    outcome_kind <> 'RefundObservation' OR (
      (record_json#>>'{outcome,providerRequestDigest}') IS NOT DISTINCT FROM provider_request_digest AND
      COALESCE((record_json#>>'{outcome,providerRefundReference}') ~ '^re_[A-Za-z0-9]+$',false) AND
      COALESCE((record_json#>>'{outcome,providerIntentReference}') ~ '^pi_[A-Za-z0-9_]+$',false) AND
      (record_json#>>'{outcome,amount,currencyCode}') IS NOT DISTINCT FROM 'CAD' AND
      COALESCE((record_json#>>'{outcome,amount,amountMinor}') ~ '^[1-9][0-9]{0,7}$',false) AND
      COALESCE((record_json#>>'{outcome,status}') IN ('pending','requires_action','succeeded','failed','canceled'),false) AND
      COALESCE((record_json#>>'{outcome,evidenceDigest}') ~ '^sha256:[a-f0-9]{64}$',false)
    )
  );
