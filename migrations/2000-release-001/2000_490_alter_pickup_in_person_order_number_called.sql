-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M21 (2026-11-06): an order staff took at the counter has no pickup code and, by default,
-- no name (Owner M110). Staff call its number and hand it to the customer who answers. That check
-- is recorded as what it is, OrderNumberCalled, never as a name check that was not made. It is
-- allowed only while no pickup proof was ever issued (reason ProofNotIssued); the merchant
-- composition also requires the order to be a counter order (Ordering's own read). Rows recorded
-- before this migration keep their checks and satisfy every constraint.
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  DROP CONSTRAINT pickup_in_person_verification_identity_check_check;
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  ADD CONSTRAINT pickup_in_person_verification_identity_check_check
    CHECK (
      identity_check IN ('OrderNumberAndName', 'OrderNumberAndPhoneLast4', 'OrderNumberCalled')
    );
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  ADD CONSTRAINT pickup_in_person_verification_order_number_called_check
    CHECK (identity_check <> 'OrderNumberCalled' OR reason = 'ProofNotIssued');
