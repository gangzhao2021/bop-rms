-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE bop_identity.guest_session
  ADD COLUMN dining_session_id platform_helpers.uuid_v7,
  ADD COLUMN dining_participant_id platform_helpers.uuid_v7;

ALTER TABLE bop_identity.guest_session
  DROP CONSTRAINT guest_session_dining_state_check,
  ADD CONSTRAINT guest_session_dining_binding_check CHECK (
    (
      dining_state = 'ContextOnly'
      AND dining_session_id IS NULL
      AND dining_participant_id IS NULL
    )
    OR (
      dining_state = 'DiningBound'
      AND channel = 'DineIn'
      AND dining_session_id IS NOT NULL
      AND dining_participant_id IS NOT NULL
    )
  );
