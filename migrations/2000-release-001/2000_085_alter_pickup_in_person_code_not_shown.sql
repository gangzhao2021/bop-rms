-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-18): a pickup customer whose code is still valid but who cannot show it (phone
-- dead, lost or left behind; the code never reached them; the order page was closed or lost) is
-- handed the order after staff deliberately choose the in-person check and name why, with no wrong
-- codes needed to lock the order first. The in-person verification records reason CodeNotShown and
-- the cause staff chose from a fixed list (never free text, so no personal detail is stored). The
-- cause is present exactly when the reason is CodeNotShown; rows recorded before this migration
-- have no cause and still satisfy every constraint. The owner writer still decides, under the
-- fulfillment fence, that the code is valid and unlocked when CodeNotShown is recorded.
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  ADD COLUMN code_not_shown_cause text;
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  DROP CONSTRAINT pickup_in_person_verification_reason_check;
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  ADD CONSTRAINT pickup_in_person_verification_reason_check
    CHECK (reason IN ('ProofExpired', 'ProofNotIssued', 'CodeLocked', 'CodeNotShown'));
ALTER TABLE rms_fulfillment.pickup_in_person_verification
  ADD CONSTRAINT pickup_in_person_verification_code_not_shown_cause_check
    CHECK (
      CASE WHEN reason = 'CodeNotShown'
        THEN code_not_shown_cause IS NOT NULL
          AND code_not_shown_cause IN ('PhoneUnavailable', 'CodeNotReceived', 'OrderPageLost')
        ELSE code_not_shown_cause IS NULL
      END
    );
