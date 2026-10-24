-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (2026-10-15): eventing retry policy version 2. Version 1 (1 s x 2, full jitter, 8
-- handoffs) used up its 8 handoffs in about a minute, so any condition lasting minutes (a database
-- restart, a lock held by a long job, a round still waiting for its payment) ended in a dead letter
-- that staff had to replay by hand. Version 2 keeps the 8 handoffs and the 24 h horizon and spreads
-- them over about 36-71 minutes (2 s x 4 capped at 30 min, equal jitter): quick retries for
-- ordering gaps and short lock waits, then minutes apart for outages. Attempts and dead letters
-- keep the version that resolved them; nothing recorded under version 1 is rewritten.
ALTER TABLE platform_eventing.delivery_attempt
  DROP CONSTRAINT delivery_attempt_policy_version_check;
ALTER TABLE platform_eventing.delivery_attempt
  ADD CONSTRAINT delivery_attempt_policy_version_check CHECK (policy_version IN (1, 2));
ALTER TABLE platform_eventing.dead_letter_item
  DROP CONSTRAINT dead_letter_item_policy_version_check;
ALTER TABLE platform_eventing.dead_letter_item
  ADD CONSTRAINT dead_letter_item_policy_version_check CHECK (policy_version IN (1, 2));
