-- bop-rms-migration: 1
-- owner: shared-infrastructure/projection
-- schema: platform_projection
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 600000
-- recovery: forward-fix
-- WP-2423 (2026-10-17): the Exceptions page lists every open case and pages resolved history,
-- instead of reading every case the Store ever had (it stopped at 500). A case is open while it
-- has no Final version (Final is terminal), so the open read visits the open versions and checks
-- each against the Final ones; resolved history pages by reference over the Final versions.
-- Index only: no row is changed or removed, no grant changes (Owner standing approval
-- 2026-10-14, WP-2423).
CREATE INDEX order_exception_source_open_idx
  ON platform_projection.order_exception_source (tenant_id, brand_id, store_id, source_id, source_version DESC)
  WHERE (record_json->>'sourceStatus') = 'Open';
CREATE INDEX order_exception_source_final_idx
  ON platform_projection.order_exception_source (tenant_id, brand_id, store_id, source_id)
  WHERE (record_json->>'sourceStatus') = 'Final';
