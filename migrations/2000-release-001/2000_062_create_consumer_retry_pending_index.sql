-- bop-rms-migration: 1
-- owner: shared-infrastructure/eventing
-- schema: platform_eventing
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 600000
-- recovery: forward-fix
-- WP-2423 (2026-10-16): the operations monitor warns while order updates are still being retried
-- (4 tries, or failing for 10 minutes), before any dead letter. It reads only consumer retries
-- that are still pending (scheduled or being processed); completed and dead-lettered retries stay
-- as history and are not read. Without this index the read visited every retry row the Store ever
-- had. Index only: no row is changed or removed, no grant changes (Owner standing approval
-- 2026-10-14, WP-2423).
CREATE INDEX consumer_retry_schedule_pending_idx
  ON platform_eventing.consumer_retry_schedule (brand_id, store_id, deadline_at)
  INCLUDE (attempt_count)
  WHERE state IN ('scheduled', 'claimed');
